/** Pipeline self-test against a throwaway database: npm test (needs DATABASE_URL to an empty test DB) */
import assert from 'node:assert/strict';
import { ensureSchema, getPool, q, one } from '../server/db';
import { defaultOrgId } from '../server/auth';
import { getOrg } from '../server/settings';
import { ingestMessages } from '../server/ingest';
import { analysePending, backfillSubcategories } from '../server/analyze';
import { SUBCATEGORIES, normaliseSubcategory } from '../server/ai/taxonomy';
import { DEFAULT_TEMPLATES, listTemplates, templatesForGroup } from '../server/templates';
import { importCsv, matchReference, parseCsv } from '../server/reference';
import { categoryReport } from '../server/views';
import { heuristicAnalyse } from '../server/ai/heuristic';
import { cleanBody, normalizeSubject, redactPII } from '../server/text';
import { placeholders, sendDraft, bodyToHtml, fillDraft } from '../server/drafts';
import { buildMime } from '../server/connectors/gmail';

assert.equal(normalizeSubject('RE: Fwd: [EXT] Late delivery'), 'late delivery');
assert.match(cleanBody('Thanks, done.\n\nOn Mon, 1 Jan 2026 at 10:00, Bob <b@x.com> wrote:\n> old text'), /^Thanks, done\.$/);
assert.equal(redactPII('card 4111 1111 1111 1111'), 'card [card-number]');

const msg = (body: string, subject = 'Load') => ({ index: 0, emailId: 1, direction: 'inbound' as const, from: 'dana@acmefoods.ca', fromName: 'Dana Clarke', sentAt: new Date().toISOString(), subject, body });
const input = (body: string, subject?: string) => ({ conversationId: 1, customerName: 'Dana Clarke', customerTier: 'standard', orgName: 'Wheel King TransHaul', isInternal: false, isAutomated: false, replySignature: 'Kind regards,\nWheel King TransHaul', messages: [msg(body, subject)] });

// legal escalation → red
const a = heuristicAnalyse(input('This is my third email and nobody has answered. This is very disappointing. Our lawyer will be in touch about the damaged freight.'));
assert.equal(a.sentiment, 'negative');
assert.equal(a.rag_suggestion, 'red');
assert.ok(a.legal_or_churn_signal);

// quote request: categorised, and the draft asks the team for the rate instead of guessing
const quote = heuristicAnalyse(input('Can you quote a weekly dry van from Toronto to Chicago starting next month? Please send your rate and transit time.', 'Rate request Toronto to Chicago'));
assert.equal(quote.business_category, 'sales_proposal');
assert.ok(quote.categories.includes('pricing'), `pricing: ${quote.categories}`);
assert.ok(quote.requires_reply);
assert.equal(quote.subcategory, 'quote_request');
assert.ok(placeholders(quote.suggested_reply).length >= 1, 'draft has items to fill in');
assert.ok(quote.suggested_reply.includes('Kind regards,\nWheel King TransHaul'), 'signature added');

// damage complaint: negative, customer service, damage subgroup
const dmg = heuristicAnalyse(input('Load PRO 448812 arrived at our DC with 4 crushed pallets. This is unacceptable, please advise how you will resolve it.', 'Damaged pallets on PRO 448812'));
assert.ok(dmg.categories.includes('damage'), `damage detected: ${dmg.categories}`);
assert.equal(dmg.sentiment, 'negative');
assert.equal(dmg.subcategory, 'damage_shortage');

// breakdown goes to fleet
const brk = heuristicAnalyse(input('Unit 512 broke down on the 401 near Kingston and needs a tow. Driver is stranded.', 'Breakdown unit 512'));
assert.equal(brk.business_category, 'fleet_maintenance');
assert.equal(brk.subcategory, 'breakdown');
assert.equal(normaliseSubcategory('billing_finance', 'nonsense'), 'invoice_query');

// subgroups and templates line up
for (const [g, list] of Object.entries(DEFAULT_TEMPLATES))
	for (const sub of Object.keys(list)) assert.ok(SUBCATEGORIES[g as keyof typeof SUBCATEGORIES].some((x) => x.key === sub), `template ${g}/${sub} matches a subgroup`);
