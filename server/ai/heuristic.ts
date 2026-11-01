/**
 * Deterministic analyser. Used when no LLM is configured, as a fallback when the LLM call fails,
 * and in tests. Tuned for road-haulage / logistics customer email.
 */
import { normaliseSubcategory } from './taxonomy';
import { CATEGORY_LABELS, type Analysis, type BusinessCategory, type Category, type ProposalStage, type Sentiment, type ThreadInput } from './types';

const NEG: [RegExp, number][] = [
	[/\b(unacceptable|appalling|disgraceful|ridiculous|shocking|outrageous|furious|livid)\b/i, 3],
	[/\b(very|extremely|deeply|really) (disappointed|unhappy|frustrated|concerned|annoyed)\b/i, 3],
	[/\b(disappointed|unhappy|frustrated|annoyed|upset|dissatisfied|not happy|poor service|terrible|awful|worst)\b/i, 2],
	[/\b(complain(t|ing)?|failure|failed|missed|late again|still (not|no|waiting)|no one (has )?(called|replied|responded)|chas(e|ing))\b/i, 1.5],
	[/\b(late|delay(ed)?|overdue|damaged?|broken|lost|missing|wrong|incorrect|error|overcharg(ed|e)|dispute|refund|credit note)\b/i, 1],
	[/\b(issue|problem|concern|unfortunately|again)\b/i, 0.5],
	[/\b(cancel|terminate|switch(ing)? (supplier|provider|haulier)|take our business elsewhere|legal action|solicitor|lawyer|claim)\b/i, 3],
	[/!{2,}/, 1],
];
const POS: [RegExp, number][] = [
	[/\b(excellent|outstanding|fantastic|brilliant|superb|amazing|exceptional)\b/i, 2.5],
	[/\b(thank you so much|really appreciate|much appreciated|great job|well done|impressed|delighted|very happy|pleased)\b/i, 2],
	[/\b(thanks|thank you|appreciate|great|good|happy|helpful|smooth|on time|resolved|sorted)\b/i, 0.8],
];
const NEGATION = /\b(not|no|never|isn't|wasn't|aren't|don't|didn't)\s+(\w+\s+)?$/i;

const CATS: [Category, RegExp][] = [
	['delay', /\b(late|delay(ed|s)?|behind schedule|not arrived|hasn'?t arrived|eta|overdue|running late|missed (the )?(slot|window|delivery))\b/i],
	['missed_collection', /\b(missed collection|did(n'?t| not) (turn up|arrive|collect)|no[- ]show|failed collection|collection (was )?missed)\b/i],
	['damage', /\b(damaged?|broken|crushed|dented|lost (pallet|parcel|goods|load|consignment)|missing (items?|pallets?|cartons?)|shortage|wet goods)\b/i],
	['billing', /\b(invoice|overcharg|incorrect (charge|amount|invoice)|surcharge|credit note|billing|billed twice|double charged|fuel surcharge)\b/i],
	['payment', /\b(payment|remittance|paid|outstanding balance|overdue (invoice|payment)|statement|chase payment)\b/i],
	['pricing', /\b(quote|quotation|rate card|rates?|price|pricing|tariff|cost per)\b/i],
	['booking', /\b(book(ing)?|schedule (a )?(collection|delivery)|slot|reserve|new order|load request)\b/i],
	['tracking', /\b(track(ing)?|where is|whereabouts|location of|gps|live update|eta update|status update)\b/i],
	['documentation', /\b(pod|proof of delivery|cmr|delivery note|paperwork|documents?|signature|customs|manifest)\b/i],
	['driver_conduct', /\b(driver (was )?(rude|aggressive|unprofessional)|driver behaviou?r|attitude of (the|your) driver|speeding|reckless)\b/i],
	['communication', /\b(no (one|response|reply|update)|not (been )?(updated|informed|told)|lack of communication|ignored|chasing|still waiting for (a )?(reply|response|update))\b/i],
	['contract', /\b(contract|sla|terminate|termination|penalt(y|ies)|escalat(e|ion)|legal|solicitor|switch(ing)? supplier|review (our|the) relationship)\b/i],
	['compliance', /\b(health and safety|h&s|accident|incident|insurance|hazardous|adr|tdg|hours of service|eld|tachograph|compliance|safety)\b/i],
	['service_failure', /\b(failed|failure|service (failure|level)|not delivered|wrong (address|delivery|load)|delivered to the wrong|refused delivery)\b/i],
	['breakdown_maintenance', /\b(broke(n)? down|breakdown|break-down|mechanical (issue|failure)|flat (tyre|tire)|tow(ed|ing)?|repair(s|ed)?|out of service|maintenance|pm service|engine (light|fault)|reefer (failure|unit))\b/i],
	['accident_claim', /\b(accident|collision|incident report|cargo claim|claim (number|form|ref)|insurance claim|osd|over,? short (and|&) damaged)\b/i],
	['detention', /\b(detention|waiting time|wait time|held (at|up at) (the )?(dock|shipper|receiver)|layover|demurrage)\b/i],
	['border_customs', /\b(border|customs|aci|ace manifest|pars|paps|broker|cbsa|cbp|crossing)\b/i],
	['eld_hos', /\b(eld|hours of service|hos|logbook|log book|out of hours|driver hours)\b/i],
	['fuel', /\b(fuel (card|surcharge|cost|price)|diesel|def\b|fuel)\b/i],
	['compliment', /\b(thank you so much|great (job|service|work)|well done|excellent service|really appreciate|impressed|brilliant)\b/i],
	['enquiry', /\b(could you (please )?(let me know|confirm|advise)|can you (confirm|advise)|enquir(y|e|ies)|query|question|wondering)\b/i],
];

const URGENT = /\b(urgent(ly)?|asap|immediately|right away|critical|(need|needs|needed|require|required|must|by|before) (it |this |a response |an answer |them )?(today|tonight)|today please|within the hour|end of (the )?day|eod|top priority|emergency|production (line )?(stopped|down)|stock[- ]?out)\b/i;
const LEGAL = /\b(legal action|solicitor|lawyer|terminate|termination|cancel (the |our )?contract|switch(ing)? (supplier|provider|haulier)|take our business elsewhere|formal (complaint|claim)|compensation|penalt(y|ies)|final (notice|warning))\b/i;

const COMMIT_US = /\b(we will|we'll|i will|i'll|we are going to|we're going to|we shall|let me|i am going to|we can confirm we will)\b/i;
const REQUEST = /\b(please|kindly|can you|could you|would you|need you to|we need|require|request that|i'd like you to|make sure)\b/i;

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function sentences(text: string): string[] {
	return text
		.replace(/\n+/g, '. ')
		.split(/(?<=[.!?])\s+/)
		.map((s) => s.trim().replace(/^[-•*]\s*/, ''))
		.filter((s) => s.length > 3);
}

function scoreText(text: string): number {
	let neg = 0;
	let pos = 0;
	for (const s of sentences(text)) {
		for (const [re, w] of NEG) {
			const m = re.exec(s);
			if (m) {
				const before = s.slice(0, m.index);
				neg += NEGATION.test(before) && w < 2.5 ? -0.3 * w : w;
			}
		}
		for (const [re, w] of POS) {
			const m = re.exec(s);
			if (m) {
				const before = s.slice(0, m.index);
				if (NEGATION.test(before)) neg += w;
				else pos += w;
			}
		}
	}
	const shouting = (text.match(/\b[A-Z]{4,}\b/g) || []).filter((w) => !/^(ASAP|POD|CMR|ETA|PO|INV|UK|USA|SLA|GPS|ADR|NOTE|URGENT|BACS|CHAPS|SWIFT|IBAN|VAT|HGV|LGV|FTL|LTL|PDF|EORI)$/.test(w)).length;
	if (shouting >= 3) neg += Math.min((shouting - 2) * 0.5, 2);
	if (/\bURGENT\b/.test(text)) neg += 0.5;
	const raw = (pos - neg) / Math.max(3, pos + neg);
	return Math.max(-1, Math.min(1, Number(raw.toFixed(2))));
}

const toSentiment = (s: number): Sentiment => (s <= -0.2 ? 'negative' : s >= 0.2 ? 'positive' : 'neutral');

function parseDue(text: string, base: Date): string | null {
	const t = text.toLowerCase();
	const d = new Date(base);
	const iso = (x: Date) => x.toISOString().slice(0, 10);
	if (/\b(today|end of (the )?day|eod|by close of business|cob|this afternoon|tonight)\b/.test(t)) return iso(d);
	if (/\btomorrow\b/.test(t)) { d.setUTCDate(d.getUTCDate() + 1); return iso(d); }
	const within = /\bwithin (\d{1,2}) ?(hours|hrs|days|working days)\b/.exec(t);
	if (within) {
		const n = Number(within[1]);
		d.setUTCDate(d.getUTCDate() + (within[2].startsWith('h') ? Math.ceil(n / 24) : n));
		return iso(d);
	}
	const day = /\b(?:by|on|before|this|next)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.exec(t);
	if (day) {
		const target = DAYS.indexOf(day[1]);
		let diff = (target - d.getUTCDay() + 7) % 7 || 7;
		if (/next\s/.test(day[0]) && diff < 7) diff += 0;
		d.setUTCDate(d.getUTCDate() + diff);
		return iso(d);
	}
	if (/\b(end of (the )?week|this week)\b/.test(t)) {
		const diff = (5 - d.getUTCDay() + 7) % 7;
		d.setUTCDate(d.getUTCDate() + diff);
		return iso(d);
	}
	const dm = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/.exec(t);
	if (dm) {
		const month = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(dm[2]);
		const x = new Date(Date.UTC(d.getUTCFullYear(), month, Number(dm[1])));
		if (x.getTime() < base.getTime() - 30 * 86400_000) x.setUTCFullYear(x.getUTCFullYear() + 1);
		return iso(x);
	}
	const num = /\bby\s+(\d{1,2})[/.-](\d{1,2})\b/.exec(t);
	if (num) {
		const x = new Date(Date.UTC(d.getUTCFullYear(), Number(num[2]) - 1, Number(num[1])));
		if (!isNaN(x.getTime())) return iso(x);
	}
	return null;
}

const uniq = <T,>(a: T[]) => [...new Set(a)];

function entities(text: string) {
	return {
		shipment_refs: uniq((text.match(/\b(?:WK|WKT|CN|CON|SHP|BKG|JOB|LOAD|PO|REF|AWB)[-#:\s]?\d{3,}[A-Z0-9-]*\b/gi) || []).map((s) => s.toUpperCase().replace(/\s+/g, ''))).slice(0, 10),
		invoice_refs: uniq((text.match(/\b(?:INV|INVOICE|CN|CREDIT NOTE)[-#:\s]*(?:NO\.?\s*)?\d{3,}\b/gi) || []).map((s) => s.toUpperCase())).slice(0, 10),
		vehicle_regs: uniq([
			...(text.match(/\b(?:truck|unit|tractor|trailer)\s?#?\d{2,5}\b/gi) || []).map((x) => x.replace(/^./, (c) => c.toUpperCase())),
			...(text.match(/\b[A-Z]{2}\d{2}\s?[A-Z]{3}\b/g) || []),
			...(text.match(/\b[A-Z]{2}\s?\d{1,2}\s?[A-Z]{1,3}\s?\d{4}\b/g) || []),
		]).slice(0, 10),
		amounts: uniq(text.match(/(?:£|\$|€|₹|GBP|USD|CAD|C\$|INR|EUR)\s?\d[\d,]*(?:\.\d{1,2})?(?:k|m)?/gi) || []).slice(0, 10),
		locations: uniq((text.match(/\b(?:depot|warehouse|site|DC|hub) (?:in |at )?([A-Z][a-z]+(?: [A-Z][a-z]+)?)/g) || [])).slice(0, 8),
		dates: [] as string[],
	};
}

const BUSINESS_RULES: [BusinessCategory, RegExp, number][] = [
	['sales_proposal', /\b(rfq|rfp|rfi|tender|quotation|quote|quoted|rate (request|card|confirmation|sheet)|proposal|bid|pricing for|lane rates?|contract renewal|new business|commercial terms|price list)\b/gi, 3],
	['billing_finance', /\b(invoic(e|es|ed|ing)|inv[- ]?\d+[a-z]?|billed (twice|incorrectly|wrong)|payment|remittance|credit note|statement of account|overdue (invoice|payment)|accounts payable|accounts receivable|bank|factoring|purchase order|po number)\b/gi, 2],
	['operations', /\b(load|pick[- ]?up|delivery|deliveries|dispatch|booking|collection|pod|proof of delivery|eta|consignment|shipment|appointment|dock|trailer drop|lane|route)\b/gi, 1],
	['fleet_maintenance', /\b(truck|tractor|trailer|reefer|repair|maintenance|breakdown|tyre|tire|telematics|eld|dashcam|dms|device|installation|gps|vehicle|odometer|engine)\b/gi, 1],
	['compliance_safety', /\b(insurance|claim|accident|audit|compliance|safety|cvor|dot|fmcsa|inspection|violation|h&s|health and safety|tdg|hazmat)\b/gi, 2],
	['vendor_partner', /\b(vendor|supplier|partner(ship)?|subscription|licen[sc]e|credits|integration|platform|software|account manager|renewal|sla)\b/gi, 1],
	['people_hr', /\b(recruit|hiring|interview|candidate|payroll|salary|leave request|onboarding new|driver application|cv|resume|offer letter|appraisal)\b/gi, 3],
	['events_marketing', /\b(webinar|event|conference|exhibitor|exhibition|summit|expo|register now|newsletter|invitation to|pitch day|meetup|workshop)\b/gi, 2],
];

function classifyBusiness(input: ThreadInput, text: string, hasIssues: boolean, negative: boolean): BusinessCategory {
	if (input.isAutomated) return /webinar|event|conference|newsletter|register/i.test(text) ? 'events_marketing' : 'notifications';
	const scores = new Map<BusinessCategory, number>();
	for (const [cat, re, w] of BUSINESS_RULES) scores.set(cat, (text.match(re) || []).length * w);
	const external = !input.isInternal;
	const first = input.messages[0];
	// we asked an outside company for a quote → procurement, not sales
	if (external && first?.direction === 'outbound' && /\b(quote|quotation|price)\b/i.test(`${first.subject} ${first.body}`)) {
		scores.set('vendor_partner', (scores.get('vendor_partner') || 0) + 8);
		scores.set('sales_proposal', 0);
	}
	const opening = `${first?.subject || ''} ${first?.body || ''}`;
	// a truck breakdown or tow is a fleet matter even when it reads as bad news; judged on the first email,
	// so our apology "missed due to a breakdown" does not move a customer's missed-pickup complaint
	if (/\b(broke down|breakdown|roadside assistance|needs a tow|towing|stranded)\b/i.test(opening) && !/\b(our|my) (load|shipment|freight|order)\b/i.test(opening)) return 'fleet_maintenance';
	// cargo claims and insurance certificates belong to compliance, even when the email is unhappy
	// (judged on the first email only: our own reply opening a claim reference does not turn a customer's damage report into a claim)
	if (/\b(cargo claim|freight claim|claim (number|no\.?|ref|form)|clm-\d+|certificate of insurance|coi)\b/i.test(opening)) scores.set('compliance_safety', (scores.get('compliance_safety') || 0) + 10);
	// an unhappy customer is usually a customer-service matter, unless the email is clearly about invoices or a claim
	if (external && negative && first?.direction === 'inbound') {
		const billing = scores.get('billing_finance') || 0, comp = scores.get('compliance_safety') || 0;
		if (comp >= 10) return 'compliance_safety';
		// a routine change request that merely reads as negative stays with operations
		const ops = scores.get('operations') || 0;
		if (ops >= 3 && !hasIssues && !/\b(unacceptable|disappoint|frustrat|complain|again|still (not|no|waiting)|poor|terrible|worst|angry|escalat)\w*/i.test(text)) return 'operations';
		if (billing >= 4 && /\b(invoice|invoiced|billed|overcharg|duplicate (invoice|charge)|credit note)\b/i.test(text)) return 'billing_finance';
		return 'customer_service';
	}
	if (external && hasIssues) scores.set('customer_service', (scores.get('customer_service') || 0) + 6);
	const best = [...scores.entries()].sort((a, b) => b[1] - a[1])[0];
	if (best && best[1] >= 2) return best[0];
	if (!external) return 'internal';
	return input.messages.some((m) => m.direction === 'inbound') ? 'customer_service' : 'other';
}

/** Subgroup rules per group, checked in order; the first match wins, otherwise the group's fallback. */
const SUB_RULES: Partial<Record<BusinessCategory, [string, RegExp][]>> = {
	customer_service: [
		['damage_shortage', /\b(damaged?|broken|crushed|wet|short(age)?|missing (pallet|skid|carton|piece)s?|lost (load|freight|shipment)|over,? short)\b/i],
		['missed_pickup', /\b(missed (the )?(pick[- ]?up|collection)|no[- ]show|did(n'?t| not) (show|turn up|arrive) (for|to) (the )?(pick[- ]?up|collection)|not collected)\b/i],
		['delay_eta', /\b(late|delay(ed)?|still not (delivered|arrived)|where is (my|the|our) (load|shipment|truck|delivery|freight|order)|eta|running behind|overdue)\b/i],
		['pod_request', /\b(pod|proof of delivery|signed bol|delivery receipt|paperwork)\b/i],
		['complaint_service', /\b(unacceptable|complain|rude|unprofessional|no (one|response|reply)|still waiting (for )?(a |your )?(reply|response|answer)|poor service|disappointed|escalat)\b/i],
		['feedback', /\b(thank you so much|great job|well done|appreciate|excellent service|kudos)\b/i],
	],
	sales_proposal: [
		['rfp_tender', /\b(rfp|rfq|rfi|tender|bid (due|deadline)|request for (proposal|quotation))\b/i],
		['contract_renewal', /\b(renewal|renew|contract (review|extension)|annual rates?|rate review)\b/i],
		['onboarding', /\b(credit application|carrier packet|set ?up (as a )?(new )?(customer|vendor)|w-?9|certificate of insurance|onboarding)\b/i],
		['negotiation', /\b(counter|revised|better (rate|price)|can you do better|best (rate|price)|follow(ing)? up on (the|our|your) quote|match)\b/i],
		['new_lane', /\b(new lane|new service|do you (cover|service|run)|expand(ing)? to|dedicated)\b/i],
		['quote_request', /\b(quote|rate|pricing|how much|cost)\b/i],
	],
	operations: [
		['border_customs', /\b(customs|border|pars|paps|aci|ace manifest|broker|cbsa|cbp|crossing)\b/i],
		['detention', /\b(detention|waiting time|held at|layover|lumper)\b/i],
		['appointment', /\b(appointment|appt|reschedul|dock time|delivery window|pickup window|time slot)\b/i],
		['dispatch_change', /\b((move|moving|push) .{0,30}\b(loads?|pick ?ups?|deliver(y|ies)|collections?) to|(add|an) (an )?extra (collection|pick ?up|stop)|cancel|change (the|of)|add(ed|ing)? (a )?stop|reconsign|update the (address|pickup|delivery))\b/i],
		['booking', /\b(new load|book(ing)?|tender(ed)?|load offer|rate con(firmation)?|please (cover|book))\b/i],
		['tracking_eta', /\b(track|tracking|eta|where is|status|location|update on)\b/i],
	],
	fleet_maintenance: [
		['breakdown', /\b(breakdown|broke down|roadside|tow(ing)?|flat tyre|flat tire|stranded)\b/i],
		['telematics_eld', /\b(eld|telematics|gps|dashcam|camera|device|tablet|samsara|geotab|omnitracs|motive)\b/i],
		['parts_equipment', /\b(parts?|tyres?|tires?|trailer order|equipment order|quote for (parts|tyres|tires))\b/i],
	],
	billing_finance: [
		['accessorials', /\b(accessorial|detention charge|lumper|layover|tonu|fuel surcharge|fsc)\b/i],
		['credit_note', /\b(credit note|credit memo|refund)\b/i],
		['payment_status', /\b(payment (status|date|due)|when will (we|i) be paid|remittance|paid|eft|cheque|check number|ach)\b/i],
		['statements', /\b(statement|account balance|credit limit|aging|ageing)\b/i],
		['invoice_query', /\b(invoic(e|es|ed|ing)|inv[- ]?\d+|billing|billed|charge|dispute|overcharg|duplicate)\b/i],
	],
	compliance_safety: [
		['cargo_claim', /\b(cargo claim|claim (number|form)|file a claim|freight claim)\b/i],
		['accident_incident', /\b(accident|collision|incident|injur|crash|rollover)\b/i],
		['insurance_coi', /\b(insurance|coi|certificate of insurance|coverage|additional insured)\b/i],
		['audit_inspection', /\b(audit|inspection|cvor|csa score|fmcsa|dot|mto|violation)\b/i],
		['hos_eld', /\b(hours of service|hos|logbook|log book|eld)\b/i],
	],
	vendor_partner: [
		['supplier_invoice', /\b(invoice|outstanding|payment due|remittance|statement)\b/i],
		['purchase_order', /\b(purchase order|po (no|number|#))\b/i],
		['carrier_partner', /\b(carrier|broker|capacity|load board|partner carrier)\b/i],
	],
	people_hr: [['driver_recruitment', /\b(apply|application|resume|cv|hiring|driver (job|position)|cdl|az licen[sc]e|class 1)\b/i]],
	internal: [['ops_planning', /\b(capacity|plan(ning)?|schedule|roster|equipment availability)\b/i]],
	events_marketing: [
		['trade_show', /\b(trade show|expo|conference|booth|exhibit|summit)\b/i],
		['media_request', /\b(journalist|interview|press|media|podcast|article)\b/i],
		['newsletter', /\b(newsletter|unsubscribe|promotion|webinar)\b/i],
	],
	notifications: [
		['eld_alert', /\b(eld|hos violation|harsh braking|speeding alert|camera event|samsara|geotab|motive)\b/i],
		['tracking_alert', /\b(tracking|load (status|update)|delivered|picked up|portal|macropoint|project44|fourkites)\b/i],
	],
};

/** The subgroup for a thread, from its group and text (rules engine; the AI picks it directly). */
export function guessSubcategory(group: BusinessCategory, text: string): string {
	for (const [key, re] of SUB_RULES[group] || []) if (re.test(text)) return key;
	return normaliseSubcategory(group, '');
}

const PROMO = /\b(unsubscribe|opt[- ]?out|view (this|it) in (your|a) browser|grow your (business|sales)|boost your (sales|business)|seo services|digital marketing|limited[- ]time offer|special offer|book a demo|free trial|load board subscription|factoring (offer|rates)|lead generation|register (now|today)|webinar)\b/i;

function detectProposal(msgs: ThreadInput['messages'], text: string): Analysis['proposal'] {
	const kindMatch = /\b(rfq|rfp|rfi|tender|quotation|quote|rate request|rate confirmation|rate review|proposal|bid|contract renewal)\b/i.exec(text);
	const kind = kindMatch ? kindMatch[1].toLowerCase().replace('quotation', 'quote').replace(' ', '_') : 'proposal';
	const out = msgs.filter((m) => m.direction === 'outbound').map((m) => m.body).join('\n');
	const inn = msgs.filter((m) => m.direction !== 'outbound').map((m) => m.body).join('\n');
	const last = msgs[msgs.length - 1];
	let stage: ProposalStage = 'request_received';
	if (/\b(we will send|we'll send|preparing|working on (the|our) (quote|proposal)|will revert with)\b/i.test(out)) stage = 'in_preparation';
	if (/\b(please find (attached )?(our|the) (quote|quotation|proposal|rates|bid)|attached (is|are) our|we are pleased to (submit|quote)|submitted)\b/i.test(out)) stage = 'submitted';
	if (/\b(counter|revised (rate|quote|offer)|discount|negotiat|best and final|can you do better|match (the|their) rate)\b/i.test(text)) stage = 'negotiation';
	if (/\b(accepted|approved|go ahead|awarded|pleased to confirm|signed|is acceptable|we accept)\b/i.test(inn)) stage = 'won';
	if (/\b(unsuccessful|not been selected|decided to go with|regret to inform|declined|not proceed)\b/i.test(inn)) stage = 'lost';
	if (stage === 'submitted' && last && last.direction === 'outbound' && Date.now() - new Date(last.sentAt).getTime() > 14 * 86400_000) stage = 'no_response';
	const dl = sentences(text).find((x) => /\b(deadline|due|by|before|submission|closing date|no later than)\b/i.test(x) && parseDue(x, new Date(msgs[0].sentAt)));
	const amount = (text.match(/(?:£|\$|€|₹|USD|CAD|C\$|INR)\s?\d[\d,]*(?:\.\d{1,2})?(?:k|m)?(?:\s?(?:per|\/)\s?(?:mile|km|load|month|pallet))?/i) || [])[0] || null;
	const scope = (text.match(/\b(?:from|ex)\s+[A-Z][a-z]+(?:\s[A-Z][a-z]+)?\s+to\s+[A-Z][a-z]+(?:\s[A-Z][a-z]+)?/) || [])[0] || null;
	const next = stage === 'request_received' ? 'Prepare and send the quote' : stage === 'in_preparation' ? 'Finish and submit the proposal' : stage === 'submitted' ? 'Follow up for a decision' : stage === 'negotiation' ? 'Agree final terms' : stage === 'no_response' ? 'Chase for a decision' : null;
	return { kind, stage, deadline: dl ? parseDue(dl, new Date(msgs[0].sentAt)) : null, value: amount, lanes_or_scope: scope, next_step: next };
}

export function heuristicAnalyse(input: ThreadInput): Analysis {
	const msgs = input.messages;
	const inbound = msgs.filter((m) => m.direction === 'inbound');
	const outbound = msgs.filter((m) => m.direction === 'outbound');
	const all = msgs.map((m) => `${m.subject}\n${m.body}`).join('\n');
	// internal threads have no customer side: treat every message as the "voice" of the thread
	const voice = input.isInternal ? msgs : inbound;
	const inboundText = voice.map((m) => `${m.subject}\n${m.body}`).join('\n') || all;

	const message_sentiments = msgs.map((m) => {
		const s = scoreText(`${m.subject}. ${m.body}`);
		return { index: m.index, sentiment: toSentiment(s), score: s };
	});
	// customer sentiment weighted towards recent inbound messages
	let wsum = 0;
	let w = 0;
	voice.forEach((m, i) => {
		const weight = 1 + i;
		wsum += (message_sentiments.find((x) => x.index === m.index)?.score ?? 0) * weight;
		w += weight;
	});
	const score = w ? Number((wsum / w).toFixed(2)) : 0;
	const sentiment = toSentiment(score);

	const categories = uniq(CATS.filter(([, re]) => re.test(inboundText)).map(([c]) => c)) as Category[];
	if (sentiment === 'negative' && !categories.some((c) => c !== 'enquiry' && c !== 'compliment')) categories.push('complaint');
	if (sentiment === 'negative') {
		const i = categories.indexOf('compliment');
		if (i >= 0) categories.splice(i, 1);
	}
	const lastInbound = inbound[inbound.length - 1];
	const lastInboundText = lastInbound ? `${lastInbound.subject} ${lastInbound.body}` : '';
	const urgentHits = (inboundText.match(new RegExp(URGENT, 'gi')) || []).length;
	const legal = LEGAL.test(inboundText);
	const chasing = inbound.length >= 3 && /\b(chas|still|again|follow(ing)? up|second time|third time|reminder)/i.test(lastInboundText);
	const urgency: Analysis['urgency'] = legal || (urgentHits >= 2 && sentiment === 'negative')
		? 'critical'
		: urgentHits >= 1 || (sentiment === 'negative' && chasing)
			? 'high'
			: sentiment === 'negative'
				? 'medium'
				: 'low';

	let escalation = 10;
	if (sentiment === 'negative') escalation += Math.round(-score * 45);
	if (legal) escalation += 35;
	if (chasing) escalation += 15;
	if (urgentHits) escalation += 8 * Math.min(urgentHits, 2);
	if (categories.includes('contract')) escalation += 10;
	if (input.customerTier === 'strategic') escalation += 5;
	escalation = Math.max(0, Math.min(100, escalation));

	const sevFor = (c: Category): Analysis['issues'][number]['severity'] => {
		if (legal && (c === 'contract' || c === 'service_failure')) return 'critical';
		if (['damage', 'service_failure', 'missed_collection', 'driver_conduct', 'compliance'].includes(c)) return sentiment === 'negative' ? 'high' : 'medium';
		if (['delay', 'billing', 'communication'].includes(c)) return sentiment === 'negative' ? (urgency === 'critical' || urgency === 'high' ? 'high' : 'medium') : 'low';
		return 'low';
	};
	const issueCats = categories.filter((c) => !['compliment', 'enquiry', 'booking', 'pricing', 'payment'].includes(c) || sentiment === 'negative');
	const issues = issueCats
		.filter((c) => c !== 'compliment' && c !== 'enquiry')
		.map((c) => {
			const re = CATS.find(([k]) => k === c)![1];
			const sent = sentences(inboundText).find((s) => re.test(s)) || '';
			return { category: c, description: sent ? sent.slice(0, 220) : CATEGORY_LABELS[c], severity: sevFor(c) };
		})
		.slice(0, 6);

	// action items & commitments
	const action_items: Analysis['action_items'] = [];
	const lastOutboundIdx = Math.max(-1, ...msgs.filter((m) => m.direction === 'outbound').map((m) => m.index));
	for (const m of msgs) {
		// customer requests that we have already replied to are no longer open
		const answered = m.direction === 'inbound' && m.index < lastOutboundIdx;
		for (const raw of sentences(m.body).slice(0, 40)) {
			const s = raw.replace(/\.{2,}$/, '.');
			if (answered && !COMMIT_US.test(s)) continue;
			if (/^(ok|okay|thanks|thank you|great|perfect)\b/i.test(s)) continue;
			// generic chasers ("Please respond ASAP.", "Please chase.") are not actionable on their own
			if (/^(please\s+)?(respond|reply|chase|advise|confirm|call me|revert)( asap| urgently| today)?[.!]?$/i.test(s.trim()) || s.trim().length < 18) continue;
			// statements about the customer's own plans are not requests to us
			if (m.direction === 'inbound' && /^we need to (confirm|check|let|tell|inform) (with )?our\b/i.test(s)) continue;
			if (s.length > 260 || /^(hi|hello|dear|regards|thanks)\b/i.test(s)) continue;
			const base = new Date(m.sentAt);
			if ((m.direction === 'outbound' || m.direction === 'internal') && COMMIT_US.test(s)) {
				action_items.push({ description: s.replace(/\s+/g, ' '), owner_side: 'us', owner_name: m.fromName || m.from, is_commitment: true, due_date: parseDue(s, base), message_index: m.index });
			} else if ((m.direction === 'inbound' || (m.direction === 'internal' && m.index === msgs.length - 1)) && REQUEST.test(s) && /\?|please|kindly|need|require|can you|could you/i.test(s)) {
				action_items.push({ description: s.replace(/\s+/g, ' '), owner_side: 'us', owner_name: null, is_commitment: false, due_date: parseDue(s, base), message_index: m.index });
			} else if (m.direction === 'inbound' && COMMIT_US.test(s)) {
				action_items.push({ description: s.replace(/\s+/g, ' '), owner_side: 'customer', owner_name: m.fromName || m.from, is_commitment: true, due_date: parseDue(s, base), message_index: m.index });
			}
		}
	}
	// requests answered by a later outbound message are less likely still open; keep the latest few
	const trimmed = action_items.slice(-8);

	const lastMsg = msgs[msgs.length - 1];
	const lastIsInbound = !!lastMsg && lastMsg.direction === 'inbound';
	// a short "thanks / ok / received" closing note does not need a reply
	const ackOnly = lastIsInbound && lastMsg.body.trim().length < 160 && !/\?/.test(lastMsg.body) &&
		/^\s*(hi[^\n]*\n+)?\s*(ok|okay|great|perfect|thanks|thank you|many thanks|cheers|noted|received|much appreciated|brilliant|lovely|excellent|that's great|sounds good)\b/i.test(lastMsg.body);
	// cold marketing and sales pitches do not need an answer
	const promo = PROMO.test(`${msgs[0]?.subject || ''}\n${(msgs[0]?.body || '').slice(0, 3000)}`) && outbound.length === 0;
	const awaiting = lastIsInbound && !ackOnly && !input.isAutomated && !promo;
	const ent = entities(all);

	const primary = categories.find((c) => c !== 'complaint') || categories[0];
	const firstLine = sentences(lastInbound?.body || msgs[msgs.length - 1]?.body || '').find((s) => s.length > 25) || '';
	const who = input.isInternal ? 'Internal thread:' : input.customerName || 'The customer';
	const business_category = classifyBusiness(input, all, issues.length > 0, sentiment === 'negative');
	const proposal = business_category === 'sales_proposal' ? detectProposal(msgs, all) : null;
	const internalSummary = input.isInternal || input.isAutomated
		? [
			input.isAutomated ? `Automated message from ${msgs[0]?.fromName || msgs[0]?.from}.` : `Internal thread between ${uniq(msgs.map((m) => (m.fromName || m.from).split(' ')[0])).slice(0, 4).join(', ')} (${msgs.length} message${msgs.length > 1 ? 's' : ''}).`,
			firstLine || sentences(msgs[msgs.length - 1]?.body || '').find((x) => x.length > 20) ? `Latest: "${(firstLine || sentences(msgs[msgs.length - 1]?.body || '').find((x) => x.length > 20) || '').slice(0, 180)}"` : '',
		]
		: null;
	const summaryParts = internalSummary || [
		`${who} ${sentiment === 'negative' ? 'raised' : 'wrote about'} ${primary ? CATEGORY_LABELS[primary].toLowerCase() : 'a general matter'}${ent.shipment_refs[0] ? ` (${ent.shipment_refs[0]})` : ''}.`,
		firstLine ? `Latest: "${firstLine.slice(0, 160)}${firstLine.length > 160 ? '…' : ''}"` : '',
		outbound.length
			? awaiting
				? `${outbound.length} reply${outbound.length > 1 ? 'ies' : ''} sent; the customer has written again and is awaiting a response.`
				: `Our team has responded (${outbound.length} reply${outbound.length > 1 ? 'ies' : ''}).`
			: awaiting
				? 'No reply has been sent yet.'
				: '',
	];

	const customer_state: Analysis['customer_state'] =
		sentiment === 'negative' ? (escalation >= 60 || legal ? 'dissatisfied' : 'at_risk') : sentiment === 'positive' ? 'satisfied' : 'neutral';
	const rag: Analysis['rag_suggestion'] =
		legal || (sentiment === 'negative' && (urgency === 'critical' || urgency === 'high' || escalation >= 65))
			? 'red'
			: sentiment === 'negative' || issues.some((i) => i.severity !== 'low')
				? 'amber'
				: 'green';

	const suggested_reply = awaiting
		? [
			`Dear ${lastInbound?.fromName?.split(' ')[0] || 'Customer'},`,
			'',
			sentiment === 'negative'
				? `Thank you for your email, and I am sorry for the ${primary ? CATEGORY_LABELS[primary].toLowerCase() : 'inconvenience'} you have experienced${ent.shipment_refs[0] ? ` with ${ent.shipment_refs[0]}` : ''}.`
				: 'Thank you for your email.',
			sentiment === 'negative'
				? 'I have personally picked this up and am investigating with our operations team now. I will update you by [[provide: time of the next update]] today with [[provide: the confirmed ETA or the outcome of our investigation]].'
				: '[[provide: answer to the customer\'s question]].',
			'',
			input.replySignature || `Kind regards,\n${input.orgName}`,
		].join('\n')
		: '';

	if (proposal && !internalSummary) summaryParts.push(`Proposal stage: ${proposal.stage.replace(/_/g, ' ')}${proposal.deadline ? `, deadline ${proposal.deadline}` : ''}.`);
	return {
		business_category,
		subcategory: guessSubcategory(business_category, inboundText),
		proposal,
		summary: summaryParts.filter(Boolean).join(' '),
		sentiment,
		sentiment_score: score,
		customer_state,
		urgency,
		escalation_risk: escalation,
		categories,
		topics: categories.slice(0, 5).map((c) => CATEGORY_LABELS[c].toLowerCase()),
		issues,
		action_items: trimmed,
		entities: ent,
		message_sentiments,
		requires_reply: awaiting,
		suggested_reply,
		rag_suggestion: rag,
		rag_reason:
			rag === 'red'
				? legal
					? 'Customer has used legal, cancellation or penalty language.'
					: `Negative sentiment with ${urgency} urgency and escalation risk ${escalation}.`
				: rag === 'amber'
					? `Open ${issues[0] ? CATEGORY_LABELS[issues[0].category].toLowerCase() : 'concern'} needs attention before it escalates.`
					: 'No open concerns detected.',
		legal_or_churn_signal: legal,
	};
}
