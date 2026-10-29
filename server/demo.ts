/**
 * Realistic demo dataset for Wheel King TransHaul: 5 shared mailboxes, ~14 customers,
 * ~150 threads over the last 45 days, including cross-mailbox duplicates.
 * Everything goes through the real ingestion + analysis pipeline.
 */
import { one, q } from './db';
import { getOrg } from './settings';
import { ingestMessages } from './ingest';
import type { MailboxRow, NormalizedMessage } from './connectors/types';

const MAILBOXES = [
	['customerservice@wheelking.com', 'Customer Service'],
	['operations@wheelking.com', 'Operations'],
	['accounts@wheelking.com', 'Accounts'],
	['bookings@wheelking.com', 'Bookings'],
	['keyaccounts@wheelking.com', 'Key Accounts'],
] as const;

const STAFF = [
	['Priya Shah', 'priya.shah@wheelking.com'],
	['Tom Bennett', 'tom.bennett@wheelking.com'],
	['Aisha Khan', 'aisha.khan@wheelking.com'],
	['Daniel Price', 'daniel.price@wheelking.com'],
	['Rohit Menon', 'rohit.menon@wheelking.com'],
];

const CUSTOMERS: { name: string; domain: string; tier: 'strategic' | 'key' | 'standard'; contacts: [string, string][]; mood: number }[] = [
	{ name: 'Northgate Retail Group', domain: 'northgateretail.ca', tier: 'strategic', contacts: [['Helen Carter', 'helen.carter'], ['Mark Doyle', 'mark.doyle']], mood: -0.6 },
	{ name: 'Brightwell Foods', domain: 'brightwellfoods.com', tier: 'strategic', contacts: [['Sanjay Patel', 's.patel'], ['Emma Walsh', 'emma.walsh']], mood: 0.2 },
	{ name: 'Apex Building Supplies', domain: 'apexbuild.ca', tier: 'key', contacts: [['Gary Holmes', 'gary.holmes']], mood: -0.3 },
	{ name: 'Meridian Pharma Logistics', domain: 'meridianpharma.com', tier: 'key', contacts: [['Dr Olivia Grant', 'o.grant'], ['Kevin Moss', 'kevin.moss']], mood: 0.1 },
	{ name: 'Castlefield Beverages', domain: 'castlefieldbev.ca', tier: 'key', contacts: [['Rachel Hughes', 'rachel.hughes']], mood: -0.5 },
	{ name: 'Harbour Auto Parts', domain: 'harbourauto.ca', tier: 'standard', contacts: [['Lee Thompson', 'lee.t']], mood: 0 },
	{ name: 'Greenleaf Garden Centres', domain: 'greenleafgc.ca', tier: 'standard', contacts: [['Fiona Reid', 'fiona.reid']], mood: 0.5 },
	{ name: 'Sterling Paper Mills', domain: 'sterlingpaper.com', tier: 'key', contacts: [['Ian McLeod', 'ian.mcleod']], mood: -0.2 },
	{ name: 'Orbit Electronics', domain: 'orbitelectronics.ca', tier: 'standard', contacts: [['Nadia Rahman', 'nadia']], mood: 0.3 },
	{ name: 'Northshore Steel Fabrication', domain: 'northshoresteel.ca', tier: 'standard', contacts: [['Craig Barker', 'craig.barker']], mood: -0.4 },
	{ name: 'Lumen Home Furnishings', domain: 'lumenhome.com', tier: 'standard', contacts: [['Sophie Turner', 'sophie.turner']], mood: 0.4 },
	{ name: 'Kestrel Agri Supplies', domain: 'kestrelagri.ca', tier: 'standard', contacts: [['John Pryce', 'john.pryce']], mood: 0 },
	{ name: 'Velocity Ecommerce', domain: 'velocity-ecom.com', tier: 'key', contacts: [['Ava Collins', 'ava.collins']], mood: -0.1 },
	{ name: 'Prairie Dairy Co-operative', domain: 'prairiedairy.ca', tier: 'standard', contacts: [['Peter Ward', 'peter.ward']], mood: 0.2 },
];

type Step = { dir: 'in' | 'out'; after: number; text: string };
interface Scenario { mood: number; mailbox: number; subject: string; steps: Step[] }

