/**
 * Customer database. For every shipper, broker, carrier, consignee or supplier, remail keeps a profile
 * gathered from their emails: company, phone numbers, address, postal or ZIP code, province or state,
 * language, load and account numbers, lanes, and GST/HST, USDOT and MC numbers. The rules engine fills it
 * for everyone (free); the AI refines it for active customers when available. Staff edits are never overwritten.
 */
import { one, q } from './db';
import { HttpError } from './http';

export interface Profile {
	type?: string; // shipper, broker, carrier, consignee, supplier, other
	organisation?: string;
	emails?: string[];
	phones?: string[];
	address?: string;
	city?: string;
	state?: string; // province or state
	postal_code?: string;
	country?: string;
	language?: string;
	order_refs?: string[]; // load, PRO, BOL and PO numbers
	account_numbers?: string[];
	lanes?: string[];
	tax_ids?: string[]; // GST/HST business number, USDOT, MC
	notes?: string;
}
export const PROFILE_FIELDS: (keyof Profile)[] = ['type', 'organisation', 'emails', 'phones', 'address', 'city', 'state', 'postal_code', 'country', 'language', 'order_refs', 'account_numbers', 'lanes', 'tax_ids', 'notes'];
export const LIST_FIELDS = ['emails', 'phones', 'order_refs', 'account_numbers', 'lanes', 'tax_ids'];
export const CUSTOMER_TYPES = ['shipper', 'broker', 'carrier', 'consignee', 'supplier', 'other'];

const uniq = (a: (string | undefined | null)[], n = 10) => [...new Set(a.map((x) => String(x || '').trim()).filter(Boolean))].slice(0, n);
const PROV: Record<string, string> = { ON: 'Ontario', QC: 'Quebec', BC: 'British Columbia', AB: 'Alberta', MB: 'Manitoba', SK: 'Saskatchewan', NS: 'Nova Scotia', NB: 'New Brunswick', NL: 'Newfoundland and Labrador', PE: 'Prince Edward Island', YT: 'Yukon', NT: 'Northwest Territories', NU: 'Nunavut' };
const US: Record<string, string> = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia' };
export const REGION_NAMES = { ...PROV, ...US };
const CA_POSTAL = /\b([ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z])\s?(\d[ABCEGHJ-NPRSTV-Z]\d)\b/i;
const US_ZIP = new RegExp(`\\b(${Object.keys(US).join('|')})\\s+(\\d{5})(?:-\\d{4})?\\b`);
const CA_PROV_LINE = new RegExp(`\\b(${Object.keys(PROV).join('|')})\\b`);

/** The part of an email a person wrote: drop quoted replies and our own text. */
const own = (b: string) => b.split(/\n(?:On .{5,80}wrote:|Le .{5,80}a écrit|-{2,} ?Original Message|From: .+\nSent:|>)/)[0];

