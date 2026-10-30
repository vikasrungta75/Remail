import bcrypt from 'bcryptjs';
import { SignJWT, jwtVerify } from 'jose';
import { one, q } from './db';
import { HttpError, type Ctx } from './http';
import { decrypt, encrypt, randomToken, sha256 } from './crypto';
import { audit } from './audit';

export type Role = 'admin' | 'manager' | 'analyst' | 'viewer';
export const ROLE_RANK: Record<Role, number> = { viewer: 1, analyst: 2, manager: 3, admin: 4 };

export interface SessionUser {
	id: number;
	orgId: number;
	email: string;
	fullName: string;
	role: Role;
	allMailboxes: boolean;
	sessionId: string;
	authProvider: string;
	timezone: string;
}

const SESSION_HOURS = Number(process.env.SESSION_HOURS || 12);

function secret(): Uint8Array {
	const s = process.env.JWT_SECRET;
	if (!s || s.length < 32) throw new Error('JWT_SECRET must be set (32+ characters)');
	return new TextEncoder().encode(s);
}

export function authMode(): 'local' | 'ravity' | 'both' {
	const m = (process.env.AUTH_MODE || '').toLowerCase();
	if (m === 'local' || m === 'ravity' || m === 'both') return m;
	return process.env.RAVITY_IAM_URL ? 'both' : 'local';
}

// ── Organisation bootstrap ──────────────────────────────────────────────────
let orgId: number | null = null;

export async function defaultOrgId(): Promise<number> {
	if (orgId) return orgId;
	let org = await one<{ id: number }>('select id from organisations order by id limit 1');
	if (!org) {
		const internal = (process.env.INTERNAL_DOMAINS || 'wheelking.com,wheelkingtranshaul.com,wheelking.ca')
			.split(',')
			.map((d) => d.trim().toLowerCase())
			.filter(Boolean);
		org = await one<{ id: number }>(
			`insert into organisations (name, internal_domains, settings) values ($1, $2, $3) returning id`,
			[
				process.env.ORG_NAME || 'Wheel King TransHaul',
				internal,
				JSON.stringify({ slaHours: 4, piiRedaction: true, retentionDays: 365, analysisWindowDays: 30 }),
			],
		);
		await seedOrgDefaults(org!.id);
	}
	orgId = org!.id;
	await ensureBootstrapAdmin(orgId);
	return orgId;
}

