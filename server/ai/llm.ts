/**
 * LLM providers: Google Gemini (default when GEMINI_API_KEY is set), Anthropic Claude, or any
 * OpenAI-compatible endpoint including Azure OpenAI (for processing inside a customer's Azure tenant).
 * Falls back to the deterministic analyser when nothing is configured or a call fails.
 */
import { q } from '../db';
import { heuristicAnalyse } from './heuristic';
import { ANALYSIS_SCHEMA, BUSINESS_CATEGORIES, CATEGORIES, PROPOSAL_STAGES, type Analysis, type ThreadInput } from './types';

export type Provider = 'gemini' | 'anthropic' | 'openai' | 'azure' | 'heuristic';

const geminiKey = () => process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';

export function aiProvider(): Provider {
	const p = (process.env.AI_PROVIDER || '').toLowerCase();
	if (p === 'heuristic') return 'heuristic';
	if ((p === 'gemini' || !p) && geminiKey()) return 'gemini';
	if ((p === 'anthropic' || !p) && process.env.ANTHROPIC_API_KEY) return 'anthropic';
	if ((p === 'azure' || !p) && process.env.AZURE_OPENAI_ENDPOINT && process.env.AZURE_OPENAI_API_KEY) return 'azure';
	if ((p === 'openai' || !p) && process.env.OPENAI_API_KEY) return 'openai';
	return 'heuristic';
}

export function aiModel(): string {
	switch (aiProvider()) {
		case 'gemini': return process.env.GEMINI_MODEL || 'gemini-3.8-flash';
		case 'anthropic': return process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';
		case 'azure': return process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o-mini';
		case 'openai': return process.env.OPENAI_MODEL || 'gpt-4o-mini';
		default: return 'remail-heuristic-v1';
	}
}

const SYSTEM = (org: string) => `You are remail, an analyst for ${org}, a trucking and fleet management company (truckload, LTL, dispatch, cross-border Canada/US).
You read every kind of business email thread at ${org} — customer issues, quotes and proposals, operations and dispatch, fleet maintenance, billing, compliance, vendors, people and internal team threads — and produce structured, factual analysis for managers and staff.
Rules:
- Base everything strictly on the emails. Do not invent shipment numbers, dates, amounts or promises.
- "inbound" messages are from the customer, "outbound" are from ${org} staff, "internal" are between ${org} staff.
- Sentiment reflects the EXTERNAL party (customer, prospect or vendor), weighted to their most recent messages; for internal threads it reflects the overall tone. Polite but firm complaints are still negative.
- For sales_proposal threads fill the proposal object (kind, stage, deadline, value, scope, next step).
- RAG: red = dissatisfied customer with an urgent, repeated or high-impact problem, or any legal/churn/penalty signal; amber = a live concern or unanswered request that needs attention; green = routine, resolved or positive.
- Action items: capture explicit commitments made by ${org} staff ("we will…", "I'll send…") with due dates when stated, and requests the customer is waiting on. Keep each under 25 words.
- Dates: resolve relative dates ("tomorrow", "by Friday") against the message's sent time; output YYYY-MM-DD.
- The suggested reply must be courteous, specific, British English, and use [placeholders] for any fact you do not know.`;

