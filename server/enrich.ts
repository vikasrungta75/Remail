/**
 * Customer enrichment. Adds to each customer record:
 *  - activity from remail itself (threads, groups they write about, mailbox they use, sentiment, last reply)
 *  - region from the postal code (Canadian postal code → province) or the state in a US address
 *  - other records that share a phone number or address (possible duplicates or one company)
 *  - for companies with their own email domain, the title and description of their public website
 *  - for carriers and brokers with a USDOT number, the public FMCSA company snapshot (legal name, status, power units).
 * Individuals are never looked up on the internet: only what they wrote is used.
 */
import { one, q } from './db';
import { merged } from './profiles';
import { BUSINESS_LABELS, type BusinessCategory } from './ai/types';

const FSA: Record<string, string> = { A: 'Newfoundland and Labrador', B: 'Nova Scotia', C: 'Prince Edward Island', E: 'New Brunswick', G: 'Quebec', H: 'Quebec', J: 'Quebec', K: 'Ontario', L: 'Ontario', M: 'Ontario', N: 'Ontario', P: 'Ontario', R: 'Manitoba', S: 'Saskatchewan', T: 'Alberta', V: 'British Columbia', X: 'Northwest Territories or Nunavut', Y: 'Yukon' };
export const provinceFromPostal = (pc?: string) => (pc && /^[ABCEGHJ-NPRSTVXY]\d[A-Z] ?\d[A-Z]\d$/i.test(pc) ? FSA[pc[0].toUpperCase()] || '' : '');
export function taxInfo(ids: string[] = []) {
	const out: { gst_hst?: boolean; usdot?: string; mc?: string } = {};
	for (const t of ids) {
		if (/^GST\/HST/i.test(t)) out.gst_hst = true;
		const d = t.match(/^USDOT (\d+)/i);
		if (d) out.usdot = d[1];
		const m = t.match(/^MC (\d+)/i);
		if (m) out.mc = m[1];
	}
	return out;
}

/** Public FMCSA company snapshot for a USDOT number (carriers and brokers are public records). */
export async function fmcsaSnapshot(usdot: string) {
	const url = `https://safer.fmcsa.dot.gov/query.asp?searchtype=ANY&query_type=queryCarrierSnapshot&query_param=USDOT&query_string=${encodeURIComponent(usdot)}`;
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { 'user-agent': 'remail/1.0 (customer record enrichment)' } });
		if (!res.ok) return null;
		const html = (await res.text()).replace(/&nbsp;/g, ' ');
		const cell = (label: string) => html.match(new RegExp(`${label}[\\s\\S]{0,200}?<td[^>]*>([^<]{1,120})<`, 'i'))?.[1]?.replace(/\s+/g, ' ').trim();
		const legal = cell('Legal Name:');
		if (!legal) return null;
		return { url, legal_name: legal, dba: cell('DBA Name:') || null, operating_status: cell('Operating Status:') || cell('USDOT Status:') || null, power_units: cell('Power Units:') || null, drivers: cell('Drivers:') || null };
	} catch {
		return null;
	}
}

const FREE_MAIL = /^(gmail|googlemail|yahoo|ymail|rocketmail|hotmail|outlook|live|msn|icloud|me|mac|aol|protonmail|proton|zohomail|yandex|mail|gmx|inbox|shaw|rogers|bell|sympatico|videotron|telus|cogeco|eastlink|comcast|att|verizon|sbcglobal|bellsouth|charter|cox|frontier)\./i;
const isOrgDomain = (d: string) => !!d && !FREE_MAIL.test(d) && !/wheelking/i.test(d);

/** The title and description of an organisation's own website (public business information). */
export async function websiteInfo(domain: string) {
	for (const url of [`https://${domain}`, `https://www.${domain}`]) {
		try {
			const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(6000), headers: { 'user-agent': 'remail/1.0 (customer record enrichment)', accept: 'text/html' } });
			if (!res.ok || !/text\/html/i.test(res.headers.get('content-type') || '')) continue;
			const html = (await res.text()).slice(0, 200_000);
			const meta = (name: string) => html.match(new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*content=["']([^"']{2,400})["']`, 'i'))?.[1] || html.match(new RegExp(`<meta[^>]+content=["']([^"']{2,400})["'][^>]*(?:name|property)=["']${name}["']`, 'i'))?.[1];
			const decode = (s?: string) => s?.replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
			const title = decode(meta('og:site_name') || html.match(/<title[^>]*>([^<]{2,200})<\/title>/i)?.[1]);
			const description = decode(meta('description') || meta('og:description'));
			if (title || description) return { url: res.url || url, title: title?.slice(0, 160), description: description?.slice(0, 300) };
		} catch {
			/* site not reachable: no website information */
		}
	}
	return null;
}

