import { q } from './db';
import type { Ctx } from './http';

/** Append-only audit trail. Never throws (auditing must not break the request). */
export async function audit(
	ctx: Ctx | null,
	action: string,
	entityType: string | null,
	entityId: string | number | null,
	details: Record<string, unknown> = {},
	actor?: { id?: number; org_id?: number; orgId?: number; email?: string } | null,
) {
	try {
		const u = actor ?? ctx?.user;
		await q(
			`insert into audit_log (org_id, user_id, user_email, action, entity_type, entity_id, details, ip_address, user_agent)
			 values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
			[
				(u as any)?.orgId ?? (u as any)?.org_id ?? null,
				u?.id ?? null,
				u?.email ?? null,
				action,
				entityType,
				entityId === null || entityId === undefined ? null : String(entityId),
				JSON.stringify(details),
				ctx?.ip ?? null,
				ctx?.ua?.slice(0, 300) ?? null,
			],
		);
	} catch (e: any) {
		console.error('[audit] failed', e.message);
	}
}
