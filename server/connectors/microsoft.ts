/**
 * Microsoft 365 / Outlook connector (Microsoft Graph, read-only).
 *
 * Two modes:
 *  - microsoft_app: application permission Mail.Read (client credentials). Used for the
 *    production Wheel King mailboxes; access is restricted to the monitored mailboxes with an
 *    Exchange Online application access policy (see docs/MICROSOFT_365_SETUP.md).
 *  - microsoft: delegated OAuth (Mail.Read + offline_access) — a user connects their own mailbox.
 *    Used for testing and for teams without tenant-wide admin consent.
 */
import { decrypt, encrypt } from '../crypto';
import { htmlToText, normalizeAddress, AUTOMATED_SENDER } from '../text';
import type { MailboxRow, NormalizedMessage, SyncBatch } from './types';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const LOGIN = 'https://login.microsoftonline.com';
export const MS_DELEGATED_SCOPES = 'offline_access openid email profile User.Read Mail.Read';

const tenant = () => process.env.MS_TENANT_ID || 'common';
const clientId = () => required('MS_CLIENT_ID');
const clientSecret = () => required('MS_CLIENT_SECRET');

function required(name: string) {
	const v = process.env[name];
	if (!v) throw new Error(`${name} is not configured`);
	return v;
}

export const microsoftConfigured = () => !!(process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET);

export function microsoftAuthorizeUrl(state: string, redirectUri: string) {
	const p = new URLSearchParams({
		client_id: clientId(),
		response_type: 'code',
		redirect_uri: redirectUri,
		response_mode: 'query',
		scope: MS_DELEGATED_SCOPES,
		state,
		prompt: 'select_account',
	});
	return `${LOGIN}/${process.env.MS_DELEGATED_TENANT || 'common'}/oauth2/v2.0/authorize?${p}`;
}

async function tokenRequest(body: Record<string, string>, tenantId: string) {
	const res = await fetch(`${LOGIN}/${tenantId}/oauth2/v2.0/token`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ client_id: clientId(), client_secret: clientSecret(), ...body }),
	});
	const data: any = await res.json();
	if (!res.ok) throw new Error(`Microsoft token error: ${data.error_description || data.error || res.status}`);
	return data;
}

export async function microsoftExchangeCode(code: string, redirectUri: string) {
	const data = await tokenRequest(
		{ grant_type: 'authorization_code', code, redirect_uri: redirectUri, scope: MS_DELEGATED_SCOPES },
		process.env.MS_DELEGATED_TENANT || 'common',
	);
	const me = await graphGet(`${GRAPH}/me?$select=mail,userPrincipalName,displayName`, data.access_token);
	return {
		address: (me.mail || me.userPrincipalName || '').toLowerCase(),
		displayName: me.displayName || '',
		credentials: encrypt(JSON.stringify({ refresh_token: data.refresh_token })),
	};
}

let appToken: { token: string; exp: number } | null = null;

async function accessToken(mb: MailboxRow): Promise<{ token: string; credentials?: string }> {
	if (mb.provider === 'microsoft_app') {
		if (appToken && appToken.exp > Date.now() + 60_000) return { token: appToken.token };
		const data = await tokenRequest(
			{ grant_type: 'client_credentials', scope: 'https://graph.microsoft.com/.default' },
			tenant(),
		);
		appToken = { token: data.access_token, exp: Date.now() + data.expires_in * 1000 };
		return { token: data.access_token };
	}
	if (!mb.credentials_enc) throw new Error('Mailbox is not connected — reconnect it from Mailboxes');
	const creds = JSON.parse(decrypt(mb.credentials_enc));
	const data = await tokenRequest(
		{ grant_type: 'refresh_token', refresh_token: creds.refresh_token, scope: MS_DELEGATED_SCOPES },
		process.env.MS_DELEGATED_TENANT || 'common',
	);
	// Microsoft rotates refresh tokens; persist the new one
	const rotated = data.refresh_token && data.refresh_token !== creds.refresh_token
		? encrypt(JSON.stringify({ refresh_token: data.refresh_token }))
		: undefined;
	return { token: data.access_token, credentials: rotated };
}

async function graphGet(url: string, token: string, extraHeaders: Record<string, string> = {}): Promise<any> {
	for (let attempt = 0; attempt < 4; attempt++) {
		const res = await fetch(url, {
			headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...extraHeaders },
		});
		if (res.status === 429 || res.status >= 500) {
			const wait = Number(res.headers.get('retry-after') || 2 ** attempt) * 1000;
			await new Promise((r) => setTimeout(r, Math.min(wait, 10_000)));
			continue;
		}
		const data: any = await res.json().catch(() => ({}));
		if (!res.ok) {
			const err: any = new Error(`Graph ${res.status}: ${data?.error?.message || res.statusText}`);
			err.status = res.status;
			throw err;
		}
		return data;
	}
	throw new Error('Graph request kept failing (throttled)');
}

