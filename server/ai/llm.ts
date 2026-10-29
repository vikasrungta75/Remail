/**
 * LLM providers. Anthropic Claude (default) or any OpenAI-compatible endpoint, including
 * Azure OpenAI (for customers who need processing inside their own Azure tenant).
 * Falls back to the deterministic analyser when nothing is configured or a call fails.
 */
import { q } from '../db';
import { heuristicAnalyse } from './heuristic';
import { ANALYSIS_SCHEMA, CATEGORIES, type Analysis, type ThreadInput } from './types';

export type Provider = 'anthropic' | 'openai' | 'azure' | 'heuristic';

export function aiProvider(): Provider {
	const p = (process.env.AI_PROVIDER || '').toLowerCase();
	if (p === 'heuristic') return 'heuristic';
	if ((p === 'anthropic' || !p) && process.env.ANTHROPIC_API_KEY) return 'anthropic';
	if ((p === 'azure' || !p) && process.env.AZURE_OPENAI_ENDPOINT && process.env.AZURE_OPENAI_API_KEY) return 'azure';
	if ((p === 'openai' || !p) && process.env.OPENAI_API_KEY) return 'openai';
	return 'heuristic';
}

export function aiModel(): string {
	switch (aiProvider()) {
		case 'anthropic': return process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';
		case 'azure': return process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o-mini';
		case 'openai': return process.env.OPENAI_MODEL || 'gpt-4o-mini';
		default: return 'remail-heuristic-v1';
	}
}

const SYSTEM = (org: string) => `You are remail, an analyst for ${org}, a road haulage and logistics company.
You read customer email threads between ${org} and its customers and produce structured, factual analysis for the customer service and operations teams.
Rules:
- Base everything strictly on the emails. Do not invent shipment numbers, dates, amounts or promises.
- "inbound" messages are from the customer, "outbound" are from ${org} staff, "internal" are between ${org} staff.
- Sentiment reflects the CUSTOMER, weighted to their most recent messages. Polite but firm complaints are still negative.
- RAG: red = dissatisfied customer with an urgent, repeated or high-impact problem, or any legal/churn/penalty signal; amber = a live concern or unanswered request that needs attention; green = routine, resolved or positive.
- Action items: capture explicit commitments made by ${org} staff ("we will…", "I'll send…") with due dates when stated, and requests the customer is waiting on. Keep each under 25 words.
- Dates: resolve relative dates ("tomorrow", "by Friday") against the message's sent time; output YYYY-MM-DD.
- The suggested reply must be courteous, specific, British English, and use [placeholders] for any fact you do not know.`;

function buildPrompt(input: ThreadInput): string {
	const lines = [
		`Customer: ${input.customerName || 'Unknown'} (tier: ${input.customerTier || 'standard'})`,
		`Conversation id: ${input.conversationId}`,
		`Messages (oldest first):`,
	];
	for (const m of input.messages) {
		lines.push(
			`--- message ${m.index} | ${m.direction} | ${m.sentAt} | from: ${m.fromName ? `${m.fromName} <${m.from}>` : m.from}`,
			`Subject: ${m.subject}`,
			m.body.slice(0, 2500),
		);
	}
	lines.push('---', 'Analyse this conversation and call record_analysis.');
	return lines.join('\n');
}

async function logUsage(orgId: number | null, model: string, inTok: number, outTok: number, purpose: string) {
	await q('insert into ai_usage (org_id, model, input_tokens, output_tokens, purpose) values ($1,$2,$3,$4,$5)', [
		orgId, model, inTok || 0, outTok || 0, purpose,
	]).catch(() => {});
}

