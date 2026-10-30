import { one } from './db';

export interface OrgSettings {
	slaHours: number;
	piiRedaction: boolean;
	retentionDays: number;
	analysisWindowDays: number;
	ignoreAutomated: boolean;
	reportTimezone: string;
}

export interface Org {
	id: number;
	name: string;
	internalDomains: string[];
	settings: OrgSettings;
}

const DEFAULTS: OrgSettings = {
	slaHours: 4,
	piiRedaction: true,
	retentionDays: 365,
	analysisWindowDays: 30,
	ignoreAutomated: false,
	reportTimezone: 'America/Toronto',
};

const cache = new Map<number, { org: Org; at: number }>();

export async function getOrg(id: number, fresh = false): Promise<Org> {
	const c = cache.get(id);
	if (!fresh && c && Date.now() - c.at < 30_000) return c.org;
	const row = await one<any>('select * from organisations where id=$1', [id]);
	if (!row) throw new Error(`Organisation ${id} not found`);
	const org: Org = {
		id: row.id,
		name: row.name,
		internalDomains: (row.internal_domains || []).map((d: string) => d.toLowerCase()),
		settings: { ...DEFAULTS, ...(row.settings || {}) },
	};
	cache.set(id, { org, at: Date.now() });
	return org;
}

export const invalidateOrg = (id: number) => cache.delete(id);
