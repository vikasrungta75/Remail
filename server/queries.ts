import { q, one } from './db';
import type { SessionUser } from './auth';
import { mailboxScope } from './auth';
import { listParam } from './http';
import { getOrg } from './settings';

export interface Filter {
	where: string[];
	params: unknown[];
	from: Date;
	to: Date;
}

const p = (f: Filter, v: unknown) => {
	f.params.push(v);
	return `$${f.params.length}`;
};

/** Conversation-level filter from query string + the user's mailbox scope. Alias: c */
export async function convFilter(user: SessionUser, qs: URLSearchParams, opts: { dateField?: string; ignoreDates?: boolean } = {}): Promise<Filter> {
	const to = qs.get('to') ? endOfDay(new Date(qs.get('to')!)) : new Date();
	const from = qs.get('from') ? new Date(qs.get('from')!) : new Date(to.getTime() - 30 * 86400_000);
	const f: Filter = { where: [], params: [], from, to };
	f.where.push(`c.org_id = ${p(f, user.orgId)}`);
	f.where.push(`c.message_count > 0`);
	// audience: customers (default, customer-health views) · all (comprehensive) · internal · automated
	const audience = qs.get('audience') || (qs.get('internal') === 'true' ? 'all' : 'customers');
	if (audience === 'customers') f.where.push(`exists (select 1 from customers k where k.id=c.customer_id and k.kind='customer')`);
	else if (audience === 'external') f.where.push(`c.customer_id is not null`);
	else if (audience === 'internal') f.where.push(`c.is_internal`);
	else if (audience === 'automated') f.where.push(`c.is_automated`);
	else if (audience === 'human') f.where.push(`not c.is_automated`);
	const types = listParam(qs.get('type'));
	if (types.length) f.where.push(`c.business_category = any(${p(f, types)})`);
	// individual view: threads I took part in, am assigned to, or that came from a mailbox I connected
	if (qs.get('view') === 'me') {
		const ids = [user.email.toLowerCase(), ...((await one<any>('select email_aliases from users where id=$1', [user.id]))?.email_aliases || [])];
		const me = p(f, ids);
		const uid = p(f, user.id);
		f.where.push(`(c.participants && ${me}::text[] or c.staff_participants && ${me}::text[] or c.assignee_id = ${uid}
			or c.mailbox_ids && (select coalesce(array_agg(id), '{}') from mailboxes where created_by = ${uid} and provider in ('microsoft','gmail')))`);
	}
	const scope = await mailboxScope(user);
	if (scope) f.where.push(`c.mailbox_ids && ${p(f, scope)}::bigint[]`);
	if (!opts.ignoreDates) {
		const field = opts.dateField || 'c.last_message_at';
		f.where.push(`${field} >= ${p(f, from)}`);
		f.where.push(`${field} <= ${p(f, to)}`);
	}
	const ids = (k: string) => listParam(qs.get(k)).map(Number).filter(Number.isFinite);
	if (ids('customer').length) f.where.push(`c.customer_id = any(${p(f, ids('customer'))}::bigint[])`);
	if (ids('mailbox').length) f.where.push(`c.mailbox_ids && ${p(f, ids('mailbox'))}::bigint[]`);
	const vals = (k: string, allowed: string[]) => listParam(qs.get(k)).filter((v) => allowed.includes(v));
	const sent = vals('sentiment', ['positive', 'neutral', 'negative']);
	if (sent.length) f.where.push(`c.sentiment = any(${p(f, sent)})`);
	const rag = vals('rag', ['red', 'amber', 'green']);
	if (rag.length) f.where.push(`c.rag = any(${p(f, rag)})`);
	const status = vals('status', ['open', 'in_progress', 'resolved', 'ignored']);
	if (status.length) f.where.push(`c.status = any(${p(f, status)})`);
	else if (qs.get('includeIgnored') !== 'true') f.where.push(`c.status <> 'ignored'`);
	const state = vals('state', ['satisfied', 'neutral', 'at_risk', 'dissatisfied']);
	if (state.length) f.where.push(`c.customer_state = any(${p(f, state)})`);
	const cats = listParam(qs.get('category'));
	if (cats.length) f.where.push(`c.categories && ${p(f, cats)}::text[]`);
	const tier = vals('tier', ['strategic', 'key', 'standard']);
	if (tier.length) f.where.push(`exists (select 1 from customers t where t.id=c.customer_id and t.tier = any(${p(f, tier)}))`);
	if (qs.get('awaiting') === 'true') f.where.push(`c.awaiting_reply`);
	if (qs.get('assignee') === 'me') f.where.push(`c.assignee_id = ${p(f, user.id)}`);
	const search = (qs.get('q') || '').trim();
	if (search) {
		const like = p(f, `%${search.replace(/[%_]/g, '\\$&')}%`);
		f.where.push(`(c.subject ilike ${like} or c.summary ilike ${like} or exists (select 1 from customers s where s.id=c.customer_id and s.name ilike ${like})
			or exists (select 1 from emails se where se.conversation_id=c.id and (se.from_address ilike ${like} or se.body_clean ilike ${like})))`);
	}
	return f;
}

