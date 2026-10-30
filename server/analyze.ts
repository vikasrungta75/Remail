import { one, q } from './db';
import { analyseThread } from './ai/llm';
import { heuristicAnalyse } from './ai/heuristic';
import type { ThreadInput } from './ai/types';
import { getOrg } from './settings';
import { score, healthScore, healthStatus } from './scoring';
import { redactPII, snippet } from './text';
import { sha256 } from './crypto';
import { evaluateConversationAlerts, evaluateHealthAlert } from './alerts';

const MAX_MESSAGES = 14;

export async function analysePending(orgId: number, limit = 25, deadline = Date.now() + 60_000) {
	const rows = await q<{ id: number }>(
		`select id from conversations where org_id=$1 and needs_analysis and message_count > 0
		 order by last_message_at desc limit $2`,
		[orgId, limit],
	);
	let done = 0;
	const customers = new Set<number>();
	for (const r of rows) {
		if (Date.now() > deadline) break;
		try {
			const cid = await analyseConversation(r.id);
			if (cid) customers.add(cid);
			done++;
		} catch (e: any) {
			console.error('[analyse] conversation', r.id, e.message);
			await q('update conversations set needs_analysis=false, rag_reason=$2 where id=$1', [r.id, `Analysis failed: ${e.message}`.slice(0, 300)]);
		}
	}
	for (const c of customers) await updateCustomerHealth(c);
	return done;
}

export async function analyseConversation(conversationId: number): Promise<number | null> {
	const conv = await one<any>(
		`select c.*, cu.name as customer_name, cu.tier as customer_tier
		   from conversations c left join customers cu on cu.id = c.customer_id where c.id=$1`,
		[conversationId],
	);
	if (!conv) return null;
	const org = await getOrg(conv.org_id);
	const emails = await q<any>(
		`select id, direction, from_address, from_name, sent_at, subject, body_clean, body_text
		   from emails where conversation_id=$1 and not is_duplicate order by sent_at desc limit ${MAX_MESSAGES}`,
		[conversationId],
	);
	emails.reverse();
	if (!emails.length) return null;

	const input: ThreadInput = {
		conversationId,
		customerName: conv.customer_name || '',
		customerTier: conv.customer_tier || 'standard',
		orgName: org.name,
		isInternal: !conv.customer_id || conv.is_internal,
		isAutomated: !!conv.is_automated,
		messages: emails.map((e, idx) => {
			const body = (e.body_clean || e.body_text || '').slice(0, 3000);
			return {
				index: idx,
				emailId: e.id,
				direction: e.direction,
				from: e.from_address,
				fromName: e.from_name,
				sentAt: new Date(e.sent_at).toISOString(),
				subject: e.subject,
				body: org.settings.piiRedaction ? redactPII(body) : body,
			};
		}),
	};

	// Automated notifications never need an AI call — the rules engine is enough
	const { analysis, model } = input.isAutomated
		? { analysis: heuristicAnalyse(input), model: 'remail-heuristic-v1' }
		: await analyseThread(input, org.id);
	const external = !input.isInternal && !input.isAutomated;
	if (!external) {
		// internal and automated threads are not rated as customer risk
		analysis.legal_or_churn_signal = false;
		if (input.isAutomated) { analysis.action_items = []; analysis.issues = []; analysis.requires_reply = false; }
	}

	if (conv.awaiting_reply && !analysis.requires_reply) conv.awaiting_reply = false;
	const hoursWaiting = conv.awaiting_reply && conv.last_inbound_at
		? (Date.now() - new Date(conv.last_inbound_at).getTime()) / 3600_000
		: 0;
	const s = score({
		analysis,
		awaitingReply: conv.awaiting_reply,
		hoursWaiting,
		slaHours: org.settings.slaHours,
		tier: conv.customer_tier || 'standard',
		inboundCount: conv.inbound_count,
	});

	await q(
		`update conversations set summary=$2, sentiment=$3, sentiment_score=$4, rag=$5, rag_reason=$6, customer_state=$7,
		   urgency=$8, escalation_risk=$9, priority_score=$10, categories=$11, topics=$12, entities=$13, suggested_reply=$14,
		   analysis_model=$15, analysed_at=now(), needs_analysis=false, awaiting_reply=$16, updated_at=now(),
		   business_category = case when category_locked then business_category else $17 end,
		   proposal = $18,
		   proposal_stage = case when proposal_stage_locked then proposal_stage else $19 end
		 where id=$1`,
		[
			conversationId, analysis.summary, analysis.sentiment, analysis.sentiment_score, s.rag,
			[...new Set([analysis.rag_reason, ...s.reasons])].filter((r, i, a) => !(i > 0 && /legal|cancellation/i.test(r) && /legal|cancellation/i.test(a[0]))).join(' · ').slice(0, 800),
			s.customerState, analysis.urgency, analysis.escalation_risk, s.priority, analysis.categories,
			analysis.topics, JSON.stringify(analysis.entities), analysis.requires_reply ? analysis.suggested_reply : null, model,
			conv.awaiting_reply && external,
			analysis.business_category,
			analysis.proposal ? JSON.stringify(analysis.proposal) : null,
			analysis.proposal?.stage ?? null,
		],
	);

	// per-message sentiment (feeds trend charts)
	for (const ms of analysis.message_sentiments) {
		const em = input.messages[ms.index];
		if (em) await q('update emails set sentiment=$2, sentiment_score=$3 where id=$1', [em.emailId, ms.sentiment, ms.score]);
	}

	// issues: replace with latest view of the thread
	await q('delete from issues where conversation_id=$1', [conversationId]);
	for (const i of analysis.issues) {
		await q(
			`insert into issues (org_id, conversation_id, customer_id, category, description, severity, detected_at) values ($1,$2,$3,$4,$5,$6,$7)`,
			[conv.org_id, conversationId, conv.customer_id, i.category, i.description, i.severity, conv.last_message_at || new Date()],
		);
	}

	// action items: upsert by fingerprint so user status changes survive re-analysis
	const seen: string[] = [];
	for (const a of analysis.action_items) {
		const fp = sha256(a.description.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()).slice(0, 24);
		seen.push(fp);
		const src = a.message_index !== null && a.message_index !== undefined ? input.messages[a.message_index]?.emailId : null;
		await q(
			`insert into action_items (org_id, conversation_id, customer_id, description, owner_side, owner_name, is_commitment, due_date, fingerprint, source_email_id, assignee_id)
			 values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
			   case when $5 = 'us' then coalesce(
			     (select u.id from users u join emails e on e.id=$10 where u.org_id=$1 and u.is_active and $7 and (lower(u.email)=lower(e.from_address) or lower(e.from_address) = any(u.email_aliases)) limit 1),
			     (select assignee_id from conversations where id=$2),
			     (select m.created_by from emails e join mailboxes m on m.id=e.mailbox_id where e.id=$10 and m.provider in ('microsoft','gmail'))
			   ) end)
			 on conflict (conversation_id, fingerprint) do update set due_date = coalesce(excluded.due_date, action_items.due_date),
			   owner_name = coalesce(excluded.owner_name, action_items.owner_name), assignee_id = coalesce(action_items.assignee_id, excluded.assignee_id)`,
			[conv.org_id, conversationId, conv.customer_id, snippet(a.description, 400), a.owner_side, a.owner_name || null, a.is_commitment, a.due_date || null, fp, src],
		);
	}

	const updated = await one<any>(
		`select c.*, cu.name as customer_name, cu.tier as customer_tier from conversations c left join customers cu on cu.id=c.customer_id where c.id=$1`,
		[conversationId],
	);
	if (external) await evaluateConversationAlerts(updated, analysis);
	// classify the external organisation: customer, prospect, vendor or partner (unless set by a person)
	if (conv.customer_id) {
		await q(
			`update customers cu set kind = x.kind from (
			   select case
			     when count(*) filter (where business_category = 'vendor_partner') > count(*) / 2 then 'vendor'
			     when count(*) filter (where business_category = 'sales_proposal') = count(*) and not exists (select 1 from conversations c2 where c2.customer_id=$1 and c2.business_category in ('customer_service','operations','billing_finance')) then 'prospect'
			     when count(*) filter (where business_category = 'people_hr') = count(*) then 'candidate'
			     else 'customer' end as kind
			   from conversations where customer_id=$1) x
			 where cu.id=$1 and not cu.kind_locked`,
			[conv.customer_id],
		);
	}
	return conv.customer_id;
}

