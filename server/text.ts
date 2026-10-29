import { sha256 } from './crypto';

export const FREE_MAIL_DOMAINS = new Set([
	'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'hotmail.co.uk', 'live.com', 'live.co.uk',
	'yahoo.com', 'yahoo.co.uk', 'yahoo.co.in', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com',
	'rediffmail.com', 'msn.com', 'gmx.com', 'zoho.com', 'mail.com', 'btinternet.com', 'sky.com',
]);

/** Senders that are almost never customers — newsletters and system mail */
export const AUTOMATED_SENDER = /(^|[._-])(no-?reply|do-?not-?reply|mailer-daemon|postmaster|notifications?|newsletter|marketing|bounce|alerts?|news|updates|digest|calendar-notification)([._-]|@)/i;

export function domainOf(addr: string): string {
	const m = /@([^@>\s]+)\s*>?$/.exec(addr.trim().toLowerCase());
	return m ? m[1] : '';
}

export function normalizeAddress(addr: string): string {
	const m = /<([^>]+)>/.exec(addr);
	return (m ? m[1] : addr).trim().toLowerCase();
}

export function normalizeSubject(s: string): string {
	let out = (s || '').trim();
	// strip any chain of reply/forward prefixes (multi-language) and bracketed tags like [EXT]
	for (let i = 0; i < 6; i++) {
		const before = out;
		out = out
			.replace(/^\s*(re|fw|fwd|aw|wg|sv|vs|rif|tr|antw|odp|ynt)\s*(\[\d+\])?\s*:\s*/i, '')
			.replace(/^\s*\[(ext|external|external email|caution)[^\]]*\]\s*/i, '');
		if (out === before) break;
	}
	return out.replace(/\s+/g, ' ').toLowerCase().slice(0, 300);
}

export function htmlToText(html: string): string {
	return html
		.replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, '\n')
		.replace(/<li[^>]*>/gi, '- ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&quot;/gi, '"')
		.replace(/&#39;|&apos;/gi, "'")
		.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
		.replace(/[ \t\f\v]+/g, ' ')
		.replace(/\n\s*\n\s*\n+/g, '\n\n')
		.trim();
}

const QUOTE_MARKERS: RegExp[] = [
	/^\s*On .{3,200}wrote:\s*$/im,
	/^\s*On .{3,120}\n.{0,120}wrote:\s*$/im,
	/^\s*-{2,}\s*Original Message\s*-{2,}/im,
	/^\s*-{2,}\s*Forwarded message\s*-{2,}/im,
	/^\s*From:\s.+\n\s*(Sent|Date):\s.+/im,
	/^\s*De\s?:\s.+\n\s*(Envoyé|Date)\s?:\s.+/im,
	/^\s*Von:\s.+\n\s*Gesendet:\s.+/im,
	/^_{10,}\s*$/m,
];

const SIGNATURE_MARKERS: RegExp[] = [
	/^\s*--\s*$/m,
	/^\s*(Kind|Best|Warm|Many)?\s*regards,?\s*$/im,
	/^\s*(Thanks|Thank you|Cheers|Sincerely)( and regards| again)?,?\s*$/im,
	/^\s*Sent from my (iPhone|iPad|Android|Samsung|mobile).*$/im,
	/^\s*Get Outlook for (iOS|Android).*$/im,
	/^\s*(DISCLAIMER|CONFIDENTIALITY NOTICE|This e-?mail (and any attachments )?(is|are) confidential).*$/im,
];

/** Remove quoted earlier messages so each email's analysed content is only what it newly says. */
export function stripQuoted(text: string): string {
	let body = text.replace(/\r\n/g, '\n');
	let cut = body.length;
	for (const re of QUOTE_MARKERS) {
		const m = re.exec(body);
		if (m && m.index > 0 && m.index < cut) cut = m.index;
	}
	body = body.slice(0, cut);
	body = body
		.split('\n')
		.filter((l) => !/^\s*>/.test(l))
		.join('\n');
	return body.trim();
}

/** Body without quotes and signature boilerplate — used for hashing and AI. */
export function cleanBody(text: string): string {
	let body = stripQuoted(text);
	let cut = body.length;
	for (const re of SIGNATURE_MARKERS) {
		const m = re.exec(body);
		// only treat as signature if it is in the latter part of the message
		if (m && m.index > body.length * 0.35 && m.index < cut) cut = m.index;
	}
	return body.slice(0, cut).replace(/\n{3,}/g, '\n\n').trim();
}

export function contentHash(fromAddr: string, subject: string, clean: string): string {
	const norm = clean.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 4000);
	return sha256(`${normalizeAddress(fromAddr)}|${normalizeSubject(subject)}|${norm}`);
}

/**
 * Dedup key. The RFC 5322 Message-ID is identical when the same email lands in several
 * monitored mailboxes (To/CC to several team members, shared mailboxes).
 */
export function dedupKey(internetMessageId: string | null | undefined, fromAddr: string, sentAt: Date, subject: string, clean: string) {
	if (internetMessageId) return `mid:${internetMessageId.trim().toLowerCase().replace(/^<|>$/g, '')}`;
	const minute = Math.floor(sentAt.getTime() / 60000);
	return `h:${sha256(`${normalizeAddress(fromAddr)}|${minute}|${normalizeSubject(subject)}|${clean.slice(0, 500)}`)}`;
}

const PII_PATTERNS: [RegExp, string][] = [
	[/\b(?:\d[ -]*?){13,19}\b/g, '[card-number]'],
	[/\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g, '[iban]'],
	[/\b\d{2}-\d{2}-\d{2}\s?\d{8}\b/g, '[bank-account]'],
	[/\b[A-CEGHJ-PR-TW-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/gi, '[ni-number]'],
	[/\b\d{4}\s?\d{4}\s?\d{4}\b/g, '[id-number]'],
	[/\b[A-Z]{5}\d{4}[A-Z]\b/g, '[pan]'],
	[/(?:password|passcode|pwd)\s*[:=]\s*\S+/gi, 'password: [redacted]'],
];

/** Redact sensitive identifiers before text leaves our boundary (to the AI provider). */
export function redactPII(text: string): string {
	let out = text;
	for (const [re, rep] of PII_PATTERNS) out = out.replace(re, rep);
	return out;
}

export function snippet(text: string, n = 240): string {
	const s = text.replace(/\s+/g, ' ').trim();
	return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function titleCaseFromDomain(domain: string): string {
	const base = domain.split('.').filter((p) => !['co', 'com', 'org', 'net', 'ltd', 'uk', 'in', 'io', 'gov', 'ac'].includes(p))[0] || domain;
	return base
		.split(/[-_]/)
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(' ');
}