function endOfDay(d: Date) {
	const x = new Date(d);
	if (x.getUTCHours() === 0 && x.getUTCMinutes() === 0) x.setUTCHours(23, 59, 59, 999);
	return x;
}

const W = (f: Filter) => f.where.join(' and ');

export async function dashboardSummary(user: SessionUser, qs: URLSearchParams) {
	const f = await convFilter(user, qs);
	const org = await getOrg(user.orgId);
	const span = f.to.getTime() - f.from.getTime();
	const prevQs = new URLSearchParams(qs);
	prevQs.set('from', new Date(f.from.getTime() - span).toISOString());
	prevQs.set('to', new Date(f.from.getTime() - 1).toISOString());
	const fp = await convFilter(user, prevQs);

	const kpiSql = (flt: Filter) => `
		select
		  count(*)::int as conversations,
		  count(*) filter (where c.rag='red')::int as red,
		  count(*) filter (where c.rag='amber')::int as amber,
		  count(*) filter (where c.rag='green')::int as green,
		  count(*) filter (where c.rag is null)::int as pending,
		  count(*) filter (where c.sentiment='negative')::int as negative,
		  count(*) filter (where c.sentiment='positive')::int as positive,
		  count(*) filter (where c.sentiment='neutral')::int as neutral,
		  count(*) filter (where c.awaiting_reply and c.status in ('open','in_progress'))::int as awaiting,
		  count(*) filter (where c.awaiting_reply and c.status in ('open','in_progress') and c.last_inbound_at < now() - make_interval(hours => ${org.settings.slaHours}))::int as sla_breaches,
		  round(avg(c.first_response_minutes))::int as avg_first_response_min,
		  round(percentile_cont(0.5) within group (order by c.first_response_minutes))::int as median_first_response_min,
		  count(distinct c.customer_id)::int as customers,
		  coalesce(sum(c.message_count),0)::int as emails,
		  coalesce(sum(c.duplicate_count),0)::int as duplicates
		from conversations c where ${W(flt)}`;
	const [cur, prev] = await Promise.all([one<any>(kpiSql(f), f.params), one<any>(kpiSql(fp), fp.params)]);

	const atRisk = await one<any>(
		`select count(*) filter (where cu.health_status in ('at_risk'))::int as at_risk,
		        count(*) filter (where cu.health_status = 'dissatisfied')::int as dissatisfied,
		        count(*) filter (where cu.health_status = 'satisfied')::int as satisfied,
		        count(*) filter (where cu.health_status = 'neutral')::int as neutral,
		        round(avg(cu.health_score))::int as avg_health
		   from customers cu where cu.id in (select distinct c.customer_id from conversations c where ${W(f)})`,
		f.params,
	);
	const actions = await one<any>(
		`select count(*) filter (where a.status='open')::int as open,
		        count(*) filter (where a.status='open' and a.due_date < current_date)::int as overdue,
		        count(*) filter (where a.status='open' and a.is_commitment and a.owner_side='us')::int as commitments
		   from action_items a join conversations c on c.id=a.conversation_id where ${W(f)}`,
		f.params,
	);
	const alerts = await one<any>(
		`select count(*) filter (where status='open')::int as open, count(*) filter (where status='open' and severity='critical')::int as critical
		   from alerts where org_id=$1 and created_at > now() - interval '30 days'`,
		[user.orgId],
	);
	const critical = await q<any>(
		`select c.id, c.subject, c.summary, c.rag, c.rag_reason, c.sentiment, c.urgency, c.escalation_risk, c.priority_score,
		        c.last_message_at, c.awaiting_reply, c.last_inbound_at, c.status, c.categories, cu.name as customer_name, cu.tier as customer_tier, c.customer_id
		   from conversations c left join customers cu on cu.id=c.customer_id
		  where ${W(f)} and c.rag in ('red','amber') and c.status in ('open','in_progress')
		  order by c.priority_score desc, c.last_message_at desc limit 8`,
		f.params,
	);
	const syncInfo = await one<any>(`select max(last_synced_at) as last_synced_at, count(*)::int as mailboxes from mailboxes where org_id=$1 and status <> 'paused'`, [user.orgId]);
	return { period: { from: f.from, to: f.to }, kpis: cur, previous: prev, customers: atRisk, actions, alerts, critical, sync: syncInfo, slaHours: org.settings.slaHours };
}

