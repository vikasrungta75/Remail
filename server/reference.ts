/**
 * Reference data the AI may rely on in drafts: rates and services (lanes, equipment, accessorials),
 * FAQs and policies. Uploaded as CSV in Help → Reference data. For each thread the entries that
 * match the email text are added to the prompt, so fewer facts are left as yellow placeholders.
 */
import { q } from './db';
import { HttpError } from './http';

export type RefKind = 'book' | 'faq' | 'policy';

/** Small RFC 4180 CSV parser (quotes, escaped quotes, newlines inside quotes). */
export function parseCsv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let cell = '';
	let quoted = false;
	const s = text.replace(/^﻿/, '');
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (quoted) {
			if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; }
			else if (c === '"') quoted = false;
			else cell += c;
		} else if (c === '"') quoted = true;
		else if (c === ',' || c === '\t') { row.push(cell); cell = ''; }
		else if (c === '\n' || c === '\r') {
			if (c === '\r' && s[i + 1] === '\n') i++;
			row.push(cell); cell = '';
			if (row.some((x) => x.trim())) rows.push(row);
			row = [];
		} else cell += c;
	}
	row.push(cell);
	if (row.some((x) => x.trim())) rows.push(row);
	return rows;
}

const HEAD: Record<string, string[]> = {
	code: ['code', 'lane code', 'service code', 'item code', 'sku', 'id'],
	title: ['title', 'lane', 'service', 'name', 'question', 'policy'],
	language: ['language', 'lang', 'bhasha'],
	price: ['price', 'mrp', 'rate', 'cost'],
	in_stock: ['in_stock', 'in stock', 'stock', 'available', 'availability'],
	body: ['answer', 'text', 'details', 'description', 'notes', 'note', 'remarks'],
	keywords: ['keywords', 'keyword', 'tags', 'aliases'],
};
const col = (header: string[], key: string) => header.findIndex((h) => HEAD[key].includes(h.trim().toLowerCase()));

export const TEMPLATES_CSV: Record<RefKind, string> = {
	book: 'code,title,price,in_stock,notes,keywords\nLANE-TOR-CHI,Toronto to Chicago 53 ft dry van,2450 CAD all-in,yes,Transit 2 days; fuel surcharge included,toronto chicago;yyz chi\n',
	faq: 'question,answer,keywords\nWhat are your detention charges?,Two hours free at each stop; then 85 CAD per hour billed in 15-minute increments.,detention;waiting time\n',
	policy: 'title,text,keywords\nCargo claims,Claims must be filed in writing within 9 months of delivery with photos and the signed delivery receipt.,claim;damage;shortage\n',
};

export async function importCsv(orgId: number, kind: RefKind, csv: string, replace: boolean) {
	if (!['book', 'faq', 'policy'].includes(kind)) throw new HttpError(400, 'Unknown kind');
	const rows = parseCsv(csv || '');
	if (rows.length < 2) throw new HttpError(400, 'The file needs a header row and at least one data row');
	if (rows.length > 20001) throw new HttpError(400, 'At most 20,000 rows per upload');
	// skip title or note lines above the header (as in the Excel template)
	const hi = rows.slice(0, 10).findIndex((r) => r.some((h) => HEAD.title.includes(String(h).trim().toLowerCase())));
	if (hi > 0) rows.splice(0, hi);
	const header = rows[0];
	const ix = Object.fromEntries(Object.keys(HEAD).map((k) => [k, col(header, k)]));
	if (ix.title < 0) throw new HttpError(400, `No title column found. Expected a header like: ${TEMPLATES_CSV[kind].split('\n')[0]}`);
	if (kind !== 'book' && ix.body < 0) throw new HttpError(400, `No answer or text column found. Expected: ${TEMPLATES_CSV[kind].split('\n')[0]}`);
	if (replace) await q('delete from reference_items where org_id=$1 and kind=$2', [orgId, kind]);
	let added = 0;
	let updated = 0;
	for (const r of rows.slice(1)) {
		const get = (k: string) => (ix[k] >= 0 ? String(r[ix[k]] ?? '').trim() : '');
		const title = get('title');
		if (!title) continue;
		const code = get('code') || null;
		const data: Record<string, string> = {};
		if (kind === 'book') for (const k of ['language', 'price', 'in_stock']) if (get(k)) data[k] = get(k);
		// any other column (author, edition, pages, binding, size, ebook link, branch…) is kept and given to the AI as is
		header.forEach((h, i) => {
			const key = h.trim().toLowerCase();
			if (!key || (Object.values(ix) as number[]).includes(i) || !String(r[i] ?? '').trim()) return;
			if (Object.keys(data).length < 25) data[key.slice(0, 40)] = String(r[i]).trim().slice(0, 300);
		});
		const keywords = get('keywords').split(/[;|]/).map((x) => x.trim().toLowerCase()).filter(Boolean).slice(0, 20);
		const body = get('body').slice(0, 2000);
		if (kind !== 'book' && !body) continue; // a question or policy with no answer yet
		const res = code
			? await q<any>(
				`insert into reference_items (org_id, kind, code, title, body, keywords, data) values ($1,$2,$3,$4,$5,$6,$7)
				 on conflict (org_id, kind, code) where code is not null do update set title=excluded.title, body=excluded.body, keywords=excluded.keywords, data=excluded.data, updated_at=now()
				 returning (xmax = 0) as inserted`,
				[orgId, kind, code.slice(0, 60), title.slice(0, 300), body, keywords, JSON.stringify(data)],
			)
			: await q<any>(
				`insert into reference_items (org_id, kind, title, body, keywords, data) values ($1,$2,$3,$4,$5,$6) returning true as inserted`,
				[orgId, kind, title.slice(0, 300), body, keywords, JSON.stringify(data)],
			);
		if (res[0]?.inserted) added++;
		else updated++;
	}
	cache.delete(orgId);
	return { added, updated, total: added + updated };
}