/** Rules engine: everything that can be read reliably with patterns. */
export function rulesProfile(texts: string[], refs: { orders: string[]; units?: string[] }, email: string): Profile {
	const all = texts.map(own).join('\n\n');
	const phones = uniq([...all.matchAll(/(?:\+?1[\s.-]?)?\(?\b([2-9]\d{2})\)?[\s.-]?([2-9]\d{2})[\s.-](\d{4})\b/g)].map((m) => `+1 ${m[1]}-${m[2]}-${m[3]}`), 4);
	// an address is the short lines leading up to a postal or ZIP code
	let address = '';
	let postal = '';
	let state = '';
	let country = '';
	const lines = all.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
	for (let i = lines.length - 1; i >= 0; i--) {
		const ca = lines[i].match(CA_POSTAL);
		const us = lines[i].match(US_ZIP);
		if ((ca || us) && lines[i].length < 140 && !/load|pro|bol|invoice|po\b|order|ref|tracking/i.test(lines[i])) {
			postal = ca ? `${ca[1]} ${ca[2]}`.toUpperCase() : us![2];
			country = ca ? 'Canada' : 'United States';
			const prov = ca ? lines[i].match(CA_PROV_LINE)?.[1] : us![1];
			state = prov ? REGION_NAMES[prov] || '' : '';
			let k = i;
			while (k > Math.max(0, i - 3) && lines[k - 1].length < 70 && !/[.!?]\s*$|[.!?]\s/.test(lines[k - 1]) && !/^(regards|thanks|thank you|cheers|best|sincerely|hi|hello|dear|sent from|on .* wrote|tel|phone|cell|mobile|fax|email|e-mail|www\.)\b/i.test(lines[k - 1])) k--;
			address = lines.slice(k, i + 1).join(', ').replace(/\s+/g, ' ').slice(0, 300);
			break;
		}
	}
	const city = address ? (address.split(',').map((x) => x.trim()).reverse().find((x) => /^[A-Za-zÀ-ÿ .'-]{3,30}$/.test(x) && !REGION_NAMES[x.toUpperCase()] && !Object.values(REGION_NAMES).includes(x) && !/canada|usa|united states|suite|unit|street|st\.?$|road|rd\.?$|ave|avenue|blvd|drive|dr\.?$|way|lane/i.test(x)) || '') : '';
	const french = (all.match(/\b(bonjour|merci|livraison|camion|cordialement|veuillez|nous|votre|facture|ramassage)\b/gi) || []).length;
	const tax = uniq([
		...[...all.matchAll(/\b(\d{9})\s?RT\s?(\d{4})\b/gi)].map((m) => `GST/HST ${m[1]}RT${m[2]}`),
		...[...all.matchAll(/\bUS\s?DOT\s?(?:#|no\.?|number)?\s*[:#]?\s*(\d{5,8})\b/gi)].map((m) => `USDOT ${m[1]}`),
		...[...all.matchAll(/\bMC\s?(?:#|no\.?|number)?\s*[:#-]?\s*(\d{5,7})\b/g)].map((m) => `MC ${m[1]}`),
	], 4);
	const accounts = uniq([...all.matchAll(/\b(?:account|acct|customer)\s*(?:no\.?|number|#|id)\s*[:#-]?\s*([A-Z0-9-]{4,15})\b/gi)].map((m) => m[1].toUpperCase()), 4);
	const lanes = uniq([...all.matchAll(/\bfrom ([A-Z][A-Za-z .'-]{2,24}?)(?:,\s?[A-Z]{2})? to ([A-Z][A-Za-z .'-]{2,24}?)(?:,\s?[A-Z]{2})?(?=[\s,.;)]|$)/g)].map((m) => `${m[1].trim()} to ${m[2].trim()}`), 6);
	const org = all.match(/\b([A-Z][A-Za-z0-9.&' ]{2,50}(?:Inc\.?|Ltd\.?|LLC|Ltée|Corp\.?|Corporation|Logistics|Transport|Transportation|Trucking|Freight|Distribution|Foods|Manufacturing|Group|Company|Co\.))(?=[\s,.]|$)/)?.[1] || '';
	const type = /\b(freight broker|brokerage|3pl|third[- ]party logistics)\b/i.test(all) ? 'broker'
		: /\b(carrier|owner[- ]operator|our trucks|mc number|usdot)\b/i.test(all) && tax.some((t) => /USDOT|MC/.test(t)) ? 'carrier'
		: /\b(our invoice|we supply|quotation for|purchase order|our products)\b/i.test(all) && !/\b(load|pickup|delivery)\b/i.test(all.slice(0, 1500)) ? 'supplier'
		: 'shipper';
	return {
		type, organisation: org || undefined, emails: [email], phones, address: address || undefined, city: city || undefined, state: state || undefined,
		postal_code: postal || undefined, country: country || undefined, language: french >= 3 ? 'French' : 'English',
		order_refs: uniq(refs.orders, 10), account_numbers: accounts, lanes, tax_ids: tax,
	};
}

const AI_SCHEMA = {
	type: 'object',
	properties: {
		type: { type: 'string', enum: CUSTOMER_TYPES, description: 'shipper = sends freight with us; broker = freight broker or 3PL; carrier = another trucking company; consignee = receives freight; supplier = sells to us; other' },
		organisation: { type: ['string', 'null'], description: 'Company name' },
		phones: { type: 'array', items: { type: 'string' }, description: 'Phone numbers the sender gave as their own, as +1 XXX-XXX-XXXX' },
		address: { type: ['string', 'null'], description: 'Company or shipping address the sender gave as their own, one line' },
		city: { type: ['string', 'null'] }, state: { type: ['string', 'null'], description: 'Province or state, full name' },
		postal_code: { type: ['string', 'null'] }, country: { type: ['string', 'null'] },
		language: { type: ['string', 'null'], description: 'English or French' },
		order_refs: { type: 'array', items: { type: 'string' }, description: 'Load, PRO, BOL and PO numbers' },
		account_numbers: { type: 'array', items: { type: 'string' }, description: 'Their customer or account numbers with us' },
		lanes: { type: 'array', items: { type: 'string' }, description: 'Lanes they ship, as "Origin to Destination"' },
		tax_ids: { type: 'array', items: { type: 'string' }, description: 'GST/HST business number, USDOT and MC numbers, with the label' },
		notes: { type: ['string', 'null'], description: 'One short line on who they are and what they usually ship or write about. No opinions.' },
	},
	required: ['type', 'phones', 'order_refs', 'lanes'],
} as const;

async function aiProfile(orgId: number, name: string, texts: string[]): Promise<Profile | null> {
	const { aiPaused, aiProvider, extractJson } = await import('./ai/llm');
	if (aiProvider() === 'heuristic' || (await aiPaused())) return null;
	const out = await extractJson(orgId, 'You build a customer record for a trucking company from the emails a customer, broker, carrier or supplier sent. Use only what the emails state about the sender and their company; never guess. Leave a field empty when it is not stated.',
		`Sender: ${name}\n\nTheir emails (newest first):\n${texts.map((t, k) => `--- email ${k + 1}\n${own(t).slice(0, 1800)}`).join('\n')}`, AI_SCHEMA, 'record_customer');
	if (!out) return null;
	const clean = (v: any) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 300) : undefined);
	const arr = (v: any, n = 10) => (Array.isArray(v) ? uniq(v.map(String), n) : []);
	return {
		type: CUSTOMER_TYPES.includes(out.type) ? out.type : 'shipper', organisation: clean(out.organisation), phones: arr(out.phones, 4),
		address: clean(out.address), city: clean(out.city), state: clean(out.state), postal_code: clean(out.postal_code), country: clean(out.country), language: clean(out.language),
		order_refs: arr(out.order_refs), account_numbers: arr(out.account_numbers, 5), lanes: arr(out.lanes, 8), tax_ids: arr(out.tax_ids, 4), notes: clean(out.notes),
	};
}

/** Rules first, then the AI's reading on top where it found something. */
export async function buildProfile(customerId: number, useAi: boolean) {
	const c = await one<any>('select id, org_id, name from customers where id=$1', [customerId]);
	if (!c) throw new HttpError(404, 'Customer not found');
	const emails = await q<any>(
		`select e.body_clean, e.body_text, e.subject, e.from_address from emails e join conversations cv on cv.id=e.conversation_id
		  where cv.customer_id=$1 and e.direction='inbound' and not e.is_duplicate order by e.sent_at desc limit 12`,
		[customerId],
	);
	const refs = await one<any>(
		`select coalesce(array_agg(distinct r) filter (where r is not null), '{}') as orders,
		        coalesce((select array_agg(distinct b) from conversations c2, jsonb_array_elements_text(coalesce(c2.entities->'vehicle_regs','[]')) b where c2.customer_id=$1), '{}') as books
		   from conversations cv left join lateral jsonb_array_elements_text(coalesce(cv.entities->'shipment_refs','[]')) r on true where cv.customer_id=$1`,
		[customerId],
	);
	const addresses = uniq((await q<any>('select email from contacts where customer_id=$1', [customerId])).map((r) => r.email.toLowerCase()), 5);
	const texts = emails.map((e) => `${e.subject || ''}\n${e.body_clean || e.body_text || ''}`);
	let profile = rulesProfile(texts, { orders: refs?.orders || [] }, addresses[0] || emails[0]?.from_address || '');
	profile.emails = addresses.length ? addresses : profile.emails;
	let source = 'rules';
	if (useAi && texts.length) {
		try {
			const ai = await aiProfile(c.org_id, c.name, texts.slice(0, 6));
			if (ai) {
				const merged: any = { ...profile };
				for (const k of PROFILE_FIELDS) {
					const v = (ai as any)[k];
					if (Array.isArray(v) ? v.length : v) merged[k] = Array.isArray(v) && Array.isArray(merged[k]) ? uniq([...v, ...merged[k]]) : v;
				}
				profile = merged;
				source = 'ai';
			}
		} catch (e: any) {
			console.error('[profiles] AI failed, rules only:', e.message);
		}
	}
	await q('update customers set profile=$2, profile_source=$3, profile_at=now() where id=$1', [customerId, JSON.stringify(profile), source]);
	return { profile, source };
}

/** Background: profile customers that are new or have written since; the AI only for recently active ones. */
export async function buildProfiles(orgId: number, deadline: number) {
	const rows = await q<any>(
		`select id, (last_contact_at > now() - interval '30 days') as recent from customers
		  where org_id=$1 and (profile_at is null or last_contact_at > profile_at) order by last_contact_at desc nulls last limit 300`,
		[orgId],
	);
	let n = 0;
	let ai = 0;
	for (const r of rows) {
		if (Date.now() > deadline) break;
		const useAi = r.recent && ai < 25;
		const res = await buildProfile(r.id, useAi).catch((e) => (console.error('[profiles]', e.message), null));
		if (res?.source === 'ai') ai++;
		n++;
	}
	return { profiled: n, ai };
}

export const merged = (c: any): Profile => ({ ...(c.profile || {}), ...(c.profile_manual || {}) });

export async function listCustomerDb(orgId: number, qs: URLSearchParams) {
	const params: unknown[] = [orgId];
	const where = ['c.org_id=$1', `exists (select 1 from conversations cv where cv.customer_id=c.id)`];
	const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
	const P = `(c.profile || c.profile_manual)`;
	const text = (qs.get('q') || '').trim();
	if (text) { const t = p(`%${text}%`); where.push(`(c.name ilike ${t} or ${P}::text ilike ${t} or exists (select 1 from contacts k where k.customer_id=c.id and k.email ilike ${t}))`); }
	if (qs.get('type')) where.push(`coalesce(${P}->>'type', c.kind) = ${p(qs.get('type'))}`);
	if (qs.get('language')) where.push(`${P}->>'language' = ${p(qs.get('language'))}`);
	if (qs.get('state')) where.push(`${P}->>'state' ilike ${p(qs.get('state'))}`);
	if (qs.get('has') === 'phone') where.push(`jsonb_array_length(coalesce(${P}->'phones','[]')) > 0`);
	if (qs.get('has') === 'address') where.push(`coalesce(${P}->>'address','') <> ''`);
	if (qs.get('has') === 'orders') where.push(`jsonb_array_length(coalesce(${P}->'order_refs','[]')) > 0`);
	if (qs.get('has') === 'tax') where.push(`jsonb_array_length(coalesce(${P}->'tax_ids','[]')) > 0`);
	if (qs.get('has') === 'lanes') where.push(`jsonb_array_length(coalesce(${P}->'lanes','[]')) > 0`);
	const sort = { recent: 'c.last_contact_at desc nulls last', name: 'c.name', threads: 'threads desc' }[qs.get('sort') || 'recent'] || 'c.last_contact_at desc nulls last';
	const limit = Math.min(Number(qs.get('limit')) || 50, qs.get('format') === 'csv' ? 20000 : 200);
	const offset = Math.max(0, Number(qs.get('offset')) || 0);
	const W = where.join(' and ');
	const rows = await q<any>(
		`select c.id, c.name, c.kind, c.tier, c.health_score, c.health_status, c.last_contact_at, c.profile, c.profile_manual, c.profile_source, c.profile_at, c.enrichment, c.enriched_at,
		        (select count(*) from conversations cv where cv.customer_id=c.id)::int as threads,
		        (select count(*) from conversations cv where cv.customer_id=c.id and cv.awaiting_reply and cv.status in ('open','in_progress'))::int as waiting,
		        (select min(cv.first_message_at) from conversations cv where cv.customer_id=c.id) as first_contact
		   from customers c where ${W} order by ${sort} limit ${limit} offset ${offset}`,
		params,
	);
	const totals = await one<any>(
		`select count(*)::int as total,
		        count(*) filter (where jsonb_array_length(coalesce(${P}->'phones','[]')) > 0)::int as with_phone,
		        count(*) filter (where coalesce(${P}->>'address','') <> '')::int as with_address,
		        count(*) filter (where jsonb_array_length(coalesce(${P}->'order_refs','[]')) > 0)::int as with_orders,
		        count(*) filter (where jsonb_array_length(coalesce(${P}->'tax_ids','[]')) > 0)::int as with_tax,
		        count(*) filter (where jsonb_array_length(coalesce(${P}->'lanes','[]')) > 0)::int as with_lanes,
		        count(*) filter (where c.profile_source='ai')::int as by_ai,
		        count(*) filter (where c.profile_at is null)::int as pending
		   from customers c
		  where ${W}`,
		params,
	);
	const types = await q<any>(`select coalesce(${P}->>'type', c.kind) as k, count(*)::int as n from customers c where ${W} group by 1 order by 2 desc`, params);
	return { rows: rows.map((r) => ({ ...r, p: merged(r) })), totals: { ...totals, types }, offset, limit };
}

export async function updateProfile(orgId: number, id: number, input: Record<string, unknown>) {
	const c = await one<any>('select * from customers where id=$1 and org_id=$2', [id, orgId]);
	if (!c) throw new HttpError(404, 'Customer not found');
	const manual: any = { ...(c.profile_manual || {}) };
	for (const k of PROFILE_FIELDS) {
		if (!(k in input)) continue;
		const v = input[k];
		if (v === null || v === '') delete manual[k];
		else if (LIST_FIELDS.includes(k)) manual[k] = uniq((Array.isArray(v) ? v : String(v).split(/[,;\n]/)).map(String), 20);
		else manual[k] = String(v).slice(0, 500);
	}
	if (manual.type && !CUSTOMER_TYPES.includes(manual.type)) throw new HttpError(400, 'Unknown type');
	await q('update customers set profile_manual=$3, name=coalesce($4, name) where id=$1 and org_id=$2', [id, orgId, JSON.stringify(manual), typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 200) : null]);
	return one<any>('select * from customers where id=$1', [id]).then((r) => ({ ...r, p: merged(r) }));
}

/** One line for the AI when it drafts a reply to this customer. */
export function profileForPrompt(c: any): string {
	const p = merged(c);
	const parts = [
		p.type && `type: ${p.type}`, p.organisation && `company: ${p.organisation}`, p.language && `writes in ${p.language}`,
		p.address && `address on file: ${p.address}`, p.account_numbers?.length && `account no.: ${p.account_numbers.join(', ')}`,
		p.lanes?.length && `usual lanes: ${p.lanes.slice(0, 4).join('; ')}`, p.order_refs?.length && `earlier loads: ${p.order_refs.slice(0, 5).join(', ')}`,
	].filter(Boolean);
	return parts.join('; ');
}
