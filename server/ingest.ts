/**
 * Ingestion: normalised provider messages → emails, conversations, customers.
 * Handles thread reconstruction across mailboxes and duplicate elimination.
 */
import { one, q } from './db';
import type { NormalizedMessage, MailboxRow } from './connectors/types';
import type { Org } from './settings';
import {
	FREE_MAIL_DOMAINS,
	cleanBody,
	contentHash,
	dedupKey,
	domainOf,
	normalizeSubject,
	snippet,
	titleCaseFromDomain,
} from './text';

export interface IngestResult {
	inserted: number;
	duplicates: number;
	skipped: number;
	conversationsTouched: Set<number>;
}

const SUBJECT_MATCH_DAYS = 21;

export async function ingestMessages(org: Org, mb: MailboxRow, messages: NormalizedMessage[]): Promise<IngestResult> {
	const result: IngestResult = { inserted: 0, duplicates: 0, skipped: 0, conversationsTouched: new Set() };
	// oldest first so threads build in order
	const sorted = [...messages].sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());
	for (const m of sorted) {
		try {
			const r = await ingestOne(org, mb, m);
			if (r === 'skipped') result.skipped++;
			else if (r === 'exists') continue;
			else {
				if (r.duplicate) result.duplicates++;
				else result.inserted++;
				if (r.conversationId) result.conversationsTouched.add(r.conversationId);
			}
		} catch (e: any) {
			console.error('[ingest] failed for message', m.providerMessageId, e.message);
		}
	}
	return result;
}

function isInternal(org: Org, mb: MailboxRow, address: string): boolean {
	const d = domainOf(address);
	if (!address) return false;
	if (address === mb.address.toLowerCase()) return true;
	if (org.internalDomains.includes(d)) return true;
	// a corporate mailbox's own domain counts as internal (but not gmail.com etc.)
	const own = domainOf(mb.address);
	return !!own && !FREE_MAIL_DOMAINS.has(own) && d === own;
}