const SELECT = [
	'id', 'internetMessageId', 'conversationId', 'subject', 'from', 'sender', 'toRecipients', 'ccRecipients',
	'receivedDateTime', 'sentDateTime', 'body', 'bodyPreview', 'hasAttachments', 'importance', 'webLink',
	'isDraft', 'inferenceClassification',
].join(',');

function toNormalized(m: any, folder: 'inbox' | 'sent'): NormalizedMessage | null {
	if (m['@removed'] || m.isDraft) return null;
	const addr = (r: any) => ({
		address: normalizeAddress(r?.emailAddress?.address || ''),
		name: r?.emailAddress?.name || '',
	});
	const from = addr(m.from || m.sender);
	const body = m.body?.contentType === 'html' ? htmlToText(m.body?.content || '') : m.body?.content || m.bodyPreview || '';
	return {
		providerMessageId: m.id,
		internetMessageId: m.internetMessageId || null,
		threadId: m.conversationId || null,
		inReplyTo: null,
		references: [],
		from,
		to: (m.toRecipients || []).map(addr),
		cc: (m.ccRecipients || []).map(addr),
		subject: m.subject || '',
		bodyText: body,
		sentAt: new Date(m.sentDateTime || m.receivedDateTime),
		hasAttachments: !!m.hasAttachments,
		importance: m.importance || null,
		webLink: m.webLink || null,
		folder,
		isAutomated: AUTOMATED_SENDER.test(from.address) || (folder === 'inbox' && m.inferenceClassification === 'other' && AUTOMATED_SENDER.test(from.name)),
	};
}

/** Delta sync of Inbox and Sent Items. Resumable across invocations via sync_state. */
export async function microsoftSync(mb: MailboxRow, maxMessages = 300): Promise<SyncBatch> {
	const { token, credentials } = await accessToken(mb);
	const base = mb.provider === 'microsoft_app' ? `${GRAPH}/users/${encodeURIComponent(mb.address)}` : `${GRAPH}/me`;
	const state: Record<string, any> = { ...(mb.sync_state || {}) };
	const since = new Date(Date.now() - mb.backfill_days * 86400_000).toISOString();
	const messages: NormalizedMessage[] = [];
	let more = false;

	for (const [folder, wellKnown] of [['inbox', 'inbox'], ['sent', 'sentitems']] as const) {
		const fs = state[folder] || {};
		let url: string =
			fs.nextLink ||
			fs.deltaLink ||
			`${base}/mailFolders/${wellKnown}/messages/delta?$select=${SELECT}&$filter=${encodeURIComponent(`receivedDateTime ge ${since}`)}`;
		while (url) {
			let page: any;
			try {
				page = await graphGet(url, token, {
					Prefer: 'outlook.body-content-type="text", odata.maxpagesize=50',
				});
			} catch (e: any) {
				// expired delta token → restart that folder
				if (e.status === 410 || /syncStateNotFound|resyncRequired/i.test(e.message)) {
					state[folder] = {};
					url = `${base}/mailFolders/${wellKnown}/messages/delta?$select=${SELECT}&$filter=${encodeURIComponent(`receivedDateTime ge ${since}`)}`;
					continue;
				}
				throw e;
			}
			for (const m of page.value || []) {
				const n = toNormalized(m, folder);
				if (n) messages.push(n);
			}
			if (page['@odata.nextLink']) {
				url = page['@odata.nextLink'];
				state[folder] = { nextLink: url };
				if (messages.length >= maxMessages) {
					more = true;
					break;
				}
			} else {
				state[folder] = { deltaLink: page['@odata.deltaLink'] };
				url = '';
			}
		}
		if (more) break;
	}
	return { messages, state, more, credentials };
}

/** Optional: send a notification email from a dedicated mailbox (requires Mail.Send for that one mailbox). */
export async function microsoftSendMail(from: string, to: string[], subject: string, html: string) {
	const { token } = await accessToken({ provider: 'microsoft_app' } as MailboxRow);
	const res = await fetch(`${GRAPH}/users/${encodeURIComponent(from)}/sendMail`, {
		method: 'POST',
		headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
		body: JSON.stringify({
			message: {
				subject,
				body: { contentType: 'HTML', content: html },
				toRecipients: to.map((address) => ({ emailAddress: { address } })),
			},
			saveToSentItems: false,
		}),
	});
	if (!res.ok) throw new Error(`Graph sendMail ${res.status}: ${await res.text()}`);
}
