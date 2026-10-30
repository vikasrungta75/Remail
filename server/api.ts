import { ensureSchema, one, q } from './db';
import { HttpError, Router, intParam, json, redirect, type Ctx } from './http';
import {
	authenticate, authMode, consumeResetToken, createResetToken, defaultOrgId, hashPassword, login, logout,
	mailboxScope, publicUser, requireRole, verifyPassword, ROLE_RANK, type Role,
	ravityConfigured, ravityForgotPassword, ravityResetPassword, microsoftSsoEnabled, loginWithMicrosoft,
} from './auth';
import { categoriesOverview, myDay, proposals, team } from './views';
import { audit } from './audit';
import { convFilter, dashboardSummary, dashboardTrends, filterOptions, insights } from './queries';
import { getOrg, invalidateOrg } from './settings';
import { randomToken, safeEqual } from './crypto';
import {
	microsoftAuthorizeUrl, microsoftConfigured, microsoftExchangeCode, microsoftAdminConsentUrl, microsoftSignIn,
	microsoftTestMailbox, orgTenant, MS_SIGNIN_SCOPES,
} from './connectors/microsoft';
import { googleAuthorizeUrl, googleConfigured, googleExchangeCode } from './connectors/gmail';
import { parseEml } from './connectors/upload';
import { ingestMessages } from './ingest';
import { analyseConversation, analysePending, backfillHealthHistory, updateCustomerHealth } from './analyze';
import { runTick, syncMailbox } from './worker';
import { aiModel, aiProvider } from './ai/llm';
import { appUrl, emailLayout, esc, mailerProvider, sendEmail } from './mailer';
import { buildReport, runSchedule } from './reports';
import { ask, SUGGESTED_QUESTIONS } from './copilot';
import { loadDemoData, clearDemoData } from './demo';
import { BUSINESS_CATEGORIES, BUSINESS_LABELS, CATEGORIES, CATEGORY_LABELS, PROPOSAL_STAGES } from './ai/types';
import type { MailboxRow } from './connectors/types';

const r = new Router();

// ── Auth ────────────────────────────────────────────────────────────────────
r.get('/api/auth/config', async () => ({
	mode: authMode(),
	ravity: ravityConfigured(),
	microsoft: microsoftSsoEnabled(),
	orgName: (await getOrg(await defaultOrgId())).name,
}), { auth: 'public' });

// Sign in with Microsoft (Office 365 work account)
r.post('/api/auth/microsoft/start', async () => {
	if (!microsoftSsoEnabled()) throw new HttpError(400, 'Microsoft sign-in is not configured');
	const state = randomToken(24);
	await q('insert into oauth_states (state, provider) values ($1, $2)', [state, 'ms_signin']);
	return { url: microsoftAuthorizeUrl(state, `${appUrl()}/api/auth/microsoft/callback`, MS_SIGNIN_SCOPES, 'select_account') };
}, { auth: 'public' });

r.get('/api/auth/microsoft/callback', async (ctx) => {
	const fail = (m: string) => redirect(`${appUrl()}/auth/login?error=${encodeURIComponent(m)}`);
	const st = await one<any>(`delete from oauth_states where state=$1 and provider='ms_signin' and created_at > now() - interval '15 minutes' returning *`, [ctx.query.get('state') || '']);
	if (!st) return fail('The sign-in request expired. Please try again.');
	if (ctx.query.get('error')) return fail(ctx.query.get('error_description') || ctx.query.get('error')!);
	try {
		const ms = await microsoftSignIn(ctx.query.get('code') || '', `${appUrl()}/api/auth/microsoft/callback`);
		const res = await loginWithMicrosoft(ctx, ms);
		return redirect(`${appUrl()}/auth/sso#token=${encodeURIComponent(res.token)}&loginTime=${encodeURIComponent(res.loginTime)}`);
	} catch (e: any) {
		console.error('[sso]', e.message);
		return fail(e instanceof HttpError ? e.message : 'Microsoft sign-in failed. Please try again.');
	}
}, { auth: 'public' });

// Microsoft 365 administrator consent (organisation-wide read-only access to the monitored mailboxes)
r.post('/api/connect/microsoft-admin/start', async (ctx) => {
	requireRole(ctx.user, 'admin');
	if (!microsoftConfigured()) throw new HttpError(400, 'Set MS_CLIENT_ID and MS_CLIENT_SECRET first');
	const state = randomToken(24);
	await q('insert into oauth_states (state, user_id, provider) values ($1,$2,$3)', [state, ctx.user!.id, 'ms_admin']);
	return { url: microsoftAdminConsentUrl(state, `${appUrl()}/api/connect/microsoft-admin/callback`, String(ctx.body?.tenant || 'organizations')) };
});

r.get('/api/connect/microsoft-admin/callback', async (ctx) => {
	const back = (msg: string, ok: boolean) => redirect(`${appUrl()}/admin/mailboxes?${ok ? 'connected' : 'error'}=${encodeURIComponent(msg)}`);
	const st = await one<any>(`delete from oauth_states where state=$1 and provider='ms_admin' and created_at > now() - interval '30 minutes' returning *`, [ctx.query.get('state') || '']);
	if (!st) return back('The consent request expired. Please try again.', false);
	if (ctx.query.get('error')) return back(ctx.query.get('error_description') || ctx.query.get('error')!, false);
	const tenant = ctx.query.get('tenant') || '';
	if (ctx.query.get('admin_consent') !== 'True' || !/^[0-9a-f-]{36}$/i.test(tenant)) return back('Consent was not granted', false);
	const user = await one<any>('select * from users where id=$1', [st.user_id]);
	await q(`update organisations set settings = settings || $2::jsonb where id=$1`, [user.org_id, JSON.stringify({ msTenantId: tenant, msConsentedAt: new Date().toISOString(), msConsentedBy: user.email })]);
	invalidateOrg(user.org_id);
	await audit({ ...ctx, user: undefined }, 'microsoft.admin_consent', 'organisation', user.org_id, { tenant }, user);
	return back('Microsoft 365 organisation', true);
}, { auth: 'public' });

r.post('/api/auth/login', async (ctx) => {
	const { userid, password } = ctx.body || {};
	if (!userid || !password) throw new HttpError(400, 'Email and password are required');
	return login(ctx, String(userid), String(password));
}, { auth: 'public' });

r.post('/api/auth/logout', async (ctx) => {
	await logout(ctx, ctx.user!, ctx.body?.loginTime);
	return { success: true };
});

r.get('/api/auth/me', async (ctx) => {
	const u = await one('select * from users where id=$1', [ctx.user!.id]);
	const org = await getOrg(ctx.user!.orgId);
	return { user: publicUser(u), org: { id: org.id, name: org.name } };
});

r.post('/api/auth/forgot-password', async (ctx) => {
	const email = String(ctx.body?.email || '').trim().toLowerCase();
	const u = await one<any>('select * from users where lower(email)=$1 and is_active', [email]);
	if (u) {
		if (u.auth_provider === 'ravity' && ravityConfigured()) {
			// Password is owned by Ravity IAM — trigger its reset email (same as rfleet)
			await ravityForgotPassword(email).catch((e) => console.error('[auth] IAM forgot password', e.message));
		} else if (u.auth_provider === 'microsoft') {
			/* Microsoft accounts reset their password with Microsoft */
		} else {
			const token = await createResetToken(u.id);
			const link = `${appUrl()}/auth/reset-password?token=${token}`;
			await sendEmail([u.email], 'Reset your remail password', emailLayout('Reset your password', `<p style="font-size:14px">We received a request to reset the password for ${esc(u.email)}. The link is valid for one hour.</p><p><a href="${link}" style="display:inline-block;background:#F00D69;color:#fff;text-decoration:none;padding:10px 18px;border-radius:10px;font-weight:700">Reset password</a></p><p style="font-size:12px;color:#5b6180">If you did not ask for this, you can ignore this email.</p>`)).catch((e) => console.error('[mail]', e.message));
		}
		await audit(ctx, 'auth.password_reset_requested', 'user', u.id, {}, u);
	} else if (ravityConfigured()) {
		// not yet provisioned in remail, but may exist in Ravity IAM
		await ravityForgotPassword(email).catch(() => {});
	}
	// Always the same response — never reveal whether an account exists
	return { success: true, message: 'If an account exists for that email, a reset link has been sent.' };
}, { auth: 'public' });