async function ingestOne(
	org: Org,
	mb: MailboxRow,
	m: NormalizedMessage,
): Promise<'skipped' | 'exists' | { duplicate: boolean; conversationId: number | null }> {
	if (!m.from.address) return 'skipped';
	if (m.isAutomated && org.settings.ignoreAutomated) return 'skipped';
	// a "reply" from a known human to an automated thread is not automated
	const automated = !!m.isAutomated;

	const exists = await one('select id from emails where mailbox_id=$1 and provider_message_id=$2', [mb.id, m.providerMessageId]);
	if (exists) return 'exists';

	const fromInternal = isInternal(org, mb, m.from.address);
	const recipients = [...m.to, ...m.cc].map((r) => r.address).filter(Boolean);
	const externalRecipients = recipients.filter((r) => !isInternal(org, mb, r));
	const direction: 'inbound' | 'outbound' | 'internal' = !fromInternal
		? 'inbound'
		: externalRecipients.length
			? 'outbound'
			: 'internal';

	const clean = cleanBody(m.bodyText);
	const dk = dedupKey(m.internetMessageId, m.from.address, m.sentAt, m.subject, clean);
	const ch = contentHash(m.from.address, m.subject, clean);

	// ── Duplicate detection ────────────────────────────────────────────────
	// 1) exact: the same RFC Message-ID already ingested from another monitored mailbox
	// 2) content: same sender + subject + body re-sent / forwarded within 3 days
	let canonical = await one<{ id: number; conversation_id: number | null }>(
		'select id, conversation_id from emails where org_id=$1 and dedup_key=$2 and not is_duplicate order by id limit 1',
		[org.id, dk],
	);
	if (!canonical && clean.length > 40) {
		canonical = await one(
			`select id, conversation_id from emails where org_id=$1 and content_hash=$2 and not is_duplicate
			   and sent_at between $3::timestamptz - interval '3 days' and $3::timestamptz + interval '3 days'
			 order by id limit 1`,
			[org.id, ch, m.sentAt],
		);
	}

	// ── Customer resolution ────────────────────────────────────────────────
	const counterpart =
		direction === 'inbound'
			? m.from
			: [...m.to, ...m.cc].find((r) => r.address && !isInternal(org, mb, r.address));
	// newsletters and system mail are categorised, but never become customer records
	const customerId = counterpart && !automated ? await resolveCustomer(org.id, counterpart.address, counterpart.name) : null;
	const staff = [m.from, ...m.to, ...m.cc].map((r) => r.address).filter((a) => a && isInternal(org, mb, a));

	// ── Conversation resolution ───────────────────────────────────────────
	const threadKey = m.threadId ? `t:${mb.provider}:${mb.id}:${m.threadId}` : null;
	let conversationId: number | null = canonical?.conversation_id ?? null;
	if (!conversationId && threadKey) {
		conversationId = (await one<any>('select conversation_id from conversation_keys where key=$1', [threadKey]))?.conversation_id ?? null;
	}
	if (!conversationId) {
		const refs = [m.inReplyTo, ...m.references].filter(Boolean).map((r) => r!.trim().toLowerCase().replace(/^<|>$/g, ''));
		if (refs.length) {
			conversationId = (await one<any>(
				`select conversation_id from emails where org_id=$1 and dedup_key = any($2) and conversation_id is not null order by id desc limit 1`,
				[org.id, refs.map((r) => `mid:${r}`)],
			))?.conversation_id ?? null;
		}
	}
	const nsubj = normalizeSubject(m.subject);
	if (!conversationId && nsubj.length >= 6 && !customerId) {
		// internal threads (no external party): match on subject only among internal conversations
		conversationId = (await one<any>(
			`select id from conversations where org_id=$1 and normalized_subject=$2
			   and (customer_id is null or $4 = any(participants))
			   and last_message_at > $3::timestamptz - interval '${SUBJECT_MATCH_DAYS} days' order by last_message_at desc limit 1`,
			[org.id, nsubj, m.sentAt, m.from.address],
		))?.id ?? null;
	}
	if (!conversationId && nsubj.length >= 6 && customerId) {
		// cross-mailbox threading: same customer + same normalised subject in a recent window
		conversationId = (await one<any>(
			`select id from conversations where org_id=$1 and customer_id=$2 and normalized_subject=$3
			   and last_message_at > $4::timestamptz - interval '${SUBJECT_MATCH_DAYS} days' order by last_message_at desc limit 1`,
			[org.id, customerId, nsubj, m.sentAt],
		))?.id ?? null;
	}
	if (!conversationId && nsubj.length >= 6 && customerId) {
		// a thread that started internally and now involves a customer: adopt it
		const internal = await one<any>(
			`select id from conversations where org_id=$1 and customer_id is null and normalized_subject=$2
			   and last_message_at > $3::timestamptz - interval '${SUBJECT_MATCH_DAYS} days' order by last_message_at desc limit 1`,
			[org.id, nsubj, m.sentAt],
		);
		if (internal) {
			conversationId = internal.id;
			await q('update conversations set customer_id=$2 where id=$1', [internal.id, customerId]);
		}
	}
	if (!conversationId) {
		const c = await one<{ id: number }>(
			`insert into conversations (org_id, customer_id, subject, normalized_subject, first_message_at, last_message_at)
			 values ($1,$2,$3,$4,$5,$5) returning id`,
			[org.id, customerId, m.subject.slice(0, 500), nsubj, m.sentAt],
		);
		conversationId = c!.id;
	}
	if (threadKey) {
		await q('insert into conversation_keys (conversation_id, key) values ($1,$2) on conflict (key) do nothing', [conversationId, threadKey]);
	}

	const isDuplicate = !!canonical;
	await q(
		`insert into emails (org_id, mailbox_id, conversation_id, provider_message_id, internet_message_id, provider_thread_id,
			in_reply_to, dedup_key, content_hash, is_duplicate, duplicate_of, direction, from_address, from_name, to_addresses,
			cc_addresses, subject, body_text, body_clean, snippet, has_attachments, importance, web_link, sent_at, is_automated)
		 values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
		 on conflict (mailbox_id, provider_message_id) do nothing`,
		[
			org.id, mb.id, conversationId, m.providerMessageId, m.internetMessageId, m.threadId, m.inReplyTo, dk, ch,
			isDuplicate, canonical?.id ?? null, direction, m.from.address, m.from.name.slice(0, 200),
			m.to.map((r) => r.address), m.cc.map((r) => r.address), m.subject.slice(0, 1000),
			m.bodyText.slice(0, 100_000), clean.slice(0, 20_000), snippet(clean || m.bodyText), m.hasAttachments,
			m.importance, m.webLink, m.sentAt, automated,
		],
	);
	if (staff.length) {
		await q(`update conversations set staff_participants = (select array(select distinct unnest(staff_participants || $2::text[]))) where id=$1`, [conversationId, staff]);
	}
	await refreshConversation(conversationId, !isDuplicate, mb.id);
	if (customerId) await q('update customers set last_contact_at = greatest(coalesce(last_contact_at, $2), $2) where id=$1', [customerId, m.sentAt]);
	return { duplicate: isDuplicate, conversationId };
}

