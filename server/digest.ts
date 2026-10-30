/**
 * Delivery of activities: a personal "My day" email each morning (local time) and
 * alerts for overdue actions and approaching proposal deadlines.
 */
import { one, q } from './db';
import { myDay } from './views';
import { appUrl, emailLayout, esc, sendEmail } from './mailer';
import type { SessionUser } from './auth';
import { BUSINESS_LABELS, type BusinessCategory } from './ai/types';

function localHour(tz: string) {
	try {
		return Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: tz || 'UTC' }).format(new Date()));
	} catch {
		return new Date().getUTCHours();
	}
}

export async function sendDailyDigests(orgId: number) {
	const hour = Number(process.env.DIGEST_LOCAL_HOUR || 7);
	const users = await q<any>(
		`select * from users where org_id=$1 and is_active and digest_enabled
		   and (last_digest_at is null or last_digest_at < now() - interval '20 hours')`,
		[orgId],
	);
	let sent = 0;
	for (const u of users) {
		if (localHour(u.timezone) !== hour) continue;
		const su: SessionUser = {
			id: u.id, orgId, email: u.email, fullName: u.full_name, role: u.role,
			allMailboxes: u.all_mailboxes || u.role === 'admin' || u.role === 'manager', sessionId: '', authProvider: u.auth_provider, timezone: u.timezone,
		};
		const d = await myDay(su);
		await q('update users set last_digest_at=now() where id=$1', [u.id]);
		if (!d.awaiting.length && !d.actions.length && !d.proposals.length) continue;
		const today = new Date().toISOString().slice(0, 10);
		const li = (href: string, title: string, sub: string, color = '#0B1143') =>
			`<tr><td style="padding:8px 0;border-bottom:1px solid #eceef5"><a href="${href}" style="color:${color};font-weight:700;text-decoration:none">${esc(title)}</a><br><span style="color:#5b6180;font-size:12px">${esc(sub)}</span></td></tr>`;
		const sec = (kw: string, rest: string, rows: string) =>
			rows ? `<h2 style="font-family:Nunito,Arial;font-size:16px;margin:22px 0 6px"><span style="color:#F00D69">${kw}</span> ${rest}</h2><table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px">${rows}</table>` : '';
		const html = emailLayout(
			`Good morning ${esc((u.full_name || '').split(' ')[0] || '')}`,
			`<p style="font-size:14px;color:#5b6180;margin:0">${d.stats.awaiting} emails waiting for your reply · ${d.stats.actionsOverdue} overdue actions · ${d.stats.actionsToday} due today</p>
			${sec('Waiting', 'for your reply', d.awaiting.slice(0, 10).map((c: any) => li(`${appUrl()}/conversations/${c.id}`, `${c.customer_name || 'Internal'}: ${c.subject}`, `${BUSINESS_LABELS[c.business_category as BusinessCategory] || ''} · waiting ${Math.round((Date.now() - new Date(c.last_inbound_at).getTime()) / 3600_000)}h`, c.rag === 'red' ? '#F00D69' : '#0B1143')).join(''))}
			${sec('Your', 'actions', d.actions.slice(0, 12).map((a: any) => li(a.conversation_id ? `${appUrl()}/conversations/${a.conversation_id}` : `${appUrl()}/actions`, a.description, `${a.customer_name ? `${a.customer_name} · ` : ''}${a.due_date ? (a.due_date < today ? `overdue since ${a.due_date}` : `due ${a.due_date}`) : 'no due date'}`, a.due_date && a.due_date < today ? '#F00D69' : '#0B1143')).join(''))}
			${sec('Open', 'proposals', d.proposals.slice(0, 8).map((p: any) => li(`${appUrl()}/conversations/${p.id}`, `${p.customer_name || ''}: ${p.subject}`, `${String(p.proposal_stage || '').replace(/_/g, ' ')}${p.proposal?.deadline ? ` · deadline ${p.proposal.deadline}` : ''}`)).join(''))}
			<p style="margin-top:22px"><a href="${appUrl()}/my-day" style="display:inline-block;background:#F00D69;color:#fff;text-decoration:none;padding:10px 18px;border-radius:10px;font-weight:700">Open my day</a></p>`,
		);
		try {
			if ((await sendEmail([u.email], `remail · your day: ${d.stats.awaiting} to reply, ${d.stats.actionsOverdue} overdue`, html)) === 'sent') sent++;
		} catch (e: any) {
			console.error('[digest]', u.email, e.message);
		}
	}
	return sent;
}