for (const [g, list] of Object.entries(SUBCATEGORIES))
	for (const sg of list) if (sg.replies) assert.ok(DEFAULT_TEMPLATES[g]?.[sg.key], `subgroup ${g}/${sg.key} has a default template`);
assert.deepEqual(parseCsv('a,b\n"x, y","he said ""hi"""\n'), [['a', 'b'], ['x, y', 'he said "hi"']]);

// outgoing email: non-ASCII subject encoded, threaded headers present, placeholders highlighted in HTML
const mime = buildMime({ from: 'dispatch@wheelking.com', to: ['dana@acmefoods.ca'], cc: [], subject: 'Re: Livraison à Montréal', text: 'Merci', html: '<p>Merci</p>', inReplyTo: '<a@b>', references: ['<a@b>'] });
assert.match(mime, /Subject: =\?UTF-8\?B\?/);
assert.match(mime, /In-Reply-To: <a@b>/);
assert.match(bodyToHtml('Yes [[provide: date]]'), /background:#fff176/);

await ensureSchema();
const orgId = await defaultOrgId();
await q(`update organisations set internal_domains='{wheelking.com}' where id=$1`, [orgId]);
const org = await getOrg(orgId, true);
const mk = async (addr: string) => one<any>(`insert into mailboxes (org_id, provider, address) values ($1,'demo',$2) on conflict (org_id, provider, lower(address)) do update set status='active' returning *`, [orgId, addr]);
const m1 = await mk('dispatch@wheelking.com');
const m2 = await mk('cs@wheelking.com');
const base = { threadId: null, inReplyTo: null, references: [], cc: [], hasAttachments: false, importance: null, webLink: null, folder: 'inbox' as const, isAutomated: false };
const email = { ...base, providerMessageId: 'p1', internetMessageId: '<abc@acmefoods.ca>', from: { address: 'jo@acmefoods.ca', name: 'Jo Patel' }, to: [{ address: 'dispatch@wheelking.com', name: '' }], subject: 'Damaged pallets received', bodyText: 'Two pallets on PRO 448812 arrived crushed. Please arrange a credit.', sentAt: new Date() };
const r1 = await ingestMessages(org, m1, [email]);
const r2 = await ingestMessages(org, m2, [{ ...email, providerMessageId: 'p2' }]);
assert.equal(r1.inserted, 1);
assert.equal(r2.duplicates, 1, 'same Message-ID in a second mailbox must be a duplicate');
const reply = { ...base, providerMessageId: 'p3', internetMessageId: '<r1@wheelking.com>', inReplyTo: '<abc@acmefoods.ca>', from: { address: 'neha.dubey@wheelking.com', name: 'Neha' }, to: [{ address: 'jo@acmefoods.ca', name: '' }], subject: 'RE: Damaged pallets received', bodyText: 'Sorry, we will send the credit note by Friday.', sentAt: new Date(Date.now() + 60_000), folder: 'sent' as const };
await ingestMessages(org, m1, [reply]);
const conv = await one<any>(`select * from conversations where normalized_subject='damaged pallets received'`);
assert.equal(conv.message_count, 2);
assert.equal(conv.duplicate_count, 1);
assert.equal(conv.awaiting_reply, false);

// a customer waiting on an answer gets a stored draft
const ask = { ...base, providerMessageId: 'p4', internetMessageId: '<ask@acmefoods.ca>', from: { address: 'meena@acmefoods.ca', name: 'Meena Rao' }, to: [{ address: 'dispatch@wheelking.com', name: '' }], subject: 'Load WK-2610444 still not delivered', bodyText: 'Load WK-2610444 was due yesterday and has still not been delivered. Please tell me the new ETA.', sentAt: new Date() };
await ingestMessages(org, m1, [ask]);
await analysePending(orgId, 10);
const acts = await q<any>('select * from action_items where conversation_id=$1', [conv.id]);
assert.ok(acts.some((x) => x.is_commitment && x.due_date), 'commitment with due date extracted');
const waiting = await one<any>(`select * from conversations where normalized_subject like 'load wk-2610444%'`);
const draft = await one<any>('select * from reply_drafts where conversation_id=$1', [waiting.id]);
assert.ok(draft, 'draft created for a conversation awaiting reply');
assert.equal(draft.status, 'draft');
assert.deepEqual(draft.to_addresses, ['meena@acmefoods.ca']);
assert.ok(placeholders(draft.body).length > 0, 'draft has items to fill in');
assert.ok(!(await one('select 1 from reply_drafts where conversation_id=$1', [conv.id])), 'no draft once the team has replied');
// Send is refused while yellow items remain
const admin = await one<any>(`insert into users (org_id, email, full_name, role) values ($1,'t@wheelking.com','Test','admin') returning id`, [orgId]);
await assert.rejects(sendDraft({}, { id: admin.id, orgId } as any, draft.id, {}), /Fill in the/);
// answers typed in the small boxes go into the email; without the AI they are inserted as typed
const items = [...new Set(placeholders(draft.body))];
const filled = await fillDraft({ id: admin.id, orgId } as any, draft.id, [{ item: items[0], value: '3 November 2026' }]);
assert.equal(filled.filled, 1);
assert.ok(filled.draft.body.includes('3 November 2026'));
assert.equal(placeholders(filled.draft.body).length, placeholders(draft.body).length - placeholders(draft.body).filter((p) => p === items[0]).length, 'every occurrence of that item answered');
await assert.rejects(fillDraft({ id: admin.id, orgId } as any, draft.id, [{ item: 'not in the draft', value: 'x' }]), /no longer in the draft/);
assert.ok(waiting.subcategory && SUBCATEGORIES[waiting.business_category as keyof typeof SUBCATEGORIES].some((x) => x.key === waiting.subcategory), `subgroup stored: ${waiting.business_category}/${waiting.subcategory}`);
assert.match(draft.body, /^Hi Meena,/, 'rules-engine draft follows the default template');

// templates are seeded, editable and given to the AI for the likely group
const tpls = await listTemplates(orgId);
assert.equal(tpls.length, Object.values(DEFAULT_TEMPLATES).reduce((n, l) => n + Object.keys(l).length, 0), 'every default template seeded');
const forCs = await templatesForGroup(orgId, 'customer_service', 'delay_eta');
assert.equal(forCs[0].subgroup, 'delay_eta');

// reference data: rates upload and matching against an email
const imp = await importCsv(orgId, 'book', 'code,title,price,in_stock\nTOR-CHI-DV,Toronto to Chicago dry van,2450,yes\nMTL-NYC-RF,Montreal to New York reefer,2900,yes\n', true);
assert.equal(imp.added, 2);
assert.equal((await importCsv(orgId, 'book', 'code,title,price\nMTL-NYC-RF,Montreal to New York reefer,2950\n', false)).updated, 1);
await importCsv(orgId, 'faq', 'question,answer,keywords\nHow is detention charged?,After 2 free hours at CAD 85 per hour.,detention;waiting time\n', true);
const mt = await matchReference(orgId, 'Please quote Toronto to Chicago dry van, lane TOR-CHI-DV. Also how is detention charged?');
assert.ok(mt.some((m) => /Toronto to Chicago/.test(m.title)), `lane matched: ${JSON.stringify(mt)}`);
assert.ok(mt.some((m) => m.kind === 'faq'), 'faq matched');
assert.ok(!mt.some((m) => /Montreal to New York/.test(m.title)), 'unrelated lane not matched');

// customer database: the rules engine reads phone, address, postal code, tax and carrier numbers
const { rulesProfile, buildProfile, listCustomerDb } = await import('../server/profiles');
const rp = rulesProfile(['Please book the load below.\nDana Clarke\nAcme Foods Inc.\n1200 Industrial Pkwy, Unit 4\nMississauga, ON L5T 2H8\nTel 905-555-0142\nGST/HST 123456789RT0001\nUSDOT 1234567'], { orders: ['WK-2610444'] }, 'dana@acmefoods.ca');
assert.equal(rp.postal_code?.replace(' ', ''), 'L5T2H8');
assert.ok(rp.phones?.[0]?.includes('905'), `phones: ${rp.phones}`);
assert.equal(rp.state, 'Ontario');
assert.ok(rp.address?.includes('Industrial Pkwy'), `address: ${rp.address}`);
assert.ok(rp.tax_ids?.some((t) => /USDOT 1234567/.test(t)) && rp.tax_ids?.some((t) => /GST\/HST/.test(t)), `tax ids: ${rp.tax_ids}`);
const anyCustomer = await one<any>('select customer_id from conversations where customer_id is not null limit 1');
const bp = await buildProfile(anyCustomer.customer_id, false);
assert.equal(bp.source, 'rules');
const db = await listCustomerDb(orgId, new URLSearchParams({ q: '' }));
assert.ok(db.totals.total >= 1 && db.rows[0].p);

// enrichment: postal code to province, registrations, activity and possible duplicates
const { provinceFromPostal, taxInfo, enrichCustomer } = await import('../server/enrich');
assert.equal(provinceFromPostal('L5T 2H8'), 'Ontario');
assert.equal(provinceFromPostal('H3B 1A7'), 'Quebec');
assert.equal(provinceFromPostal('V6B1A1'), 'British Columbia');
assert.equal(provinceFromPostal('12345'), '');
assert.deepEqual(taxInfo(['GST/HST 123456789RT0001', 'USDOT 1234567', 'MC 765432']), { gst_hst: true, usdot: '1234567', mc: '765432' });
await q(`insert into customers (org_id, name, domains) values ($1, 'Acme Foods (Mississauga)', '{acme-mississauga.ca}')`, [orgId]);
await q(`update customers set profile = profile || '{"phones":["+1 905-555-0142"]}' where id in (select id from customers where org_id=$1 order by id limit 2)`, [orgId]);
const twinIds = (await q<any>('select id from customers where org_id=$1 order by id limit 2', [orgId])).map((r) => r.id);
const en = await enrichCustomer(twinIds[0], { web: false });
assert.ok(en && en.activity.threads >= 0);
assert.ok(en!.possible_duplicates.some((d: any) => d.id === twinIds[1]), 'same phone found as possible duplicate');

// reply footer: the location in the customer's city when its address is on file, otherwise the head office
const { branches: brList, pickBranch, footerParts, headOffice } = await import('../server/branding');
const head = headOffice({ headOffice: { address: '100 Test Rd, Brampton, ON L6T 0A1', website: 'https://www.wheelking.com', logoUrl: 'https://example.com/logo.png' } }, 'Wheel King TransHaul');
const bl = brList([{ city: 'Montreal', state: 'Quebec', address: '5 Test St, Montréal, QC H4T 1A1' }, { city: 'Calgary', state: 'Alberta', address: '' }]);
assert.equal(pickBranch(bl, { city: 'Montréal' }, head).branch.city, 'Montreal');
assert.equal(pickBranch(bl, { address: '22 Rue X, Montreal, QC' }, head).branch.city, 'Montreal');
assert.ok(pickBranch(bl, { city: 'Calgary' }, head).isHead, 'no address on file for Calgary, so the head office');
assert.ok(pickBranch(bl, {}, head).isHead);
const hb = pickBranch(bl, {}, head);
const fp = footerParts(hb.branch, head, hb.isHead);
assert.ok(fp.text.includes('Brampton') && fp.text.includes('www.wheelking.com') && fp.html.includes('https://example.com/logo.png'));

// cold marketing is not waiting for a reply
const promo = heuristicAnalyse(input('Grow your business with our digital marketing and SEO services. Free load board trial for your trucks. Click to unsubscribe.', "Don't Just Advertise. Create Opportunities for Growth."));
assert.equal(promo.requires_reply, false);

// threads analysed before subgroups existed are back-filled; the report has headings and subheadings
await q('update conversations set subcategory=null where id=$1', [waiting.id]);
assert.ok((await backfillSubcategories(orgId)) >= 1);
assert.ok((await one<any>('select subcategory from conversations where id=$1', [waiting.id])).subcategory);
const rep = await categoryReport({ id: admin.id, orgId, email: 't@wheelking.com', role: 'admin', allMailboxes: true } as any, new URLSearchParams({ audience: 'all', to: new Date(Date.now() + 86400_000).toISOString() }));
const g = rep.groups.find((x: any) => x.conversations > 0)!;
assert.ok(g.label && g.subgroups.length, 'report group has subgroups');
assert.equal(rep.totals.conversations, rep.groups.reduce((n: number, x: any) => n + x.conversations, 0));
console.log('All pipeline tests passed');
await getPool().end();