export async function updateCustomerHealth(customerId: number) {
	const c = await one<any>('select * from customers where id=$1', [customerId]);
	if (!c) return;
	const org = await getOrg(c.org_id);
	const days = org.settings.analysisWindowDays;
	const m = await one<any>(
		`select
		   coalesce((select avg(e.sentiment_score) from emails e join conversations cv on cv.id=e.conversation_id
		      where cv.customer_id=$1 and e.direction='inbound' and not e.is_duplicate and e.sentiment_score is not null
		        and e.sent_at > now() - make_interval(days => $2)), 0) as avg_sentiment,
		   (select count(*) from conversations where customer_id=$1 and rag='red' and status not in ('resolved','ignored') and last_message_at > now() - make_interval(days => $2))::int as red,
		   (select count(*) from conversations where customer_id=$1 and rag='amber' and status not in ('resolved','ignored') and last_message_at > now() - make_interval(days => $2))::int as amber,
		   (select count(*) from conversations where customer_id=$1 and sentiment='positive' and last_message_at > now() - make_interval(days => $2))::int as positive,
		   (select count(*) from conversations where customer_id=$1 and last_message_at > now() - make_interval(days => $2))::int as convs,
		   (select count(*) from conversations where customer_id=$1 and awaiting_reply and status not in ('resolved','ignored') and last_inbound_at < now() - make_interval(hours => $3))::int as sla,
		   (select count(*) from action_items where customer_id=$1 and status='open' and owner_side='us' and due_date < current_date)::int as overdue,
		   (select count(*) from emails e join conversations cv on cv.id=e.conversation_id where cv.customer_id=$1 and not e.is_duplicate and e.sent_at::date = current_date)::int as today_emails,
		   (select avg(case when e.sentiment='negative' then 1.0 else 0 end) from emails e join conversations cv on cv.id=e.conversation_id
		      where cv.customer_id=$1 and e.direction='inbound' and not e.is_duplicate and e.sent_at > now() - make_interval(days => $2)) as neg_pct`,
		[customerId, days, org.settings.slaHours],
	);
	const hs = healthScore({
		avgSentiment: Number(m.avg_sentiment) || 0,
		red: m.red,
		amber: m.amber,
		overdueActions: m.overdue,
		slaBreaches: m.sla,
		positiveConversations: m.positive,
		conversations: m.convs,
	});
	const prev = await one<any>(
		`select health_score from customer_health_daily where customer_id=$1 and day <= current_date - 7 order by day desc limit 1`,
		[customerId],
	);
	const trend = prev ? hs - prev.health_score : 0;
	await q('update customers set health_score=$2, health_status=$3, health_trend=$4 where id=$1', [customerId, hs, healthStatus(hs), trend]);
	await q(
		`insert into customer_health_daily (customer_id, day, health_score, negative_pct, red_count, email_count)
		 values ($1, current_date, $2, $3, $4, $5)
		 on conflict (customer_id, day) do update set health_score=excluded.health_score, negative_pct=excluded.negative_pct,
		   red_count=excluded.red_count, email_count=excluded.email_count`,
		[customerId, hs, Number(m.neg_pct) || 0, m.red, m.today_emails],
	);
	if (c.health_score !== null && c.health_score - hs > 0) await evaluateHealthAlert({ ...c, health_score: hs }, c.health_score);
}

