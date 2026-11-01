/**
 * The footer added to every reply when it is sent: company name, address, phone, email, website and an
 * optional logo. The address is the terminal or office in the customer's city when one is set up, otherwise
 * the head office. All of it is set in Settings → Reply drafts; nothing is invented, and a location is used
 * only once its address is filled in.
 */
import { one } from './db';
import { getOrg } from './settings';
import { merged } from './profiles';

export interface Branch { city: string; state: string; address: string; phone?: string; email?: string }
export interface HeadOffice { name: string; address: string; phone?: string; email?: string; website?: string; logoUrl?: string }

export function headOffice(settings: any, orgName: string): HeadOffice {
	const h = settings?.headOffice || {};
	return { name: h.name || orgName, address: h.address || '', phone: h.phone || '', email: h.email || '', website: h.website || '', logoUrl: h.logoUrl || '' };
}
export const branches = (saved?: Branch[]): Branch[] => (saved || []).filter((b) => b && b.city);

const ALIASES: Record<string, string[]> = {
	montreal: ['montréal'], 'quebec city': ['québec', 'quebec'], mississauga: [], brampton: [], toronto: ['gta'], vaughan: ['concord', 'woodbridge'],
	'new york': ['nyc'], 'los angeles': ['la'],
};

/** The location in the customer's city (address on file), else the head office. */
export function pickBranch(list: Branch[], place: { city?: string; address?: string }, head: HeadOffice): { branch: Branch; why: string; isHead: boolean } {
	const hay = ` ${`${place.city || ''} ${place.address || ''}`.toLowerCase().replace(/[,]/g, ' ')} `;
	for (const b of list) {
		if (!b.address.trim()) continue;
		const names = [b.city.toLowerCase(), ...(ALIASES[b.city.toLowerCase()] || [])];
		if (names.some((n) => hay.includes(` ${n} `) || (place.city || '').toLowerCase() === n)) return { branch: b, why: `the customer is in ${b.city}`, isHead: false };
	}
	const known = place.city ? `no location is set up for ${place.city}` : 'the customer\'s city is not known';
	return { branch: { city: '', state: '', address: head.address, phone: head.phone, email: head.email }, why: `${known}, so the head office is used`, isHead: true };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function footerParts(b: Branch, head: HeadOffice, isHead: boolean) {
	const title = isHead ? head.name : `${head.name}, ${b.city}`;
	const site = head.website ? head.website.replace(/^https?:\/\//, '').replace(/\/$/, '') : '';
	const text = ['', '--', title, b.address, b.phone ? `Phone: ${b.phone}` : '', b.email ? `Email: ${b.email}` : '', site].filter((x, i) => i < 2 || x).join('\n');
	const logo = head.logoUrl && /^https:\/\//.test(head.logoUrl) ? `<td style="padding-right:12px;vertical-align:top"><img src="${esc(head.logoUrl)}" height="44" alt="${esc(head.name)}" style="display:block;height:44px"></td>` : '';
	const html = `<table cellpadding="0" cellspacing="0" style="margin-top:18px;border-top:1px solid #e6e8f0;padding-top:12px;font-family:'Nunito Sans','Segoe UI',Arial,sans-serif;font-size:12.5px;line-height:1.5;color:#4a5072"><tr>${logo}
<td style="vertical-align:top"><b style="color:#0b1143;font-size:13.5px">${esc(title)}</b>${b.address ? `<br>${esc(b.address)}` : ''}${b.phone ? `<br>Phone: ${esc(b.phone)}` : ''}${b.email ? `<br>Email: <a href="mailto:${esc(b.email)}" style="color:#4c80ff">${esc(b.email)}</a>` : ''}${site ? `<br><a href="${esc(head.website!)}" style="color:#4c80ff">${esc(site)}</a>` : ''}</td>
</tr></table>`;
	return { title, text, html };
}

/** The footer for a draft, chosen from the customer's city or address. Null when switched off or nothing is set up. */
export async function footerForConversation(orgId: number, conversationId: number) {
	const org = await getOrg(orgId);
	const st = org.settings as any;
	if (st.replyFooter === false) return null;
	const head = headOffice(st, org.name);
	const list = branches(st.branches);
	if (!head.address && !head.website && !list.some((b) => b.address)) return null;
	const cu = await one<any>('select cu.profile, cu.profile_manual from conversations c left join customers cu on cu.id=c.customer_id where c.id=$1', [conversationId]);
	const p = cu ? merged(cu) : {};
	const { branch, why, isHead } = pickBranch(list, { city: p.city, address: p.address }, head);
	return { branch: { ...branch, city: isHead ? 'Head office' : branch.city }, why, ...footerParts(branch, head, isHead), inlineLogo: false };
}
