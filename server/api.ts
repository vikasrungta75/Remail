import { ensureSchema, one, q } from './db';
import { HttpError, Router, intParam, json, redirect, type Ctx } from './http';
import {
	authenticate, authMode, consumeResetToken, createResetToken, defaultOrgId, hashPassword, login, logout,
	mailboxScope, publicUser, requireRole, verifyPassword, ROLE_RANK, type Role,
	ravityConfigured, ravityForgotPassword, ravityResetPassword, microsoftSsoEnabled, loginWithMicrosoft, loginWithGoogle,
} from './auth';
import { categoriesOverview, categoryReport, myDay, proposals, team } from './views';
import { audit } from './audit';
import { convFilter, dashboardSummary, dashboardTrends, filterOptions, insights } from './queries';
import { getOrg, invalidateOrg } from './settings';
import { encrypt, randomToken, safeEqual } from './crypto';
import {
	microsoftAuthorizeUrl, microsoftConfigured, microsoftExchangeCode, microsoftAdminConsentUrl, microsoftSignIn,
	microsoftTestMailbox, orgTenant, msSigninScopes,
	microsoftSendEnabled,
} from './connectors/microsoft';
import { googleAuthorizeUrl, googleConfigured, googleExchangeCode, googleSsoEnabled, googleSigninConnectsMailbox, googleSigninScopes, googleSignIn, googleTestMailbox, serviceAccount, workspaceConfigured, GMAIL_READONLY, GMAIL_SEND, gmailSendEnabled, loadServiceAccount, parseServiceAccount } from './connectors/gmail';
import { parseEml } from './connectors/upload';
import { ingestMessages } from './ingest';
import { analyseConversation, analysePending, backfillHealthHistory, updateCustomerHealth } from './analyze';
import { runTick, syncMailbox } from './worker';
import { aiModel, aiProvider } from './ai/llm';
import { appUrl, emailLayout, esc, mailerProvider, sendEmail } from './mailer';
import { buildReport, runSchedule } from './reports';
import { ask, SUGGESTED_QUESTIONS } from './copilot';
import { loadDemoData, clearDemoData, demoEnabled } from './demo';
import { enrichCustomer } from './enrich';
import { branches as branchList, headOffice, footerForConversation } from './branding';
import { buildProfile, listCustomerDb, merged as mergedProfile, updateProfile } from './profiles';
import { listTemplates, resetTemplate, updateTemplate } from './templates';
import { deleteReference, importCsv, listReference, matchReference, TEMPLATES_CSV, type RefKind } from './reference';
import { normaliseSubcategory, subgroupOf, taxonomyTree } from './ai/taxonomy';
import { dismissDraft, fillDraft, getDraft, getDraftForConversation, listDrafts, saveDraft, sendDraft } from './drafts';
import { BUSINESS_CATEGORIES, BUSINESS_LABELS, CATEGORIES, CATEGORY_LABELS, PROPOSAL_STAGES, type BusinessCategory } from './ai/types';
import type { MailboxRow } from './connectors/types';

const r = new Router();

// ── Auth ────────────────────────────────────────────────────────────────────
r.get('/api/auth/config', async () => ({
	mode: authMode(),
	ravity: ravityConfigured(),
	microsoft: microsoftSsoEnabled(),
	microsoftConnectsMailbox: microsoftSsoEnabled() && process.env.MS_SIGNIN_CONNECTS_MAILBOX !== 'false',
	google: googleSsoEnabled(),
	googleConnectsMailbox: googleSsoEnabled() && googleSigninConnectsMailbox(),
	orgName: (await getOrg(await defaultOrgId())).name,
}), { auth: 'public' });

// Sign in with Google (Google Workspace account). Also connects the person's own inbox, read-only.
r.post('/api/auth/google/start', async (ctx) => {
	if (!googleSsoEnabled()) throw new HttpError(400, 'Google sign-in is not configured');
	const state = randomToken(24);
	await q('insert into oauth_states (state, provider) values ($1, $2)', [state, 'google_signin']);
	return { url: googleAuthorizeUrl(state, `${appUrl()}/api/auth/google/callback`, { scope: googleSigninScopes(), prompt: 'select_account' }) };
}, { auth: 'public' });

