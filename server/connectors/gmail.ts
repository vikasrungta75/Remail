/**
 * Gmail connector (read-only scope gmail.readonly). Used to test remail against a personal
 * or Google Workspace mailbox. Incremental sync uses the Gmail history API.
 */
import { decrypt, encrypt } from '../crypto';
import { htmlToText, normalizeAddress, AUTOMATED_SENDER } from '../text';
import type { Address, MailboxRow, NormalizedMessage, SyncBatch } from './types';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
export const GOOGLE_SCOPES = 'openid email profile https://www.googleapis.com/auth/gmail.readonly';

export const googleConfigured = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

export function googleAuthorizeUrl(state: string, redirectUri: string) {
	const p = new URLSearchParams({
		client_id: process.env.GOOGLE_CLIENT_ID || '',
		redirect_uri: redirectUri,
		response_type: 'code',
		scope: GOOGLE_SCOPES,
		access_type: 'offline',
		prompt: 'consent',
		include_granted_scopes: 'true',
		state,
	});
	return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

async function token(body: Record<string, string>) {
	const res = await fetch('https://oauth2.googleapis.com/token', {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			client_id: process.env.GOOGLE_CLIENT_ID || '',
			client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
			...body,
		}),
	});
	const data: any = await res.json();
	if (!res.ok) throw new Error(`Google token error: ${data.error_description || data.error}`);
	return data;
}

export async function googleExchangeCode(code: string, redirectUri: string) {
	const data = await token({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
	if (!data.refresh_token) throw new Error('Google did not return a refresh token. Remove remail from your Google account permissions and connect again.');
	const profile = await gget(`${API}/profile`, data.access_token);
	return {
		address: String(profile.emailAddress || '').toLowerCase(),
		displayName: profile.emailAddress || '',
		credentials: encrypt(JSON.stringify({ refresh_token: data.refresh_token })),
	};
}

async function accessToken(mb: MailboxRow) {
	if (!mb.credentials_enc) throw new Error('Mailbox is not connected — reconnect it from Mailboxes');
	const creds = JSON.parse(decrypt(mb.credentials_enc));
	const data = await token({ grant_type: 'refresh_token', refresh_token: creds.refresh_token });
	return data.access_token as string;
}

async function gget(url: string, accessTok: string): Promise<any> {
	for (let attempt = 0; attempt < 4; attempt++) {
		const res = await fetch(url, { headers: { authorization: `Bearer ${accessTok}` } });
		if (res.status === 429 || res.status >= 500) {
			await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
			continue;
		}
		const data: any = await res.json().catch(() => ({}));
		if (!res.ok) {
			const err: any = new Error(`Gmail ${res.status}: ${data?.error?.message || res.statusText}`);
			err.status = res.status;
			throw err;
		}
		return data;
	}
	throw new Error('Gmail request kept failing (throttled)');
}

function parseAddressList(v: string | undefined): Address[] {
	if (!v) return [];
	const out: Address[] = [];
	// split on commas that are not inside quotes
	for (const part of v.match(/("[^"]*"|[^,])+/g) || []) {
		const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(part);
		if (m) out.push({ name: m[1].trim(), address: normalizeAddress(m[2]) });
		else if (part.includes('@')) out.push({ name: '', address: normalizeAddress(part) });
	}
	return out;
}

const b64 = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

function extractBody(payload: any): string {
	let plain = '';
	let html = '';
	const walk = (p: any) => {
		if (!p) return;
		if (p.mimeType === 'text/plain' && p.body?.data && !plain) plain = b64(p.body.data);
		else if (p.mimeType === 'text/html' && p.body?.data && !html) html = b64(p.body.data);
		(p.parts || []).forEach(walk);
	};
	walk(payload);
	return plain || (html ? htmlToText(html) : '');
}

export function normalizeGmail(m: any): NormalizedMessage {
	const headers: Record<string, string> = {};
	for (const h of m.payload?.headers || []) headers[h.name.toLowerCase()] = h.value;
	const from = parseAddressList(headers['from'])[0] || { address: '', name: '' };
	const labels: string[] = m.labelIds || [];
	const automated =
		!!headers['list-unsubscribe'] ||
		/bulk|list|junk/i.test(headers['precedence'] || '') ||
		AUTOMATED_SENDER.test(from.address) ||
		labels.some((l) => ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS', 'SPAM'].includes(l));
	return {
		providerMessageId: m.id,
		internetMessageId: headers['message-id'] || null,
		threadId: m.threadId || null,
		inReplyTo: headers['in-reply-to'] || null,
		references: (headers['references'] || '').split(/\s+/).filter(Boolean),
		from,
		to: parseAddressList(headers['to']),
		cc: parseAddressList(headers['cc']),
		subject: headers['subject'] || '',
		bodyText: extractBody(m.payload),
		sentAt: new Date(Number(m.internalDate) || headers['date'] || Date.now()),
		hasAttachments: /"filename":"[^"]+"/.test(JSON.stringify(m.payload || {})),
		importance: headers['importance'] || null,
		webLink: `https://mail.google.com/mail/u/0/#all/${m.threadId}`,
		folder: labels.includes('SENT') ? 'sent' : labels.includes('INBOX') ? 'inbox' : 'other',
		isAutomated: automated,
	};
}

export async function gmailSync(mb: MailboxRow, maxMessages = 200): Promise<SyncBatch> {
	const tok = await accessToken(mb);
	const state: Record<string, any> = { ...(mb.sync_state || {}) };
	let ids: string[] = [];
	let more = false;

	if (state.historyId && !state.pageToken) {
		try {
			let pageToken = '';
			let latest = state.historyId;
			do {
				const h = await gget(
					`${API}/history?startHistoryId=${state.historyId}&historyTypes=messageAdded&maxResults=500${pageToken ? `&pageToken=${pageToken}` : ''}`,
					tok,
				);
				for (const rec of h.history || [])
					for (const ma of rec.messagesAdded || []) ids.push(ma.message.id);
				latest = h.historyId || latest;
				pageToken = h.nextPageToken || '';
			} while (pageToken && ids.length < maxMessages * 3);
			state.historyId = latest;
		} catch (e: any) {
			if (e.status !== 404) throw e;
			delete state.historyId; // history expired — fall back to a window resync
		}
	}

	if (!state.historyId || state.pageToken) {
		if (!state.pageToken) {
			const profile = await gget(`${API}/profile`, tok);
			state.pendingHistoryId = profile.historyId;
		}
		const qStr = `newer_than:${mb.backfill_days}d -in:spam -in:trash -in:drafts`;
		const list = await gget(
			`${API}/messages?maxResults=${Math.min(maxMessages, 100)}&q=${encodeURIComponent(qStr)}${state.pageToken ? `&pageToken=${state.pageToken}` : ''}`,
			tok,
		);
		ids = (list.messages || []).map((m: any) => m.id);
		if (list.nextPageToken) {
			state.pageToken = list.nextPageToken;
			more = true;
		} else {
			delete state.pageToken;
			state.historyId = state.pendingHistoryId;
			delete state.pendingHistoryId;
		}
	}

	ids = [...new Set(ids)].slice(0, maxMessages);
	const messages: NormalizedMessage[] = [];
	// fetch in small parallel batches
	for (let i = 0; i < ids.length; i += 10) {
		const chunk = await Promise.all(
			ids.slice(i, i + 10).map((id) => gget(`${API}/messages/${id}?format=full`, tok).catch(() => null)),
		);
		for (const m of chunk) {
			if (!m || (m.labelIds || []).includes('DRAFT')) continue;
			messages.push(normalizeGmail(m));
		}
	}
	return { messages, state, more };
}
