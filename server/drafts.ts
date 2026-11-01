/**
 * Reply drafts. Every conversation waiting on an answer gets a complete AI-drafted reply that stays
 * in the app. Facts the AI cannot know are written as [[provide: …]] placeholders (shown in yellow).
 * Nothing leaves the app until a person presses Send; then it goes through Gmail, in the same thread,
 * from the mailbox the customer wrote to.
 */
import { one, q } from './db';
import { HttpError } from './http';
import { audit } from './audit';
import type { SessionUser } from './auth';
import { getOrg } from './settings';
import { gmailSendReply, gmailSendEnabled } from './connectors/gmail';
import { microsoftSendEnabled, microsoftSendReply } from './connectors/microsoft';
import { footerForConversation } from './branding';
import type { MailboxRow } from './connectors/types';

export const PLACEHOLDER = /\[\[\s*provide\s*:(.*?)\]\](?!\])/gis;
export const placeholders = (body: string) => [...body.matchAll(PLACEHOLDER)].map((m) => m[1].trim());

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
export const bodyToHtml = (body: string) =>
	`<div style="font-family:'Segoe UI',Arial,sans-serif;font-size:14px;line-height:1.55;color:#0b1143">${esc(body)
		.replace(PLACEHOLDER, (_m, p) => `<span style="background:#fff176">[provide: ${p.trim()}]</span>`)
		.replace(/\r?\n/g, '<br>')}</div>`;

/** The latest inbound message, the mailbox to answer from, and who to address. */
async function replyContext(conversationId: number) {
	const last = await one<any>(
		`select e.* from emails e where e.conversation_id=$1 and e.direction='inbound' and not e.is_duplicate order by e.sent_at desc limit 1`,
		[conversationId],
	);
	if (!last) return null;
	// every copy of that message (it may have arrived in several mailboxes): prefer a shared mailbox, then a personal Gmail
	const copies = await q<any>(
		`select e.id, e.mailbox_id, e.provider_thread_id, m.provider, m.address, m.status
		   from emails e join mailboxes m on m.id=e.mailbox_id
		  where e.org_id=$1 and (e.id=$2 or e.duplicate_of=$2 or (e.dedup_key=$3))
		    and m.provider in ('microsoft_app','microsoft','gmail_app','gmail') and m.status <> 'paused'
		  order by case m.provider when 'microsoft_app' then 0 when 'gmail_app' then 1 when 'microsoft' then 2 else 3 end, e.id`,
		[last.org_id, last.id, last.dedup_key],
	);
	const via = copies[0] || null;
	const ours = new Set<string>((await q<any>('select lower(address) a from mailboxes where org_id=$1', [last.org_id])).map((r) => r.a));
	const to = [last.from_address].filter(Boolean);
	const cc = [...new Set([...(last.to_addresses || []), ...(last.cc_addresses || [])].map((a: string) => a.toLowerCase()))]
		.filter((a) => a && !ours.has(a) && !to.includes(a))
		.slice(0, 10);
	return { last, via, to, cc };
}

const reSubject = (s: string) => (/^\s*re:/i.test(s || '') ? s : `Re: ${s || ''}`.trim());

/** Called after each analysis. Keeps a person's edits; refreshes untouched drafts; clears drafts no longer needed. */
export async function upsertDraft(conv: any, needsReply: boolean, body: string, model: string) {
	const org = await getOrg(conv.org_id);
	const existing = await one<any>('select * from reply_drafts where conversation_id=$1', [conv.id]);
	if (!needsReply || !body?.trim() || !org.settings.autoDrafts) {
		// answered from Gmail directly, or nothing to answer
		if (existing?.status === 'draft') {
			if (existing.edited) await q(`update reply_drafts set status='replied_elsewhere', updated_at=now() where id=$1`, [existing.id]);
			else await q('delete from reply_drafts where id=$1', [existing.id]);
		}
		return;
	}
	const ctx = await replyContext(conv.id);
	if (!ctx) return;
	if (existing) {
		const newMailSinceDone = existing.status !== 'draft' && ctx.last.id !== existing.reply_to_email_id;
		if (existing.status === 'draft' && existing.edited && ctx.last.id === existing.reply_to_email_id) return; // keep the person's edits
		if (existing.status !== 'draft' && !newMailSinceDone) return;
		await q(
			`update reply_drafts set body=$2, generated_body=$2, model=$3, edited=false, status='draft', to_addresses=$4, cc_addresses=$5, subject=$6,
			   reply_to_email_id=$7, send_mailbox_id=$8, generated_at=now(), updated_at=now(), last_error=null where id=$1`,
			[existing.id, body, model, ctx.to, ctx.cc, reSubject(conv.subject), ctx.last.id, ctx.via?.mailbox_id ?? null],
		);
		return;
	}
	await q(
		`insert into reply_drafts (org_id, conversation_id, body, generated_body, model, to_addresses, cc_addresses, subject, reply_to_email_id, send_mailbox_id)
		 values ($1,$2,$3,$3,$4,$5,$6,$7,$8,$9) on conflict (conversation_id) do nothing`,
		[conv.org_id, conv.id, body, model, ctx.to, ctx.cc, reSubject(conv.subject), ctx.last.id, ctx.via?.mailbox_id ?? null],
	);
}