r.get('/api/auth/google/callback', async (ctx) => {
	const fail = (m: string) => redirect(`${appUrl()}/auth/login?error=${encodeURIComponent(m)}`);
	const st = await one<any>(`delete from oauth_states where state=$1 and provider='google_signin' and created_at > now() - interval '15 minutes' returning *`, [ctx.query.get('state') || '']);
	if (!st) return fail('The sign-in request expired. Please try again.');
	if (ctx.query.get('error')) return fail(ctx.query.get('error') === 'access_denied' ? 'Sign-in was cancelled.' : ctx.query.get('error')!);
	const redirectUri = `${appUrl()}/api/auth/google/callback`;
	try {
		const g = await googleSignIn(ctx.query.get('code') || '', redirectUri);
		const res = await loginWithGoogle(ctx, g);
		const user = await one<any>('select * from users where lower(email)=$1 or google_sub=$2 limit 1', [g.email, g.sub]);
		if (user && googleSigninConnectsMailbox()) {
			if (g.credentials) {
				try {
					await connectPersonalMailbox(ctx, user, 'gmail', { address: g.email, displayName: g.fullName, credentials: g.credentials }, Number(process.env.SIGNIN_BACKFILL_DAYS || (await getOrg(user.org_id)).settings.defaultBackfillDays || 90), false);
				} catch (e: any) {
					console.error('[sso] mailbox connect', e.message);
				}
			} else {
				// Google only returns a refresh token on first consent: ask once more if this inbox is not yet connected
				const mb = await one<any>(`select id from mailboxes where org_id=$1 and provider='gmail' and lower(address)=$2 and credentials_enc is not null`, [user.org_id, g.email]);
				if (!mb && !st.payload?.consentRetry) {
					const s2 = randomToken(24);
					await q('insert into oauth_states (state, provider, payload) values ($1,$2,$3)', [s2, 'google_signin', JSON.stringify({ consentRetry: true })]);
					return redirect(googleAuthorizeUrl(s2, redirectUri, { scope: googleSigninScopes(), prompt: 'consent', loginHint: g.email }));
				}
			}
		}
		return redirect(`${appUrl()}/auth/sso#token=${encodeURIComponent(res.token)}&loginTime=${encodeURIComponent(res.loginTime)}`);
	} catch (e: any) {
		console.error('[sso google]', e.message);
		return fail(e instanceof HttpError ? e.message : 'Google sign-in failed. Please try again.');
	}
}, { auth: 'public' });

// Sign in with Microsoft (Office 365 work account)
r.post('/api/auth/microsoft/start', async () => {
	if (!microsoftSsoEnabled()) throw new HttpError(400, 'Microsoft sign-in is not configured');
	const state = randomToken(24);
	await q('insert into oauth_states (state, provider) values ($1, $2)', [state, 'ms_signin']);
	return { url: microsoftAuthorizeUrl(state, `${appUrl()}/api/auth/microsoft/callback`, msSigninScopes(), 'select_account') };
}, { auth: 'public' });