async function seedOrgDefaults(id: number) {
	const recipients = (process.env.ALERT_RECIPIENTS || process.env.ADMIN_EMAIL || '')
		.split(',').map((s) => s.trim()).filter(Boolean);
	const rules: [string, string, object, string, number | null][] = [
		['Red conversation detected', 'rag_red', {}, 'high', 60],
		['Negative email from strategic or key customer', 'negative_key_customer', { tiers: ['strategic', 'key'] }, 'high', 120],
		['High escalation risk', 'escalation_risk', { threshold: 70 }, 'critical', 30],
		['Legal, cancellation or penalty language', 'keyword', { keywords: ['legal action', 'lawyer', 'solicitor', 'terminate', 'cancel the contract', 'penalty', 'compensation', 'final notice', 'escalate to your md', 'switch supplier'] }, 'critical', 30],
		['Customer awaiting reply beyond SLA', 'sla_breach', { hours: 4 }, 'medium', null],
		['Customer health dropped sharply', 'health_drop', { points: 15 }, 'high', null],
		['Action overdue', 'action_overdue', { days: 1 }, 'medium', null],
		['Proposal deadline within 2 days', 'proposal_deadline', { days: 2 }, 'high', null],
	];
	for (const [name, type, params, sev, esc] of rules) {
		await q(
			`insert into alert_rules (org_id, name, rule_type, params, severity, channels, recipients, escalate_after_minutes, escalation_recipients)
			 values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
			[id, name, type, JSON.stringify(params), sev, ['in_app', 'email'], recipients, esc, recipients],
		);
	}
	await q(
		`insert into report_schedules (org_id, name, frequency, hour_utc, recipients) values
		 ($1, 'Daily customer communication health', 'daily', 7, $2),
		 ($1, 'Weekly executive summary', 'weekly', 7, $2)`,
		[id, recipients],
	);
}

async function ensureBootstrapAdmin(org: number) {
	const email = process.env.ADMIN_EMAIL;
	const pw = process.env.ADMIN_PASSWORD;
	if (!email || !pw) return;
	const exists = await one('select id from users where lower(email)=lower($1)', [email]);
	if (exists) return;
	const any = await one('select id from users limit 1');
	if (any) return; // only bootstrap an empty system
	await q(
		`insert into users (org_id, email, full_name, role, password_hash, all_mailboxes) values ($1,$2,$3,'admin',$4,true)`,
		[org, email.toLowerCase(), process.env.ADMIN_NAME || 'Administrator', await bcrypt.hash(pw, 11)],
	);
}

// ── Sessions ────────────────────────────────────────────────────────────────
export async function issueSession(userId: number, ctx: Ctx, iamToken?: string) {
	const expires = new Date(Date.now() + SESSION_HOURS * 3600_000);
	const s = await one<{ id: string }>(
		`insert into sessions (user_id, expires_at, ip_address, user_agent, iam_token_enc) values ($1,$2,$3,$4,$5) returning id`,
		[userId, expires, ctx.ip, ctx.ua.slice(0, 300), iamToken ? encrypt(iamToken) : null],
	);
	const token = await new SignJWT({ sid: s!.id })
		.setProtectedHeader({ alg: 'HS256' })
		.setSubject(String(userId))
		.setIssuedAt()
		.setExpirationTime(expires)
		.setIssuer('remail')
		.sign(secret());
	await q('update users set last_login_at = now() where id=$1', [userId]);
	return { token, expiresAt: expires.toISOString(), sessionId: s!.id };
}

export async function authenticate(ctx: Ctx): Promise<SessionUser> {
	const header = ctx.req.headers.get('authorization') || '';
	const token = header.startsWith('Bearer ') ? header.slice(7) : ctx.query.get('access_token') || '';
	if (!token) throw new HttpError(401, 'Not signed in');
	let payload: any;
	try {
		({ payload } = await jwtVerify(token, secret(), { issuer: 'remail' }));
	} catch {
		throw new HttpError(401, 'Session expired. Please sign in again.');
	}
	const row = await one<any>(
		`select u.id, u.org_id, u.email, u.full_name, u.role, u.all_mailboxes, u.is_active, u.auth_provider, u.timezone,
		        s.id as sid, s.revoked_at, s.expires_at
		   from sessions s join users u on u.id = s.user_id
		  where s.id = $1 and u.id = $2`,
		[payload.sid, Number(payload.sub)],
	);
	if (!row || row.revoked_at || new Date(row.expires_at) < new Date() || !row.is_active)
		throw new HttpError(401, 'Session expired. Please sign in again.');
	return {
		id: row.id,
		orgId: row.org_id,
		email: row.email,
		fullName: row.full_name,
		role: row.role,
		allMailboxes: row.all_mailboxes || row.role === 'admin' || row.role === 'manager',
		sessionId: row.sid,
		authProvider: row.auth_provider,
		timezone: row.timezone,
	};
}

export function requireRole(user: SessionUser | undefined, min: Role) {
	if (!user) throw new HttpError(401, 'Not signed in');
	if (ROLE_RANK[user.role] < ROLE_RANK[min]) throw new HttpError(403, 'You do not have permission for this action');
}

/** Mailbox ids the user may see; null = all mailboxes in org */
export async function mailboxScope(user: SessionUser): Promise<number[] | null> {
	if (user.allMailboxes) return null;
	const rows = await q<{ mailbox_id: number }>('select mailbox_id from user_mailboxes where user_id=$1', [user.id]);
	return rows.map((r) => r.mailbox_id);
}

// ── Login: Ravity IAM (same flow and endpoints as rfleet) ───────────────────
// rfleet: getCustomerSpaces → authenticateuser → getUserInfoByToken → getProfileUserDetails,
// logout → /auth/logout, forgot → /user/forgetpasswordresetlink, reset → /auth/updateforgotpassword
export const ravityConfigured = () => !!process.env.RAVITY_IAM_URL;

export async function iamPost(path: string, fields: Record<string, string>, headers: Record<string, string> = {}) {
	const base = (process.env.RAVITY_IAM_URL || '').replace(/\/$/, '');
	const res = await fetch(`${base}${path.startsWith('/') ? path : `/${path}`}`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', accept: '*/*', ...headers },
		body: new URLSearchParams(fields).toString(),
		signal: AbortSignal.timeout(20_000),
	});
	if (!res.ok && res.status !== 304) throw new Error(`IAM ${path} responded ${res.status}`);
	return res.json().catch(() => ({})) as Promise<any>;
}

async function ravitySpace(userid: string) {
	const spaceName = process.env.RAVITY_SPACE_NAME || '';
	const spaces = await iamPost('/auth/getCustomerSpaces', { userid, authType: 'ep' });
	if (!spaces?.spaces?.success) return { ok: false as const, message: spaces?.spaces?.errorMessage || spaces?.spaces?.message };
	const list: any[] = spaces.spaces.spaces || [];
	const space = (spaceName && list.find((s) => s.spaceName === spaceName)) || list[0];
	return { ok: true as const, space };
}

async function ravityLogin(userid: string, password: string) {
	const sp = await ravitySpace(userid);
	if (!sp.ok) return sp;
	const login = await iamPost('/auth/authenticateuser', {
		userid,
		authType: 'ep',
		password,
		customerkey: String(sp.space?.customerKey ?? ''),
	});
	if (!login?.users?.success || !login.users.authToken)
		return { ok: false as const, message: login?.users?.errorMessage || login?.users?.message };
	const token = login.users.authToken as string;
	const info = await iamPost('/auth/getUserInfoByToken', { token });
	if (!info?.users?.success) return { ok: false as const, message: info?.users?.errorMessage || 'Could not read your Ravity profile' };
	const u = info.users.user || {};
	let profile: any = {};
	try {
		const pd = await iamPost('/user/getProfileUserDetails', { spacekey: String(u.spaceKey ?? '') }, { authtoken: token, spacekey: String(u.spaceKey ?? ''), userid: String(u.id ?? '') });
		profile = pd?.users?.user || pd?.users || {};
	} catch { /* profile is optional */ }
	let props: any[] = [];
	try { props = JSON.parse(u.customproperties || '[]'); } catch { props = []; }
	const prop = (k: string) => (Array.isArray(props) ? props : []).find((p: any) => String(p?.key).toUpperCase() === k)?.value;
	const fullName = profile.fullName || u.fullName || [profile.firstName || u.firstName, profile.lastName || u.lastName].filter(Boolean).join(' ') || userid;
	return {
		ok: true as const,
		token,
		externalId: String(u.id ?? userid),
		spaceKey: String(u.spaceKey ?? sp.space?.spaceKey ?? ''),
		fullName,
		email: String(profile.emailID || profile.email || u.email || u.emailID || userid).toLowerCase(),
		iamRole: String(prop('ROLE') || '').toLowerCase(),
	};
}

/** rfleet's forgot-password: the Ravity IAM emails a reset link for the user's space. */
export async function ravityForgotPassword(email: string) {
	const sp = await ravitySpace(email);
	if (!sp.ok) return false;
	const r = await iamPost('/user/forgetpasswordresetlink', { emailID: email, spaceKey: String(sp.space?.spaceKey ?? '') });
	return !!r?.users?.success;
}

/** rfleet's reset page posts the token from the email link with the new password. */
export async function ravityResetPassword(encodedToken: string, newpassword: string) {
	const r = await iamPost('/auth/updateforgotpassword', { encodedToken, newpassword });
	if (!r?.users?.success) throw new HttpError(400, r?.users?.errorMessage || r?.users?.message || 'This reset link is invalid or has expired');
	return true;
}

function mapIamRole(r: string): Role {
	if (/admin/.test(r)) return 'admin';
	if (/manager|supervisor/.test(r)) return 'manager';
	if (/analyst|agent|operator/.test(r)) return 'analyst';
	const def = (process.env.RAVITY_DEFAULT_ROLE || 'viewer') as Role;
	return ROLE_RANK[def] ? def : 'viewer';
}

export async function login(ctx: Ctx, userid: string, password: string) {
	const email = userid.trim().toLowerCase();
	const org = await defaultOrgId();

	// Throttle brute force: 10 failures per identity per 15 minutes
	const fails = await one<{ n: number }>(
		`select count(*)::int n from audit_log where action='auth.login_failed' and lower(user_email)=$1 and created_at > now() - interval '15 minutes'`,
		[email],
	);
	if ((fails?.n || 0) >= 10) throw new HttpError(429, 'Too many failed attempts. Try again in 15 minutes.');

	const mode = authMode();
	let user = await one<any>('select * from users where lower(email)=$1', [email]);

	// 1) Local password (when the account is local)
	if ((mode === 'local' || mode === 'both') && user?.password_hash && user.auth_provider === 'local') {
		if (await bcrypt.compare(password, user.password_hash)) {
			if (!user.is_active) throw new HttpError(403, 'This account is disabled');
			return finishLogin(ctx, user);
		}
		if (mode === 'local') return failLogin(ctx, email);
	}

	// 2) Ravity IAM (getCustomerSpaces → authenticateuser → getUserInfoByToken)
	if ((mode === 'ravity' || mode === 'both') && process.env.RAVITY_IAM_URL) {
		let res;
		try {
			res = await ravityLogin(userid.trim(), password);
		} catch (e: any) {
			console.error('[auth] IAM error', e.message);
			throw new HttpError(502, 'Sign-in service is unavailable. Please try again shortly.');
		}
		if (res.ok) {
			const bootstrapAdmins = (process.env.BOOTSTRAP_ADMIN_EMAILS || '').toLowerCase().split(',').map((s) => s.trim());
			if (!user) {
				const anyUser = await one('select id from users limit 1');
				const role: Role = !anyUser || bootstrapAdmins.includes(email) ? 'admin' : mapIamRole(res.iamRole);
				user = await one<any>(
					`insert into users (org_id, email, full_name, role, auth_provider, external_id, all_mailboxes, ravity_space_key)
					 values ($1,$2,$3,$4,'ravity',$5,$6,$7) returning *`,
					[org, email, res.fullName, role, res.externalId, role === 'admin' || role === 'manager', res.spaceKey],
				);
				await audit(ctx, 'user.provisioned', 'user', user.id, { provider: 'ravity', role }, user);
			} else {
				user = await one<any>(
					`update users set full_name=coalesce(nullif($2,''), full_name), external_id=$3, ravity_space_key=$4,
					   auth_provider = case when auth_provider='local' and password_hash is null then 'ravity' else auth_provider end
					 where id=$1 returning *`,
					[user.id, res.fullName, res.externalId, res.spaceKey],
				);
			}
			if (!user.is_active) throw new HttpError(403, 'This account is disabled');
			return finishLogin(ctx, user, res.token);
		}
	}
	return failLogin(ctx, email);
}

async function failLogin(ctx: Ctx, email: string): Promise<never> {
	await audit(ctx, 'auth.login_failed', 'user', null, {}, { email });
	throw new HttpError(401, 'Invalid email or password');
}

export async function finishLogin(ctx: Ctx, user: any, iamToken?: string) {
	const session = await issueSession(user.id, ctx, iamToken);
	await audit(ctx, 'auth.login', 'user', user.id, { provider: user.auth_provider }, user);
	return {
		success: true,
		token: session.token,
		expiresAt: session.expiresAt,
		loginTime: new Date().toISOString(),
		user: publicUser(user),
	};
}

export function publicUser(u: any) {
	return {
		id: u.id,
		email: u.email,
		fullName: u.full_name ?? u.fullName,
		role: u.role,
		authProvider: u.auth_provider ?? u.authProvider,
		allMailboxes: u.all_mailboxes ?? u.allMailboxes,
		timezone: u.timezone,
		notifyEmail: u.notify_email,
		digestEnabled: u.digest_enabled,
		emailAliases: u.email_aliases || [],
		lastLoginAt: u.last_login_at,
	};
}

export async function logout(ctx: Ctx, user: SessionUser, loginTime?: string) {
	const s = await one<any>('update sessions set revoked_at = now() where id=$1 returning iam_token_enc', [user.sessionId]);
	// end the Ravity IAM session too, exactly as rfleet does on logout
	if (s?.iam_token_enc && ravityConfigured()) {
		try { await iamPost('/auth/logout', { token: decrypt(s.iam_token_enc) }); } catch (e: any) { console.error('[auth] IAM logout', e.message); }
	}
	let duration = '';
	if (loginTime) {
		const s = Math.max(0, Math.round((Date.now() - new Date(loginTime).getTime()) / 1000));
		duration = `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ${s % 60}s`;
	}
	await audit(ctx, 'auth.logout', 'user', user.id, { session_duration: duration });
}

// ── Password management ─────────────────────────────────────────────────────
export function validatePassword(pw: string) {
	if (pw.length < 10 || !/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw))
		throw new HttpError(400, 'Password must be at least 10 characters and include letters and numbers');
}

export async function hashPassword(pw: string) {
	validatePassword(pw);
	return bcrypt.hash(pw, 11);
}

export async function createResetToken(userId: number) {
	const token = randomToken(32);
	await q(`insert into password_resets (user_id, token_hash, expires_at) values ($1,$2, now() + interval '1 hour')`, [
		userId,
		sha256(token),
	]);
	return token;
}

export async function consumeResetToken(token: string, newPassword: string) {
	const row = await one<any>(
		`select * from password_resets where token_hash=$1 and used_at is null and expires_at > now()`,
		[sha256(token)],
	);
	if (!row) throw new HttpError(400, 'This reset link is invalid or has expired');
	const hash = await hashPassword(newPassword);
	await q(`update users set password_hash=$2, auth_provider='local', updated_at=now() where id=$1`, [row.user_id, hash]);
	await q(`update password_resets set used_at=now() where id=$1`, [row.id]);
	await q(`update sessions set revoked_at=now() where user_id=$1 and revoked_at is null`, [row.user_id]);
	return row.user_id as number;
}

export async function verifyPassword(userId: number, pw: string) {
	const u = await one<any>('select password_hash from users where id=$1', [userId]);
	return !!u?.password_hash && bcrypt.compare(pw, u.password_hash);
}

// ── Sign in with Microsoft (Entra ID / Office 365 work accounts) ────────────
export const microsoftSsoEnabled = () => !!(process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET) && process.env.MS_SSO !== 'false';

export async function loginWithMicrosoft(ctx: Ctx, ms: { email: string; fullName: string; objectId: string; tenantId: string }) {
	const org = await defaultOrgId();
	const { getOrg } = await import('./settings');
	const o = await getOrg(org, true);
	if (!ms.email) throw new HttpError(400, 'Your Microsoft account has no email address');
	let user = await one<any>('select * from users where lower(email)=$1 or ms_object_id=$2 or $1 = any(email_aliases) limit 1', [ms.email, ms.objectId]);
	if (!user) {
		const domain = ms.email.split('@')[1] || '';
		const anyUser = await one('select id from users limit 1');
		const sameTenant = (o.settings as any).msTenantId && (o.settings as any).msTenantId === ms.tenantId;
		const allowed = !anyUser || sameTenant || o.internalDomains.includes(domain) ||
			(process.env.MS_SSO_ALLOWED_DOMAINS || '').toLowerCase().split(',').map((x) => x.trim()).includes(domain);
		if (!allowed) {
			await audit(ctx, 'auth.login_failed', 'user', null, { provider: 'microsoft', reason: 'not provisioned' }, { email: ms.email });
			throw new HttpError(403, 'Your Microsoft account is not set up for remail yet. Ask an administrator to invite you.');
		}
		const bootstrapAdmins = (process.env.BOOTSTRAP_ADMIN_EMAILS || process.env.ADMIN_EMAIL || '').toLowerCase().split(',').map((x) => x.trim());
		const role: Role = !anyUser || bootstrapAdmins.includes(ms.email) ? 'admin' : ((process.env.MS_SSO_DEFAULT_ROLE as Role) in ROLE_RANK ? (process.env.MS_SSO_DEFAULT_ROLE as Role) : 'analyst');
		user = await one<any>(
			`insert into users (org_id, email, full_name, role, auth_provider, ms_object_id, all_mailboxes) values ($1,$2,$3,$4,'microsoft',$5,$6) returning *`,
			[org, ms.email, ms.fullName || ms.email, role, ms.objectId, role === 'admin' || role === 'manager'],
		);
		await audit(ctx, 'user.provisioned', 'user', user.id, { provider: 'microsoft', role }, user);
	} else {
		user = await one<any>('update users set ms_object_id=$2, full_name=coalesce(nullif(full_name,\'\'), $3) where id=$1 returning *', [user.id, ms.objectId, ms.fullName]);
	}
	if (!user.is_active) throw new HttpError(403, 'This account is disabled');
	return finishLogin(ctx, user);
}