const DRAFT_COLS = `d.id, d.conversation_id, d.body, d.edited, d.status, d.to_addresses, d.cc_addresses, d.subject, d.model, d.generated_at, d.updated_at,
	d.sent_at, d.last_error, d.send_mailbox_id, m.address as send_from, m.provider as send_provider,
	c.subject as conv_subject, c.rag, c.urgency, c.sentiment, c.summary, c.last_inbound_at, c.business_category, c.subcategory, c.awaiting_reply,
	cu.name as customer_name, cu.tier as customer_tier, su.full_name as sent_by_name, uu.full_name as updated_by_name`;
const DRAFT_JOIN = `from reply_drafts d join conversations c on c.id=d.conversation_id left join customers cu on cu.id=c.customer_id
	left join mailboxes m on m.id=d.send_mailbox_id left join users su on su.id=d.sent_by left join users uu on uu.id=d.updated_by`;

const sendEnabled = (provider?: string) => (/^microsoft/.test(provider || '') ? microsoftSendEnabled() : gmailSendEnabled());
const withMeta = (d: any) => d && { ...d, placeholders: placeholders(d.body), canSend: !!d.send_mailbox_id && sendEnabled(d.send_provider) };

const DRAFT_SORTS: Record<string, string> = {
	priority: `case c.rag when 'red' then 0 when 'amber' then 1 else 2 end, c.last_inbound_at desc nulls last`,
	newest: 'c.last_inbound_at desc nulls last',
	oldest: 'c.last_inbound_at asc nulls last',
	ready: `case when d.body ~* '\\[\\[\\s*provide\\s*:' then 1 else 0 end, c.last_inbound_at desc nulls last`,
	sent: 'd.sent_at desc nulls last',
};
export async function listDrafts(where: string, params: unknown[], status: string, sort = 'priority') {
	const order = status === 'sent' ? DRAFT_SORTS.sent : DRAFT_SORTS[sort] || DRAFT_SORTS.priority;
	const rows = await q<any>(
		`select ${DRAFT_COLS}, c.urgency as conv_urgency, c.mailbox_ids ${DRAFT_JOIN} where ${where} and d.status = $${params.length + 1}
		 order by ${order} limit 200`,
		[...params, status],
	);
	return rows.map(withMeta);
}

export async function getDraft(id: number, orgId: number) {
	return withMeta(await one<any>(`select ${DRAFT_COLS} ${DRAFT_JOIN} where d.id=$1 and d.org_id=$2`, [id, orgId]));
}
export async function getDraftForConversation(conversationId: number, orgId: number) {
	return withMeta(await one<any>(`select ${DRAFT_COLS} ${DRAFT_JOIN} where d.conversation_id=$1 and d.org_id=$2`, [conversationId, orgId]));
}

const cleanList = (v: unknown) =>
	(Array.isArray(v) ? v : String(v || '').split(/[,;\s]+/)).map((a) => String(a).trim().toLowerCase()).filter((a) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a)).slice(0, 20);