r.post('/api/auth/reset-password', async (ctx) => {
	const token = String(ctx.body?.token || '');
	const password = String(ctx.body?.password || '');
	try {
		const userId = await consumeResetToken(token, password);
		await audit(ctx, 'auth.password_reset', 'user', userId, {}, { id: userId });
	} catch (e) {
		// Not a remail token: a Ravity IAM reset link (as sent by rfleet's forgot-password)
		if (!ravityConfigured()) throw e;
		await ravityResetPassword(token, password);
		await audit(ctx, 'auth.password_reset', 'user', null, { provider: 'ravity' });
	}
	return { success: true };
}, { auth: 'public' });

r.post('/api/auth/change-password', async (ctx) => {
	const { currentPassword, newPassword } = ctx.body || {};
	if (ctx.user!.authProvider !== 'local') throw new HttpError(400, ctx.user!.authProvider === 'microsoft' ? 'Your password is managed by Microsoft' : 'Your password is managed by Ravity sign-in');
	if (!(await verifyPassword(ctx.user!.id, String(currentPassword || '')))) throw new HttpError(400, 'Current password is incorrect');
	await q('update users set password_hash=$2, updated_at=now() where id=$1', [ctx.user!.id, await hashPassword(String(newPassword || ''))]);
	await q('update sessions set revoked_at=now() where user_id=$1 and id<>$2 and revoked_at is null', [ctx.user!.id, ctx.user!.sessionId]);
	await audit(ctx, 'auth.password_changed', 'user', ctx.user!.id);
	return { success: true };
});

r.patch('/api/auth/profile', async (ctx) => {
	const { fullName, timezone, notifyEmail, digestEnabled, emailAliases } = ctx.body || {};
	await q(
		`update users set full_name=coalesce($2, full_name), timezone=coalesce($3, timezone), notify_email=coalesce($4, notify_email),
		   digest_enabled=coalesce($5, digest_enabled), email_aliases=coalesce($6, email_aliases), updated_at=now() where id=$1`,
		[ctx.user!.id, fullName ?? null, timezone ?? null, typeof notifyEmail === 'boolean' ? notifyEmail : null,
			typeof digestEnabled === 'boolean' ? digestEnabled : null,
			Array.isArray(emailAliases) ? emailAliases.map((x: string) => String(x).trim().toLowerCase()).filter((x: string) => /@/.test(x)) : null],
	);
	await audit(ctx, 'user.profile_updated', 'user', ctx.user!.id);
	return publicUser(await one('select * from users where id=$1', [ctx.user!.id]));
});

// ── Dashboard & insights ────────────────────────────────────────────────────
r.get('/api/filters/options', async (ctx) => ({
	...(await filterOptions(ctx.user!)),
	categories: CATEGORIES.map((c) => ({ id: c, label: CATEGORY_LABELS[c] })),
	types: BUSINESS_CATEGORIES.map((c) => ({ id: c, label: BUSINESS_LABELS[c] })),
}));
r.get('/api/dashboard/summary', (ctx) => dashboardSummary(ctx.user!, ctx.query));
r.get('/api/dashboard/trends', (ctx) => dashboardTrends(ctx.user!, ctx.query));
r.get('/api/insights', (ctx) => insights(ctx.user!, ctx.query));

// ── Conversations ───────────────────────────────────────────────────────────
const SORTS: Record<string, string> = {
	priority: 'c.priority_score desc, c.last_message_at desc',
	recent: 'c.last_message_at desc',
	oldest_waiting: 'c.awaiting_reply desc, c.last_inbound_at asc nulls last',
	risk: 'c.escalation_risk desc nulls last',
	sentiment: 'c.sentiment_score asc nulls last',
};

r.get('/api/conversations', async (ctx) => {
	const f = await convFilter(ctx.user!, ctx.query);
	const limit = Math.min(intParam(ctx.query.get('limit'), 50)!, 200);
	const offset = intParam(ctx.query.get('offset'), 0)!;
	const sort = SORTS[ctx.query.get('sort') || 'priority'] || SORTS.priority;
	const where = f.where.join(' and ');
	const [rows, total] = await Promise.all([
		q<any>(
			`select c.id, c.subject, c.summary, c.sentiment, c.sentiment_score, c.rag, c.rag_reason, c.customer_state, c.urgency,
			        c.escalation_risk, c.priority_score, c.categories, c.status, c.awaiting_reply, c.message_count, c.duplicate_count,
			        c.last_message_at, c.last_inbound_at, c.first_response_minutes, c.mailbox_ids, c.assignee_id, c.analysed_at,
			        c.business_category, c.proposal_stage, c.is_internal, c.is_automated,
			        cu.id as customer_id, cu.name as customer_name, cu.tier as customer_tier, u.full_name as assignee_name,
			        (select count(*) from action_items a where a.conversation_id=c.id and a.status='open')::int as open_actions
			   from conversations c left join customers cu on cu.id=c.customer_id left join users u on u.id=c.assignee_id
			  where ${where} order by ${sort} limit ${limit} offset ${offset}`,
			f.params,
		),
		one<any>(`select count(*)::int n from conversations c where ${where}`, f.params),
	]);
	return { rows, total: total?.n || 0 };
});