export async function enrichCustomer(customerId: number, opts: { web?: boolean } = {}) {
	const c = await one<any>('select * from customers where id=$1', [customerId]);
	if (!c) return null;
	const p = merged(c);
	const act = await one<any>(
		`select count(*)::int as threads,
		        coalesce(sum(inbound_count),0)::int as emails_from_them,
		        count(*) filter (where awaiting_reply and status in ('open','in_progress'))::int as waiting,
		        count(*) filter (where rag='red')::int as red,
		        round(avg(sentiment_score)::numeric, 2)::float as avg_sentiment,
		        round(avg(first_response_minutes)::numeric / 60, 1)::float as avg_first_reply_hours,
		        min(first_message_at) as first_contact, max(last_message_at) as last_contact,
		        (select jsonb_agg(x order by x.n desc) from (select business_category as g, count(*)::int as n from conversations where customer_id=$1 group by 1 order by 2 desc limit 4) x) as groups,
		        (select m.address from conversations c2 join mailboxes m on m.id = c2.mailbox_ids[1] where c2.customer_id=$1 group by m.address order by count(*) desc limit 1) as usual_mailbox,
		        (select max(d.sent_at) from reply_drafts d join conversations c3 on c3.id=d.conversation_id where c3.customer_id=$1 and d.status='sent') as last_reply_sent
		   from conversations where customer_id=$1`,
		[customerId],
	);
	// other records sharing a phone number or the same address and PIN
	const phones: string[] = p.phones || [];
	const twins = phones.length || (p.address && p.postal_code)
		? await q<any>(
			`select id, name from customers where org_id=$1 and id<>$2 and (
			   (coalesce(profile->'phones','[]') || coalesce(profile_manual->'phones','[]')) ?| $3::text[]
			   or ($4::text is not null and (profile||profile_manual)->>'postal_code' = $4 and lower(regexp_replace((profile||profile_manual)->>'address', '\\W', '', 'g')) = lower(regexp_replace($5, '\\W', '', 'g'))))
			 limit 5`,
			[c.org_id, customerId, phones, p.address && p.postal_code ? p.postal_code : null, p.address || ''],
		)
		: [];
	const tax = taxInfo(p.tax_ids);
	const domains: string[] = [...new Set([...(c.domains || []), ...((p.emails || []) as string[]).map((e) => e.split('@')[1]?.toLowerCase())].filter(Boolean))];
	const orgDomain = domains.find(isOrgDomain);
	const prev = c.enrichment || {};
	let website = prev.website || null;
	// carriers and brokers: the public FMCSA snapshot, refreshed monthly
	let fmcsa = prev.fmcsa || null;
	if (opts.web && tax.usdot && (!prev.fmcsa_checked_at || Date.now() - new Date(prev.fmcsa_checked_at).getTime() > 30 * 86400_000)) fmcsa = await fmcsaSnapshot(tax.usdot);
	if (opts.web && orgDomain && (!prev.website_checked_at || Date.now() - new Date(prev.website_checked_at).getTime() > 30 * 86400_000)) {
		website = await websiteInfo(orgDomain);
	}
	const enrichment = {
		activity: {
			...act,
			groups: (act?.groups || []).map((g: any) => ({ label: BUSINESS_LABELS[g.g as BusinessCategory] || g.g, n: g.n })),
		},
		region: {
			province: provinceFromPostal(p.postal_code) || null,
			country: p.country || (provinceFromPostal(p.postal_code) ? 'Canada' : null),
			mismatch: !!(p.state && provinceFromPostal(p.postal_code) && !provinceFromPostal(p.postal_code).toLowerCase().includes(String(p.state).toLowerCase().split(' ')[0])),
		},
		registrations: { gst_hst: !!tax.gst_hst, usdot: tax.usdot || null, mc: tax.mc || null },
		fmcsa,
		possible_duplicates: twins,
		org_domain: orgDomain || null,
		website,
		website_checked_at: opts.web && orgDomain ? new Date().toISOString() : prev.website_checked_at || null,
		fmcsa_checked_at: opts.web && tax.usdot ? new Date().toISOString() : prev.fmcsa_checked_at || null,
	};
	await q('update customers set enrichment=$2, enriched_at=now() where id=$1', [customerId, JSON.stringify(enrichment)]);
	// fill the province from the postal code when the emails did not say it
	if (!p.state && enrichment.region.province) {
		await q(`update customers set profile = jsonb_set(profile, '{state}', to_jsonb($2::text)) where id=$1`, [customerId, enrichment.region.province]);
	}
	return enrichment;
}

/** Background: enrich records built or changed since their last enrichment; a few website checks per run. */
export async function enrichCustomers(orgId: number, deadline: number) {
	const rows = await q<any>(
		`select id from customers where org_id=$1 and profile_at is not null and (enriched_at is null or enriched_at < profile_at or enriched_at < last_contact_at)
		  order by last_contact_at desc nulls last limit 200`,
		[orgId],
	);
	let n = 0;
	let web = 0;
	for (const r of rows) {
		if (Date.now() > deadline) break;
		const allowWeb = web < 10;
		const e = await enrichCustomer(r.id, { web: allowWeb }).catch((err) => (console.error('[enrich]', err.message), null));
		if (allowWeb && e?.org_domain) web++;
		n++;
	}
	return { enriched: n, websites: web };
}