export async function listReference(orgId: number, kind?: string, search?: string, limit = 200) {
	const params: unknown[] = [orgId];
	let where = 'org_id=$1';
	if (kind) { params.push(kind); where += ` and kind=$${params.length}`; }
	if (search) { params.push(`%${search}%`); where += ` and (title ilike $${params.length} or body ilike $${params.length} or code ilike $${params.length})`; }
	const items = await q<any>(`select id, kind, code, title, body, keywords, data, updated_at from reference_items where ${where} order by kind, title limit ${Math.min(limit, 500)}`, params);
	const counts = await q<any>('select kind, count(*)::int as n from reference_items where org_id=$1 group by kind', [orgId]);
	return { items, counts: Object.fromEntries(counts.map((c) => [c.kind, c.n])) };
}

export async function deleteReference(orgId: number, id: number | null, kind?: string) {
	if (id) await q('delete from reference_items where id=$1 and org_id=$2', [id, orgId]);
	else if (kind) await q('delete from reference_items where org_id=$1 and kind=$2', [orgId, kind]);
	cache.delete(orgId);
	return { success: true };
}

// ---- matching ----

const norm = (s: string) => s.toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
const STOP = new Set('the a an of and or to in on for is are be my your our with how what when where can do does i we you it this that from by at shri shree sri'.split(' '));
const tokens = (s: string) => norm(s).split(' ').filter((t) => t.length > 2 && !STOP.has(t));

interface Item { id: number; kind: RefKind; code: string | null; title: string; body: string; keywords: string[]; data: any; t: string; tk: string[] }
const cache = new Map<number, { at: number; items: Item[] }>();

async function loadItems(orgId: number): Promise<Item[]> {
	const c = cache.get(orgId);
	if (c && Date.now() - c.at < 120_000) return c.items;
	const rows = await q<any>('select id, kind, code, title, body, keywords, data from reference_items where org_id=$1 limit 20000', [orgId]).catch(() => []);
	const items = rows.map((r) => ({ ...r, t: norm(r.title), tk: tokens(r.title) }));
	cache.set(orgId, { at: Date.now(), items });
	return items;
}

const describe = (i: Item) => {
	if (i.kind !== 'book') return i.body;
	const d = i.data || {};
	const extra = Object.entries(d).filter(([k]) => !['language', 'price', 'in_stock'].includes(k)).map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`);
	return [i.code && `code ${i.code}`, d.language && `language ${d.language}`, d.price && `rate ${d.price}`, d.in_stock && `in stock: ${d.in_stock}`, ...extra, i.body]
		.filter(Boolean).join('; ');
};

/** The reference entries most relevant to an email thread (at most `max`). */
export async function matchReference(orgId: number, text: string, max = 8) {
	const items = await loadItems(orgId);
	if (!items.length) return [];
	const t = ` ${norm(text)} `;
	const words = new Set(tokens(text));
	// customers quote lane, service or rate codes: "code 26", "lane no 1388"
	const cited = new Set([...text.matchAll(/(?:code|cod|book\s*no\.?|no\.|number|item|#|कोड|क्रमांक|पुस्तक\s*संख्या|पुस्तक\s*सं\.?)\s*[:#-]?\s*(\d{1,5}(?:\s*(?:,|and|&|और)\s*\d{1,5})*)/gi)]
		.flatMap((m) => m[1].split(/\s*(?:,|and|&|और)\s*/)).map((x) => x.trim().replace(/^0+/, '')));
	const scored: [number, Item][] = [];
	for (const i of items) {
		let s = 0;
		if (i.t.length >= 4 && t.includes(` ${i.t} `)) s += 10; // the whole title appears
		if (i.kind === 'book' && i.code && cited.has(i.code.replace(/^0+/, ''))) s += 12;
		else if (i.code && i.code.length >= 3 && new RegExp(`\\b${i.code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text)) s += 8;
		for (const k of i.keywords) if (k.length >= 3 && t.includes(` ${norm(k)} `)) s += 4;
		if (i.tk.length) {
			const hit = i.tk.filter((w) => words.has(w)).length;
			if (hit >= 2 || (hit === 1 && i.tk.length === 1)) s += (hit / i.tk.length) * (i.kind === 'book' ? 5 : 3);
		}
		if (s >= 3) scored.push([s, i]);
	}
	return scored
		.sort((a, b) => b[0] - a[0])
		.slice(0, max)
		.map(([, i]) => ({ kind: i.kind, title: i.title, text: describe(i).slice(0, 400) }));
}