r.get('/api/conversations/export', async (ctx) => {
	requireRole(ctx.user, 'analyst');
	const f = await convFilter(ctx.user!, ctx.query);
	const rows = await q<any>(
		`select c.id, c.business_category as type, cu.name as customer, cu.tier, c.subject, c.rag, c.sentiment, c.urgency, c.escalation_risk, c.status,
		        array_to_string(c.categories, '; ') as categories, c.message_count, c.awaiting_reply, c.first_response_minutes,
		        c.last_message_at, c.summary
		   from conversations c left join customers cu on cu.id=c.customer_id where ${f.where.join(' and ')}
		  order by c.priority_score desc limit 5000`,
		f.params,
	);
	await audit(ctx, 'export.conversations', 'conversation', null, { rows: rows.length });
	const cols = Object.keys(rows[0] || { id: '' });
	const cell = (v: any) => {
		const s = v instanceof Date ? v.toISOString() : v === null || v === undefined ? '' : String(v);
		return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
	};
	const csv = [cols.join(','), ...rows.map((row) => cols.map((c) => cell(row[c])).join(','))].join('\n');
	return new Response(csv, {
		headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="remail-conversations-${new Date().toISOString().slice(0, 10)}.csv"` },
	});
});

async function assertConversationAccess(ctx: Ctx, id: number) {
	const c = await one<any>('select id, org_id, mailbox_ids from conversations where id=$1', [id]);
	if (!c || c.org_id !== ctx.user!.orgId) throw new HttpError(404, 'Conversation not found');
	const scope = await mailboxScope(ctx.user!);
	if (scope && !c.mailbox_ids.some((m: number) => scope.includes(m))) throw new HttpError(404, 'Conversation not found');
	return c;
}

r.get('/api/conversations/:id', async (ctx) => {
	const id = Number(ctx.params.id);
	await assertConversationAccess(ctx, id);
	const conv = await one<any>(
		`select c.*, cu.name as customer_name, cu.tier as customer_tier, cu.health_score as customer_health, cu.health_status as customer_health_status,
		        u.full_name as assignee_name
		   from conversations c left join customers cu on cu.id=c.customer_id left join users u on u.id=c.assignee_id where c.id=$1`,
		[id],
	);
	const emails = await q<any>(
		`select e.id, e.mailbox_id, m.address as mailbox_address, e.direction, e.from_address, e.from_name, e.to_addresses, e.cc_addresses,
		        e.subject, e.body_clean, e.body_text, e.sent_at, e.sentiment, e.sentiment_score, e.is_duplicate, e.duplicate_of,
		        e.has_attachments, e.web_link
		   from emails e join mailboxes m on m.id=e.mailbox_id where e.conversation_id=$1 order by e.sent_at, e.id`,
		[id],
	);
	const [issues, actions, notes, alerts] = await Promise.all([
		q('select * from issues where conversation_id=$1 order by severity desc', [id]),
		q(`select a.*, u.full_name as assignee_name from action_items a left join users u on u.id=a.assignee_id where conversation_id=$1 order by a.status, a.due_date nulls last`, [id]),
		q(`select n.*, u.full_name as author from conversation_notes n left join users u on u.id=n.user_id where conversation_id=$1 order by created_at`, [id]),
		q(`select id, title, severity, status, created_at from alerts where conversation_id=$1 order by created_at desc`, [id]),
	]);
	await audit(ctx, 'conversation.viewed', 'conversation', id);
	return { conversation: conv, emails, issues, actions, notes, alerts };
});

r.patch('/api/conversations/:id', async (ctx) => {
	requireRole(ctx.user, 'analyst');
	const id = Number(ctx.params.id);
	await assertConversationAccess(ctx, id);
	const { status, assigneeId, businessCategory, proposalStage } = ctx.body || {};
	if (status && !['open', 'in_progress', 'resolved', 'ignored'].includes(status)) throw new HttpError(400, 'Invalid status');
	if (businessCategory) {
		if (!(BUSINESS_CATEGORIES as readonly string[]).includes(businessCategory)) throw new HttpError(400, 'Invalid category');
		await q('update conversations set business_category=$2, category_locked=true where id=$1', [id, businessCategory]);
	}
	if (proposalStage) {
		if (!(PROPOSAL_STAGES as readonly string[]).includes(proposalStage)) throw new HttpError(400, 'Invalid stage');
		await q(`update conversations set proposal_stage=$2, proposal_stage_locked=true, business_category='sales_proposal' where id=$1`, [id, proposalStage]);
	}
	await q(
		`update conversations set status=coalesce($2,status), assignee_id = case when $3::text = 'unset' then assignee_id else $4::bigint end,
		   resolved_at = case when $2='resolved' then now() when $2 is not null then null else resolved_at end, updated_at=now() where id=$1`,
		[id, status ?? null, assigneeId === undefined ? 'unset' : 'set', assigneeId ?? null],
	);
	if (status === 'resolved') {
		await q(`update alerts set status='resolved' where conversation_id=$1 and status<>'resolved'`, [id]);
		await q(`update action_items set status='done', completed_at=now() where conversation_id=$1 and status='open' and not is_commitment`, [id]);
	}
	const c = await one<any>('select customer_id from conversations where id=$1', [id]);
	if (c?.customer_id) await updateCustomerHealth(c.customer_id);
	await audit(ctx, 'conversation.updated', 'conversation', id, { status, assigneeId });
	return { success: true };
});

r.post('/api/conversations/:id/notes', async (ctx) => {
	requireRole(ctx.user, 'analyst');
	const id = Number(ctx.params.id);
	await assertConversationAccess(ctx, id);
	const body = String(ctx.body?.body || '').trim();
	if (!body) throw new HttpError(400, 'Note is empty');
	const n = await one('insert into conversation_notes (conversation_id, user_id, body) values ($1,$2,$3) returning *', [id, ctx.user!.id, body.slice(0, 5000)]);
	await audit(ctx, 'conversation.note_added', 'conversation', id);
	return n;
});

r.post('/api/conversations/:id/reanalyse', async (ctx) => {
	requireRole(ctx.user, 'analyst');
	const id = Number(ctx.params.id);
	await assertConversationAccess(ctx, id);
	const cust = await analyseConversation(id);
	if (cust) await updateCustomerHealth(cust);
	await audit(ctx, 'conversation.reanalysed', 'conversation', id);
	return { success: true };
});

// ── Comprehensive and individual views ──────────────────────────────────────
r.get('/api/views/categories', (ctx) => categoriesOverview(ctx.user!, ctx.query));
r.get('/api/views/my-day', (ctx) => myDay(ctx.user!));
r.get('/api/views/proposals', (ctx) => proposals(ctx.user!, ctx.query));
r.get('/api/views/team', async (ctx) => {
	requireRole(ctx.user, 'manager');
	return team(ctx.user!, ctx.query);
});

// ── Customers ───────────────────────────────────────────────────────────────
r.get('/api/customers', async (ctx) => {
	const cq = new URLSearchParams(ctx.query);
	if (cq.get('kind') && cq.get('kind') !== 'customer' && !cq.get('audience')) cq.set('audience', 'external');
	const f = await convFilter(ctx.user!, cq);
	const where = f.where.join(' and ');
	const search = (ctx.query.get('q') || '').trim();
	const rows = await q<any>(
		`select cu.id, cu.name, cu.tier, cu.kind, cu.domains, cu.health_score, cu.health_status, cu.health_trend, cu.last_contact_at, cu.account_owner,
		        count(c.id)::int as conversations,
		        count(c.id) filter (where c.rag='red')::int as red,
		        count(c.id) filter (where c.rag='amber')::int as amber,
		        count(c.id) filter (where c.rag='green')::int as green,
		        count(c.id) filter (where c.sentiment='negative')::int as negative,
		        count(c.id) filter (where c.awaiting_reply and c.status in ('open','in_progress'))::int as awaiting,
		        round(avg(c.sentiment_score)::numeric, 2)::float as avg_sentiment,
		        sum(c.message_count)::int as emails,
		        (select array_agg(x.cat) from (select unnest(categories) cat from conversations c2 where c2.customer_id=cu.id group by 1 order by count(*) desc limit 3) x) as top_categories
		   from customers cu join conversations c on c.customer_id=cu.id
		  where ${where} ${search ? `and cu.name ilike $${f.params.push(`%${search}%`)}` : ''}
		    ${ctx.query.get('kind') && ctx.query.get('kind') !== 'all' ? `and cu.kind = $${f.params.push(ctx.query.get('kind'))}` : ''}
		  group by cu.id order by cu.health_score asc nulls last, red desc limit 500`,
		f.params,
	);
	return { rows };
});

r.get('/api/customers/:id', async (ctx) => {
	const id = Number(ctx.params.id);
	const cu = await one<any>('select * from customers where id=$1 and org_id=$2', [id, ctx.user!.orgId]);
	if (!cu) throw new HttpError(404, 'Customer not found');
	const scope = await mailboxScope(ctx.user!);
	const sp = scope ? ` and c.mailbox_ids && $2::bigint[]` : '';
	const args = scope ? [id, scope] : [id];
	const [convs, health, contacts, issues, actions] = await Promise.all([
		q(`select c.id, c.subject, c.summary, c.rag, c.sentiment, c.status, c.last_message_at, c.categories, c.awaiting_reply, c.priority_score, c.message_count
		     from conversations c where c.customer_id=$1 ${sp} order by c.last_message_at desc limit 200`, args),
		q(`select day, health_score, negative_pct, red_count from customer_health_daily where customer_id=$1 order by day desc limit 120`, [id]),
		q(`select email, name from contacts where customer_id=$1 order by name`, [id]),
		q(`select i.category, count(*)::int n, max(i.severity) as max_severity from issues i where i.customer_id=$1 group by 1 order by 2 desc`, [id]),
		q(`select a.*, c.subject from action_items a join conversations c on c.id=a.conversation_id where a.customer_id=$1 and a.status='open' order by a.due_date nulls last`, [id]),
	]);
	const sentiment = await q(
		`select date_trunc('week', e.sent_at) as bucket, round(avg(e.sentiment_score)::numeric, 2)::float as avg_score, count(*)::int n,
		        count(*) filter (where e.sentiment='negative')::int as negative
		   from emails e join conversations c on c.id=e.conversation_id where c.customer_id=$1 and e.direction='inbound' and not e.is_duplicate
		  group by 1 order by 1`,
		[id],
	);
	return { customer: cu, conversations: convs, health: health.reverse(), contacts, issues, actions, sentiment };
});

r.patch('/api/customers/:id', async (ctx) => {
	requireRole(ctx.user, 'manager');
	const id = Number(ctx.params.id);
	const { name, tier, domains, accountOwner, notes, kind } = ctx.body || {};
	if (kind) {
		if (!['customer', 'prospect', 'vendor', 'partner', 'candidate', 'other'].includes(kind)) throw new HttpError(400, 'Invalid type');
		await q('update customers set kind=$3, kind_locked=true where id=$1 and org_id=$2', [Number(ctx.params.id), ctx.user!.orgId, kind]);
	}
	if (tier && !['strategic', 'key', 'standard'].includes(tier)) throw new HttpError(400, 'Invalid tier');
	await q(
		`update customers set name=coalesce($3,name), tier=coalesce($4,tier), domains=coalesce($5,domains), account_owner=coalesce($6,account_owner),
		   notes=coalesce($7,notes), auto_created=false where id=$1 and org_id=$2`,
		[id, ctx.user!.orgId, name ?? null, tier ?? null, Array.isArray(domains) ? domains.map((d: string) => d.toLowerCase().trim()) : null, accountOwner ?? null, notes ?? null],
	);
	if (tier) await q('update conversations set needs_analysis=true where customer_id=$1 and last_message_at > now() - interval \'30 days\'', [id]);
	await audit(ctx, 'customer.updated', 'customer', id, ctx.body);
	return { success: true };
});

r.post('/api/customers/merge', async (ctx) => {
	requireRole(ctx.user, 'manager');
	const target = Number(ctx.body?.targetId);
	const sources: number[] = (ctx.body?.sourceIds || []).map(Number).filter((x: number) => x && x !== target);
	const t = await one<any>('select * from customers where id=$1 and org_id=$2', [target, ctx.user!.orgId]);
	if (!t || !sources.length) throw new HttpError(400, 'Choose a target and at least one customer to merge');
	for (const s of sources) {
		const src = await one<any>('select * from customers where id=$1 and org_id=$2', [s, ctx.user!.orgId]);
		if (!src) continue;
		for (const table of ['conversations', 'contacts', 'issues', 'action_items', 'alerts'])
			await q(`update ${table} set customer_id=$1 where customer_id=$2`, [target, s]);
		await q(`update customers set domains = (select array(select distinct unnest(domains || $2::text[]))) where id=$1`, [target, src.domains]);
		await q('delete from customers where id=$1', [s]);
	}
	await updateCustomerHealth(target);
	await audit(ctx, 'customer.merged', 'customer', target, { sources });
	return { success: true };
});

// ── Action items ────────────────────────────────────────────────────────────
r.get('/api/actions', async (ctx) => {
	const aq = new URLSearchParams(ctx.query);
	if (!aq.get('audience')) aq.set('audience', 'all');
	const f = await convFilter(ctx.user!, aq, { ignoreDates: (ctx.query.get('actionStatus') || 'open') === 'open' });
	const st = ctx.query.get('actionStatus') || 'open';
	const owner = ctx.query.get('owner');
	const params = [...f.params];
	const extra: string[] = [];
	if (st !== 'all') { params.push(st); extra.push(`a.status = $${params.length}`); }
	if (owner === 'us' || owner === 'customer') { params.push(owner); extra.push(`a.owner_side = $${params.length}`); }
	if (ctx.query.get('overdue') === 'true') extra.push(`a.due_date < current_date`);
	if (ctx.query.get('commitments') === 'true') extra.push(`a.is_commitment`);
	if (ctx.query.get('mine') === 'true') { params.push(ctx.user!.id); extra.push(`(a.assignee_id = $${params.length} or (a.assignee_id is null and a.created_by = $${params.length}))`); }
	params.push(ctx.user!.orgId);
	const orgP = params.length;
	// manual actions (no conversation) are included when they fall in the user's view
	const rows = await q<any>(
		`select a.*, c.subject, c.rag, c.business_category, cu.name as customer_name, cu.tier as customer_tier, u.full_name as assignee_name
		   from action_items a left join conversations c on c.id=a.conversation_id left join customers cu on cu.id=a.customer_id
		   left join users u on u.id=a.assignee_id
		  where a.org_id = $${orgP} and (${f.where.join(' and ')} or (a.conversation_id is null and c.id is null))
		    ${extra.length ? `and ${extra.join(' and ')}` : ''}
		  order by (a.due_date < current_date and a.status='open') desc, a.due_date nulls last, a.created_at desc limit 500`,
		params,
	);
	return { rows };
});

r.post('/api/actions', async (ctx) => {
	requireRole(ctx.user, 'analyst');
	const { description, dueDate, conversationId, assigneeId, notes } = ctx.body || {};
	if (!String(description || '').trim()) throw new HttpError(400, 'Describe the action');
	let customerId: number | null = null;
	if (conversationId) {
		await assertConversationAccess(ctx, Number(conversationId));
		customerId = (await one<any>('select customer_id from conversations where id=$1', [conversationId]))?.customer_id ?? null;
	}
	const row = await one<any>(
		`insert into action_items (org_id, conversation_id, customer_id, description, owner_side, is_commitment, due_date, fingerprint, assignee_id, source, created_by, notes)
		 values ($1,$2,$3,$4,'us',true,$5,$6,$7,'manual',$8,$9) returning *`,
		[ctx.user!.orgId, conversationId || null, customerId, String(description).trim().slice(0, 500), dueDate || null, randomToken(12),
			assigneeId ?? ctx.user!.id, ctx.user!.id, notes ? String(notes).slice(0, 2000) : null],
	);
	await audit(ctx, 'action.created', 'action_item', row.id, { conversationId });
	return row;
});

/** Add an action to Outlook / any calendar (.ics) */
r.get('/api/actions/:id/ics', async (ctx) => {
	const a = await one<any>(
		`select a.*, c.subject, cu.name as customer_name from action_items a left join conversations c on c.id=a.conversation_id
		  left join customers cu on cu.id=a.customer_id where a.id=$1 and a.org_id=$2`,
		[Number(ctx.params.id), ctx.user!.orgId],
	);
	if (!a) throw new HttpError(404, 'Action not found');
	const day = (a.due_date || new Date().toISOString().slice(0, 10)).replace(/-/g, '');
	const next = new Date(`${a.due_date || new Date().toISOString().slice(0, 10)}T00:00:00Z`);
	next.setUTCDate(next.getUTCDate() + 1);
	const esc2 = (t: string) => t.replace(/[\\;,]/g, (m) => `\\${m}`).replace(/\n/g, '\\n');
	const link = a.conversation_id ? `${appUrl()}/conversations/${a.conversation_id}` : `${appUrl()}/actions`;
	const ics = [
		'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Ravity//remail//EN', 'BEGIN:VEVENT',
		`UID:remail-action-${a.id}@ravity.io`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`,
		`DTSTART;VALUE=DATE:${day}`, `DTEND;VALUE=DATE:${next.toISOString().slice(0, 10).replace(/-/g, '')}`,
		`SUMMARY:${esc2(`remail: ${a.description}`.slice(0, 200))}`,
		`DESCRIPTION:${esc2(`${a.customer_name ? `${a.customer_name} · ` : ''}${a.subject || ''}\n${link}`)}`,
		`URL:${link}`, 'BEGIN:VALARM', 'TRIGGER:-PT15H', 'ACTION:DISPLAY', 'DESCRIPTION:remail action due', 'END:VALARM',
		'END:VEVENT', 'END:VCALENDAR',
	].join('\r\n');
	return new Response(ics, { headers: { 'content-type': 'text/calendar; charset=utf-8', 'content-disposition': `attachment; filename="remail-action-${a.id}.ics"` } });
});

r.patch('/api/actions/:id', async (ctx) => {
	requireRole(ctx.user, 'analyst');
	const id = Number(ctx.params.id);
	const a = await one<any>('select * from action_items where id=$1 and org_id=$2', [id, ctx.user!.orgId]);
	if (!a) throw new HttpError(404, 'Action not found');
	if (a.conversation_id) await assertConversationAccess(ctx, a.conversation_id);
	const { status, dueDate, assigneeId } = ctx.body || {};
	if (status && !['open', 'done', 'dismissed'].includes(status)) throw new HttpError(400, 'Invalid status');
	await q(
		`update action_items set status=coalesce($2,status), due_date = case when $3::text='unset' then due_date else $4::date end,
		   assignee_id = case when $5::text='unset' then assignee_id else $6::bigint end,
		   completed_at = case when $2='done' then now() when $2 is not null then null else completed_at end where id=$1`,
		[id, status ?? null, dueDate === undefined ? 'unset' : 'set', dueDate || null, assigneeId === undefined ? 'unset' : 'set', assigneeId ?? null],
	);
	if (a.customer_id) await updateCustomerHealth(a.customer_id);
	await audit(ctx, 'action.updated', 'action_item', id, ctx.body);
	return { success: true };
});

// ── Alerts ──────────────────────────────────────────────────────────────────
r.get('/api/alerts', async (ctx) => {
	const status = ctx.query.get('status') || 'open';
	const scope = await mailboxScope(ctx.user!);
	const params: unknown[] = [ctx.user!.orgId];
	let where = 'a.org_id=$1';
	if (status !== 'all') { params.push(status); where += ` and a.status=$${params.length}`; }
	if (scope) { params.push(scope); where += ` and (a.conversation_id is null or c.mailbox_ids && $${params.length}::bigint[])`; }
	const rows = await q<any>(
		`select a.*, cu.name as customer_name, c.subject, c.rag, r.name as rule_name, u.full_name as acknowledged_by_name
		   from alerts a left join conversations c on c.id=a.conversation_id left join customers cu on cu.id=a.customer_id
		   left join alert_rules r on r.id=a.rule_id left join users u on u.id=a.acknowledged_by
		  where ${where} order by case a.severity when 'critical' then 0 when 'high' then 1 else 2 end, a.created_at desc limit 300`,
		params,
	);
	const counts = await one<any>(
		`select count(*) filter (where status='open')::int open, count(*) filter (where status='open' and severity='critical')::int critical from alerts where org_id=$1`,
		[ctx.user!.orgId],
	);
	return { rows, counts };
});

r.post('/api/alerts/:id/:action', async (ctx) => {
	requireRole(ctx.user, 'analyst');
	const id = Number(ctx.params.id);
	const action = ctx.params.action;
	if (action === 'ack') await q(`update alerts set status='acknowledged', acknowledged_by=$3, acknowledged_at=now() where id=$1 and org_id=$2`, [id, ctx.user!.orgId, ctx.user!.id]);
	else if (action === 'resolve') await q(`update alerts set status='resolved' where id=$1 and org_id=$2`, [id, ctx.user!.orgId]);
	else if (action === 'reopen') await q(`update alerts set status='open' where id=$1 and org_id=$2`, [id, ctx.user!.orgId]);
	else throw new HttpError(400, 'Unknown action');
	await audit(ctx, `alert.${action}`, 'alert', id);
	return { success: true };
});

r.get('/api/alert-rules', async (ctx) => ({ rows: await q('select * from alert_rules where org_id=$1 order by id', [ctx.user!.orgId]) }));

const RULE_TYPES = ['rag_red', 'negative_key_customer', 'escalation_risk', 'keyword', 'sla_breach', 'health_drop', 'action_overdue', 'proposal_deadline'];
function ruleFields(b: any) {
	if (b.rule_type && !RULE_TYPES.includes(b.rule_type)) throw new HttpError(400, 'Invalid rule type');
	if (b.severity && !['medium', 'high', 'critical'].includes(b.severity)) throw new HttpError(400, 'Invalid severity');
	const arr = (v: any) => (Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean) : null);
	return [
		b.name ?? null, b.enabled ?? null, b.rule_type ?? null, b.params ? JSON.stringify(b.params) : null, b.severity ?? null,
		arr(b.channels), arr(b.recipients), b.escalate_after_minutes === undefined ? null : b.escalate_after_minutes, arr(b.escalation_recipients),
	];
}
r.post('/api/alert-rules', async (ctx) => {
	requireRole(ctx.user, 'manager');
	const f = ruleFields(ctx.body || {});
	if (!f[0] || !f[2]) throw new HttpError(400, 'Name and rule type are required');
	const row = await one(
		`insert into alert_rules (org_id, name, enabled, rule_type, params, severity, channels, recipients, escalate_after_minutes, escalation_recipients)
		 values ($1,$2,coalesce($3,true),$4,coalesce($5,'{}'),coalesce($6,'high'),coalesce($7,'{in_app,email}'),coalesce($8,'{}'),$9,coalesce($10,'{}')) returning *`,
		[ctx.user!.orgId, ...f],
	);
	await audit(ctx, 'alert_rule.created', 'alert_rule', (row as any).id, ctx.body);
	return row;
});
r.patch('/api/alert-rules/:id', async (ctx) => {
	requireRole(ctx.user, 'manager');
	const f = ruleFields(ctx.body || {});
	const hasEsc = ctx.body && 'escalate_after_minutes' in ctx.body;
	await q(
		`update alert_rules set name=coalesce($3,name), enabled=coalesce($4,enabled), rule_type=coalesce($5,rule_type), params=coalesce($6::jsonb,params),
		   severity=coalesce($7,severity), channels=coalesce($8,channels), recipients=coalesce($9,recipients),
		   escalate_after_minutes = case when $12 then $10::int else escalate_after_minutes end, escalation_recipients=coalesce($11,escalation_recipients)
		 where id=$1 and org_id=$2`,
		[Number(ctx.params.id), ctx.user!.orgId, ...f, hasEsc],
	);
	await audit(ctx, 'alert_rule.updated', 'alert_rule', ctx.params.id, ctx.body);
	return { success: true };
});
r.del('/api/alert-rules/:id', async (ctx) => {
	requireRole(ctx.user, 'manager');
	await q('delete from alert_rules where id=$1 and org_id=$2', [Number(ctx.params.id), ctx.user!.orgId]);
	await audit(ctx, 'alert_rule.deleted', 'alert_rule', ctx.params.id);
	return { success: true };
});

