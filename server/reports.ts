import { one, q } from './db';
import type { SessionUser } from './auth';
import { dashboardSummary, dashboardTrends, insights } from './queries';
import { appUrl, emailLayout, esc, sendEmail } from './mailer';
import { CATEGORY_LABELS, type Category } from './ai/types';
import { getOrg } from './settings';

export function systemUser(orgId: number): SessionUser {
	return { id: 0, orgId, email: 'system', fullName: 'System', role: 'admin', allMailboxes: true, sessionId: '', authProvider: 'system', timezone: 'UTC' };
}

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
const ragDot = (r: string) => `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${r === 'red' ? '#F00D69' : r === 'amber' ? '#E89040' : '#00B894'};margin-right:6px"></span>`;
const delta = (cur: number, prev: number, invert = false) => {
	if (!prev && !cur) return '';
	const d = cur - prev;
	if (d === 0) return '<span style="color:#8a90a8">no change</span>';
	const good = invert ? d < 0 : d > 0;
	return `<span style="color:${good ? '#00A37A' : '#F00D69'}">${d > 0 ? '+' : ''}${d} vs previous</span>`;
};

export async function buildReport(orgId: number, from: Date, to: Date, filters: Record<string, string> = {}) {
	const qs = new URLSearchParams({ ...filters, from: from.toISOString(), to: to.toISOString() });
	const user = systemUser(orgId);
	const org = await getOrg(orgId);
	const [s, t, ins] = await Promise.all([dashboardSummary(user, qs), dashboardTrends(user, qs), insights(user, qs)]);
	const k = s.kpis;
	const overdue = await q<any>(
		`select a.description, a.due_date, cu.name as customer_name, a.conversation_id from action_items a
		   left join customers cu on cu.id=a.customer_id
		  where a.org_id=$1 and a.status='open' and a.owner_side='us' and a.due_date < current_date
		  order by a.due_date limit 10`,
		[orgId],
	);
	const atRisk = await q<any>(
		`select cu.name, cu.tier, cu.health_score, cu.health_trend, cu.health_status from customers cu
		  where cu.org_id=$1 and cu.health_status in ('at_risk','dissatisfied') and cu.last_contact_at > $2
		  order by cu.health_score asc limit 10`,
		[orgId, new Date(from.getTime() - 30 * 86400_000)],
	);

	const tile = (label: string, value: string | number, sub = '', color = '#0B1143') =>
		`<td style="width:25%;padding:6px"><div style="border:1px solid #eceef5;border-top:3px solid ${color};border-radius:12px;padding:12px">
		 <div style="font-size:12px;color:#5b6180">${label}</div><div style="font-family:Nunito,Arial;font-size:24px;font-weight:700;color:#0B1143">${value}</div>
		 <div style="font-size:11px">${sub}</div></div></td>`;
	const frt = k.avg_first_response_min == null ? 'n/a' : k.avg_first_response_min >= 120 ? `${(k.avg_first_response_min / 60).toFixed(1)}h` : `${k.avg_first_response_min}m`;

	const inner = `
	<p style="font-size:14px;color:#5b6180;margin:0 0 16px">${org.name} · ${from.toUTCString().slice(5, 16)} to ${to.toUTCString().slice(5, 16)}</p>
	<table width="100%" cellpadding="0" cellspacing="0"><tr>
	  ${tile('Conversations', k.conversations, delta(k.conversations, s.previous.conversations), '#4C80FF')}
	  ${tile('Red', k.red, delta(k.red, s.previous.red, true), '#F00D69')}
	  ${tile('Negative', `${pct(k.negative, k.conversations)}%`, delta(k.negative, s.previous.negative, true), '#E89040')}
	  ${tile('Avg first response', frt, `${k.sla_breaches} awaiting beyond ${s.slaHours}h SLA`, '#00D3CF')}
	</tr><tr>
	  ${tile('Emails analysed', k.emails, `${k.duplicates} duplicates removed`, '#2C55BA')}
	  ${tile('At-risk customers', (s.customers?.at_risk || 0) + (s.customers?.dissatisfied || 0), `avg health ${s.customers?.avg_health ?? 'n/a'}`, '#5D2CA4')}
	  ${tile('Open actions', s.actions?.open || 0, `${s.actions?.overdue || 0} overdue`, '#E89040')}
	  ${tile('Open alerts', s.alerts?.open || 0, `${s.alerts?.critical || 0} critical`, '#F00D69')}
	</tr></table>

	<h2 style="font-family:Nunito,Arial;font-size:17px;margin:24px 0 8px"><span style="color:#F00D69">Critical</span> issues needing attention</h2>
	${s.critical.length ? `<table width="100%" cellpadding="8" cellspacing="0" style="font-size:13px;border-collapse:collapse">
	${s.critical.map((c: any) => `<tr style="border-bottom:1px solid #eceef5"><td>${ragDot(c.rag)}<b>${esc(c.customer_name || 'Unknown')}</b><br><a href="${appUrl()}/conversations/${c.id}" style="color:#2C55BA">${esc(c.subject || '(no subject)')}</a><br><span style="color:#5b6180">${esc((c.summary || '').slice(0, 220))}</span></td><td style="white-space:nowrap;color:#5b6180">priority ${c.priority_score}</td></tr>`).join('')}
	</table>` : '<p style="font-size:13px;color:#5b6180">No red or amber conversations are open.</p>'}

	<h2 style="font-family:Nunito,Arial;font-size:17px;margin:24px 0 8px"><span style="color:#F00D69">Top</span> issue categories</h2>
	<table width="100%" cellpadding="6" cellspacing="0" style="font-size:13px">
	${ins.categoryChange.slice(0, 8).map((c: any) => `<tr><td>${esc(CATEGORY_LABELS[c.category as Category] || c.category)}</td><td align="right"><b>${c.n}</b></td><td align="right" style="color:${c.change > 0 ? '#F00D69' : '#00A37A'}">${c.change > 0 ? '+' : ''}${c.change}</td><td align="right" style="color:#5b6180">${c.customers} customers</td></tr>`).join('') || '<tr><td style="color:#5b6180">No issues detected.</td></tr>'}
	</table>

	${atRisk.length ? `<h2 style="font-family:Nunito,Arial;font-size:17px;margin:24px 0 8px"><span style="color:#F00D69">At-risk</span> customers</h2>
	<table width="100%" cellpadding="6" cellspacing="0" style="font-size:13px">${atRisk.map((c: any) => `<tr><td>${esc(c.name)} <span style="color:#5b6180">(${c.tier})</span></td><td align="right"><b>${c.health_score}</b>/100</td><td align="right" style="color:${c.health_trend < 0 ? '#F00D69' : '#00A37A'}">${c.health_trend > 0 ? '+' : ''}${c.health_trend} 7d</td></tr>`).join('')}</table>` : ''}

	${overdue.length ? `<h2 style="font-family:Nunito,Arial;font-size:17px;margin:24px 0 8px"><span style="color:#F00D69">Overdue</span> commitments</h2>
	<ul style="font-size:13px;padding-left:18px">${overdue.map((a: any) => `<li style="margin-bottom:6px">${esc(a.customer_name || '')}: ${esc(a.description)} <span style="color:#F00D69">(due ${a.due_date})</span></li>`).join('')}</ul>` : ''}

	${ins.emerging.length ? `<h2 style="font-family:Nunito,Arial;font-size:17px;margin:24px 0 8px"><span style="color:#F00D69">Emerging</span> topics</h2>
	<p style="font-size:13px">${ins.emerging.map((e: any) => `${esc(e.topic)} (${e.n}, was ${e.previous})`).join(' · ')}</p>` : ''}
	`;
	const title = 'Customer communication health report';
	const summary = {
		conversations: k.conversations, red: k.red, amber: k.amber, green: k.green, negativePct: pct(k.negative, k.conversations),
		emails: k.emails, duplicates: k.duplicates, avgFirstResponseMin: k.avg_first_response_min,
		atRisk: (s.customers?.at_risk || 0) + (s.customers?.dissatisfied || 0), overdueActions: s.actions?.overdue || 0,
		sentimentSeries: t.sentiment.length,
	};
	return { html: emailLayout(title, inner), summary, title };
}