export async function dashboardTrends(user: SessionUser, qs: URLSearchParams) {
	const f = await convFilter(user, qs);
	const days = (f.to.getTime() - f.from.getTime()) / 86400_000;
	const bucket = qs.get('bucket') || (days > 92 ? 'week' : 'day');
	const trunc = bucket === 'week' ? 'week' : bucket === 'month' ? 'month' : 'day';
	const ef = { ...f, params: [...f.params] };

	const sentiment = await q<any>(
		`select date_trunc('${trunc}', e.sent_at) as bucket,
		        count(*) filter (where e.sentiment='positive')::int as positive,
		        count(*) filter (where e.sentiment='neutral')::int as neutral,
		        count(*) filter (where e.sentiment='negative')::int as negative,
		        count(*)::int as total,
		        round(avg(e.sentiment_score)::numeric, 3)::float as avg_score
		   from emails e join conversations c on c.id=e.conversation_id
		  where ${W(ef)} and e.direction='inbound' and not e.is_duplicate and e.sent_at between $${ef.params.push(f.from)} and $${ef.params.push(f.to)}
		  group by 1 order by 1`,
		ef.params,
	);
	const rag = await q<any>(
		`select date_trunc('${trunc}', c.last_message_at) as bucket,
		        count(*) filter (where c.rag='red')::int as red,
		        count(*) filter (where c.rag='amber')::int as amber,
		        count(*) filter (where c.rag='green')::int as green
		   from conversations c where ${W(f)} group by 1 order by 1`,
		f.params,
	);
	const categories = await q<any>(
		`select i.category, count(*)::int as count,
		        count(*) filter (where i.severity in ('high','critical'))::int as severe,
		        count(distinct i.customer_id)::int as customers
		   from issues i join conversations c on c.id=i.conversation_id
		  where ${W(f)} group by 1 order by 2 desc`,
		f.params,
	);
	const g = { ...f, params: [...f.params] };
	const mailboxes = await q<any>(
		`select m.id, m.address, m.display_name, count(e.id)::int as emails,
		        count(e.id) filter (where e.is_duplicate)::int as duplicates,
		        count(e.id) filter (where e.sentiment='negative')::int as negative
		   from emails e join mailboxes m on m.id=e.mailbox_id join conversations c on c.id=e.conversation_id
		  where ${W(g)} and e.sent_at between $${g.params.push(f.from)} and $${g.params.push(f.to)}
		  group by m.id order by 4 desc`,
		g.params,
	);
	const h = { ...f, params: [...f.params] };
	const health = await q<any>(
		`select date_trunc('${trunc}', d.day::timestamptz) as bucket, round(avg(d.health_score))::int as avg_health,
		        count(*) filter (where d.health_score < 55)::int as at_risk
		   from customer_health_daily d
		  where d.customer_id in (select distinct c.customer_id from conversations c where ${W(h)})
		    and d.day between $${h.params.push(f.from)}::date and $${h.params.push(f.to)}::date
		  group by 1 order by 1`,
		h.params,
	);
	return { bucket: trunc, sentiment, rag, categories, mailboxes, health };
}