// ── Reports ─────────────────────────────────────────────────────────────────
r.get('/api/reports/schedules', async (ctx) => ({ rows: await q('select * from report_schedules where org_id=$1 order by id', [ctx.user!.orgId]) }));
r.post('/api/reports/schedules', async (ctx) => {
	requireRole(ctx.user, 'manager');
	const b = ctx.body || {};
	if (!b.name || !['daily', 'weekly', 'monthly'].includes(b.frequency)) throw new HttpError(400, 'Name and frequency are required');
	const row = await one(
		`insert into report_schedules (org_id, name, frequency, hour_utc, day_of_week, day_of_month, recipients, filters, enabled, created_by)
		 values ($1,$2,$3,$4,$5,$6,$7,$8,coalesce($9,true),$10) returning *`,
		[ctx.user!.orgId, b.name, b.frequency, b.hour_utc ?? 7, b.day_of_week ?? 1, b.day_of_month ?? 1, b.recipients || [], JSON.stringify(b.filters || {}), b.enabled, ctx.user!.id],
	);
	await audit(ctx, 'report_schedule.created', 'report_schedule', (row as any).id, b);
	return row;
});
r.patch('/api/reports/schedules/:id', async (ctx) => {
	requireRole(ctx.user, 'manager');
	const b = ctx.body || {};
	if (b.frequency && !['daily', 'weekly', 'monthly'].includes(b.frequency)) throw new HttpError(400, 'Invalid frequency');
	await q(
		`update report_schedules set name=coalesce($3,name), frequency=coalesce($4,frequency), hour_utc=coalesce($5,hour_utc), day_of_week=coalesce($6,day_of_week),
		   day_of_month=coalesce($7,day_of_month), recipients=coalesce($8,recipients), filters=coalesce($9::jsonb,filters), enabled=coalesce($10,enabled)
		 where id=$1 and org_id=$2`,
		[Number(ctx.params.id), ctx.user!.orgId, b.name ?? null, b.frequency ?? null, b.hour_utc ?? null, b.day_of_week ?? null, b.day_of_month ?? null,
			Array.isArray(b.recipients) ? b.recipients : null, b.filters ? JSON.stringify(b.filters) : null, typeof b.enabled === 'boolean' ? b.enabled : null],
	);
	await audit(ctx, 'report_schedule.updated', 'report_schedule', ctx.params.id, b);
	return { success: true };
});
r.del('/api/reports/schedules/:id', async (ctx) => {
	requireRole(ctx.user, 'manager');
	await q('delete from report_schedules where id=$1 and org_id=$2', [Number(ctx.params.id), ctx.user!.orgId]);
	await audit(ctx, 'report_schedule.deleted', 'report_schedule', ctx.params.id);
	return { success: true };
});
r.post('/api/reports/schedules/:id/send', async (ctx) => {
	requireRole(ctx.user, 'manager');
	const s = await one<any>('select id from report_schedules where id=$1 and org_id=$2', [Number(ctx.params.id), ctx.user!.orgId]);
	if (!s) throw new HttpError(404, 'Schedule not found');
	const res = await runSchedule(s.id, true);
	await audit(ctx, 'report.sent_now', 'report_schedule', s.id, res);
	return res;
});
r.get('/api/reports/runs', async (ctx) => ({
	rows: await q(
		`select r.id, r.schedule_id, s.name as schedule_name, r.period_start, r.period_end, r.summary, r.recipients, r.delivery_status, r.created_at
		   from report_runs r left join report_schedules s on s.id=r.schedule_id where r.org_id=$1 order by r.created_at desc limit 100`,
		[ctx.user!.orgId],
	),
}));
r.get('/api/reports/runs/:id', async (ctx) => {
	const run = await one<any>('select * from report_runs where id=$1 and org_id=$2', [Number(ctx.params.id), ctx.user!.orgId]);
	if (!run) throw new HttpError(404, 'Report not found');
	return run;
});
r.post('/api/reports/preview', async (ctx) => {
	const days = Number(ctx.body?.days || 7);
	const to = new Date();
	const from = new Date(Date.now() - days * 86400_000);
	const rep = await buildReport(ctx.user!.orgId, from, to, ctx.body?.filters || {});
	return { html: rep.html, summary: rep.summary };
});

