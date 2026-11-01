/**
 * Gmail / Google Workspace connector, read-only (gmail.readonly).
 *  - 'gmail'     : a person's own inbox, connected when they sign in with Google (OAuth, refresh token)
 *  - 'gmail_app' : shared or team mailboxes read through a Workspace service account with
 *                  domain-wide delegation (no per-mailbox sign-in)
 * Incremental sync uses the Gmail history API.
 */
import { SignJWT, importPKCS8 } from 'jose';
import { decrypt, encrypt } from '../crypto';
import { htmlToText, normalizeAddress, AUTOMATED_SENDER } from '../text';
import type { Address, MailboxRow, NormalizedMessage, SyncBatch } from './types';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
export const GMAIL_READONLY = 'https://www.googleapis.com/auth/gmail.readonly';
export const GMAIL_SEND = 'https://www.googleapis.com/auth/gmail.send';
/** Replies drafted in the app are sent through Gmail only when a person presses Send */
export const gmailSendEnabled = () => process.env.GMAIL_SEND_ENABLED !== 'false';
export const GOOGLE_SCOPES_BASE = `openid email profile ${GMAIL_READONLY}`;
export const GOOGLE_SCOPES = gmailSendEnabled() ? `${GOOGLE_SCOPES_BASE} ${GMAIL_SEND}` : GOOGLE_SCOPES_BASE;

export const googleConfigured = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
export const googleSsoEnabled = () => googleConfigured() && process.env.GOOGLE_SSO !== 'false';
/** Signing in with Google also connects the person's own inbox, read-only, unless GOOGLE_SIGNIN_CONNECTS_MAILBOX=false */
export const googleSigninConnectsMailbox = () => process.env.GOOGLE_SIGNIN_CONNECTS_MAILBOX !== 'false';
export const googleSigninScopes = () => (googleSigninConnectsMailbox() ? GOOGLE_SCOPES : 'openid email profile');

export function googleAuthorizeUrl(state: string, redirectUri: string, opts: { scope?: string; prompt?: string; loginHint?: string } = {}) {
	const p = new URLSearchParams({
		client_id: process.env.GOOGLE_CLIENT_ID || '',
		redirect_uri: redirectUri,
		response_type: 'code',
		scope: opts.scope || GOOGLE_SCOPES,
		access_type: 'offline',
		prompt: opts.prompt || 'consent',
		include_granted_scopes: 'true',
		state,
	});
	// a single Workspace domain: Google shows only accounts from it
	const domains = (process.env.GOOGLE_SSO_ALLOWED_DOMAINS || '').split(',').map((d) => d.trim()).filter(Boolean);
	if (domains.length === 1) p.set('hd', domains[0]);
	if (opts.loginHint) p.set('login_hint', opts.loginHint);
	return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

function decodeJwt(t: string): any {
	try { return JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString('utf8')); } catch { return {}; }
}

