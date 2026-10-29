/** Mail Sage — ask questions about customer email in plain English. */
import { q } from './db';
import type { SessionUser } from './auth';
import { convFilter, dashboardSummary } from './queries';
import { askLLM } from './ai/llm';
import { CATEGORIES, CATEGORY_LABELS, type Category } from './ai/types';
import { getOrg } from './settings';

const STOP = new Set('a an the of to in on for and or is are was were be been what which who whom how why when where do does did any all me my our we us show list tell give about with from this that these those last past week month today yesterday customers customer emails email conversations conversation issues issue please can could would'.split(' '));

function keywords(question: string) {
	return [...new Set(question.toLowerCase().replace(/[^a-z0-9@.\- ]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)))].slice(0, 8);
}

function detectCategory(question: string): Category | null {
	const s = question.toLowerCase();
	const map: [RegExp, Category][] = [
		[/billing|invoice|overcharg|credit note/, 'billing'],
		[/delay|late|eta/, 'delay'],
		[/damage|broken|lost/, 'damage'],
		[/collection/, 'missed_collection'],
		[/pod|proof of delivery|paperwork|document/, 'documentation'],
		[/driver/, 'driver_conduct'],
		[/payment|remittance/, 'payment'],
		[/price|pricing|rate|quote/, 'pricing'],
		[/track/, 'tracking'],
		[/contract|legal|terminat/, 'contract'],
	];
	return map.find(([re]) => re.test(s))?.[1] ?? null;
}