// ── Copilot ─────────────────────────────────────────────────────────────────
r.get('/api/copilot/suggestions', async () => ({ suggestions: SUGGESTED_QUESTIONS, mode: aiProvider() === 'heuristic' ? 'rules' : 'ai' }));
r.post('/api/copilot/ask', async (ctx) => {
	const question = String(ctx.body?.question || '').trim().slice(0, 500);
	if (!question) throw new HttpError(400, 'Ask a question');
	const res = await ask(ctx.user!, question, new URLSearchParams(ctx.body?.filters || {}));
	await audit(ctx, 'copilot.asked', null, null, { question });
	return res;
});

// ── Mailboxes & connectors ──────────────────────────────────────────────────
r.get('/api/mailboxes', async (ctx) => {
	const scope = await mailboxScope(ctx.user!);
	const rows = await q<any>(
		`select m.id, m.provider, m.address, m.display_name, m.status, m.last_error, m.backfill_days, m.last_synced_at, m.messages_synced, m.created_at,
		        (select count(*) from emails e where e.mailbox_id=m.id)::int as emails,
		        (select count(*) from emails e where e.mailbox_id=m.id and e.is_duplicate)::int as duplicates,
		        (select row_to_json(s) from (select started_at, finished_at, fetched, inserted, duplicates, error from sync_runs where mailbox_id=m.id order by id desc limit 1) s) as last_run
		   from mailboxes m where m.org_id=$1 ${scope ? 'and m.id = any($2)' : ''} order by m.created_at`,
		scope ? [ctx.user!.orgId, scope] : [ctx.user!.orgId],
	);
	return {
		rows,
		providers: await providerStatus(ctx.user!.orgId),
	};
});