/** "Sign in with Google": OpenID Connect sign-in; with gmail.readonly granted it also returns inbox credentials. */
export async function googleSignIn(code: string, redirectUri: string) {
	const data = await token({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
	const c = decodeJwt(data.id_token || '');
	if (c.email_verified === false) throw new Error('Your Google email address is not verified');
	const hasMail = String(data.scope || '').includes(GMAIL_READONLY);
	return {
		email: String(c.email || '').toLowerCase(),
		fullName: String(c.name || ''),
		sub: String(c.sub || ''),
		hostedDomain: String(c.hd || ''),
		mailGranted: hasMail,
		credentials: hasMail && data.refresh_token ? encrypt(JSON.stringify({ refresh_token: data.refresh_token })) : null,
	};
}

// ── Workspace service account (domain-wide delegation) ─────────────────────
interface ServiceAccount { client_email: string; private_key: string; client_id: string }
export function parseServiceAccount(raw: string): ServiceAccount | null {
	raw = (raw || '').trim();
	if (!raw) return null;
	try {
		const json = JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8'));
		if (!json.client_email || !json.private_key) return null;
		return { client_email: json.client_email, private_key: json.private_key, client_id: String(json.client_id || '') };
	} catch {
		return null;
	}
}
// The key is normally uploaded in Mailboxes and stored encrypted in the database, because Netlify
// functions allow only 4 KB of environment variables in total. GOOGLE_SERVICE_ACCOUNT_JSON also works.
let dbSa: { sa: ServiceAccount | null; at: number } = { sa: null, at: 0 };
export async function loadServiceAccount(force = false) {
	if (!force && Date.now() - dbSa.at < 60_000) return;
	try {
		const { one } = await import('../db');
		const row = await one<any>(`select settings->>'googleServiceAccountEnc' as enc from organisations order by id limit 1`);
		dbSa = { sa: row?.enc ? parseServiceAccount(decrypt(row.enc)) : null, at: Date.now() };
	} catch {
		dbSa = { sa: null, at: Date.now() };
	}
}
export function serviceAccount(): ServiceAccount | null {
	return parseServiceAccount(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '') || dbSa.sa;
}
export const workspaceConfigured = () => !!serviceAccount();

const delegated = new Map<string, { token: string; exp: number }>();
export async function delegatedToken(subject: string, scope = GMAIL_READONLY): Promise<string> {
	const key = `${subject.toLowerCase()}|${scope}`;
	const cached = delegated.get(key);
	if (cached && cached.exp > Date.now() + 60_000) return cached.token;
	const sa = serviceAccount();
	if (!sa) throw new Error('Google Workspace access is not set up (GOOGLE_SERVICE_ACCOUNT_JSON)');
	const pk = await importPKCS8(sa.private_key.replace(/\\n/g, '\n'), 'RS256');
	const now = Math.floor(Date.now() / 1000);
	const assertion = await new SignJWT({ scope })
		.setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
		.setIssuer(sa.client_email)
		.setSubject(subject.toLowerCase())
		.setAudience('https://oauth2.googleapis.com/token')
		.setIssuedAt(now)
		.setExpirationTime(now + 3600)
		.sign(pk);
	const res = await fetch('https://oauth2.googleapis.com/token', {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
	});
	const data: any = await res.json();
	if (!res.ok) {
		const msg = data.error_description || data.error || res.status;
		throw new Error(/unauthorized_client/i.test(String(data.error)) || /not authorized/i.test(String(msg))
			? `Domain-wide delegation is not authorised for ${scope.split('/').pop()} yet. In the Google Admin console add the service account client ID with the gmail.readonly and gmail.send scopes.`
			: `Google token error: ${msg}`);
	}
	delegated.set(key, { token: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 });
	return data.access_token;
}

/** Checks that the service account can read this Workspace mailbox. */
export async function googleTestMailbox(address: string) {
	try {
		const tok = await delegatedToken(address);
		const p = await gget(`${API}/profile`, tok);
		return { ok: true, message: `Access confirmed: ${p.messagesTotal ?? 'unknown'} messages in ${p.emailAddress}` };
	} catch (e: any) {
		return { ok: false, message: e.status === 400 || e.status === 403 ? 'This address is not a mailbox in your Google Workspace, or delegation does not cover it.' : e.message };
	}
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
	if (mb.provider === 'gmail_app') return delegatedToken(mb.address);
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

export function normalizeGmail(m: any, mailbox = ''): NormalizedMessage {
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
		webLink: `https://mail.google.com/mail/${mailbox ? `?authuser=${encodeURIComponent(mailbox)}` : 'u/0/'}#all/${m.threadId}`,
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
			messages.push(normalizeGmail(m, mb.address));
		}
	}
	return { messages, state, more };
}

// ── Sending a reply (only when a person presses Send in the app) ───────────
const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const encodeHeader = (v: string) => (/^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v).toString('base64')}?=`);
const wrap76 = (s: string) => s.replace(/.{1,76}/g, (m) => `${m}\r\n`);

export interface OutgoingReply {
	from: string;
	fromName?: string;
	to: string[];
	cc: string[];
	subject: string;
	text: string;
	html: string;
	threadId?: string | null;
	inReplyTo?: string | null;
	references?: string[];
	/** images referenced from the HTML as cid:… */
	inline?: { cid: string; contentType: string; base64: string; filename: string }[];
}

export function buildMime(m: OutgoingReply): string {
	const boundary = `gm_${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
	const refs = [...new Set((m.references || []).filter(Boolean))];
	const headers = [
		`From: ${m.fromName ? `${encodeHeader(m.fromName)} <${m.from}>` : m.from}`,
		`To: ${m.to.join(', ')}`,
		m.cc.length ? `Cc: ${m.cc.join(', ')}` : '',
		`Subject: ${encodeHeader(m.subject)}`,
		m.inReplyTo ? `In-Reply-To: ${m.inReplyTo}` : '',
		refs.length ? `References: ${refs.join(' ')}` : '',
		'MIME-Version: 1.0',
	].filter(Boolean);
	const alt = [
		`--${boundary}`, 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', wrap76(Buffer.from(m.text).toString('base64')),
		`--${boundary}`, 'Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', wrap76(Buffer.from(m.html).toString('base64')),
		`--${boundary}--`,
	];
	if (!m.inline?.length) return [...headers, `Content-Type: multipart/alternative; boundary="${boundary}"`, '', ...alt, ''].join('\r\n');
	// text and HTML, plus the images the HTML shows inline (the logo)
	const rel = `rel_${boundary}`;
	return [
		...headers, `Content-Type: multipart/related; boundary="${rel}"`, '',
		`--${rel}`, `Content-Type: multipart/alternative; boundary="${boundary}"`, '', ...alt,
		...m.inline.flatMap((f) => [`--${rel}`, `Content-Type: ${f.contentType}; name="${f.filename}"`, 'Content-Transfer-Encoding: base64', `Content-ID: <${f.cid}>`, `Content-Disposition: inline; filename="${f.filename}"`, '', wrap76(f.base64)]),
		`--${rel}--`, '',
	].join('\r\n');
}

/** Sends through the mailbox the customer wrote to, as a reply in the same Gmail thread. */
export async function gmailSendReply(mb: MailboxRow, m: OutgoingReply): Promise<{ id: string; threadId: string }> {
	if (!gmailSendEnabled()) throw new Error('Sending is switched off (GMAIL_SEND_ENABLED=false)');
	const tok = mb.provider === 'gmail_app' ? await delegatedToken(mb.address, GMAIL_SEND) : await accessToken(mb);
	const res = await fetch(`${API}/messages/send`, {
		method: 'POST',
		headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
		body: JSON.stringify({ raw: b64url(buildMime(m)), ...(m.threadId ? { threadId: m.threadId } : {}) }),
	});
	const data: any = await res.json().catch(() => ({}));
	if (!res.ok) {
		const msg = data?.error?.message || res.statusText;
		if (res.status === 403 && /insufficient|scope/i.test(msg))
			throw new Error(mb.provider === 'gmail_app'
				? 'This shared mailbox is not allowed to send yet. Add the gmail.send scope to domain-wide delegation in the Google Admin console.'
				: 'Your Gmail connection does not allow sending yet. Sign out and sign in with Google again to grant it.');
		throw new Error(`Gmail send failed (${res.status}): ${msg}`);
	}
	return { id: data.id, threadId: data.threadId };
}