r.get('/api/auth/microsoft/callback', async (ctx) => {
	const fail = (m: string) => redirect(`${appUrl()}/auth/login?error=${encodeURIComponent(m)}`);
	const st = await one<any>(`delete from oauth_states where state=$1 and provider='ms_signin' and created_at > now() - interval '15 minutes' returning *`, [ctx.query.get('state') || '']);
	if (!st) return fail('The sign-in request expired. Please try again.');
	if (ctx.query.get('error')) return fail(ctx.query.get('error_description') || ctx.query.get('error')!);
	try {
		const ms = await microsoftSignIn(ctx.query.get('code') || '', `${appUrl()}/api/auth/microsoft/callback`);
		const res = await loginWithMicrosoft(ctx, ms);
		if (ms.credentials) {
			// signing in also connects (or refreshes) the person's own inbox, read-only
			try {
				const user = await one<any>('select * from users where lower(email)=$1 or ms_object_id=$2 limit 1', [ms.email, ms.objectId]);
				if (user) await connectPersonalMailbox(ctx, user, 'microsoft', { address: ms.email, displayName: ms.fullName, credentials: ms.credentials }, Number(process.env.SIGNIN_BACKFILL_DAYS || 90), false);
			} catch (e: any) {
				console.error('[sso] mailbox connect', e.message);
			}
		}
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
			        c.business_category, c.subcategory, c.proposal_stage, c.is_internal, c.is_automated,
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
		`select c.id, c.business_category as type, c.subcategory as subtype, cu.name as customer, cu.tier, c.subject, c.rag, c.sentiment, c.urgency, c.escalation_risk, c.status,
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
	const { status, assigneeId, businessCategory, subcategory, proposalStage } = ctx.body || {};
	if (status && !['open', 'in_progress', 'resolved', 'ignored'].includes(status)) throw new HttpError(400, 'Invalid status');
	if (businessCategory) {
		if (!(BUSINESS_CATEGORIES as readonly string[]).includes(businessCategory)) throw new HttpError(400, 'Invalid category');
		await q('update conversations set business_category=$2, category_locked=true where id=$1', [id, businessCategory]);
	}
	if (subcategory) {
		const cur = await one<any>('select business_category from conversations where id=$1', [id]);
		const group = (businessCategory || cur?.business_category || 'other') as BusinessCategory;
		if (!subgroupOf(group, subcategory)) throw new HttpError(400, 'That subgroup does not belong to the group');
		await q('update conversations set subcategory=$2, subcategory_locked=true where id=$1', [id, subcategory]);
	} else if (businessCategory) {
		const cur = await one<any>('select subcategory from conversations where id=$1', [id]);
		if (!subgroupOf(businessCategory, cur?.subcategory)) await q('update conversations set subcategory=$2 where id=$1', [id, normaliseSubcategory(businessCategory, '')]);
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

// ── Reply drafts: stay in the app until a person presses Send ─────────────
r.get('/api/drafts', async (ctx) => {
	const qs = new URLSearchParams(ctx.query);
	if (!qs.get('audience')) qs.set('audience', 'all');
	const status = ['draft', 'sent', 'dismissed', 'replied_elsewhere'].includes(ctx.query.get('status') || '') ? ctx.query.get('status')! : 'draft';
	const add = (w: { where: string[]; params: unknown[] }, sql: (n: string) => string, v: unknown) => { w.params.push(v); w.where.push(sql(`$${w.params.length}`)); };
	// counts beside the quick filters (rating, received, status) ignore those filters, so they show what each choice would give
	const noQuick = new URLSearchParams(qs);
	noQuick.delete('rag');
	const fq = await convFilter(ctx.user!, noQuick, { ignoreDates: true });
	const base = { where: [...fq.where], params: [...fq.params] };
	const f = await convFilter(ctx.user!, qs, { ignoreDates: true });
	const waited = Number(ctx.query.get('waitingDays'));
	if (waited > 0) add(f, (n) => `c.last_inbound_at > now() - make_interval(days => ${n}::int)`, waited);
	const urg = (ctx.query.get('urgency') || '').split(',').filter((u) => ['low', 'medium', 'high', 'critical'].includes(u));
	if (urg.length) add(f, (n) => `c.urgency = any(${n})`, urg);
	const ready = ctx.query.get('ready');
	if (ready === 'yes') f.where.push(`d.body !~* '\\[\\[\\s*provide\\s*:'`);
	if (ready === 'no') f.where.push(`d.body ~* '\\[\\[\\s*provide\\s*:'`);
	const text = (ctx.query.get('q') || '').trim();
	const search = (n: string) => `(c.subject ilike ${n} or d.body ilike ${n} or exists (select 1 from customers k where k.id=c.customer_id and k.name ilike ${n}) or exists (select 1 from unnest(d.to_addresses) a where a ilike ${n}))`;
	if (text) { add(f, search, `%${text}%`); add(fq, search, `%${text}%`); }
	const sort = ctx.query.get('sort') || 'priority';
	const rows = await listDrafts(f.where.join(' and '), f.params, status, sort);
	const total = await one<any>(`select count(*)::int n from reply_drafts d join conversations c on c.id=d.conversation_id where ${f.where.join(' and ')} and d.status=$${f.params.length + 1}`, [...f.params, status]);
	const counts = await one<any>(
		`select count(*) filter (where d.status='draft')::int as draft, count(*) filter (where d.status='sent' and d.sent_at > now() - interval '7 days')::int as sent_week,
		        count(*) filter (where d.status='sent')::int as sent
		   from reply_drafts d join conversations c on c.id=d.conversation_id where ${base.where.join(' and ')}`,
		base.params,
	);
	const facets = await one<any>(
		`select count(*)::int as total,
		        count(*) filter (where d.body !~* '\\[\\[\\s*provide\\s*:')::int as ready,
		        count(*) filter (where c.rag='red')::int as red, count(*) filter (where c.rag='amber')::int as amber, count(*) filter (where c.rag='green')::int as green,
		        count(*) filter (where c.last_inbound_at > now() - interval '1 day')::int as today,
		        count(*) filter (where c.last_inbound_at > now() - interval '7 days')::int as week,
		        count(*) filter (where c.last_inbound_at <= now() - interval '30 days')::int as older
		   from reply_drafts d join conversations c on c.id=d.conversation_id
		  where ${fq.where.join(' and ')} and d.status='draft'`,
		fq.params,
	);
	const byGroup = await q<any>(
		`select c.business_category as k, count(*)::int as n from reply_drafts d join conversations c on c.id=d.conversation_id
		  where ${fq.where.join(' and ')} and d.status='draft' group by 1 order by 2 desc`,
		fq.params,
	);
	return { rows, total: total?.n || 0, counts, facets: { ...facets, groups: byGroup } };
});
r.get('/api/conversations/:id/draft', async (ctx) => {
	const id = Number(ctx.params.id);
	await assertConversationAccess(ctx, id);
	return { draft: await getDraftForConversation(id, ctx.user!.orgId) };
});
async function draftAccess(ctx: Ctx) {
	const d = await getDraft(Number(ctx.params.id), ctx.user!.orgId);
	if (!d) throw new HttpError(404, 'Draft not found');
	await assertConversationAccess(ctx, d.conversation_id);
	return d;
}
r.put('/api/drafts/:id', async (ctx) => {
	requireRole(ctx.user, 'analyst');
	await draftAccess(ctx);
	return saveDraft(ctx.user!, Number(ctx.params.id), ctx.body || {});
});
r.post('/api/drafts/:id/send', async (ctx) => {
	requireRole(ctx.user, 'analyst');
	const d = await draftAccess(ctx);
	const res = await sendDraft(ctx, ctx.user!, d.id, ctx.body || {});
	kickWorker(res.mailboxId).catch(() => {}); // pull the sent message into the thread
	return res;
});
r.post('/api/drafts/:id/fill', async (ctx) => {
	requireRole(ctx.user, 'analyst');
	const d = await draftAccess(ctx);
	const res = await fillDraft(ctx.user!, d.id, ctx.body?.answers || [], ctx.body?.rewrite !== false);
	await audit(ctx, 'reply.filled', 'reply_draft', d.id, { filled: res.filled, remaining: res.remaining, how: res.how });
	return res;
});
r.get('/api/drafts/:id/footer', async (ctx) => {
	const d = await draftAccess(ctx);
	return { footer: await footerForConversation(ctx.user!.orgId, d.conversation_id) };
});
r.post('/api/drafts/:id/dismiss', async (ctx) => {
	requireRole(ctx.user, 'analyst');
	const d = await draftAccess(ctx);
	return dismissDraft(ctx, ctx.user!, d.id);
});
r.post('/api/drafts/:id/regenerate', async (ctx) => {
	requireRole(ctx.user, 'analyst');
	const d = await draftAccess(ctx);
	await q(`update reply_drafts set edited=false, status='draft', reply_to_email_id=null where id=$1`, [d.id]);
	await analyseConversation(d.conversation_id);
	return getDraft(d.id, ctx.user!.orgId);
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
r.get('/api/views/category-report', (ctx) => categoryReport(ctx.user!, ctx.query));
r.get('/api/views/category-report.csv', async (ctx) => {
	const rep = await categoryReport(ctx.user!, ctx.query);
	const cols = ['group', 'subgroup', 'conversations', 'emails', 'awaiting', 'overdue_replies', 'negative', 'red', 'drafts_waiting', 'avg_first_response_hours'];
	const cell = (v: any) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
	const lines = [cols.join(',')];
	for (const g of rep.groups) for (const sg of g.subgroups) lines.push([g.label, sg.label, sg.conversations, sg.emails, sg.awaiting, sg.overdue_replies, sg.negative, sg.red, sg.drafts_waiting, sg.avg_first_response_hours].map(cell).join(','));
	await audit(ctx, 'export.category_report', 'conversation', null, { from: rep.from, to: rep.to });
	return new Response(lines.join('\n'), {
		headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="remail-category-report-${new Date().toISOString().slice(0, 10)}.csv"` },
	});
});

