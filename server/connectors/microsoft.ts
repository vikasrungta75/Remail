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

const clientId = () => required('MS_CLIENT_ID');
const clientSecret = () => required('MS_CLIENT_SECRET');

function required(name: string) {
	const v = process.env[name];
	if (!v) throw new Error(`${name} is not configured`);
	return v;
}

export const microsoftConfigured = () => !!(process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET);

/**
 * The customer tenant used for application (organisation-wide) access. Set either by the
 * admin-consent flow (stored in organisation settings) or by MS_TENANT_ID.
 */
export async function orgTenant(orgId: number): Promise<string | null> {
	const { getOrg } = await import('../settings');
	const org = await getOrg(orgId);
	return (org.settings as any).msTenantId || process.env.MS_TENANT_ID || null;
}

export function microsoftAuthorizeUrl(state: string, redirectUri: string, scope = MS_DELEGATED_SCOPES, prompt = 'select_account') {
	const p = new URLSearchParams({
		client_id: clientId(),
		response_type: 'code',
		redirect_uri: redirectUri,
		response_mode: 'query',
		scope,
		state,
		prompt,
	});
	return `${LOGIN}/${process.env.MS_DELEGATED_TENANT || 'organizations'}/oauth2/v2.0/authorize?${p}`;
}

/** Admin consent: a Microsoft 365 administrator approves remail's read-only permissions for the whole tenant. */
export function microsoftAdminConsentUrl(state: string, redirectUri: string, tenantHint = 'organizations') {
	const p = new URLSearchParams({ client_id: clientId(), redirect_uri: redirectUri, state, scope: 'https://graph.microsoft.com/.default' });
	return `${LOGIN}/${tenantHint}/v2.0/adminconsent?${p}`;
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

function decodeJwt(t: string): any {
	try { return JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString('utf8')); } catch { return {}; }
}

export async function microsoftExchangeCode(code: string, redirectUri: string) {
	const data = await tokenRequest(
		{ grant_type: 'authorization_code', code, redirect_uri: redirectUri, scope: MS_DELEGATED_SCOPES },
		process.env.MS_DELEGATED_TENANT || 'organizations',
	);
	const me = await graphGet(`${GRAPH}/me?$select=mail,userPrincipalName,displayName`, data.access_token);
	return {
		address: (me.mail || me.userPrincipalName || '').toLowerCase(),
		displayName: me.displayName || '',
		credentials: encrypt(JSON.stringify({ refresh_token: data.refresh_token })),
	};
}

export const MS_SIGNIN_SCOPES = 'openid profile email User.Read';

/** "Sign in with Microsoft": OpenID Connect sign-in for Wheel King staff with their work accounts. */
export async function microsoftSignIn(code: string, redirectUri: string) {
	const data = await tokenRequest(
		{ grant_type: 'authorization_code', code, redirect_uri: redirectUri, scope: MS_SIGNIN_SCOPES },
		process.env.MS_DELEGATED_TENANT || 'organizations',
	);
	const claims = decodeJwt(data.id_token || '');
	const me = await graphGet(`${GRAPH}/me?$select=id,mail,userPrincipalName,displayName,jobTitle`, data.access_token);
	return {
		email: String(me.mail || me.userPrincipalName || claims.preferred_username || '').toLowerCase(),
		fullName: me.displayName || claims.name || '',
		objectId: String(me.id || claims.oid || ''),
		tenantId: String(claims.tid || ''),
	};
}

const appTokens = new Map<string, { token: string; exp: number }>();

async function appAccessToken(tenantId: string) {
	const cached = appTokens.get(tenantId);
	if (cached && cached.exp > Date.now() + 60_000) return cached.token;
	const data = await tokenRequest({ grant_type: 'client_credentials', scope: 'https://graph.microsoft.com/.default' }, tenantId);
	appTokens.set(tenantId, { token: data.access_token, exp: Date.now() + data.expires_in * 1000 });
	return data.access_token as string;
}

async function accessToken(mb: MailboxRow): Promise<{ token: string; credentials?: string }> {
	if (mb.provider === 'microsoft_app') {
		const t = await orgTenant(mb.org_id);
		if (!t) throw new Error('Microsoft 365 is not connected for this organisation. An administrator must grant consent under Mailboxes.');
		return { token: await appAccessToken(t) };
	}
	if (!mb.credentials_enc) throw new Error('Mailbox is not connected — reconnect it from Mailboxes');
	const creds = JSON.parse(decrypt(mb.credentials_enc));
	const data = await tokenRequest(
		{ grant_type: 'refresh_token', refresh_token: creds.refresh_token, scope: MS_DELEGATED_SCOPES },
		process.env.MS_DELEGATED_TENANT || 'organizations',
	);
	// Microsoft rotates refresh tokens; persist the new one
	const rotated = data.refresh_token && data.refresh_token !== creds.refresh_token
		? encrypt(JSON.stringify({ refresh_token: data.refresh_token }))
		: undefined;
	return { token: data.access_token, credentials: rotated };
}

/**
 * Verify remail can read a mailbox with the organisation's consent and access policy.
 * Returns ok=false with Microsoft's reason (e.g. the access policy denies it).
 */
export async function microsoftTestMailbox(orgId: number, address: string) {
	const t = await orgTenant(orgId);
	if (!t) return { ok: false, reason: 'Microsoft 365 is not connected yet. Grant administrator consent first.' };
	try {
		const token = await appAccessToken(t);
		const inbox = await graphGet(`${GRAPH}/users/${encodeURIComponent(address)}/mailFolders/inbox?$select=displayName,totalItemCount,unreadItemCount`, token);
		return { ok: true, totalItems: inbox.totalItemCount, unread: inbox.unreadItemCount };
	} catch (e: any) {
		const reason = e.status === 403
			? 'Access denied. Add this mailbox to the remail application access policy (or RBAC management scope) in Exchange Online.'
			: e.status === 404
				? 'Mailbox not found in this tenant. Check the address, and that it is an Exchange Online mailbox.'
				: e.message;
		return { ok: false, reason };
	}
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
export async function microsoftSendMail(from: string, to: string[], subject: string, html: string, orgId = 1) {
	const t = await orgTenant(orgId);
	if (!t) throw new Error('Microsoft 365 is not connected for sending');
	const token = await appAccessToken(t);
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