export async function ask(user: SessionUser, question: string, qs: URLSearchParams) {
	const org = await getOrg(user.orgId);
	if (!qs.get('from')) qs.set('from', new Date(Date.now() - 30 * 86400_000).toISOString());
	const f = await convFilter(user, qs);
	const W = f.where.join(' and ');
	const kws = keywords(question);
	const cat = detectCategory(question);

	// retrieval: keyword + category matches, ranked by matches then priority
	const params = [...f.params];
	const kwConds = kws.map((k) => {
		params.push(`%${k}%`);
		const i = params.length;
		return `(case when c.subject ilike $${i} or c.summary ilike $${i} or cu.name ilike $${i} or array_to_string(c.topics,' ') ilike $${i} then 1 else 0 end)`;
	});
	let catCond = '0';
	if (cat) {
		params.push(cat);
		catCond = `(case when $${params.length} = any(c.categories) then 2 else 0 end)`;
	}
	const relevance = `(${[...kwConds, catCond].join(' + ') || '0'})`;
	const matches = await q<any>(
		`select c.id, c.subject, c.summary, c.rag, c.sentiment, c.urgency, c.escalation_risk, c.categories, c.last_message_at,
		        c.awaiting_reply, c.status, cu.name as customer_name, cu.tier, cu.health_score, ${relevance} as relevance
		   from conversations c left join customers cu on cu.id=c.customer_id
		  where ${W} order by ${relevance} desc, c.priority_score desc, c.last_message_at desc limit 25`,
		params,
	);
	const relevant = matches.filter((m) => m.relevance > 0);
	const ctxConvs = (relevant.length ? relevant : matches).slice(0, 18);

	const summary = await dashboardSummary(user, qs);
	const atRisk = await q<any>(
		`select cu.id, cu.name, cu.tier, cu.health_score, cu.health_status, cu.health_trend from customers cu
		  where cu.org_id=$1 and cu.health_status in ('at_risk','dissatisfied') order by cu.health_score asc limit 10`,
		[user.orgId],
	);
	const actions = await q<any>(
		`select a.id, a.description, a.due_date, a.is_commitment, a.owner_name, a.conversation_id, cu.name as customer_name
		   from action_items a join conversations c on c.id=a.conversation_id left join customers cu on cu.id=a.customer_id
		  where ${W} and a.status='open' and a.owner_side='us' order by a.due_date nulls last limit 15`,
		f.params,
	);

	const references = ctxConvs.slice(0, 8).map((c) => ({ id: c.id, subject: c.subject, customer: c.customer_name, rag: c.rag }));
	const context = [
		`Period: ${f.from.toISOString().slice(0, 10)} to ${f.to.toISOString().slice(0, 10)}. SLA ${org.settings.slaHours}h.`,
		`KPIs: ${JSON.stringify(summary.kpis)}`,
		`Customers at risk: ${atRisk.map((c) => `${c.name} (${c.tier}, health ${c.health_score}, ${c.health_status}, trend ${c.health_trend})`).join('; ') || 'none'}`,
		`Open actions owed by us: ${actions.map((a) => `[#${a.conversation_id}] ${a.customer_name}: ${a.description}${a.due_date ? ` (due ${a.due_date})` : ''}`).join(' | ') || 'none'}`,
		'Relevant conversations:',
		...ctxConvs.map((c) => `[#${c.id}] ${c.customer_name || 'Unknown'} | ${c.rag || 'unrated'} | ${c.sentiment || ''} | ${c.status}${c.awaiting_reply ? ' | awaiting reply' : ''} | ${new Date(c.last_message_at).toISOString().slice(0, 10)} | ${c.subject}\n   ${c.summary || ''}`),
	].join('\n');

	const llm = await askLLM(
		user.orgId,
		`You are Mail Sage, the assistant inside remail for ${org.name}'s customer service and operations leaders.
Answer using ONLY the data provided. Be concise and specific: name customers, counts and dates. Cite conversations as [#id].
If the data does not answer the question, say so and suggest which filter or view in remail would. British English. No emoji.`,
		`Data:\n${context}\n\nQuestion: ${question}`,
	).catch((e) => {
		console.error('[copilot]', e.message);
		return null;
	});
	if (llm) return { answer: llm, references, mode: 'ai' };

	// Deterministic answer when no LLM is configured
	const s = question.toLowerCase();
	const lines: string[] = [];
	if (/risk|unhappy|dissatisf|churn|angry|worst/.test(s)) {
		lines.push(atRisk.length ? `${atRisk.length} customers are at risk or dissatisfied:` : 'No customers are currently at risk.');
		atRisk.forEach((c) => lines.push(`- ${c.name} (${c.tier}): health ${c.health_score}/100, ${c.health_status.replace('_', ' ')}${c.health_trend ? `, ${c.health_trend > 0 ? '+' : ''}${c.health_trend} over 7 days` : ''}`));
	} else if (/overdue|commit|promis|action|follow/.test(s)) {
		lines.push(actions.length ? `${actions.length} open actions are owed to customers:` : 'There are no open actions owed to customers.');
		actions.forEach((a) => lines.push(`- ${a.customer_name || 'Customer'}: ${a.description}${a.due_date ? ` (due ${a.due_date})` : ''} [#${a.conversation_id}]`));
	} else if (/summar|overview|how are we|status|health/.test(s) && !relevant.length) {
		const k = summary.kpis;
		lines.push(
			`In this period there were ${k.conversations} conversations (${k.emails} emails, ${k.duplicates} duplicates removed).`,
			`${k.red} are red, ${k.amber} amber and ${k.green} green; ${k.negative} have negative sentiment.`,
			`${k.awaiting} are awaiting a reply, ${k.sla_breaches} beyond the ${summary.slaHours}h SLA. Average first response: ${k.avg_first_response_min ?? 'n/a'} minutes.`,
		);
	} else {
		const label = cat ? CATEGORY_LABELS[cat].toLowerCase() : kws.join(', ');
		lines.push(relevant.length ? `Found ${relevant.length} conversations about ${label || 'that'}:` : `No conversations matched "${question}". Showing the highest-priority conversations instead:`);
		ctxConvs.slice(0, 8).forEach((c) => lines.push(`- [#${c.id}] ${c.customer_name || 'Unknown'} (${c.rag || 'unrated'}): ${c.subject}${c.summary ? ` — ${c.summary.slice(0, 160)}` : ''}`));
	}
	lines.push('', 'Tip: connect an AI provider in settings for free-form answers.');
	return { answer: lines.join('\n'), references, mode: 'rules' };
}

export const SUGGESTED_QUESTIONS = [
	'Which customers are most at risk this month?',
	'What are the main billing complaints?',
	'Which commitments are overdue?',
	'Summarise delivery delay issues this week',
	'Who is waiting longest for a reply?',
];
void CATEGORIES;