export async function saveDraft(user: SessionUser, id: number, input: { body?: string; to?: unknown; cc?: unknown; subject?: string }) {
	const d = await one<any>('select * from reply_drafts where id=$1 and org_id=$2', [id, user.orgId]);
	if (!d) throw new HttpError(404, 'Draft not found');
	if (d.status === 'sent') throw new HttpError(400, 'This reply has already been sent');
	await q(
		`update reply_drafts set body=coalesce($2, body), to_addresses=coalesce($3, to_addresses), cc_addresses=coalesce($4, cc_addresses),
		   subject=coalesce($5, subject), edited = edited or ($2 is not null and $2 <> generated_body), status='draft', updated_at=now(), updated_by=$6 where id=$1`,
		[id, input.body ?? null, input.to !== undefined ? cleanList(input.to) : null, input.cc !== undefined ? cleanList(input.cc) : null, input.subject ?? null, user.id],
	);
	return getDraft(id, user.orgId);
}

export async function sendDraft(ctx: any, user: SessionUser, id: number, edits: { body?: string; to?: unknown; cc?: unknown; subject?: string }) {
	if (edits && (edits.body !== undefined || edits.to !== undefined || edits.cc !== undefined || edits.subject !== undefined)) await saveDraft(user, id, edits);
	const d = await one<any>('select * from reply_drafts where id=$1 and org_id=$2', [id, user.orgId]);
	if (!d) throw new HttpError(404, 'Draft not found');
	if (d.status === 'sent') throw new HttpError(400, 'This reply has already been sent');
	const open = placeholders(d.body);
	if (open.length) throw new HttpError(400, `Fill in the ${open.length} highlighted item${open.length > 1 ? 's' : ''} before sending: ${open.slice(0, 3).join('; ')}`);
	if (!d.to_addresses?.length) throw new HttpError(400, 'Add at least one recipient');
	if (!d.body.trim()) throw new HttpError(400, 'The reply is empty');
	const mb = d.send_mailbox_id ? await one<MailboxRow>('select * from mailboxes where id=$1', [d.send_mailbox_id]) : null;
	if (!mb) throw new HttpError(400, 'No connected Outlook or Gmail mailbox received this email, so it cannot be answered from here');
	const src = d.reply_to_email_id ? await one<any>('select e.* from emails e where e.id=$1', [d.reply_to_email_id]) : null;
	const copy = src ? await one<any>(`select provider_thread_id, provider_message_id from emails where mailbox_id=$1 and (id=$2 or dedup_key=$3) limit 1`, [mb.id, src.id, src.dedup_key]) : null;
	const sender = await one<any>('select full_name from users where id=$1', [user.id]);
	// the footer: company, address for the customer's city (or the head office), website and logo
	const footer = await footerForConversation(user.orgId, d.conversation_id).catch(() => null);
	try {
		const html = footer ? bodyToHtml(d.body).replace(/<\/div>$/, `${footer.html}</div>`) : bodyToHtml(d.body);
		const res = /^microsoft/.test(mb.provider)
			? await microsoftSendReply(mb, { to: d.to_addresses, cc: d.cc_addresses || [], subject: d.subject, html, replyToProviderId: copy?.provider_message_id || null })
			: await gmailSendReply(mb, {
			from: mb.address,
			fromName: mb.provider === 'gmail_app' ? (mb as any).display_name || undefined : sender?.full_name || undefined,
			to: d.to_addresses,
			cc: d.cc_addresses || [],
			subject: d.subject,
			text: footer ? `${d.body}\n${footer.text}` : d.body,
			html: footer ? bodyToHtml(d.body).replace(/<\/div>$/, `${footer.html}</div>`) : bodyToHtml(d.body),
			threadId: copy?.provider_thread_id || null,
			inReplyTo: src?.internet_message_id || null,
			references: [src?.in_reply_to, src?.internet_message_id].filter(Boolean),
		});
		await q(`update reply_drafts set status='sent', sent_at=now(), sent_by=$2, provider_message_id=$3, last_error=null, updated_at=now() where id=$1`, [id, user.id, res.id]);
		await q(`update conversations set awaiting_reply=false, status=case when status='open' then 'in_progress' else status end, updated_at=now() where id=$1`, [d.conversation_id]);
		await audit(ctx, 'reply.sent', 'conversation', d.conversation_id, { draftId: id, from: mb.address, to: d.to_addresses, cc: d.cc_addresses });
		return { success: true, mailboxId: mb.id, from: mb.address };
	} catch (e: any) {
		await q('update reply_drafts set last_error=$2, updated_at=now() where id=$1', [id, String(e.message).slice(0, 500)]);
		throw new HttpError(502, e.message);
	}
}