// ── Help: email categories, reply templates and reference data ──────────────
r.get('/api/taxonomy', async () => ({
	groups: taxonomyTree().map((g) => ({ ...g, label: BUSINESS_LABELS[g.key] })),
}));
r.get('/api/templates', async (ctx) => ({ templates: await listTemplates(ctx.user!.orgId), fields: ['{{name}}', '{{order_ref}}', '{{book}}', '{{signature}}'] }));
r.put('/api/templates/:id', async (ctx) => {
	requireRole(ctx.user, 'manager');
	const t = await updateTemplate(ctx.user!.orgId, ctx.user!.id, Number(ctx.params.id), ctx.body || {});
	await audit(ctx, 'template.updated', 'reply_template', Number(ctx.params.id));
	return t;
});
r.post('/api/templates/:id/reset', async (ctx) => {
	requireRole(ctx.user, 'manager');
	const t = await resetTemplate(ctx.user!.orgId, Number(ctx.params.id));
	await audit(ctx, 'template.reset', 'reply_template', Number(ctx.params.id));
	return t;
});
r.get('/api/reference', async (ctx) => listReference(ctx.user!.orgId, ctx.query.get('kind') || undefined, ctx.query.get('q') || undefined));
r.get('/api/reference/sample/:kind', async (ctx) => {
	const kind = ctx.params.kind as RefKind;
	if (!TEMPLATES_CSV[kind]) throw new HttpError(404, 'Unknown kind');
	return new Response(TEMPLATES_CSV[kind], { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="remail-${kind}-sample.csv"` } });
});
r.post('/api/reference/import', async (ctx) => {
	requireRole(ctx.user, 'manager');
	const { kind, csv, replace } = ctx.body || {};
	const res = await importCsv(ctx.user!.orgId, kind, String(csv || ''), !!replace);
	await audit(ctx, 'reference.imported', 'reference_items', null, { kind, ...res, replace: !!replace });
	return res;
});
r.post('/api/reference/test', async (ctx) => ({ matches: await matchReference(ctx.user!.orgId, String(ctx.body?.text || '').slice(0, 5000)) }));
r.del('/api/reference/:id', async (ctx) => {
	requireRole(ctx.user, 'manager');
	return deleteReference(ctx.user!.orgId, Number(ctx.params.id));
});
r.del('/api/reference', async (ctx) => {
	requireRole(ctx.user, 'manager');
	const kind = ctx.query.get('kind') || '';
	if (!['book', 'faq', 'policy'].includes(kind)) throw new HttpError(400, 'Say which kind to clear');
	await audit(ctx, 'reference.cleared', 'reference_items', null, { kind });
	return deleteReference(ctx.user!.orgId, null, kind);
});
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
		`select a.*, cu.name as customer_name, c.subject, c.rag, c.business_category, c.mailbox_ids, r.name as rule_name, r.rule_type, u.full_name as acknowledged_by_name
		   from alerts a left join conversations c on c.id=a.conversation_id left join customers cu on cu.id=a.customer_id
		   left join alert_rules r on r.id=a.rule_id left join users u on u.id=a.acknowledged_by
		  where ${where} order by case a.severity when 'critical' then 0 when 'high' then 1 else 2 end, a.created_at desc limit 1000`,
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
		demoEnabled: demoEnabled(),
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
		googleWorkspace: workspaceConfigured(),
		googleServiceAccount: serviceAccount()?.client_email || null,
		googleServiceClientId: serviceAccount()?.client_id || null,
		googleScope: gmailSendEnabled() ? `${GMAIL_READONLY},${GMAIL_SEND}` : GMAIL_READONLY,
	};
}

r.post('/api/mailboxes/test', async (ctx) => {
	requireRole(ctx.user, 'admin');
	const address = String(ctx.body?.address || '').trim().toLowerCase();
	if (!/@/.test(address)) throw new HttpError(400, 'Enter a mailbox address');
	if (workspaceConfigured() && ctx.body?.provider !== 'microsoft') return googleTestMailbox(address);
	return microsoftTestMailbox(ctx.user!.orgId, address);
});

r.post('/api/mailboxes', async (ctx) => {
	requireRole(ctx.user, 'admin');
	const { address, displayName, backfillDays } = ctx.body || {};
	const provider = workspaceConfigured() && ctx.body?.provider !== 'microsoft' ? 'gmail_app' : 'microsoft_app';
	if (provider === 'microsoft_app' && (!microsoftConfigured() || !(await orgTenant(ctx.user!.orgId))))
		throw new HttpError(400, 'Set up Google Workspace access first (GOOGLE_SERVICE_ACCOUNT_JSON and domain-wide delegation)');
	if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(address || ''))) throw new HttpError(400, 'Enter a valid mailbox address');
	const row = await one<any>(
		`insert into mailboxes (org_id, provider, address, display_name, backfill_days, created_by) values ($1,$6,$2,$3,$4,$5)
		 on conflict (org_id, provider, lower(address)) do update set status='active' returning *`,
		[ctx.user!.orgId, String(address).toLowerCase(), displayName || address, Number(backfillDays) || 90, ctx.user!.id, provider],
	);
	await audit(ctx, 'mailbox.added', 'mailbox', row.id, { address, provider });
	kickWorker(row.id).catch(() => {});
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
		state, ctx.user!.id, provider, JSON.stringify({ backfillDays: Number(ctx.body?.backfillDays) || 90 }),
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

async function connectPersonalMailbox(ctx: any, user: any, prov: string, res: { address: string; displayName?: string; credentials: string }, backfillDays: number, reactivate = true) {
	const existing = await one<any>(`select id from mailboxes where org_id=$1 and provider=$2 and lower(address)=lower($3)`, [user.org_id, prov, res.address]);
	const mb = await one<any>(
		`insert into mailboxes (org_id, provider, address, display_name, credentials_enc, backfill_days, created_by, status)
		 values ($1,$2,$3,$4,$5,$6,$7,'active')
		 on conflict (org_id, provider, lower(address)) do update set credentials_enc=excluded.credentials_enc,
		   status=case when mailboxes.status='paused' and not $8 then 'paused' else 'active' end, last_error=null
		 returning *`,
		[user.org_id, prov, res.address, res.displayName || res.address, res.credentials, backfillDays, user.id, reactivate],
	);
	// personal mailbox: the person who connected it always sees it
	await q('insert into user_mailboxes (user_id, mailbox_id) values ($1,$2) on conflict do nothing', [user.id, mb.id]);
	if (res.address !== String(user.email).toLowerCase()) {
		await q(`update users set email_aliases = (select array(select distinct unnest(email_aliases || array[$2::text]))) where id=$1`, [user.id, res.address]);
	}
	if (!existing) await audit({ ...ctx, user: undefined }, 'mailbox.connected', 'mailbox', mb.id, { provider: prov, address: res.address }, user);
	if (mb.status === 'active') kickWorker(mb.id).catch(() => {});
	return mb;
}

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
		await connectPersonalMailbox(ctx, user, prov, res, st.payload?.backfillDays || 90);
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
// Google Workspace service account key (domain-wide delegation), stored encrypted
r.post('/api/settings/google-service-account', async (ctx) => {
	requireRole(ctx.user, 'admin');
	const raw = typeof ctx.body?.json === 'string' ? ctx.body.json : JSON.stringify(ctx.body?.json || {});
	const sa = parseServiceAccount(raw);
	if (!sa) throw new HttpError(400, 'This is not a Google service account key file (it needs client_email and private_key)');
	await q(`update organisations set settings = settings || jsonb_build_object('googleServiceAccountEnc', $2::text) where id=$1`, [ctx.user!.orgId, encrypt(raw)]);
	await loadServiceAccount(true);
	await audit(ctx, 'settings.google_service_account', 'organisation', ctx.user!.orgId, { client_email: sa.client_email, client_id: sa.client_id });
	return { success: true, clientEmail: sa.client_email, clientId: sa.client_id };
});
r.del('/api/settings/google-service-account', async (ctx) => {
	requireRole(ctx.user, 'admin');
	await q(`update organisations set settings = settings - 'googleServiceAccountEnc' where id=$1`, [ctx.user!.orgId]);
	await loadServiceAccount(true);
	await audit(ctx, 'settings.google_service_account_removed', 'organisation', ctx.user!.orgId);
	return { success: true };
});

r.get('/api/settings', async (ctx) => {
	const org = await getOrg(ctx.user!.orgId, true);
	const { googleServiceAccountEnc: _secret, ...settings } = org.settings as any;
	return { name: org.name, internalDomains: org.internalDomains, settings: { replyFooter: true, ...settings, branches: branchList(settings.branches), headOffice: headOffice(settings, org.name) } };
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
		if (settings.autoDrafts !== undefined) next.autoDrafts = !!settings.autoDrafts;
		if (settings.replyKnowledge !== undefined) next.replyKnowledge = String(settings.replyKnowledge).slice(0, 6000);
		if (settings.replySignature !== undefined) next.replySignature = String(settings.replySignature).slice(0, 600);
		if (settings.replyFooter !== undefined) (next as any).replyFooter = !!settings.replyFooter;
		if (settings.headOffice && typeof settings.headOffice === 'object') {
			const h = settings.headOffice;
			const clip = (v: any, n: number) => String(v || '').trim().slice(0, n);
			(next as any).headOffice = { name: clip(h.name, 120), address: clip(h.address, 300), phone: clip(h.phone, 120), email: clip(h.email, 120), website: /^https?:\/\//.test(clip(h.website, 200)) ? clip(h.website, 200) : clip(h.website, 200) ? `https://${clip(h.website, 200)}` : '', logoUrl: /^https:\/\//.test(clip(h.logoUrl, 400)) ? clip(h.logoUrl, 400) : '' };
		}
		if (Array.isArray(settings.branches)) (next as any).branches = settings.branches.slice(0, 60).map((b: any) => ({ city: String(b.city || '').slice(0, 60), state: String(b.state || '').slice(0, 60), address: String(b.address || '').trim().slice(0, 300), phone: String(b.phone || '').trim().slice(0, 120), email: String(b.email || '').trim().slice(0, 120) })).filter((b: any) => b.city);
		if (settings.defaultBackfillDays !== undefined) next.defaultBackfillDays = Math.max(7, Math.min(365, Number(settings.defaultBackfillDays) || 90));
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
		gmailSend: gmailSendEnabled(),
		outlookSend: microsoftSendEnabled(),
		progress: await one<any>(
			`select (select count(*)::int from conversations where org_id=$1 and needs_analysis) as waiting_for_analysis,
			        (select count(*)::int from conversations where org_id=$1 and analysis_model like '%(fallback)%') as rules_engine_fallback,
			        (select count(*)::int from conversations where org_id=$1 and analysed_at is not null and analysis_model not like '%(fallback)%' and analysis_model not like 'remail-heuristic%') as analysed_by_ai,
			        (select paused_until from ai_state where id=1) as ai_paused_until,
			        (select last_error from ai_state where id=1) as ai_last_error,
			        (select last_error_at from ai_state where id=1) as ai_last_error_at,
			        (select until from worker_lease where name='tick') as worker_busy_until`,
			[ctx.user!.orgId],
		).catch(() => null),
		webhooks: { teams: !!process.env.TEAMS_WEBHOOK_URL, slack: !!process.env.SLACK_WEBHOOK_URL },
		pendingAnalysis: pending?.n || 0,
		mailboxes: mb,
		aiUsageThisMonth: usage,
		lastWorkerRun: lastRun?.t,
	};
});