const R = (n: number) => `WK-${n}`;
const scenarios = (ref: string, inv: string, reg: string, site: string): Scenario[] => [
	{ mood: -1, mailbox: 0, subject: `Late delivery again - ${ref}`, steps: [
		{ dir: 'in', after: 0, text: `Hi,\n\nConsignment ${ref} was due at our ${site} DC at 06:00 this morning and has still not arrived. This is the third late delivery this month and our store replenishment is now behind schedule.\n\nPlease can you confirm an ETA urgently and explain what is going wrong.\n\nRegards` },
		{ dir: 'out', after: 50, text: `Hi,\n\nI'm very sorry for the delay to ${ref}. The vehicle (${reg}) was held up by an incident on Highway 401. I will send you a confirmed ETA within the hour and we will review the planning on this lane by Friday.\n\nKind regards` },
		{ dir: 'in', after: 300, text: `It is now mid-afternoon and we still have no update. This is unacceptable. If this continues we will have to review our contract and consider switching supplier.\n\nI need a call from your operations manager today.` },
	] },
	{ mood: -1, mailbox: 2, subject: `Invoice ${inv} - incorrect fuel surcharge`, steps: [
		{ dir: 'in', after: 0, text: `Hello Accounts,\n\nInvoice ${inv} includes a fuel surcharge of 14% but our agreed rate card caps this at 9%. We have been overcharged by $1,284.50.\n\nPlease issue a credit note and a corrected invoice. We will hold payment until this is resolved.\n\nThanks` },
		{ dir: 'out', after: 180, text: `Hi,\n\nThank you for flagging this. I have checked the rate card and you are correct. I will raise a credit note for $1,284.50 and send the corrected invoice by end of day tomorrow.\n\nApologies for the inconvenience.` },
	] },
	{ mood: -1, mailbox: 1, subject: `Damaged pallets on delivery ${ref}`, steps: [
		{ dir: 'in', after: 0, text: `Hi team,\n\nThree pallets on ${ref} arrived crushed and the goods are unsaleable. Photos attached. Your driver refused to note the damage on the POD.\n\nWe will be submitting a formal claim for $3,450. Please confirm your claims process.\n\nRegards` },
		{ dir: 'out', after: 240, text: `Hello,\n\nI'm sorry to hear this. I have opened claim reference CLM-${ref.slice(3)} and passed it to our insurer. I'll speak to the driver and come back to you on the POD issue by Thursday.\n\nBest regards` },
		{ dir: 'in', after: 2880, text: `It has been two days and no update on the claim. Still waiting. Please chase.` },
	] },
	{ mood: -0.6, mailbox: 3, subject: `Missed collection today - ${site}`, steps: [
		{ dir: 'in', after: 0, text: `Hi Bookings,\n\nYour driver did not turn up for the 14:00 collection at our ${site} site today. We had 22 pallets ready and the warehouse team waited until 17:00.\n\nCan you please rebook for first thing tomorrow and confirm.\n\nThanks` },
		{ dir: 'out', after: 35, text: `Hi,\n\nApologies, the collection was missed due to a vehicle breakdown. We will collect tomorrow at 07:30 and I'll confirm the driver details by 18:00 today.\n\nKind regards` },
		{ dir: 'in', after: 90, text: `Ok thanks, please make sure it happens this time.` },
	] },
	{ mood: 1, mailbox: 4, subject: `Thank you - peak season support`, steps: [
		{ dir: 'in', after: 0, text: `Hi Priya,\n\nJust wanted to say a big thank you to you and the team for the excellent service over the last few weeks. Every delivery into ${site} was on time and the drivers were brilliant.\n\nReally appreciate the extra effort.\n\nBest wishes` },
		{ dir: 'out', after: 120, text: `Thank you so much, that is lovely to hear. I'll pass this on to the drivers and planners. We look forward to continuing to support you.\n\nKind regards` },
	] },
	{ mood: 0, mailbox: 3, subject: `Quote request - weekly trunking ${site} to Montreal`, steps: [
		{ dir: 'in', after: 0, text: `Hello,\n\nCould you please provide a quote for a weekly trunking service from ${site} to Montreal, 26 pallets, Monday and Thursday, starting next month?\n\nThanks` },
		{ dir: 'out', after: 300, text: `Hi,\n\nThanks for the enquiry. We will send you a full quotation including fuel surcharge by Wednesday.\n\nKind regards` },
	] },
	{ mood: 0, mailbox: 0, subject: `POD required for ${ref}`, steps: [
		{ dir: 'in', after: 0, text: `Hi,\n\nPlease can you send the signed POD for ${ref}? Our customer is querying receipt.\n\nThanks` },
		{ dir: 'out', after: 45, text: `Hi,\n\nPlease find the POD attached for ${ref}, signed at 10:42.\n\nKind regards` },
		{ dir: 'in', after: 70, text: `Perfect, thank you for the quick response.` },
	] },
	{ mood: -0.5, mailbox: 1, subject: `Where is my delivery? ${ref}`, steps: [
		{ dir: 'in', after: 0, text: `Hi,\n\nThe tracking link for ${ref} has not updated since yesterday. Can you tell me where the load is and when it will arrive? Our production line needs these components.\n\nRegards` },
	] },
	{ mood: -0.8, mailbox: 0, subject: `Complaint about driver conduct at ${site}`, steps: [
		{ dir: 'in', after: 0, text: `Dear Wheel King,\n\nI want to make a formal complaint. Your driver on ${reg} was rude and aggressive to our gatehouse staff this morning and was speeding on site. This is a health and safety issue.\n\nI expect a full investigation and a response by Friday.` },
		{ dir: 'out', after: 200, text: `Dear Customer,\n\nThank you for raising this and I apologise. We take driver conduct and site safety very seriously. I have suspended the driver from your site and will complete the investigation and send you a written report by Friday.\n\nKind regards` },
	] },
	{ mood: 0, mailbox: 2, subject: `Remittance advice - ${inv}`, steps: [
		{ dir: 'in', after: 0, text: `Hello,\n\nPlease find attached remittance advice for payment of ${inv}, $8,420.00, paid today by EFT.\n\nRegards` },
		{ dir: 'out', after: 600, text: `Thank you, payment received and allocated.` },
	] },
	{ mood: -0.4, mailbox: 3, subject: `Booking changes for next week`, steps: [
		{ dir: 'in', after: 0, text: `Hi,\n\nWe need to move Tuesday's two loads to Wednesday and add an extra collection on Thursday from ${site}. Could you confirm availability by tomorrow?\n\nThanks` },
		{ dir: 'in', after: 1500, text: `Hi, following up on my email yesterday - still waiting for a reply. We need to confirm with our warehouse today. Please respond ASAP.` },
	] },
	{ mood: 0.4, mailbox: 4, subject: `Q3 service review`, steps: [
		{ dir: 'in', after: 0, text: `Hi Rohit,\n\nThanks for the QBR pack. On-time performance of 97.2% is a good improvement on last quarter. Could we discuss adding the Calgary lane at our next meeting?\n\nBest regards` },
		{ dir: 'out', after: 240, text: `Hi,\n\nGreat to hear. I'll prepare a proposal for the Calgary lane and share it before our meeting on the 14th.\n\nBest regards` },
	] },
	{ mood: -0.7, mailbox: 2, subject: `Duplicate invoices received`, steps: [
		{ dir: 'in', after: 0, text: `Hi,\n\nWe have been billed twice for the same job: ${inv} and ${inv}A are identical. This is the second time this has happened. Please cancel one and confirm.\n\nI am frustrated that we keep having to check your invoices line by line.` },
	] },
	{ mood: -0.9, mailbox: 4, subject: `Escalation: repeated service failures`, steps: [
		{ dir: 'in', after: 0, text: `Rohit,\n\nI'm escalating this to you directly. In the last four weeks we have had 6 late deliveries, 2 missed collections and a damaged load (${ref}). Our MD has asked me to review the relationship.\n\nI need a recovery plan from you by the end of the week, otherwise we will start a tender process.\n\nHelen` },
		{ dir: 'out', after: 120, text: `Helen,\n\nThank you for being direct and I'm sorry we have let you down. I will personally own this. I'll send a written recovery plan by Friday and would like to meet you on site on Monday.\n\nRohit` },
	] },
	{ mood: 0.5, mailbox: 0, subject: `Delivery confirmed - ${ref}`, steps: [
		{ dir: 'in', after: 0, text: `Hi,\n\nJust confirming ${ref} arrived at ${site} on time this morning and everything was in order. Thanks to the driver for being so helpful with the tail-lift.\n\nThanks` },
		{ dir: 'out', after: 60, text: `Thanks for letting us know, glad it all went smoothly.\n\nKind regards` },
	] },
	{ mood: 0, mailbox: 3, subject: `Collection booking for Thursday`, steps: [
		{ dir: 'in', after: 0, text: `Hello,\n\nPlease can we book a collection for Thursday from ${site}: 12 pallets, ready from 09:00, delivering to Mississauga.\n\nThanks` },
		{ dir: 'out', after: 40, text: `Hi,\n\nBooked for Thursday 09:30, booking reference BKG-${ref.slice(3)}. Driver details will follow on Wednesday afternoon.\n\nKind regards` },
		{ dir: 'in', after: 70, text: `Perfect, thanks.` },
	] },
	{ mood: 0, mailbox: 2, subject: `Updated invoicing address`, steps: [
		{ dir: 'in', after: 0, text: `Hi Accounts,\n\nFrom next month please send invoices to our new finance shared mailbox and quote our PO number on every invoice.\n\nMany thanks` },
		{ dir: 'out', after: 300, text: `Hi,\n\nNoted, we have updated your account and will include the PO number from the next invoice run.\n\nKind regards` },
	] },
	{ mood: 0.3, mailbox: 4, subject: `Rate review for next year`, steps: [
		{ dir: 'in', after: 0, text: `Hi Rohit,\n\nThanks for the proposed rate review. The 3.5% uplift is acceptable given the service improvements this year. Please send the updated rate card for signature.\n\nBest regards` },
		{ dir: 'out', after: 200, text: `Thank you, much appreciated. I will send the updated rate card for signature by Friday.\n\nBest regards` },
	] },
	{ mood: 0.2, mailbox: 1, subject: `Driver details for tomorrow`, steps: [
		{ dir: 'in', after: 0, text: `Hi,\n\nCould you send the driver name and vehicle registration for tomorrow's delivery into ${site}? Our gatehouse needs it for the booking system.\n\nThanks` },
		{ dir: 'out', after: 30, text: `Hi,\n\nThe driver is Mike Kowalski, ${reg}, arriving around 07:15.\n\nKind regards` },
		{ dir: 'in', after: 45, text: `Great, thanks very much.` },
	] },
	{ mood: 0, mailbox: 1, subject: `TDG paperwork for hazardous load`, steps: [
		{ dir: 'in', after: 0, text: `Hello,\n\nNext Tuesday's shipment from ${site} includes UN1263 paint (TDG class 3). Can you confirm the driver is TDG certified and what documentation you need from us?\n\nThanks` },
		{ dir: 'out', after: 150, text: `Hi,\n\nYes, we will allocate an TDG-trained driver. Please send the TDG shipping document 24 hours before collection.\n\nKind regards` },
	] },
];