async function providerStatus(orgId: number) {
	const tenant = microsoftConfigured() ? await orgTenant(orgId) : null;
	const org = await getOrg(orgId);
	return {
		microsoft: microsoftConfigured(),
		microsoftApp: microsoftConfigured() && !!tenant,
		msTenantId: tenant,
		msConsentedAt: (org.settings as any).msConsentedAt || null,
		msConsentedBy: (org.settings as any).msConsentedBy || null,
		google: googleConfigured(),
	};
}

r.post('/api/mailboxes/test', async (ctx) => {
	requireRole(ctx.user, 'admin');
	const address = String(ctx.body?.address || '').trim().toLowerCase();
	if (!/@/.test(address)) throw new HttpError(400, 'Enter a mailbox address');
	return microsoftTestMailbox(ctx.user!.orgId, address);
});

r.post('/api/mailboxes', async (ctx) => {
	requireRole(ctx.user, 'admin');
	const { address, displayName, backfillDays } = ctx.body || {};
	if (!microsoftConfigured() || !(await orgTenant(ctx.user!.orgId))) throw new HttpError(400, 'Connect your Microsoft 365 organisation first (administrator consent)');
	if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(address || ''))) throw new HttpError(400, 'Enter a valid mailbox address');
	const row = await one<any>(
		`insert into mailboxes (org_id, provider, address, display_name, backfill_days, created_by) values ($1,'microsoft_app',$2,$3,$4,$5)
		 on conflict (org_id, provider, lower(address)) do update set status='active' returning *`,
		[ctx.user!.orgId, String(address).toLowerCase(), displayName || address, Number(backfillDays) || 30, ctx.user!.id],
	);
	await audit(ctx, 'mailbox.added', 'mailbox', row.id, { address, provider: 'microsoft_app' });
	return row;
});

r.patch('/api/mailboxes/:id', async (ctx) => {
	requireRole(ctx.user, 'admin');
	const { status, displayName, backfillDays, resetSync } = ctx.body || {};
	if (status && !['active', 'paused'].includes(status)) throw new HttpError(400, 'Invalid status');
	await q(
		`update mailboxes set status=coalesce($3,status), display_name=coalesce($4,display_name), backfill_days=coalesce($5,backfill_days),
		   sync_state = case when $6 then '{}'::jsonb else sync_state end where id=$1 and org_id=$2`,
		[Number(ctx.params.id), ctx.user!.orgId, status ?? null, displayName ?? null, backfillDays ?? null, !!resetSync],
	);
	await audit(ctx, 'mailbox.updated', 'mailbox', ctx.params.id, ctx.body);
	return { success: true };
});

r.del('/api/mailboxes/:id', async (ctx) => {
	requireRole(ctx.user, 'admin');
	const id = Number(ctx.params.id);
	const purge = ctx.query.get('purge') === 'true';
	if (purge) {
		await q(`delete from conversations c where c.org_id=$2 and c.mailbox_ids = array[$1::bigint]`, [id, ctx.user!.orgId]);
	}
	await q('delete from mailboxes where id=$1 and org_id=$2', [id, ctx.user!.orgId]);
	await audit(ctx, 'mailbox.removed', 'mailbox', id, { purge });
	return { success: true };
});

async function kickWorker(mailboxId?: number) {
	// On Netlify, hand off to the background function (15 min budget); locally run inline.
	const base = process.env.URL;
	const secret = process.env.INTERNAL_API_SECRET;
	if (base && secret && process.env.NETLIFY) {
		await fetch(`${base}/.netlify/functions/worker-background`, {
			method: 'POST',
			headers: { 'x-remail-secret': secret, 'content-type': 'application/json' },
			body: JSON.stringify({ mailboxId }),
		}).catch((e) => console.error('[kick]', e.message));
		return { queued: true };
	}
	return { queued: false, result: await runTick({ mailboxId, budgetMs: 8 * 60_000, reports: false }) };
}

r.post('/api/mailboxes/:id/sync', async (ctx) => {
	requireRole(ctx.user, 'manager');
	const id = Number(ctx.params.id);
	await audit(ctx, 'mailbox.sync_requested', 'mailbox', id);
	return kickWorker(id);
});

r.post('/api/system/run', async (ctx) => {
	requireRole(ctx.user, 'manager');
	await audit(ctx, 'system.run_requested', null, null);
	return kickWorker();
});

r.post('/api/connect/:provider/start', async (ctx) => {
	// anyone who works email can connect their own mailbox (individual view); org mailboxes need admin
	requireRole(ctx.user, 'analyst');
	const provider = ctx.params.provider;
	const state = randomToken(24);
	const redirectUri = `${appUrl()}/api/connect/${provider}/callback`;
	await q('insert into oauth_states (state, user_id, provider, payload) values ($1,$2,$3,$4)', [
		state, ctx.user!.id, provider, JSON.stringify({ backfillDays: Number(ctx.body?.backfillDays) || 30 }),
	]);
	if (provider === 'microsoft') {
		if (!microsoftConfigured()) throw new HttpError(400, 'Microsoft app registration is not configured');
		return { url: microsoftAuthorizeUrl(state, redirectUri) };
	}
	if (provider === 'google') {
		if (!googleConfigured()) throw new HttpError(400, 'Google OAuth client is not configured');
		return { url: googleAuthorizeUrl(state, redirectUri) };
	}
	throw new HttpError(400, 'Unknown provider');
});

r.get('/api/connect/:provider/callback', async (ctx) => {
	const provider = ctx.params.provider;
	const state = ctx.query.get('state') || '';
	const code = ctx.query.get('code') || '';
	const st = await one<any>(`delete from oauth_states where state=$1 and provider=$2 and created_at > now() - interval '15 minutes' returning *`, [state, provider]);
	const back = (msg: string, ok: boolean) => redirect(`${appUrl()}/admin/mailboxes?${ok ? 'connected' : 'error'}=${encodeURIComponent(msg)}`);
	if (!st) return back('The connection request expired. Please try again.', false);
	if (ctx.query.get('error')) return back(ctx.query.get('error_description') || ctx.query.get('error')!, false);
	const user = await one<any>('select * from users where id=$1', [st.user_id]);
	try {
		const redirectUri = `${appUrl()}/api/connect/${provider}/callback`;
		const res = provider === 'microsoft' ? await microsoftExchangeCode(code, redirectUri) : await googleExchangeCode(code, redirectUri);
		const prov = provider === 'microsoft' ? 'microsoft' : 'gmail';
		const mb = await one<any>(
			`insert into mailboxes (org_id, provider, address, display_name, credentials_enc, backfill_days, created_by, status)
			 values ($1,$2,$3,$4,$5,$6,$7,'active')
			 on conflict (org_id, provider, lower(address)) do update set credentials_enc=excluded.credentials_enc, status='active', last_error=null
			 returning *`,
			[user.org_id, prov, res.address, res.displayName || res.address, res.credentials, st.payload?.backfillDays || 30, user.id],
		);
		// personal mailbox: the person who connected it always sees it
		await q('insert into user_mailboxes (user_id, mailbox_id) values ($1,$2) on conflict do nothing', [user.id, mb.id]);
		if (res.address !== String(user.email).toLowerCase()) {
			await q(`update users set email_aliases = (select array(select distinct unnest(email_aliases || array[$2::text]))) where id=$1`, [user.id, res.address]);
		}
		await audit({ ...ctx, user: undefined }, 'mailbox.connected', 'mailbox', mb.id, { provider: prov, address: res.address }, user);
		kickWorker(mb.id).catch(() => {});
		return back(res.address, true);
	} catch (e: any) {
		console.error('[connect]', e.message);
		return back(e.message, false);
	}
}, { auth: 'public' });