// what has been read, sorted and analysed, so the numbers across the app can be reconciled
r.get('/api/system/processing', async (ctx) => {
	requireRole(ctx.user, 'analyst');
	const org = ctx.user!.orgId;
	const [mailboxes, emails, threads, runs, ai, usage] = await Promise.all([
		q<any>(
			`select m.id, m.address, m.display_name, m.provider, m.status, m.last_error, m.last_synced_at, m.backfill_days, m.created_at,
			        (m.sync_state ? 'historyId' and not (m.sync_state ? 'pageToken')) as backfill_done,
			        (select count(*) from emails e where e.mailbox_id=m.id)::int as emails,
			        (select count(*) from emails e where e.mailbox_id=m.id and e.is_duplicate)::int as duplicates,
			        (select min(e.sent_at) from emails e where e.mailbox_id=m.id) as oldest,
			        (select max(e.sent_at) from emails e where e.mailbox_id=m.id) as newest,
			        (select count(*) from conversations c where c.org_id=m.org_id and m.id = any(c.mailbox_ids))::int as threads
			   from mailboxes m where m.org_id=$1 order by m.address`,
			[org],
		),
		one<any>(
			`select count(*)::int as stored, count(*) filter (where is_duplicate)::int as duplicates,
			        count(*) filter (where not is_duplicate and direction='inbound')::int as inbound,
			        count(*) filter (where not is_duplicate and direction='outbound')::int as outbound,
			        count(*) filter (where not is_duplicate and direction='internal')::int as internal,
			        count(*) filter (where sent_at > now() - interval '30 days')::int as last_30_days
			   from emails where org_id=$1`,
			[org],
		),
		one<any>(
			`select count(*) filter (where message_count > 0)::int as total,
			        count(*) filter (where message_count > 0 and customer_id is not null and not is_automated)::int as external,
			        count(*) filter (where message_count > 0 and is_internal)::int as internal,
			        count(*) filter (where message_count > 0 and is_automated)::int as automated,
			        count(*) filter (where message_count > 0 and needs_analysis)::int as waiting,
			        count(*) filter (where analysed_at is not null and analysis_model not like 'remail-heuristic%')::int as by_ai,
			        count(*) filter (where analysis_model = 'remail-heuristic-v1')::int as by_rules,
			        count(*) filter (where analysis_model like '%(fallback)%')::int as by_fallback,
			        count(*) filter (where awaiting_reply and status in ('open','in_progress'))::int as awaiting,
			        count(*) filter (where rag='red' and status in ('open','in_progress'))::int as red,
			        count(*) filter (where rag='amber' and status in ('open','in_progress'))::int as amber,
			        count(*) filter (where last_message_at > now() - interval '30 days' and message_count > 0)::int as last_30_days,
			        (select count(*) from reply_drafts d where d.org_id=$1 and d.status='draft')::int as drafts,
			        (select count(*) from reply_drafts d where d.org_id=$1 and d.status='sent')::int as sent,
			        (select count(*) from alerts a where a.org_id=$1 and a.status='open')::int as alerts_open,
			        (select count(*) from customers k where k.org_id=$1)::int as contacts
			   from conversations where org_id=$1`,
			[org],
		),
		q<any>(
			`select r.started_at, r.finished_at, r.fetched, r.inserted, r.duplicates, r.error, m.address
			   from sync_runs r join mailboxes m on m.id=r.mailbox_id where m.org_id=$1 order by r.started_at desc limit 15`,
			[org],
		),
		one<any>('select paused_until, last_error, last_error_at, provider from ai_state where id=1').catch(() => null),
		one<any>(`select count(*)::int calls, coalesce(sum(input_tokens),0)::bigint input_tokens, coalesce(sum(output_tokens),0)::bigint output_tokens
		            from ai_usage where org_id=$1 and created_at > now() - interval '24 hours' and purpose='analysis'`, [org]),
	]);
	return {
		ai: { provider: aiProvider(), model: aiModel(), ...ai, last24h: usage },
		emails, threads, mailboxes, runs,
		worker: await one<any>(`select until from worker_lease where name='tick'`).catch(() => null),
	};
});