export async function dismissDraft(ctx: any, user: SessionUser, id: number) {
	await q(`update reply_drafts set status='dismissed', updated_at=now(), updated_by=$3 where id=$1 and org_id=$2 and status='draft'`, [id, user.orgId, user.id]);
	await audit(ctx, 'reply.dismissed', 'reply_draft', id);
	return { success: true };
}

/**
 * Staff answer the yellow items in small boxes; the answers go into the draft and the AI rewrites the
 * email so it reads naturally (in the customer's language), keeping anything still unanswered as yellow.
 * Without the AI, the answers are put in place as typed.
 */
export async function fillDraft(user: SessionUser, id: number, answers: { item: string; value: string }[], rewrite = true) {
	const d = await one<any>('select * from reply_drafts where id=$1 and org_id=$2', [id, user.orgId]);
	if (!d) throw new HttpError(404, 'Draft not found');
	if (d.status === 'sent') throw new HttpError(400, 'This reply has already been sent');
	const given = (answers || []).map((a) => ({ item: String(a.item || '').trim(), value: String(a.value || '').trim().slice(0, 2000) })).filter((a) => a.item && a.value);
	if (!given.length) throw new HttpError(400, 'Type at least one answer');
	// 1. put each answer where its yellow item was
	const used = new Set<number>();
	let body: string = d.body.replace(PLACEHOLDER, (m: string, p: string) => {
		const i = given.findIndex((a) => a.item.toLowerCase() === p.trim().toLowerCase());
		if (i < 0) return m;
		used.add(i);
		return given[i].value;
	});
	if (!used.size) throw new HttpError(400, 'Those items are no longer in the draft. Reload and try again.');
	const stillOpen = placeholders(body).length;
	let model = 'inserted as typed';
	// 2. let the AI smooth it into a finished email
	if (rewrite) {
		try {
			const { askLLM, aiPaused } = await import('./ai/llm');
			if (!(await aiPaused())) {
				const conv = await one<any>('select subject, summary from conversations where id=$1', [d.conversation_id]);
				const last = d.reply_to_email_id ? await one<any>('select from_name, body_clean, body_text from emails where id=$1', [d.reply_to_email_id]) : null;
				const org = await getOrg(user.orgId);
				const system = `You edit email replies for ${org.name}. Rewrite the draft reply below into a finished, courteous email that includes the facts the team has just supplied, so the sentences around each fact read naturally.
Rules:
- Keep the same language as the draft (French stays French; translate a supplied fact if it was typed in the other language).
- Keep the greeting, the overall structure and the signature block exactly as they are.
- Use only facts in the draft, the supplied answers and the customer's email. Do not add promises, dates, prices or policies.
- Keep every remaining [[provide: …]] item exactly as written, character for character.
- If a supplied answer makes a sentence unnecessary (for example "not applicable"), remove that sentence.
- Return only the email text: no preamble, no quotation marks, no markdown.`;
				const prompt = [
					`Subject: ${conv?.subject || d.subject}`,
					last ? `Customer's latest email (from ${last.from_name || 'the customer'}):\n${String(last.body_clean || last.body_text || '').slice(0, 2500)}` : '',
					`Facts supplied by the team:\n${given.filter((_a, k) => used.has(k)).map((a) => `- ${a.item}: ${a.value}`).join('\n')}`,
					`Draft with the facts already inserted:\n${body}`,
				].filter(Boolean).join('\n\n');
				const out = (await askLLM(user.orgId, system, prompt))?.trim().replace(/^```[a-z]*\n?|```$/g, '').trim();
				// accept only a plausible rewrite that kept the unanswered items
				if (out && out.length > body.length * 0.4 && out.length < body.length * 3 && placeholders(out).length === stillOpen) {
					body = out;
					model = 'rewritten by AI';
				}
			}
		} catch (e: any) {
			console.error('[drafts] rewrite failed, keeping the answers as typed:', e.message);
		}
	}
	await q(`update reply_drafts set body=$2, edited=true, status='draft', updated_at=now(), updated_by=$3 where id=$1`, [id, body, user.id]);
	return { draft: await getDraft(id, user.orgId), filled: used.size, remaining: stillOpen, how: model };
}