async function anthropicCall(body: any) {
	const res = await fetch('https://api.anthropic.com/v1/messages', {
		method: 'POST',
		headers: {
			'x-api-key': process.env.ANTHROPIC_API_KEY!,
			'anthropic-version': '2023-06-01',
			'content-type': 'application/json',
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(60_000),
	});
	const data: any = await res.json();
	if (!res.ok) throw new Error(`Anthropic ${res.status}: ${data?.error?.message || 'error'}`);
	return data;
}

async function openaiCall(body: any) {
	const azure = aiProvider() === 'azure';
	const url = azure
		? `${process.env.AZURE_OPENAI_ENDPOINT!.replace(/\/$/, '')}/openai/deployments/${process.env.AZURE_OPENAI_DEPLOYMENT}/chat/completions?api-version=${process.env.AZURE_OPENAI_API_VERSION || '2024-10-21'}`
		: `${(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '')}/chat/completions`;
	const res = await fetch(url, {
		method: 'POST',
		headers: azure
			? { 'api-key': process.env.AZURE_OPENAI_API_KEY!, 'content-type': 'application/json' }
			: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
		body: JSON.stringify(azure ? { ...body, model: undefined } : body),
		signal: AbortSignal.timeout(60_000),
	});
	const data: any = await res.json();
	if (!res.ok) throw new Error(`OpenAI ${res.status}: ${data?.error?.message || 'error'}`);
	return data;
}

function coerce(raw: any, fallback: Analysis): Analysis {
	const pick = <T extends string>(v: any, allowed: readonly T[], def: T): T => (allowed.includes(v) ? v : def);
	const cats = (raw.categories || []).filter((c: any) => (CATEGORIES as readonly string[]).includes(c));
	const num = (v: any, lo: number, hi: number, def: number) => {
		const n = Number(v);
		return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def;
	};
	const date = (v: any) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
	return {
		summary: String(raw.summary || fallback.summary).slice(0, 1200),
		sentiment: pick(raw.sentiment, ['positive', 'neutral', 'negative'] as const, fallback.sentiment),
		sentiment_score: num(raw.sentiment_score, -1, 1, fallback.sentiment_score),
		customer_state: pick(raw.customer_state, ['satisfied', 'neutral', 'at_risk', 'dissatisfied'] as const, fallback.customer_state),
		urgency: pick(raw.urgency, ['low', 'medium', 'high', 'critical'] as const, fallback.urgency),
		escalation_risk: Math.round(num(raw.escalation_risk, 0, 100, fallback.escalation_risk)),
		categories: cats.length ? cats : fallback.categories,
		topics: (raw.topics || []).map((t: any) => String(t).toLowerCase().slice(0, 60)).slice(0, 6),
		issues: (raw.issues || [])
			.filter((i: any) => i && i.description)
			.map((i: any) => ({
				category: pick(i.category, CATEGORIES, 'complaint'),
				description: String(i.description).slice(0, 400),
				severity: pick(i.severity, ['low', 'medium', 'high', 'critical'] as const, 'medium'),
			}))
			.slice(0, 10),
		action_items: (raw.action_items || [])
			.filter((a: any) => a && a.description)
			.map((a: any) => ({
				description: String(a.description).slice(0, 400),
				owner_side: pick(a.owner_side, ['us', 'customer'] as const, 'us'),
				owner_name: a.owner_name ? String(a.owner_name).slice(0, 120) : null,
				is_commitment: !!a.is_commitment,
				due_date: date(a.due_date),
				message_index: Number.isInteger(a.message_index) ? a.message_index : null,
			}))
			.slice(0, 15),
		entities: {
			shipment_refs: (raw.entities?.shipment_refs || []).slice(0, 15).map(String),
			invoice_refs: (raw.entities?.invoice_refs || []).slice(0, 15).map(String),
			vehicle_regs: (raw.entities?.vehicle_regs || []).slice(0, 15).map(String),
			amounts: (raw.entities?.amounts || []).slice(0, 15).map(String),
			locations: (raw.entities?.locations || []).slice(0, 15).map(String),
			dates: (raw.entities?.dates || []).slice(0, 15).map(String),
		},
		message_sentiments: (raw.message_sentiments || [])
			.filter((m: any) => Number.isInteger(m?.index))
			.map((m: any) => ({
				index: m.index,
				sentiment: pick(m.sentiment, ['positive', 'neutral', 'negative'] as const, 'neutral'),
				score: num(m.score, -1, 1, 0),
			})),
		requires_reply: raw.requires_reply === undefined ? fallback.requires_reply : !!raw.requires_reply,
		suggested_reply: String(raw.suggested_reply || '').slice(0, 4000),
		rag_suggestion: pick(raw.rag_suggestion, ['red', 'amber', 'green'] as const, fallback.rag_suggestion),
		rag_reason: String(raw.rag_reason || fallback.rag_reason).slice(0, 400),
		legal_or_churn_signal: !!raw.legal_or_churn_signal || fallback.legal_or_churn_signal,
	};
}

export async function analyseThread(input: ThreadInput, orgId: number): Promise<{ analysis: Analysis; model: string }> {
	const fallback = heuristicAnalyse(input);
	const provider = aiProvider();
	if (provider === 'heuristic') return { analysis: fallback, model: 'remail-heuristic-v1' };
	const model = aiModel();
	try {
		if (provider === 'anthropic') {
			const data = await anthropicCall({
				model,
				max_tokens: 2500,
				system: SYSTEM(input.orgName),
				tools: [{ name: 'record_analysis', description: 'Record the structured analysis of the email conversation.', input_schema: ANALYSIS_SCHEMA }],
				tool_choice: { type: 'tool', name: 'record_analysis' },
				messages: [{ role: 'user', content: buildPrompt(input) }],
			});
			await logUsage(orgId, model, data.usage?.input_tokens, data.usage?.output_tokens, 'analysis');
			const tool = (data.content || []).find((c: any) => c.type === 'tool_use');
			if (!tool) throw new Error('No tool_use in response');
			return { analysis: coerce(tool.input, fallback), model };
		}
		const data = await openaiCall({
			model,
			temperature: 0.1,
			messages: [
				{ role: 'system', content: SYSTEM(input.orgName) },
				{ role: 'user', content: buildPrompt(input) },
			],
			tools: [{ type: 'function', function: { name: 'record_analysis', description: 'Record the structured analysis.', parameters: ANALYSIS_SCHEMA } }],
			tool_choice: { type: 'function', function: { name: 'record_analysis' } },
		});
		await logUsage(orgId, model, data.usage?.prompt_tokens, data.usage?.completion_tokens, 'analysis');
		const args = data.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
		if (!args) throw new Error('No tool call in response');
		return { analysis: coerce(JSON.parse(args), fallback), model };
	} catch (e: any) {
		console.error('[ai] analysis failed, using heuristic fallback:', e.message);
		return { analysis: fallback, model: 'remail-heuristic-v1 (fallback)' };
	}
}

/** Free-text answer for the Mail Sage copilot. Returns null when no LLM is configured. */
export async function askLLM(orgId: number, system: string, prompt: string): Promise<string | null> {
	const provider = aiProvider();
	if (provider === 'heuristic') return null;
	const model = aiModel();
	if (provider === 'anthropic') {
		const data = await anthropicCall({ model, max_tokens: 1500, system, messages: [{ role: 'user', content: prompt }] });
		await logUsage(orgId, model, data.usage?.input_tokens, data.usage?.output_tokens, 'copilot');
		return (data.content || []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
	}
	const data = await openaiCall({
		model,
		temperature: 0.2,
		messages: [
			{ role: 'system', content: system },
			{ role: 'user', content: prompt },
		],
	});
	await logUsage(orgId, model, data.usage?.prompt_tokens, data.usage?.completion_tokens, 'copilot');
	return data.choices?.[0]?.message?.content || '';
}