r.post('/api/mailboxes/upload', async (ctx) => {
	requireRole(ctx.user, 'manager');
	const files: { name: string; content: string; folder?: 'inbox' | 'sent' }[] = ctx.body?.files || [];
	if (!files.length) throw new HttpError(400, 'No files');
	const org = await getOrg(ctx.user!.orgId);
	const address = String(ctx.body?.mailbox || 'uploads@remail.local').toLowerCase();
	const mb = await one<MailboxRow>(
		`insert into mailboxes (org_id, provider, address, display_name, created_by) values ($1,'upload',$2,$3,$4)
		 on conflict (org_id, provider, lower(address)) do update set status='active' returning *`,
		[org.id, address, ctx.body?.displayName || 'Imported email', ctx.user!.id],
	);
	const msgs = [];
	for (const f of files.slice(0, 200)) {
		try {
			msgs.push(await parseEml(Buffer.from(f.content, 'base64'), f.folder || 'inbox'));
		} catch (e: any) {
			console.error('[upload] parse', f.name, e.message);
		}
	}
	const res = await ingestMessages(org, mb!, msgs);
	await q('update mailboxes set last_synced_at=now(), messages_synced=messages_synced+$2 where id=$1', [mb!.id, res.inserted + res.duplicates]);
	const analysed = await analysePending(org.id, 30, Date.now() + 20_000);
	await audit(ctx, 'mailbox.upload', 'mailbox', mb!.id, { files: files.length, inserted: res.inserted, duplicates: res.duplicates });
	return { parsed: msgs.length, inserted: res.inserted, duplicates: res.duplicates, skipped: res.skipped, analysed };
});

// ── Users ───────────────────────────────────────────────────────────────────
r.get('/api/users', async (ctx) => {
	requireRole(ctx.user, 'manager');
	return {
		rows: await q(
			`select u.id, u.email, u.full_name, u.role, u.auth_provider, u.is_active, u.all_mailboxes, u.last_login_at, u.created_at, u.email_aliases,
			        coalesce((select array_agg(mailbox_id) from user_mailboxes um where um.user_id=u.id), '{}') as mailbox_ids
			   from users u where u.org_id=$1 order by u.full_name`,
			[ctx.user!.orgId],
		),
	};
});

r.post('/api/users', async (ctx) => {
	requireRole(ctx.user, 'admin');
	const { email, fullName, role, mailboxIds, allMailboxes } = ctx.body || {};
	if (!/^[^@\s]+@[^@\s]+$/.test(String(email || ''))) throw new HttpError(400, 'Enter a valid email');
	if (!ROLE_RANK[role as Role]) throw new HttpError(400, 'Invalid role');
	const exists = await one('select id from users where lower(email)=lower($1)', [email]);
	if (exists) throw new HttpError(409, 'A user with this email already exists');
	const provider = ['ravity', 'microsoft'].includes(ctx.body?.authProvider) ? ctx.body.authProvider : 'local';
	const u = await one<any>(
		`insert into users (org_id, email, full_name, role, auth_provider, all_mailboxes) values ($1,$2,$3,$4,$5,$6) returning *`,
		[ctx.user!.orgId, String(email).toLowerCase(), fullName || email, role, provider, !!allMailboxes || role === 'admin' || role === 'manager'],
	);
	for (const m of mailboxIds || []) await q('insert into user_mailboxes values ($1,$2) on conflict do nothing', [u.id, Number(m)]);
	let inviteLink: string | null = null;
	if (provider === 'local') {
		const token = await createResetToken(u.id);
		inviteLink = `${appUrl()}/auth/reset-password?token=${token}&invite=1`;
		const org = await getOrg(ctx.user!.orgId);
		await sendEmail([u.email], `You have been invited to remail`, emailLayout('Welcome to remail', `<p style="font-size:14px">${esc(ctx.user!.fullName)} has invited you to remail, the AI email intelligence workspace for ${esc(org.name)}.</p><p><a href="${inviteLink}" style="display:inline-block;background:#F00D69;color:#fff;text-decoration:none;padding:10px 18px;border-radius:10px;font-weight:700">Set your password</a></p><p style="font-size:12px;color:#5b6180">This link is valid for one hour. Ask your administrator for a new link if it expires.</p>`)).catch(() => {});
	}
	await audit(ctx, 'user.created', 'user', u.id, { email, role, provider });
	return { user: publicUser(u), inviteLink };
});

r.patch('/api/users/:id', async (ctx) => {
	requireRole(ctx.user, 'admin');
	const id = Number(ctx.params.id);
	const { role, isActive, fullName, mailboxIds, allMailboxes, emailAliases } = ctx.body || {};
	if (Array.isArray(emailAliases)) await q('update users set email_aliases=$2 where id=$1 and org_id=$3', [id, emailAliases.map((x: string) => String(x).trim().toLowerCase()).filter((x: string) => /@/.test(x)), ctx.user!.orgId]);
	if (role && !ROLE_RANK[role as Role]) throw new HttpError(400, 'Invalid role');
	if (id === ctx.user!.id && (role && role !== 'admin' || isActive === false)) throw new HttpError(400, 'You cannot demote or disable your own account');
	await q(
		`update users set role=coalesce($3,role), is_active=coalesce($4,is_active), full_name=coalesce($5,full_name),
		   all_mailboxes=coalesce($6,all_mailboxes), updated_at=now() where id=$1 and org_id=$2`,
		[id, ctx.user!.orgId, role ?? null, typeof isActive === 'boolean' ? isActive : null, fullName ?? null, typeof allMailboxes === 'boolean' ? allMailboxes : null],
	);
	if (Array.isArray(mailboxIds)) {
		await q('delete from user_mailboxes where user_id=$1', [id]);
		for (const m of mailboxIds) await q('insert into user_mailboxes values ($1,$2) on conflict do nothing', [id, Number(m)]);
	}
	if (isActive === false) await q('update sessions set revoked_at=now() where user_id=$1 and revoked_at is null', [id]);
	await audit(ctx, 'user.updated', 'user', id, ctx.body);
	return { success: true };
});

r.post('/api/users/:id/reset-link', async (ctx) => {
	requireRole(ctx.user, 'admin');
	const id = Number(ctx.params.id);
	const u = await one<any>('select * from users where id=$1 and org_id=$2', [id, ctx.user!.orgId]);
	if (!u) throw new HttpError(404, 'User not found');
	const token = await createResetToken(id);
	await audit(ctx, 'user.reset_link_created', 'user', id);
	return { link: `${appUrl()}/auth/reset-password?token=${token}` };
});

// ── Settings, system, audit ─────────────────────────────────────────────────
r.get('/api/settings', async (ctx) => {
	const org = await getOrg(ctx.user!.orgId, true);
	return { name: org.name, internalDomains: org.internalDomains, settings: org.settings };
});

r.patch('/api/settings', async (ctx) => {
	requireRole(ctx.user, 'admin');
	const { name, internalDomains, settings } = ctx.body || {};
	const cur = await getOrg(ctx.user!.orgId, true);
	const next = { ...cur.settings };
	if (settings) {
		if (settings.slaHours !== undefined) next.slaHours = Math.max(1, Math.min(168, Number(settings.slaHours)));
		if (settings.piiRedaction !== undefined) next.piiRedaction = !!settings.piiRedaction;
		if (settings.retentionDays !== undefined) next.retentionDays = Math.max(30, Math.min(3650, Number(settings.retentionDays)));
		if (settings.analysisWindowDays !== undefined) next.analysisWindowDays = Math.max(7, Math.min(180, Number(settings.analysisWindowDays)));
		if (settings.ignoreAutomated !== undefined) next.ignoreAutomated = !!settings.ignoreAutomated;
	}
	await q(`update organisations set name=coalesce($2,name), internal_domains=coalesce($3,internal_domains), settings=$4 where id=$1`, [
		ctx.user!.orgId, name ?? null,
		Array.isArray(internalDomains) ? internalDomains.map((d: string) => d.trim().toLowerCase()).filter(Boolean) : null,
		JSON.stringify(next),
	]);
	invalidateOrg(ctx.user!.orgId);
	await audit(ctx, 'settings.updated', 'organisation', ctx.user!.orgId, ctx.body);
	return { success: true };
});