/** Recurring issues and emerging topics: current period vs previous period. */
export async function insights(user: SessionUser, qs: URLSearchParams) {
	const f = await convFilter(user, qs);
	const span = f.to.getTime() - f.from.getTime();
	const pq = new URLSearchParams(qs);
	pq.set('from', new Date(f.from.getTime() - span).toISOString());
	pq.set('to', new Date(f.from.getTime() - 1).toISOString());
	const fp = await convFilter(user, pq);
	const catSql = (flt: Filter) =>
		`select i.category, count(*)::int n, count(distinct c.customer_id)::int customers from issues i join conversations c on c.id=i.conversation_id where ${W(flt)} group by 1`;
	const [cur, prev] = await Promise.all([q<any>(catSql(f), f.params), q<any>(catSql(fp), fp.params)]);
	const prevMap = new Map(prev.map((r) => [r.category, r.n]));
	const categoryChange = cur
		.map((r) => ({ ...r, previous: prevMap.get(r.category) || 0, change: r.n - (prevMap.get(r.category) || 0) }))
		.sort((a, b) => b.n - a.n);

	const recurring = await q<any>(
		`select cu.id as customer_id, cu.name as customer_name, cu.tier, i.category, count(distinct c.id)::int as conversations,
		        max(c.last_message_at) as last_seen, array_agg(distinct c.id) as conversation_ids
		   from issues i join conversations c on c.id=i.conversation_id join customers cu on cu.id=c.customer_id
		  where ${W(f)}
		  group by cu.id, i.category having count(distinct c.id) >= 2
		  order by 5 desc, 6 desc limit 25`,
		f.params,
	);
	const topics = await q<any>(
		`select t as topic, count(*)::int as n from conversations c, unnest(c.topics) t where ${W(f)} group by t order by 2 desc limit 30`,
		f.params,
	);
	const tp = await q<any>(
		`select t as topic, count(*)::int as n from conversations c, unnest(c.topics) t where ${W(fp)} group by t`,
		fp.params,
	);
	const tpm = new Map(tp.map((r) => [r.topic, r.n]));
	const emerging = topics
		.map((t) => ({ ...t, previous: tpm.get(t.topic) || 0 }))
		.filter((t) => t.n >= 2 && t.n >= (t.previous || 0) * 1.5)
		.slice(0, 10);
	const heat = await q<any>(
		`select date_trunc('week', c.last_message_at) as week, i.category, count(*)::int n
		   from issues i join conversations c on c.id=i.conversation_id where ${W(f)} group by 1,2 order by 1`,
		f.params,
	);
	const worstCustomers = await q<any>(
		`select cu.id, cu.name, cu.tier, cu.health_score, cu.health_status, count(distinct c.id)::int conversations,
		        count(distinct c.id) filter (where c.rag='red')::int red, count(i.id)::int issues
		   from conversations c join customers cu on cu.id=c.customer_id left join issues i on i.conversation_id=c.id
		  where ${W(f)} group by cu.id order by red desc, issues desc limit 10`,
		f.params,
	);
	return { categoryChange, recurring, topics, emerging, heat, worstCustomers };
}

export async function filterOptions(user: SessionUser) {
	const scope = await mailboxScope(user);
	const mailboxes = await q<any>(
		`select id, address, display_name, provider, status from mailboxes where org_id=$1 ${scope ? 'and id = any($2)' : ''} order by address`,
		scope ? [user.orgId, scope] : [user.orgId],
	);
	const customers = await q<any>(
		`select id, name, tier, health_status from customers where org_id=$1 and exists (select 1 from conversations c where c.customer_id=customers.id) order by name limit 2000`,
		[user.orgId],
	);
	const users = await q<any>(`select id, full_name, email from users where org_id=$1 and is_active order by full_name`, [user.orgId]);
	return { mailboxes, customers, users };
}
