import { one, q } from './db';
import type { Analysis } from './ai/types';
import { appUrl, emailLayout, esc, postWebhook, sendEmail } from './mailer';
import { CATEGORY_LABELS } from './ai/types';

interface Rule {
	id: number;
	org_id: number;
	name: string;
	rule_type: string;
	params: any;
	severity: string;
	channels: string[];
	recipients: string[];
	escalate_after_minutes: number | null;
	escalation_recipients: string[];
	enabled: boolean;
}

async function rules(orgId: number, type?: string): Promise<Rule[]> {
	return q<Rule>(
		`select * from alert_rules where org_id=$1 and enabled ${type ? 'and rule_type=$2' : ''}`,
		type ? [orgId, type] : [orgId],
	);
}

async function raise(rule: Rule, opts: {
	conversationId?: number | null;
	customerId?: number | null;
	title: string;
	body: string;
	dedupKey: string;
}) {
	const row = await one<any>(
		`insert into alerts (org_id, rule_id, conversation_id, customer_id, severity, title, body, dedup_key)
		 values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (org_id, dedup_key) do nothing returning *`,
		[rule.org_id, rule.id, opts.conversationId ?? null, opts.customerId ?? null, rule.severity, opts.title.slice(0, 300), opts.body.slice(0, 4000), opts.dedupKey],
	);
	if (!row) return null; // already raised
	await deliver(row, rule, rule.recipients, 0);
	return row;
}

async function deliver(alert: any, rule: Rule, recipients: string[], level: number) {
	const link = alert.conversation_id ? `${appUrl()}/conversations/${alert.conversation_id}` : `${appUrl()}/alerts`;
	const delivered: Record<string, string> = { ...(alert.delivered || {}) };
	const prefix = level > 0 ? `[Escalation L${level}] ` : '';
	if (rule.channels.includes('email')) {
		// also include users who opted in and are admins/managers
		const optIn = await q<{ email: string }>(
			`select email from users where org_id=$1 and is_active and notify_email and role in ('admin','manager')`,
			[rule.org_id],
		);
		const to = level > 0 ? recipients : [...recipients, ...optIn.map((u) => u.email)];
		try {
			delivered[`email_l${level}`] = await sendEmail(
				to,
				`${prefix}remail ${alert.severity} alert: ${alert.title}`,
				emailLayout(
					`${prefix}${esc(alert.title)}`,
					`<p style="display:inline-block;padding:4px 10px;border-radius:999px;background:${alert.severity === 'critical' ? '#F00D69' : alert.severity === 'high' ? '#E89040' : '#4C80FF'};color:#fff;font-size:12px;font-weight:700">${esc(alert.severity)} severity</p>
					 <p style="font-size:14px;line-height:1.6;white-space:pre-line">${esc(alert.body)}</p>
					 <p><a href="${link}" style="display:inline-block;background:#F00D69;color:#fff;text-decoration:none;padding:10px 18px;border-radius:10px;font-weight:700">Open in remail</a></p>`,
				),
			);
		} catch (e: any) {
			delivered[`email_l${level}`] = `error: ${e.message}`.slice(0, 200);
		}
	}
	if (rule.channels.includes('teams')) delivered[`teams_l${level}`] = await postWebhook('teams', `${prefix}${alert.title}`, alert.body, link).catch((e) => `error: ${e.message}`);
	if (rule.channels.includes('slack')) delivered[`slack_l${level}`] = await postWebhook('slack', `${prefix}${alert.title}`, alert.body, link).catch((e) => `error: ${e.message}`);
	await q('update alerts set delivered=$2 where id=$1', [alert.id, JSON.stringify(delivered)]);
}

function convBody(conv: any, a?: Analysis) {
	const lines = [
		`Customer: ${conv.customer_name || 'Unknown'}${conv.customer_tier && conv.customer_tier !== 'standard' ? ` (${conv.customer_tier})` : ''}`,
		`Subject: ${conv.subject}`,
		`Rating: ${conv.rag || 'n/a'} · sentiment ${conv.sentiment} · urgency ${conv.urgency} · escalation risk ${conv.escalation_risk}/100`,
		'',
		conv.summary || '',
	];
	if (a?.issues?.length) lines.push('', 'Issues:', ...a.issues.slice(0, 4).map((i) => `- ${CATEGORY_LABELS[i.category]} (${i.severity}): ${i.description}`));
	if (conv.rag_reason) lines.push('', `Why: ${conv.rag_reason}`);
	return lines.join('\n');
}

