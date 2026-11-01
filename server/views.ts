/** Comprehensive (all-email), individual (my day), proposal pipeline and team views. */
import { one, q } from './db';
import type { SessionUser } from './auth';
import { convFilter } from './queries';
import { getOrg } from './settings';
import { BUSINESS_CATEGORIES, BUSINESS_LABELS } from './ai/types';
import { GROUP_DESCRIPTIONS, SUBCATEGORIES } from './ai/taxonomy';

const W = (f: { where: string[] }) => f.where.join(' and ');

/** Every category of email side by side — customer issues, proposals, operations, finance, internal… */
export async function categoriesOverview(user: SessionUser, qs: URLSearchParams) {
	const a = new URLSearchParams(qs);
	if (!a.get('audience')) a.set('audience', 'all');
	const f = await convFilter(user, a);
	const org = await getOrg(user.orgId);
	const rows = await q<any>(
		`select c.business_category as category,
		        count(*)::int as conversations,
		        coalesce(sum(c.message_count),0)::int as emails,
		        count(*) filter (where c.awaiting_reply and c.status in ('open','in_progress'))::int as awaiting,
		        count(*) filter (where c.awaiting_reply and c.status in ('open','in_progress') and c.last_inbound_at < now() - make_interval(hours => ${org.settings.slaHours}))::int as overdue_replies,
		        count(*) filter (where c.sentiment='negative')::int as negative,
		        count(*) filter (where c.rag='red' and c.status in ('open','in_progress'))::int as red,
		        count(*) filter (where c.status in ('open','in_progress'))::int as open,
		        max(c.last_message_at) as last_activity,
		        (select count(*) from action_items ai where ai.status='open' and ai.conversation_id = any(array_agg(c.id)))::int as open_actions
		   from conversations c where ${W(f)} group by 1`,
		f.params,
	);
	const recent = await q<any>(
		`select * from (
		   select c.id, c.business_category, c.subject, c.summary, c.rag, c.sentiment, c.last_message_at, c.awaiting_reply, c.is_internal, c.is_automated,
		          cu.name as customer_name, row_number() over (partition by c.business_category order by c.priority_score desc, c.last_message_at desc) rn
		     from conversations c left join customers cu on cu.id=c.customer_id where ${W(f)}
		 ) x where rn <= 4 order by last_message_at desc`,
		f.params,
	);
	const ef = { ...f, params: [...f.params] };
	const trend = await q<any>(
		`select date_trunc('day', e.sent_at) as bucket, c.business_category as category, count(*)::int as n
		   from emails e join conversations c on c.id=e.conversation_id
		  where ${W(ef)} and not e.is_duplicate and e.sent_at between $${ef.params.push(f.from)} and $${ef.params.push(f.to)}
		  group by 1,2 order by 1`,
		ef.params,
	);
	const audience = await one<any>(
		`select count(*) filter (where c.customer_id is not null)::int as external,
		        count(*) filter (where c.is_internal)::int as internal,
		        count(*) filter (where c.is_automated)::int as automated,
		        coalesce(sum(c.message_count),0)::int as emails,
		        coalesce(sum(c.duplicate_count),0)::int as duplicates
		   from conversations c where ${W(f)}`,
		f.params,
	);
	const byCat = new Map(rows.map((r) => [r.category, r]));
	return {
		categories: BUSINESS_CATEGORIES.map((c) => ({
			category: c,
			...(byCat.get(c) || { conversations: 0, emails: 0, awaiting: 0, overdue_replies: 0, negative: 0, red: 0, open: 0, open_actions: 0, last_activity: null }),
			recent: recent.filter((r) => r.business_category === c),
		})),
		trend,
		audience,
	};
}