function buildPrompt(input: ThreadInput): string {
	const lines = [
		input.isInternal ? 'Thread type: internal (staff only, no external party)' : `External party: ${input.customerName || 'Unknown'} (tier: ${input.customerTier || 'standard'})`,
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

/**
 * Gemini generateContent with JSON output. When a schema is given it is enforced with
 * responseJsonSchema; if the model/API version rejects that field we retry with JSON mode only
 * (the schema is also described in the prompt), so a Gemini API change never breaks analysis.
 */
let lastAiCall = 0;
/** Optional pacing for free-tier quotas: AI_MIN_INTERVAL_MS=6000 ≈ 10 requests a minute. */
async function pace() {
	const gap = Number(process.env.AI_MIN_INTERVAL_MS || 0);
	if (!gap) return;
	const wait = lastAiCall + gap - Date.now();
	if (wait > 0) await new Promise((r) => setTimeout(r, wait));
	lastAiCall = Date.now();
}

async function geminiCall(opts: { system: string; prompt: string; schema?: object; maxTokens?: number }) {
	await pace();
	const model = aiModel();
	const url = `${(process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '')}/models/${encodeURIComponent(model)}:generateContent`;
	const base = {
		systemInstruction: { parts: [{ text: opts.system }] },
		contents: [{ role: 'user', parts: [{ text: opts.prompt }] }],
		generationConfig: {
			temperature: 0.1,
			maxOutputTokens: opts.maxTokens || 4096,
			...(opts.schema ? { responseMimeType: 'application/json' } : {}),
		},
	};
	const attempt = async (withSchema: boolean) => {
		const body = withSchema && opts.schema
			? { ...base, generationConfig: { ...base.generationConfig, responseJsonSchema: opts.schema } }
			: base;
		for (let i = 0; i < 3; i++) {
			const res = await fetch(url, {
				method: 'POST',
				headers: { 'x-goog-api-key': geminiKey(), 'content-type': 'application/json' },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(90_000),
			});
			const data: any = await res.json().catch(() => ({}));
			if (res.status === 429 || res.status >= 500) {
				await new Promise((r) => setTimeout(r, 2000 * 2 ** i));
				continue;
			}
			return { res, data };
		}
		throw new Error('Gemini kept returning rate-limit or server errors');
	};
	let { res, data } = await attempt(true);
	if (!res.ok && res.status === 400 && opts.schema) ({ res, data } = await attempt(false));
	if (!res.ok) throw new Error(`Gemini ${res.status}: ${data?.error?.message || 'error'}`);
	const cand = data.candidates?.[0];
	const text = (cand?.content?.parts || []).filter((p: any) => !p.thought).map((p: any) => p.text || '').join('');
	if (!text) throw new Error(`Gemini returned no text (finishReason ${cand?.finishReason || data?.promptFeedback?.blockReason || 'unknown'})`);
	return { text, usage: data.usageMetadata || {}, model: data.modelVersion || model };
}

function parseJsonLoose(text: string) {
	const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
	try { return JSON.parse(t); } catch { /* fall through */ }
	const m = t.match(/\{[\s\S]*\}/);
	if (m) return JSON.parse(m[0]);
	throw new Error('Model did not return valid JSON');
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
	const bc = pick(raw.business_category, BUSINESS_CATEGORIES, fallback.business_category);
	const pr = raw.proposal && typeof raw.proposal === 'object' && bc === 'sales_proposal'
		? {
			kind: String(raw.proposal.kind || 'proposal').slice(0, 40),
			stage: pick(raw.proposal.stage, PROPOSAL_STAGES, 'request_received'),
			deadline: date(raw.proposal.deadline),
			value: raw.proposal.value ? String(raw.proposal.value).slice(0, 120) : null,
			lanes_or_scope: raw.proposal.lanes_or_scope ? String(raw.proposal.lanes_or_scope).slice(0, 200) : null,
			next_step: raw.proposal.next_step ? String(raw.proposal.next_step).slice(0, 200) : null,
		}
		: bc === 'sales_proposal' ? fallback.proposal : null;
	return {
		business_category: bc,
		proposal: pr,
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
		if (provider === 'gemini') {
			const r = await geminiCall({
				system: SYSTEM(input.orgName),
				prompt: `${buildPrompt(input).replace('call record_analysis', 'return the analysis as a single JSON object')}\n\nReturn ONLY a JSON object with exactly these fields: ${Object.keys((ANALYSIS_SCHEMA as any).properties).join(', ')}.`,
				schema: ANALYSIS_SCHEMA,
				maxTokens: 6000,
			});
			await logUsage(orgId, model, r.usage.promptTokenCount, (r.usage.candidatesTokenCount || 0) + (r.usage.thoughtsTokenCount || 0), 'analysis');
			return { analysis: coerce(parseJsonLoose(r.text), fallback), model };
		}
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
	if (provider === 'gemini') {
		const r = await geminiCall({ system, prompt, maxTokens: 2048 });
		await logUsage(orgId, model, r.usage.promptTokenCount, (r.usage.candidatesTokenCount || 0) + (r.usage.thoughtsTokenCount || 0), 'copilot');
		return r.text;
	}
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