r.get('/api/system/status', async (ctx) => {
	const [pending, mb, usage, lastRun] = await Promise.all([
		one<any>('select count(*)::int n from conversations where org_id=$1 and needs_analysis', [ctx.user!.orgId]),
		one<any>(`select count(*)::int total, count(*) filter (where status='error')::int errors, max(last_synced_at) last_synced from mailboxes where org_id=$1`, [ctx.user!.orgId]),
		one<any>(`select coalesce(sum(input_tokens),0)::int input_tokens, coalesce(sum(output_tokens),0)::int output_tokens, count(*)::int calls from ai_usage where org_id=$1 and created_at > date_trunc('month', now())`, [ctx.user!.orgId]),
		one<any>('select max(finished_at) t from sync_runs'),
	]);
	return {
		ai: { provider: aiProvider(), model: aiModel() },
		mailer: mailerProvider(),
		auth: authMode(),
		connectors: await providerStatus(ctx.user!.orgId),
		ravity: ravityConfigured(),
		microsoftSso: microsoftSsoEnabled(),
		webhooks: { teams: !!process.env.TEAMS_WEBHOOK_URL, slack: !!process.env.SLACK_WEBHOOK_URL },
		pendingAnalysis: pending?.n || 0,
		mailboxes: mb,
		aiUsageThisMonth: usage,
		lastWorkerRun: lastRun?.t,
	};
});

r.post('/api/system/demo', async (ctx) => {
	requireRole(ctx.user, 'admin');
	const res = await loadDemoData(ctx.user!.orgId, ctx.user!.id);
	const analysed = await analysePending(ctx.user!.orgId, 400, Date.now() + 18_000);
	await q(`update action_items a set status='done', completed_at=now() from conversations c
	         where c.id=a.conversation_id and c.status='resolved' and a.status='open' and (not a.is_commitment or c.last_message_at < now() - interval '10 days')`);
	await backfillHealthHistory(ctx.user!.orgId, 45);
	await audit(ctx, 'system.demo_loaded', null, null, res);
	return { ...res, analysed };
});
r.del('/api/system/demo', async (ctx) => {
	requireRole(ctx.user, 'admin');
	await clearDemoData(ctx.user!.orgId);
	await audit(ctx, 'system.demo_cleared', null, null);
	return { success: true };
});

r.get('/api/audit', async (ctx) => {
	requireRole(ctx.user, 'admin');
	const params: unknown[] = [ctx.user!.orgId];
	let where = '(a.org_id=$1 or a.org_id is null)';
	const action = ctx.query.get('action');
	if (action) { params.push(`${action}%`); where += ` and a.action like $${params.length}`; }
	const userQ = ctx.query.get('user');
	if (userQ) { params.push(`%${userQ}%`); where += ` and a.user_email ilike $${params.length}`; }
	const offset = intParam(ctx.query.get('offset'), 0)!;
	return {
		rows: await q(`select a.* from audit_log a where ${where} order by a.created_at desc limit 200 offset ${offset}`, params),
	};
});

// Internal: scheduled/background worker trigger
r.post('/api/internal/tick', async (ctx) => {
	const secret = process.env.INTERNAL_API_SECRET || '';
	if (!secret || !safeEqual(ctx.req.headers.get('x-remail-secret') || '', secret)) throw new HttpError(401, 'Unauthorised');
	return runTick({ budgetMs: Number(ctx.body?.budgetMs) || 60_000 });
}, { auth: 'public' });

/**
 * Setup check — works even when the database is not configured. Reports which settings are
 * present (never their values) and whether the database is reachable.
 */
async function setupCheck() {
	const has = (k: string) => !!process.env[k];
	const checks: Record<string, { ok: boolean; detail: string }> = {};
	const netlifyDb = !!(globalThis as any).Netlify?.env?.get?.('NETLIFY_DB_URL');
	const dbVar = ['DATABASE_URL', 'NETLIFY_DB_URL', 'NETLIFY_DATABASE_URL', 'NETLIFY_DATABASE_URL_UNPOOLED'].find(has) || (netlifyDb ? 'NETLIFY_DB_URL' : undefined);
	checks.database_variable = { ok: !!dbVar, detail: dbVar ? `using ${dbVar}` : 'Missing: in Netlify open Data & Storage → Database → Create a database, or set DATABASE_URL to a Neon connection string' };
	if (dbVar) {
		try {
			await Promise.race([q('select 1'), new Promise((_, rej) => setTimeout(() => rej(new Error('timed out after 8s')), 8000))]);
			checks.database_connection = { ok: true, detail: 'connected' };
			try {
				await ensureSchema();
				const u = await one<any>('select count(*)::int n from users');
				checks.database_tables = { ok: true, detail: `ready · ${u?.n ?? 0} user(s)` };
			} catch (e: any) {
				checks.database_tables = { ok: false, detail: `migration failed: ${e.message}`.slice(0, 200) };
			}
		} catch (e: any) {
			checks.database_connection = { ok: false, detail: `cannot connect: ${e.message}`.slice(0, 200) };
		}
	}
	checks.JWT_SECRET = { ok: (process.env.JWT_SECRET || '').length >= 32, detail: has('JWT_SECRET') ? ((process.env.JWT_SECRET || '').length >= 32 ? 'set' : 'too short: needs 32+ characters') : 'Missing' };
	checks.ENCRYPTION_KEY = { ok: has('ENCRYPTION_KEY'), detail: has('ENCRYPTION_KEY') ? 'set' : 'Missing (needed to connect mailboxes)' };
	checks.INTERNAL_API_SECRET = { ok: has('INTERNAL_API_SECRET'), detail: has('INTERNAL_API_SECRET') ? 'set' : 'Missing (needed for background sync)' };
	checks.ADMIN_EMAIL_and_PASSWORD = { ok: has('ADMIN_EMAIL') && has('ADMIN_PASSWORD'), detail: has('ADMIN_EMAIL') && has('ADMIN_PASSWORD') ? `admin: ${process.env.ADMIN_EMAIL}` : 'Missing ADMIN_EMAIL or ADMIN_PASSWORD' };
	if (has('ADMIN_PASSWORD')) {
		const pw = process.env.ADMIN_PASSWORD || '';
		checks.ADMIN_PASSWORD_strength = { ok: pw.length >= 10 && /[A-Za-z]/.test(pw) && /\d/.test(pw), detail: pw.length >= 10 ? 'ok' : 'shorter than 10 characters' };
	}
	checks.microsoft_sign_in = { ok: has('MS_CLIENT_ID') && has('MS_CLIENT_SECRET'), detail: has('MS_CLIENT_ID') && has('MS_CLIENT_SECRET') ? 'enabled' : 'optional: MS_CLIENT_ID / MS_CLIENT_SECRET not set' };
	checks.ai = { ok: true, detail: `${aiProvider()} · ${aiModel()}` };
	checks.site_url = { ok: true, detail: appUrl() };
	const ok = Object.entries(checks).every(([k, v]) => v.ok || k === 'microsoft_sign_in');
	return { ok, time: new Date().toISOString(), checks };
}

r.get('/api/health', async () => setupCheck(), { auth: 'public' });

// ── Entry point ─────────────────────────────────────────────────────────────
export async function handle(req: Request): Promise<Response> {
	const url = new URL(req.url);
	const pathname = url.pathname.replace(/^\/\.netlify\/functions\/api/, '/api').replace(/\/$/, '');
	const m = r.match(req.method, pathname);
	if (!m) return json({ error: 'Not found' }, 404);
	if (pathname === '/api/health') {
		try { return json(await setupCheck()); } catch (e: any) { return json({ ok: false, error: e.message }, 500); }
	}
	const ctx: Ctx = {
		req,
		url,
		method: req.method,
		params: m.params,
		query: url.searchParams,
		body: undefined,
		ip: (req.headers.get('x-nf-client-connection-ip') || req.headers.get('x-forwarded-for') || '').split(',')[0].trim(),
		ua: req.headers.get('user-agent') || '',
	};
	try {
		await ensureSchema();
		await defaultOrgId();
		if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
			const text = await req.text();
			if (text.length > 25_000_000) throw new HttpError(413, 'Request too large');
			ctx.body = text ? JSON.parse(text) : {};
		}
		if (m.route.auth === 'user') ctx.user = await authenticate(ctx);
		if (m.route.roles && !m.route.roles.includes(ctx.user!.role)) throw new HttpError(403, 'Forbidden');
		const out = await m.route.handler(ctx);
		return out instanceof Response ? out : json(out ?? { success: true });
	} catch (e: any) {
		if (e instanceof HttpError) return json({ error: e.message, details: e.details }, e.status);
		if (e instanceof SyntaxError) return json({ error: 'Invalid JSON body' }, 400);
		console.error('[api]', req.method, pathname, e);
		// Setup problems are shown plainly so they can be fixed from the Netlify dashboard
		const msg = String(e?.message || '');
		if (/DATABASE_URL|JWT_SECRET|ENCRYPTION_KEY|ECONNREFUSED|ENOTFOUND|password authentication failed|getaddrinfo|SSL|timeout/i.test(msg)) {
			return json({ error: `Server setup issue: ${msg.slice(0, 200)}. Open /api/health for a full setup check.` }, 503);
		}
		return json({ error: 'Something went wrong. Please try again.' }, 500);
	}
}