/** Recompute conversation aggregates from its (non-duplicate) emails. */
export async function refreshConversation(conversationId: number, markForAnalysis: boolean, mailboxId?: number) {
	await q(
		`with e as (
		   select * from emails where conversation_id=$1
		 ), nd as (select * from e where not is_duplicate),
		 firsts as (
		   select min(sent_at) filter (where direction='inbound') as first_in from nd
		 )
		 update conversations c set
		   first_message_at = (select min(sent_at) from nd),
		   last_message_at  = (select max(sent_at) from nd),
		   last_inbound_at  = (select max(sent_at) from nd where direction='inbound'),
		   last_outbound_at = (select max(sent_at) from nd where direction='outbound'),
		   message_count    = (select count(*) from nd),
		   inbound_count    = (select count(*) from nd where direction='inbound'),
		   duplicate_count  = (select count(*) from e where is_duplicate),
		   mailbox_ids      = (select coalesce(array_agg(distinct mailbox_id), '{}') from e),
		   participants     = (select coalesce(array_agg(distinct p), '{}') from (select from_address p from nd union select unnest(to_addresses) from nd) x where p <> ''),
		   awaiting_reply   = coalesce((select direction='inbound' from nd where direction <> 'internal' order by sent_at desc limit 1), false),
		   first_response_minutes = (
		     select round(extract(epoch from (min(o.sent_at) - f.first_in))/60)::int
		       from nd o, firsts f where o.direction='outbound' and f.first_in is not null and o.sent_at > f.first_in
		     group by f.first_in),
		   is_automated     = coalesce((select bool_and(is_automated) from nd), false),
		   is_internal      = c.customer_id is null and not coalesce((select bool_and(is_automated) from nd), false),
		   needs_analysis = c.needs_analysis or $2,
		   status = case when $2 and c.status = 'resolved' and (select direction from nd order by sent_at desc limit 1) = 'inbound' then 'open' else c.status end,
		   updated_at = now()
		 where c.id=$1`,
		[conversationId, markForAnalysis],
	);
	void mailboxId;
}

async function resolveCustomer(orgId: number, address: string, name: string): Promise<number | null> {
	const domain = domainOf(address);
	if (!domain) return null;
	const contact = await one<{ customer_id: number | null }>(
		'select customer_id from contacts where org_id=$1 and lower(email)=lower($2)',
		[orgId, address],
	);
	if (contact?.customer_id) return contact.customer_id;

	let customerId: number | null = null;
	if (!FREE_MAIL_DOMAINS.has(domain)) {
		customerId = (await one<any>('select id from customers where org_id=$1 and $2 = any(domains) limit 1', [orgId, domain]))?.id ?? null;
		if (!customerId) {
			customerId = (await one<any>(
				`insert into customers (org_id, name, domains) values ($1,$2,$3) returning id`,
				[orgId, titleCaseFromDomain(domain), [domain]],
			))!.id;
		}
	} else {
		// individuals on free webmail are their own customer record, keyed by address
		const label = name?.trim() || address;
		customerId = (await one<any>(
			`select c.id from customers c join contacts ct on ct.customer_id=c.id where c.org_id=$1 and lower(ct.email)=lower($2) limit 1`,
			[orgId, address],
		))?.id ?? null;
		if (!customerId) {
			customerId = (await one<any>(`insert into customers (org_id, name, domains) values ($1,$2,'{}') returning id`, [orgId, label]))!.id;
		}
	}
	await q(
		`insert into contacts (org_id, customer_id, email, name) values ($1,$2,$3,$4)
		 on conflict (org_id, lower(email)) do update set customer_id = coalesce(contacts.customer_id, excluded.customer_id),
		   name = case when contacts.name = '' then excluded.name else contacts.name end`,
		[orgId, customerId, address.toLowerCase(), name || ''],
	);
	return customerId;
}