/** Evaluate per-conversation rules after each analysis. */
export async function evaluateConversationAlerts(conv: any, a: Analysis) {
	if (!conv || conv.status === 'ignored' || conv.status === 'resolved') return;
	// Only alert on live activity, not on historical backfill
	const lookbackH = Number(process.env.ALERT_LOOKBACK_HOURS || 72);
	if (conv.last_message_at && Date.now() - new Date(conv.last_message_at).getTime() > lookbackH * 3600_000) return;
	const all = await rules(conv.org_id);
	const lastMsg = new Date(conv.last_message_at || Date.now()).toISOString().slice(0, 10);
	for (const r of all) {
		let hit = false;
		let title = '';
		switch (r.rule_type) {
			case 'rag_red':
				hit = conv.rag === 'red';
				title = `Red: ${conv.customer_name || 'Customer'} — ${conv.subject}`;
				break;
			case 'negative_key_customer': {
				const tiers: string[] = r.params?.tiers || ['strategic', 'key'];
				hit = conv.sentiment === 'negative' && tiers.includes(conv.customer_tier);
				title = `Negative email from ${conv.customer_tier} customer ${conv.customer_name}`;
				break;
			}
			case 'escalation_risk':
				hit = (conv.escalation_risk ?? 0) >= Number(r.params?.threshold ?? 70);
				title = `Escalation risk ${conv.escalation_risk}/100: ${conv.customer_name || 'Customer'}`;
				break;
			case 'keyword': {
				const kws: string[] = (r.params?.keywords || []).map((k: string) => k.toLowerCase());
				if (!kws.length) break;
				const recent = await q<{ body_clean: string; subject: string }>(
					`select body_clean, subject from emails where conversation_id=$1 and direction='inbound' and not is_duplicate order by sent_at desc limit 3`,
					[conv.id],
				);
				const text = recent.map((e) => `${e.subject} ${e.body_clean}`).join(' ').toLowerCase();
				const found = kws.filter((k) => text.includes(k));
				hit = found.length > 0;
				title = `Watch-word "${found[0]}" from ${conv.customer_name || 'customer'}`;
				break;
			}
		}
		if (hit) {
			await raise(r, {
				conversationId: conv.id,
				customerId: conv.customer_id,
				title,
				body: convBody(conv, a),
				// one alert per rule, conversation and day of latest activity
				dedupKey: `${r.id}:c${conv.id}:${lastMsg}`,
			});
		}
	}
}

export async function evaluateHealthAlert(customer: any, previous: number) {
	for (const r of await rules(customer.org_id, 'health_drop')) {
		const pts = Number(r.params?.points ?? 15);
		if (previous - customer.health_score >= pts) {
			await raise(r, {
				customerId: customer.id,
				title: `Health of ${customer.name} dropped ${previous - customer.health_score} points to ${customer.health_score}`,
				body: `Customer: ${customer.name}\nHealth score: ${previous} → ${customer.health_score}\nReview recent conversations for this customer in remail.`,
				dedupKey: `${r.id}:h${customer.id}:${new Date().toISOString().slice(0, 10)}`,
			});
		}
	}
}

/** Periodic: SLA breaches on conversations still awaiting a reply. */
export async function evaluateSlaAlerts(orgId: number) {
	for (const r of await rules(orgId, 'sla_breach')) {
		const hours = Number(r.params?.hours ?? 4);
		const rows = await q<any>(
			`select c.*, cu.name as customer_name, cu.tier as customer_tier from conversations c left join customers cu on cu.id=c.customer_id
			  where c.org_id=$1 and c.awaiting_reply and c.status in ('open','in_progress')
			    and c.last_inbound_at < now() - make_interval(hours => $2) and c.last_inbound_at > now() - interval '14 days'
			  order by c.priority_score desc limit 50`,
			[orgId, hours],
		);
		for (const conv of rows) {
			const waited = Math.round((Date.now() - new Date(conv.last_inbound_at).getTime()) / 3600_000);
			await raise(r, {
				conversationId: conv.id,
				customerId: conv.customer_id,
				title: `${conv.customer_name || 'Customer'} waiting ${waited}h for a reply`,
				body: `${convBody(conv)}\n\nLast customer message: ${new Date(conv.last_inbound_at).toUTCString()}`,
				dedupKey: `${r.id}:s${conv.id}:${new Date(conv.last_inbound_at).toISOString()}`,
			});
		}
	}
}

/** Periodic: escalate open alerts that nobody acknowledged in time. */
export async function processEscalations(orgId: number) {
	const due = await q<any>(
		`select a.*, r.escalate_after_minutes, r.escalation_recipients, r.channels, r.recipients, r.org_id as rule_org, r.name as rule_name
		   from alerts a join alert_rules r on r.id=a.rule_id
		  where a.org_id=$1 and a.status='open' and r.escalate_after_minutes is not null and a.escalation_level < 2
		    and coalesce(a.escalated_at, a.created_at) < now() - make_interval(mins => r.escalate_after_minutes)`,
		[orgId],
	);
	for (const a of due) {
		const level = a.escalation_level + 1;
		await q('update alerts set escalation_level=$2, escalated_at=now() where id=$1', [a.id, level]);
		const rule = { ...a, id: a.rule_id, org_id: a.org_id } as Rule;
		const to = a.escalation_recipients?.length ? a.escalation_recipients : a.recipients;
		await deliver({ ...a, escalation_level: level }, rule, to, level);
	}
	return due.length;
}