// threads read from months of history that nobody answered: take them off the waiting lists in one go
r.get('/api/system/old-unanswered', async (ctx) => {
	requireRole(ctx.user, 'manager');
	const days = Math.max(7, Math.min(365, Number(ctx.query.get('days')) || 45));
	return one<any>(
		`select count(*)::int as threads, (select count(*) from reply_drafts d join conversations c on c.id=d.conversation_id
		   where c.org_id=$1 and c.awaiting_reply and c.last_inbound_at < now() - make_interval(days => $2) and d.status='draft')::int as drafts
		   from conversations c where c.org_id=$1 and c.awaiting_reply and c.status in ('open','in_progress') and c.last_inbound_at < now() - make_interval(days => $2)`,
		[ctx.user!.orgId, days],
	);
});
r.post('/api/system/old-unanswered', async (ctx) => {
	requireRole(ctx.user, 'manager');
	const days = Math.max(7, Math.min(365, Number(ctx.body?.days) || 45));
	const ids = (await q<any>(
		`update conversations set awaiting_reply=false, updated_at=now() where org_id=$1 and awaiting_reply and status in ('open','in_progress')
		   and last_inbound_at < now() - make_interval(days => $2) returning id`,
		[ctx.user!.orgId, days],
	)).map((r) => r.id);
	if (ids.length) {
		await q(`update reply_drafts set status='dismissed', updated_at=now(), updated_by=$2 where conversation_id = any($1::bigint[]) and status='draft'`, [ids, ctx.user!.id]);
		await q(`update alerts set status='resolved' where conversation_id = any($1::bigint[]) and status in ('open','acknowledged')`, [ids]).catch(() => {});
	}
	await audit(ctx, 'conversations.old_unanswered_cleared', 'conversation', null, { days, threads: ids.length });
	return { threads: ids.length };
});