/** action_overdue and proposal_deadline alert rules */
export async function evaluateDeliveryAlerts(orgId: number) {
	const rules = await q<any>(`select * from alert_rules where org_id=$1 and enabled and rule_type in ('action_overdue','proposal_deadline')`, [orgId]);
	for (const r of rules) {
		if (r.rule_type === 'action_overdue') {
			const days = Number(r.params?.days ?? 1);
			const rows = await q<any>(
				`select a.*, cu.name as customer_name, u.full_name as assignee_name, u.email as assignee_email from action_items a
				  left join customers cu on cu.id=a.customer_id left join users u on u.id=a.assignee_id
				  where a.org_id=$1 and a.status='open' and a.owner_side='us' and a.due_date <= current_date - $2::int limit 100`,
				[orgId, days],
			);
			for (const a of rows) {
				const ins = await one<any>(
					`insert into alerts (org_id, rule_id, conversation_id, customer_id, severity, title, body, dedup_key)
					 values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (org_id, dedup_key) do nothing returning *`,
					[orgId, r.id, a.conversation_id, a.customer_id, r.severity, `Overdue: ${a.description}`.slice(0, 300),
						`Action: ${a.description}\nCustomer: ${a.customer_name || 'n/a'}\nDue: ${a.due_date}\nOwner: ${a.assignee_name || a.owner_name || 'unassigned'}`,
						`${r.id}:a${a.id}`],
				);
				if (ins) {
					const to = [...(r.recipients || []), ...(a.assignee_email ? [a.assignee_email] : [])];
					if (r.channels.includes('email')) await sendEmail(to, `remail: overdue action — ${a.description.slice(0, 80)}`, emailLayout('Overdue action', `<p style="font-size:14px;white-space:pre-line">${esc(ins.body)}</p><p><a href="${appUrl()}/actions" style="color:#F00D69;font-weight:700">Open actions</a></p>`)).catch(() => {});
				}
			}
		}
		if (r.rule_type === 'proposal_deadline') {
			const days = Number(r.params?.days ?? 2);
			const rows = await q<any>(
				`select c.*, cu.name as customer_name from conversations c left join customers cu on cu.id=c.customer_id
				  where c.org_id=$1 and c.business_category='sales_proposal' and coalesce(c.proposal_stage,'') in ('request_received','in_preparation','negotiation')
				    and (c.proposal->>'deadline') is not null and (c.proposal->>'deadline')::date between current_date and current_date + $2::int`,
				[orgId, days],
			);
			for (const c of rows) {
				const ins = await one<any>(
					`insert into alerts (org_id, rule_id, conversation_id, customer_id, severity, title, body, dedup_key)
					 values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (org_id, dedup_key) do nothing returning *`,
					[orgId, r.id, c.id, c.customer_id, r.severity, `Proposal due ${c.proposal.deadline}: ${c.customer_name || ''} — ${c.subject}`.slice(0, 300),
						`Stage: ${String(c.proposal_stage).replace(/_/g, ' ')}\nDeadline: ${c.proposal.deadline}\nNext step: ${c.proposal.next_step || 'n/a'}\n\n${c.summary || ''}`,
						`${r.id}:p${c.id}:${c.proposal.deadline}`],
				);
				if (ins && r.channels.includes('email')) {
					await sendEmail(r.recipients || [], `remail: proposal deadline ${c.proposal.deadline} — ${c.subject}`, emailLayout('Proposal deadline approaching', `<p style="font-size:14px;white-space:pre-line">${esc(ins.body)}</p><p><a href="${appUrl()}/conversations/${c.id}" style="color:#F00D69;font-weight:700">Open in remail</a></p>`)).catch(() => {});
				}
			}
		}
	}
}
