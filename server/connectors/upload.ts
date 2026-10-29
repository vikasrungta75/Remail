/** Manual import of .eml files (useful for pilots, historic backfills and demos). */
import { simpleParser, type AddressObject } from 'mailparser';
import { createHash } from 'node:crypto';
import { htmlToText, normalizeAddress, AUTOMATED_SENDER } from '../text';
import type { Address, NormalizedMessage } from './types';

const list = (a: AddressObject | AddressObject[] | undefined): Address[] => {
	const arr = Array.isArray(a) ? a : a ? [a] : [];
	return arr.flatMap((x) => x.value.map((v) => ({ address: normalizeAddress(v.address || ''), name: v.name || '' })));
};

export async function parseEml(raw: Buffer | string, folderHint: 'inbox' | 'sent' = 'inbox'): Promise<NormalizedMessage> {
	const p = await simpleParser(raw);
	const from = list(p.from)[0] || { address: '', name: '' };
	const text = p.text || (p.html ? htmlToText(String(p.html)) : '');
	const mid = p.messageId || null;
	const refs = Array.isArray(p.references) ? p.references : p.references ? [p.references] : [];
	return {
		providerMessageId: mid || createHash('sha256').update(typeof raw === 'string' ? raw : raw.toString('utf8')).digest('hex').slice(0, 40),
		internetMessageId: mid,
		threadId: refs[0] || (p.inReplyTo as string) || mid,
		inReplyTo: (p.inReplyTo as string) || null,
		references: refs,
		from,
		to: list(p.to),
		cc: list(p.cc),
		subject: p.subject || '',
		bodyText: text,
		sentAt: p.date || new Date(),
		hasAttachments: (p.attachments || []).length > 0,
		importance: (p.headers.get('importance') as string) || null,
		webLink: null,
		folder: folderHint,
		isAutomated: AUTOMATED_SENDER.test(from.address) || p.headers.has('list-unsubscribe'),
	};
}