/** The signed-in person's day: what is waiting on me, what I promised, what is due. */
export async function myDay(user: SessionUser) {
	const qs = new URLSearchParams({ view: 'me', audience: 'all', from: new Date(Date.now() - 90 * 86400_000).toISOString() });
	const f = await convFilter(user, qs);
	const org = await getOrg(user.orgId);
	const awaiting = await q<any>(
		`select c.id, c.subject, c.summary, c.rag, c.sentiment, c.urgency, c.business_category, c.last_inbound_at, c.priority_score,
		        cu.name as customer_name, cu.tier as customer_tier
		   from conversations c left join customers cu on cu.id=c.customer_id
		  where ${W(f)} and c.awaiting_reply and c.status in ('open','in_progress') and not c.is_automated
		  order by c.priority_score desc, c.last_inbound_at asc limit 25`,
		f.params,
	);
	const ids = [user.email.toLowerCase(), ...((await one<any>('select email_aliases from users where id=$1', [user.id]))?.email_aliases || [])];
	const actions = await q<any>(
		`select a.*, c.subject, c.rag, c.business_category, cu.name as customer_name
		   from action_items a left join conversations c on c.id=a.conversation_id left join customers cu on cu.id=a.customer_id
		  where a.org_id=$1 and a.status='open' and a.owner_side='us'
		    and (a.assignee_id=$2 or (a.assignee_id is null and (a.created_by=$2 or c.assignee_id=$2 or c.staff_participants && $3::text[])))
		  order by a.due_date nulls last, a.created_at desc limit 60`,
		[user.orgId, user.id, ids],
	);
	const proposals = await q<any>(
		`select c.id, c.subject, c.proposal, c.proposal_stage, c.last_message_at, cu.name as customer_name
		   from conversations c left join customers cu on cu.id=c.customer_id
		  where ${W(f)} and c.business_category='sales_proposal' and coalesce(c.proposal_stage,'') not in ('won','lost')
		  order by (c.proposal->>'deadline') nulls last, c.last_message_at desc limit 15`,
		f.params,
	);
	const today = new Date().toISOString().slice(0, 10);
	const stats = await one<any>(
		`select count(*)::int as conversations,
		        count(*) filter (where c.last_message_at > now() - interval '24 hours')::int as last_24h,
		        count(*) filter (where c.rag='red' and c.status in ('open','in_progress'))::int as red,
		        count(*) filter (where c.awaiting_reply and c.status in ('open','in_progress') and c.last_inbound_at < now() - make_interval(hours => ${org.settings.slaHours}))::int as sla_breaches
		   from conversations c where ${W(f)}`,
		f.params,
	);
	const recent = await q<any>(
		`select c.id, c.subject, c.summary, c.rag, c.business_category, c.last_message_at, c.is_internal, cu.name as customer_name
		   from conversations c left join customers cu on cu.id=c.customer_id
		  where ${W(f)} and not c.is_automated order by c.last_message_at desc limit 12`,
		f.params,
	);
	return {
		stats: {
			...stats,
			awaiting: awaiting.length,
			actionsOpen: actions.length,
			actionsOverdue: actions.filter((a) => a.due_date && a.due_date < today).length,
			actionsToday: actions.filter((a) => a.due_date === today).length,
		},
		awaiting, actions, proposals, recent, slaHours: org.settings.slaHours,
	};
}

/** Quotes, RFQs, tenders and proposals by stage. */
export async function proposals(user: SessionUser, qs: URLSearchParams) {
	const a = new URLSearchParams(qs);
	a.set('audience', 'all');
	a.set('type', 'sales_proposal');
	const f = await convFilter(user, a);
	const rows = await q<any>(
		`select c.id, c.subject, c.summary, c.proposal, coalesce(c.proposal_stage, 'request_received') as stage, c.proposal_stage_locked,
		        c.last_message_at, c.first_message_at, c.awaiting_reply, c.rag, c.sentiment, c.status, c.is_internal, c.mailbox_ids, c.urgency,
		        cu.id as customer_id, cu.name as customer_name, cu.tier as customer_tier, u.full_name as assignee_name, c.assignee_id
		   from conversations c left join customers cu on cu.id=c.customer_id left join users u on u.id=c.assignee_id
		  where ${W(f)} order by (c.proposal->>'deadline') nulls last, c.last_message_at desc limit 500`,
		f.params,
	);
	return { rows };
}