function periodFor(freq: string, now = new Date()) {
	const to = new Date(now);
	const from = new Date(now);
	if (freq === 'daily') from.setUTCDate(from.getUTCDate() - 1);
	else if (freq === 'weekly') from.setUTCDate(from.getUTCDate() - 7);
	else from.setUTCMonth(from.getUTCMonth() - 1);
	return { from, to };
}

export async function runSchedule(scheduleId: number, force = false) {
	const s = await one<any>('select * from report_schedules where id=$1', [scheduleId]);
	if (!s) throw new Error('Schedule not found');
	const { from, to } = periodFor(s.frequency);
	const r = await buildReport(s.org_id, from, to, s.filters || {});
	const label = s.frequency === 'daily' ? 'Daily' : s.frequency === 'weekly' ? 'Weekly' : 'Monthly';
	let status = 'skipped';
	try {
		status = await sendEmail(s.recipients || [], `${label} remail report: ${r.summary.red} red, ${r.summary.negativePct}% negative`, r.html);
	} catch (e: any) {
		status = `error: ${e.message}`.slice(0, 200);
	}
	const run = await one<any>(
		`insert into report_runs (org_id, schedule_id, period_start, period_end, html, summary, recipients, delivery_status)
		 values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
		[s.org_id, s.id, from, to, r.html, JSON.stringify(r.summary), s.recipients || [], status],
	);
	if (!force) await q('update report_schedules set last_run_at=now() where id=$1', [s.id]);
	return { runId: run!.id, status };
}

/** Called hourly: run any schedule that is due this hour and has not run yet. */
export async function runDueReports(orgId: number) {
	const now = new Date();
	const rows = await q<any>(
		`select * from report_schedules where org_id=$1 and enabled and hour_utc <= $2
		   and (last_run_at is null or last_run_at < date_trunc('day', now()))`,
		[orgId, now.getUTCHours()],
	);
	let ran = 0;
	for (const s of rows) {
		const dow = now.getUTCDay();
		const dom = now.getUTCDate();
		if (s.frequency === 'weekly' && s.day_of_week !== dow) continue;
		if (s.frequency === 'monthly' && s.day_of_month !== dom) continue;
		await runSchedule(s.id);
		ran++;
	}
	return ran;
}