function rnd(seed: number) {
	let s = seed;
	return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
}

export async function loadDemoData(orgId: number) {
	const org = await getOrg(orgId);
	if (!org.internalDomains.includes('wheelking.com')) {
		await q(`update organisations set internal_domains = array_append(internal_domains, 'wheelking.com') where id=$1`, [orgId]);
	}
	const freshOrg = await getOrg(orgId, true);
	const rand = rnd(42);
	const pick = <T,>(a: readonly T[]) => a[Math.floor(rand() * a.length)];

	const mbs: MailboxRow[] = [];
	for (const [addr, name] of MAILBOXES) {
		const row = await one<MailboxRow>(
			`insert into mailboxes (org_id, provider, address, display_name, status, last_synced_at)
			 values ($1,'demo',$2,$3,'active', now())
			 on conflict (org_id, provider, lower(address)) do update set display_name=excluded.display_name returning *`,
			[orgId, addr, name],
		);
		mbs.push(row!);
	}
	for (const c of CUSTOMERS) {
		await q(
			`insert into customers (org_id, name, domains, tier, auto_created) select $1,$2,$3,$4,false
			 where not exists (select 1 from customers where org_id=$1 and $5 = any(domains))`,
			[orgId, c.name, [c.domain], c.tier, c.domain],
		);
		await q(`update customers set tier=$3, name=$2 where org_id=$1 and $4 = any(domains)`, [orgId, c.name, c.tier, c.domain]);
	}

	const sites = ['Mississauga', 'Brampton', 'Toronto', 'Montreal', 'Calgary', 'Winnipeg', 'Vaughan', 'Hamilton'];
	const regs = ['Truck 214', 'Truck 231', 'Truck 42', 'Truck 125', 'Truck 217', 'Truck 266'];
	const byMailbox = new Map<number, NormalizedMessage[]>();
	const now = Date.now();
	let n = 0;
	for (let i = 0; i < 150; i++) {
		const cust = CUSTOMERS[Math.floor(rand() * CUSTOMERS.length)];
		const list = scenarios(R(48000 + i * 7), `INV-${20500 + i}`, pick(regs), pick(sites));
		// customer mood sets the chance of a problem thread; most email is routine
		const pNegative = Math.max(0.08, Math.min(0.6, 0.28 - cust.mood * 0.4));
		const pool = rand() < pNegative ? list.filter((s) => s.mood < 0) : list.filter((s) => s.mood >= 0);
		const sc = pick(pool);
		const [cname, clocal] = pick(cust.contacts);
		const caddr = `${clocal}@${cust.domain}`;
		const [sname, saddr] = pick(STAFF);
		const mbIdx = cust.tier === 'strategic' && rand() < 0.4 ? 4 : sc.mailbox;
		const mb = mbs[mbIdx];
		const startMin = Math.floor(rand() * 45 * 1440);
		let t = now - startMin * 60_000;
		const thread = `demo-thread-${i}`;
		let prevMid: string | null = null;
		for (const [si, st] of sc.steps.entries()) {
			t += st.after * 60_000;
			if (t > now) break;
			const mid = `<demo-${i}-${si}@${st.dir === 'in' ? cust.domain : 'wheelking.com'}>`;
			const msg: NormalizedMessage = {
				providerMessageId: `demo-${i}-${si}-${mb.id}`,
				internetMessageId: mid,
				threadId: thread,
				inReplyTo: prevMid,
				references: prevMid ? [prevMid] : [],
				from: st.dir === 'in' ? { address: caddr, name: cname } : { address: saddr, name: sname },
				to: st.dir === 'in' ? [{ address: mb.address, name: mb.display_name }] : [{ address: caddr, name: cname }],
				cc: st.dir === 'out' ? [{ address: mb.address, name: mb.display_name }] : [],
				subject: si === 0 ? sc.subject : `RE: ${sc.subject}`,
				bodyText:
					st.dir === 'in'
						? `${st.text}\n\n${cname}\n${cust.name}`
						: `${st.text}\n\n${sname}\nWheel King TransHaul`,
				sentAt: new Date(t),
				hasAttachments: /attached/.test(st.text),
				importance: null,
				webLink: null,
				folder: st.dir === 'in' ? 'inbox' : 'sent',
				isAutomated: false,
			};
			const arr = byMailbox.get(mb.id) || [];
			arr.push(msg);
			byMailbox.set(mb.id, arr);
			// ~25% of customer emails are also CC'd to a second monitored mailbox → duplicates
			if (st.dir === 'in' && rand() < 0.25) {
				const other = mbs[(mbIdx + 1 + Math.floor(rand() * 4)) % mbs.length];
				const dup = { ...msg, providerMessageId: `demo-${i}-${si}-${other.id}`, threadId: `${thread}-x${other.id}`, cc: [{ address: other.address, name: other.display_name }] };
				const a2 = byMailbox.get(other.id) || [];
				a2.push(dup);
				byMailbox.set(other.id, a2);
			}
			prevMid = mid;
			n++;
		}
	}
	let inserted = 0;
	let duplicates = 0;
	// ingest all mailboxes in global time order so cross-mailbox threading behaves like live sync
	const all = [...byMailbox.entries()].flatMap(([id, msgs]) => msgs.map((m) => ({ id, m })));
	all.sort((a, b) => a.m.sentAt.getTime() - b.m.sentAt.getTime());
	for (const { id, m } of all) {
		const mb = mbs.find((x) => x.id === id)!;
		const r = await ingestMessages(freshOrg, mb, [m]);
		inserted += r.inserted;
		duplicates += r.duplicates;
	}
	await q(`update mailboxes set messages_synced = (select count(*) from emails e where e.mailbox_id = mailboxes.id) where org_id=$1 and provider='demo'`, [orgId]);
	// older threads that we answered last have mostly been closed by the team
	await q(
		`update conversations set status='resolved', resolved_at=last_message_at + interval '1 day'
		  where org_id=$1 and status='open' and last_message_at < now() - interval '6 days'
		    and (last_outbound_at >= coalesce(last_inbound_at, last_outbound_at) or (id % 3) <> 0)
		    and id in (select distinct e.conversation_id from emails e join mailboxes m on m.id=e.mailbox_id where m.provider='demo')`,
		[orgId],
	);
	return { generated: n, inserted, duplicates };
}

export async function clearDemoData(orgId: number) {
	await q(`delete from conversations where org_id=$1 and id in (select distinct e.conversation_id from emails e join mailboxes m on m.id=e.mailbox_id where m.provider='demo')`, [orgId]);
	await q(`delete from mailboxes where org_id=$1 and provider='demo'`, [orgId]);
	await q(`delete from customers c where org_id=$1 and not exists (select 1 from conversations v where v.customer_id=c.id)`, [orgId]);
	await q(`delete from alerts a where org_id=$1 and conversation_id is null and customer_id is null`, [orgId]);
}