// ── Customer database (Admin) ───────────────────────────────────────────────
r.get('/api/customer-db', async (ctx) => {
	requireRole(ctx.user, 'analyst');
	const res = await listCustomerDb(ctx.user!.orgId, ctx.query);
	if (ctx.query.get('format') !== 'csv') return res;
	const cols = ['name', 'type', 'organisation', 'emails', 'phones', 'address', 'city', 'state', 'pin', 'language', 'order_refs', 'subscriber_numbers', 'books', 'gstin', 'threads', 'waiting', 'first_contact', 'last_contact_at', 'notes'];
	const cell = (v: any) => { const s = Array.isArray(v) ? v.join('; ') : v instanceof Date ? v.toISOString().slice(0, 10) : v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
	const lines = [cols.join(','), ...res.rows.map((r: any) => cols.map((c) => cell(c in r.p ? (r.p as any)[c] : r[c])).join(','))];
	await audit(ctx, 'export.customer_db', 'customer', null, { rows: res.rows.length });
	return new Response(lines.join('\n'), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="remail-customers-${new Date().toISOString().slice(0, 10)}.csv"` } });
});
r.patch('/api/customer-db/:id', async (ctx) => {
	requireRole(ctx.user, 'analyst');
	const res = await updateProfile(ctx.user!.orgId, Number(ctx.params.id), ctx.body || {});
	await audit(ctx, 'customer.profile_edited', 'customer', Number(ctx.params.id), { fields: Object.keys(ctx.body || {}) });
	return res;
});
r.post('/api/customer-db/:id/refresh', async (ctx) => {
	requireRole(ctx.user, 'analyst');
	const c = await one<any>('select id from customers where id=$1 and org_id=$2', [Number(ctx.params.id), ctx.user!.orgId]);
	if (!c) throw new HttpError(404, 'Customer not found');
	const res = await buildProfile(c.id, ctx.body?.ai !== false);
	await enrichCustomer(c.id, { web: true }).catch((e) => console.error('[enrich]', e.message));
	return { ...res, customer: await one<any>('select * from customers where id=$1', [c.id]).then((r) => ({ ...r, p: mergedProfile(r) })) };
});

r.post('/api/system/demo', async (ctx) => {
	requireRole(ctx.user, 'admin');
	if (!demoEnabled()) throw new HttpError(400, 'Demo data is switched off on this site (set DEMO_DATA_ENABLED=true to allow it)');
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
	checks.google_sign_in = { ok: googleConfigured(), detail: googleConfigured() ? `enabled${process.env.GOOGLE_SSO_ALLOWED_DOMAINS ? ` for ${process.env.GOOGLE_SSO_ALLOWED_DOMAINS}` : ''}` : 'Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET' };
	try { await loadServiceAccount(true); } catch { /* database not ready */ }
	const sa = serviceAccount();
	checks.google_workspace_shared_mailboxes = { ok: !!sa, detail: sa ? `service account ${sa.client_email} (client ID ${sa.client_id})` : has('GOOGLE_SERVICE_ACCOUNT_JSON') ? 'GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON' : 'optional: upload the service account key in Admin → Mailboxes' };
	checks.ai = { ok: true, detail: `${aiProvider()} · ${aiModel()}` };
	checks.site_url = { ok: true, detail: appUrl() };
	const ok = Object.entries(checks).every(([k, v]) => v.ok || k === 'google_workspace_shared_mailboxes');
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
		await loadServiceAccount();
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