/** Workload and responsiveness per team member, derived from who actually replied. */
export async function team(user: SessionUser, qs: URLSearchParams) {
	const a = new URLSearchParams(qs);
	if (!a.get('audience')) a.set('audience', 'customers');
	const f = await convFilter(user, a);
	const ef = { ...f, params: [...f.params] };
	const replies = await q<any>(
		`with inbound as (
		   select e.conversation_id, e.sent_at from emails e join conversations c on c.id=e.conversation_id
		    where ${W(ef)} and e.direction='inbound' and not e.is_duplicate and e.sent_at between $${ef.params.push(f.from)} and $${ef.params.push(f.to)}
		 ), answered as (
		   select i.conversation_id, i.sent_at as asked, r.from_address, r.from_name, r.sent_at as replied
		     from inbound i cross join lateral (
		       select o.from_address, o.from_name, o.sent_at from emails o
		        where o.conversation_id=i.conversation_id and o.direction='outbound' and not o.is_duplicate and o.sent_at > i.sent_at
		        order by o.sent_at limit 1) r
		 )
		 select lower(from_address) as email, max(from_name) as name, count(*)::int as replies,
		        round(avg(extract(epoch from (replied - asked))/60))::int as avg_response_min,
		        round(percentile_cont(0.5) within group (order by extract(epoch from (replied - asked))/60))::int as median_response_min,
		        count(distinct conversation_id)::int as conversations
		   from answered group by 1 order by replies desc limit 100`,
		ef.params,
	);
	const users = await q<any>(`select id, email, full_name, role, email_aliases from users where org_id=$1 and is_active`, [user.orgId]);
	const workload = await q<any>(
		`select u.id,
		        (select count(*) from conversations c where c.assignee_id=u.id and c.status in ('open','in_progress'))::int as assigned_open,
		        (select count(*) from action_items x where x.assignee_id=u.id and x.status='open')::int as actions_open,
		        (select count(*) from action_items x where x.assignee_id=u.id and x.status='open' and x.due_date < current_date)::int as actions_overdue,
		        (select count(*) from action_items x where x.assignee_id=u.id and x.status='done' and x.completed_at > now() - interval '30 days')::int as actions_done_30d,
		        (select count(*) from conversations c where c.status in ('open','in_progress') and c.awaiting_reply and (lower(u.email) = any(c.staff_participants) or c.assignee_id=u.id))::int as awaiting
		   from users u where u.org_id=$1 and u.is_active`,
		[user.orgId],
	);
	const wl = new Map(workload.map((w) => [w.id, w]));
	const people = new Map<string, any>();
	for (const r of replies) people.set(r.email, { email: r.email, name: r.name, ...r });
	for (const u of users) {
		const keys = [u.email.toLowerCase(), ...(u.email_aliases || [])];
		const hit = keys.map((k) => people.get(k)).find(Boolean);
		const base = hit || { email: u.email.toLowerCase(), name: u.full_name, replies: 0, conversations: 0, avg_response_min: null, median_response_min: null };
		people.set(base.email, { ...base, name: u.full_name || base.name, userId: u.id, role: u.role, ...(wl.get(u.id) || {}) });
	}
	return { rows: [...people.values()].sort((x, y) => (y.replies || 0) - (x.replies || 0)) };
}

/**
 * Category report: headings are the groups, subheadings the subgroups, each with volumes, waiting
 * replies, negative and red threads, response time, drafts waiting and the latest subjects.
 */