/**
 * Reconstruct daily health history from already-ingested email (used after a backfill, so trend
 * charts are meaningful from day one). Existing days are left untouched.
 */
export async function backfillHealthHistory(orgId: number, days = 60) {
	const org = await getOrg(orgId);
	const win = org.settings.analysisWindowDays;
	const customers = await q<{ id: number }>(
		`select distinct customer_id as id from conversations where org_id=$1 and customer_id is not null`,
		[orgId],
	);
	for (const c of customers) {
		const rows = await q<any>(
			`select d::date as day,
			   coalesce((select avg(e.sentiment_score) from emails e join conversations cv on cv.id=e.conversation_id
			      where cv.customer_id=$1 and e.direction='inbound' and not e.is_duplicate and e.sentiment_score is not null
			        and e.sent_at between d - make_interval(days => $3) and d + interval '1 day'), 0) as avg_sentiment,
			   (select avg(case when e.sentiment='negative' then 1.0 else 0 end) from emails e join conversations cv on cv.id=e.conversation_id
			      where cv.customer_id=$1 and e.direction='inbound' and not e.is_duplicate and e.sent_at between d - make_interval(days => $3) and d + interval '1 day') as neg_pct,
			   (select count(*) from conversations cv where cv.customer_id=$1 and cv.rag='red' and cv.first_message_at <= d + interval '1 day'
			      and cv.last_message_at > d - make_interval(days => $3) and (cv.resolved_at is null or cv.resolved_at > d))::int as red,
			   (select count(*) from conversations cv where cv.customer_id=$1 and cv.rag='amber' and cv.first_message_at <= d + interval '1 day'
			      and cv.last_message_at > d - make_interval(days => $3) and (cv.resolved_at is null or cv.resolved_at > d))::int as amber,
			   (select count(*) from conversations cv where cv.customer_id=$1 and cv.sentiment='positive' and cv.last_message_at between d - make_interval(days => $3) and d + interval '1 day')::int as positive,
			   (select count(*) from conversations cv where cv.customer_id=$1 and cv.first_message_at <= d + interval '1 day' and cv.last_message_at > d - make_interval(days => $3))::int as convs,
			   (select count(*) from emails e join conversations cv on cv.id=e.conversation_id where cv.customer_id=$1 and not e.is_duplicate and e.sent_at::date = d::date)::int as emails
			 from generate_series(current_date - $2::int, current_date - 1, interval '1 day') d`,
			[c.id, days, win],
		);
		for (const r of rows) {
			if (!r.convs) continue;
			const hs = healthScore({
				avgSentiment: Number(r.avg_sentiment) || 0, red: r.red, amber: r.amber, overdueActions: 0, slaBreaches: 0,
				positiveConversations: r.positive, conversations: r.convs,
			});
			await q(
				`insert into customer_health_daily (customer_id, day, health_score, negative_pct, red_count, email_count)
				 values ($1,$2,$3,$4,$5,$6) on conflict (customer_id, day) do nothing`,
				[c.id, r.day, hs, Number(r.neg_pct) || 0, r.red, r.emails],
			);
		}
	}
	// refresh 7-day trend on customers
	await q(
		`update customers cu set health_trend = coalesce(cu.health_score - (select d.health_score from customer_health_daily d
		   where d.customer_id=cu.id and d.day <= current_date - 7 order by d.day desc limit 1), 0) where cu.org_id=$1`,
		[orgId],
	);
}