export async function categoryReport(user: SessionUser, qs: URLSearchParams) {
	const a = new URLSearchParams(qs);
	if (!a.get('audience')) a.set('audience', 'all');
	const f = await convFilter(user, a);
	const org = await getOrg(user.orgId);
	const rows = await q<any>(
		`select c.business_category as grp, coalesce(c.subcategory, '') as sub,
		        count(*)::int as conversations,
		        coalesce(sum(c.message_count),0)::int as emails,
		        count(*) filter (where c.awaiting_reply and c.status in ('open','in_progress'))::int as awaiting,
		        count(*) filter (where c.awaiting_reply and c.status in ('open','in_progress') and c.last_inbound_at < now() - make_interval(hours => ${org.settings.slaHours}))::int as overdue_replies,
		        count(*) filter (where c.sentiment='negative')::int as negative,
		        count(*) filter (where c.rag='red' and c.status in ('open','in_progress'))::int as red,
		        round(avg(c.first_response_minutes) / 60.0, 1)::float as avg_first_response_hours,
		        count(d.id) filter (where d.status='draft')::int as drafts_waiting
		   from conversations c left join reply_drafts d on d.conversation_id=c.id
		  where ${W(f)} group by 1,2`,
		f.params,
	);
	const recent = await q<any>(
		`select * from (
		   select c.id, c.business_category as grp, coalesce(c.subcategory,'') as sub, c.subject, c.rag, c.last_message_at, cu.name as customer_name,
		          row_number() over (partition by c.business_category, c.subcategory order by c.last_message_at desc) rn
		     from conversations c left join customers cu on cu.id=c.customer_id where ${W(f)}
		 ) x where rn <= 3`,
		f.params,
	);
	// weekly volume per group for the last 12 weeks (trend lines)
	const weeks = await q<any>(
		`select c.business_category as grp, floor(extract(epoch from (date_trunc('week', now()) - date_trunc('week', c.first_message_at))) / 604800)::int as ago, count(*)::int as n
		   from conversations c where ${W(f)} and c.first_message_at > date_trunc('week', now()) - interval '11 weeks'
		  group by 1,2`,
		f.params,
	);
	const weekly = (g: string) => Array.from({ length: 12 }, (_x, i) => weeks.find((w) => w.grp === g && w.ago === 11 - i)?.n || 0);
	const zero = { conversations: 0, emails: 0, awaiting: 0, overdue_replies: 0, negative: 0, red: 0, avg_first_response_hours: null, drafts_waiting: 0 };
	const sum = (list: any[], k: string) => list.reduce((n, x) => n + (Number(x[k]) || 0), 0);
	const groups = BUSINESS_CATEGORIES.map((g) => {
		const defs = [...SUBCATEGORIES[g]];
		// threads not yet given a subgroup are shown as their own line until the background back-fill reaches them
		if (rows.some((r) => r.grp === g && (!r.sub || !defs.some((d) => d.key === r.sub)))) defs.push({ key: '', label: 'Not yet sorted', description: 'Waiting for the background job to assign a subgroup.', replies: false });
		const subgroups = defs.map((d) => {
			const m = rows.filter((r) => r.grp === g && (d.key ? r.sub === d.key : !SUBCATEGORIES[g].some((x) => x.key === r.sub)));
			const st = m.length ? {
				conversations: sum(m, 'conversations'), emails: sum(m, 'emails'), awaiting: sum(m, 'awaiting'), overdue_replies: sum(m, 'overdue_replies'),
				negative: sum(m, 'negative'), red: sum(m, 'red'), drafts_waiting: sum(m, 'drafts_waiting'),
				avg_first_response_hours: m.find((x) => x.avg_first_response_hours !== null)?.avg_first_response_hours ?? null,
			} : zero;
			return { key: d.key, label: d.label, description: d.description, ...st, recent: recent.filter((r) => r.grp === g && r.sub === d.key) };
		});
		const total = { conversations: sum(subgroups, 'conversations'), emails: sum(subgroups, 'emails'), awaiting: sum(subgroups, 'awaiting'), overdue_replies: sum(subgroups, 'overdue_replies'), negative: sum(subgroups, 'negative'), red: sum(subgroups, 'red'), drafts_waiting: sum(subgroups, 'drafts_waiting') };
		return { key: g, label: BUSINESS_LABELS[g], description: GROUP_DESCRIPTIONS[g], ...total, subgroups, weekly: weekly(g) };
	});
	const totals = { conversations: sum(groups, 'conversations'), emails: sum(groups, 'emails'), awaiting: sum(groups, 'awaiting'), overdue_replies: sum(groups, 'overdue_replies'), negative: sum(groups, 'negative'), red: sum(groups, 'red'), drafts_waiting: sum(groups, 'drafts_waiting') };
	return { from: f.from, to: f.to, totals, groups: groups.sort((x, y) => y.conversations - x.conversations) };
}
