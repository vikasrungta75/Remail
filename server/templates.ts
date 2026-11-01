/**
 * Default reply templates, one per subgroup that normally needs an answer. They are seeded into
 * reply_templates for each organisation and can be edited by admins in Help → Reply templates.
 *
 * Fields filled from the email: {{name}}, {{order_ref}} (load, PRO, BOL or invoice number), {{unit}} (truck or trailer), {{signature}}.
 * [[provide: …]] is information only the team knows; it shows in yellow and blocks Send until filled.
 * The AI follows the template and writes it in French when the customer wrote in French.
 */
import { one, q } from './db';
import { HttpError } from './http';
import { SUBCATEGORIES, subgroupOf } from './ai/taxonomy';
import { BUSINESS_LABELS, type BusinessCategory } from './ai/types';

const T = (title: string, body: string, guidance = '') => ({ title, body: body.trim(), guidance });
const OPEN = 'Hi {{name}},\n\nThank you for your email.';
const CLOSE = 'Please let me know if you need anything else.\n\n{{signature}}';
const SORRY = 'Hi {{name}},\n\nThank you for your email, and I am sorry for the trouble this has caused.';

export const DEFAULT_TEMPLATES: Record<string, Record<string, ReturnType<typeof T>>> = {
	customer_service: {
		delay_eta: T('Delivery delay or ETA', `${SORRY}

I have checked load{{order_ref}}. [[provide: current location and status from dispatch or tracking]]. The updated ETA is [[provide: ETA with date, time and time zone]].

[[provide: the reason for the delay, in one sentence]]. I will update you again by [[provide: time of the next update]] or sooner if anything changes.

${CLOSE}`, 'Always give a firm next update time.'),
		missed_pickup: T('Missed pickup', `${SORRY}

We missed the pickup for load{{order_ref}}. [[provide: reason the pickup was missed]].

We have rescheduled it for [[provide: new pickup date and window]], and [[provide: any recovery offered, such as expedite or rate adjustment]].

${CLOSE}`),
		damage_shortage: T('Damage, loss or shortage', `${SORRY}

I have opened a case for load{{order_ref}} under reference [[provide: case or claim reference]]. To move it forward, please send photos of the freight and packaging, the signed delivery receipt with any exceptions noted, and the commercial invoice showing the value.

[[provide: next step and when the customer will hear back]].

${CLOSE}`, 'Do not admit liability; confirm the process and timeline.'),
		pod_request: T('POD and paperwork', `${OPEN}

[[provide: the POD or document is attached / it will be sent by (time) because (reason)]] for load{{order_ref}}.

${CLOSE}`, 'Attach the POD in Outlook if the reply says it is attached.'),
		complaint_service: T('Service complaint', `${SORRY}

I have shared your feedback with [[provide: manager or team responsible]]. [[provide: what has been done or will be done, and by when]].

Your account matters to us and I will follow up personally on [[provide: follow-up date]].

${CLOSE}`, 'Acknowledge the specific complaint in one sentence before the template text.'),
		general_enquiry: T('General enquiry', `${OPEN}

[[provide: answer to the customer's question]].

${CLOSE}`),
		feedback: T('Feedback and thanks', `${OPEN} I have passed your kind words on to the team and the driver.

[[provide: optional: response to any suggestion made]].

${CLOSE}`, 'Short and warm. Remove the placeholder line if there was no suggestion.'),
	},
	sales_proposal: {
		quote_request: T('Quote or rate request', `${OPEN} We would be glad to quote.

For [[provide: origin, destination and equipment]], our rate is [[provide: all-in rate in CAD or USD, and what it includes]], with a transit time of [[provide: transit time]]. Fuel surcharge is [[provide: fuel surcharge basis]] and the quote is valid until [[provide: validity date]].

[[provide: any assumptions: weight, hazmat, appointment, accessorials]].

${CLOSE}`, 'Never quote a rate without the pricing team.'),
		rfp_tender: T('RFP or tender', `${OPEN} We confirm our intention to [[provide: bid / decline]] on [[provide: RFP name]].

[[provide: questions for the shipper, if any, and the date our submission will be sent]].

${CLOSE}`),
		new_lane: T('New lane or service', `${OPEN}

[[provide: whether we cover the lane or service, with equipment and frequency]]. [[provide: next step: quote, call or site visit]].

${CLOSE}`),
		negotiation: T('Rate negotiation and follow-up', `${OPEN}

Regarding our quote{{order_ref}}: [[provide: our response: revised rate, transit time or terms, or the final offer]].

${CLOSE}`),
		contract_renewal: T('Contract renewal', `${OPEN}

[[provide: our position on the renewal: rates, term, volume commitment]] and [[provide: proposed meeting date to review]].

${CLOSE}`),
		onboarding: T('New customer setup', `${OPEN} Welcome to Wheel King TransHaul.

[[provide: documents attached or still needed: credit application, certificate of insurance, W-9 or GST/HST number]]. [[provide: account contact and how to tender loads]].

${CLOSE}`),
	},
	operations: {
		booking: T('Load booking', `${OPEN} We confirm load{{order_ref}}.

Pickup: [[provide: pickup date, window and address]]. Delivery: [[provide: delivery date, window and address]]. Equipment: [[provide: equipment]]. Rate: [[provide: confirmed rate]].

A rate confirmation will follow [[provide: when]].

${CLOSE}`),
		tracking_eta: T('Tracking and ETA', `${OPEN}

Load{{order_ref}} is [[provide: current location and status]] and is on schedule to deliver [[provide: ETA with date, time and time zone]].

${CLOSE}`),
		appointment: T('Appointment and scheduling', `${OPEN}

[[provide: appointment confirmed for (date, time), or the alternative times we can offer]] for load{{order_ref}}.

${CLOSE}`),
		dispatch_change: T('Changes and cancellations', `${OPEN}

We have [[provide: made the change / cancelled the load]] for load{{order_ref}}. [[provide: any charge, such as TONU or extra stop, and updated rate]].

${CLOSE}`),
		detention: T('Detention and waiting time', `${OPEN}

Our driver on unit {{unit}} arrived at [[provide: arrival time]] and was released at [[provide: release time]] for load{{order_ref}}. Detention after the free time of [[provide: free time]] is [[provide: detention rate]] per hour, which comes to [[provide: amount]].

${CLOSE}`),
		border_customs: T('Border and customs', `${OPEN}

For load{{order_ref}}: [[provide: PARS or PAPS number, customs broker, and documents still needed]]. [[provide: expected crossing time and port]].

${CLOSE}`),
	},
	fleet_maintenance: {
		breakdown: T('Breakdown and roadside', `${OPEN}

[[provide: roadside service arranged, location and expected repair time]] for unit {{unit}}. [[provide: impact on loads and recovery plan]].

${CLOSE}`),
		repair_service: T('Repair and service', `${OPEN}

[[provide: confirmation of the booking, date and work to be done]] for unit {{unit}}.

${CLOSE}`),
		parts_equipment: T('Parts and equipment', `${OPEN}

[[provide: order confirmation, price and delivery date]].

${CLOSE}`),
		telematics_eld: T('Telematics and ELD', `${OPEN}

[[provide: the fix or next step for the device on unit (unit), and who will follow up]].

${CLOSE}`),
	},
	billing_finance: {
		invoice_query: T('Invoice query or dispute', `${OPEN}

I have reviewed invoice{{order_ref}}. [[provide: explanation of the charges, or the correction we will make and when]].

${CLOSE}`, 'Attach supporting documents (POD, detention log) where relevant.'),
		payment_status: T('Payment status and remittance', `${OPEN}

[[provide: payment status: paid on (date) by (method) with reference (number), or scheduled for (date)]].

${CLOSE}`),
		accessorials: T('Accessorials and fuel surcharge', `${OPEN}

The [[provide: accessorial name]] charge on load{{order_ref}} is [[provide: amount]], based on [[provide: the reason: detention log, lumper receipt, fuel surcharge table]].

${CLOSE}`),
		credit_note: T('Credit note or refund', `${OPEN}

[[provide: credit note of (amount) issued on (date) with reference (number), or the reason it cannot be issued]].

${CLOSE}`),
		statements: T('Statements and account', `${OPEN}

[[provide: statement attached, open balance and any items needing attention]].

${CLOSE}`),
	},
	compliance_safety: {
		accident_incident: T('Accident or incident', `${OPEN} Thank you for letting us know.

[[provide: what we know so far, and confirmation that safety has been informed]]. [[provide: the safety contact and next update time]].

${CLOSE}`, 'Never admit fault; safety and insurance must review before any detail is shared.'),
		cargo_claim: T('Cargo claim', `${OPEN}

We have received your claim for load{{order_ref}} and opened file [[provide: claim reference]]. [[provide: documents still needed and the expected response date]].

${CLOSE}`, 'Do not accept liability in writing.'),
		insurance_coi: T('Insurance and certificates', `${OPEN}

[[provide: certificate of insurance attached, naming (certificate holder)]].

${CLOSE}`),
		audit_inspection: T('Audit and inspection', `${OPEN}

[[provide: the information requested, or the date it will be provided, and the contact person]].

${CLOSE}`),
		hos_eld: T('Hours of service and ELD', `${OPEN}

[[provide: the answer on hours of service or ELD records, reviewed by safety]].

${CLOSE}`),
	},
	vendor_partner: {
		vendor_offer: T('Vendor offer', `Hi {{name}},

Thank you for reaching out. [[provide: whether we are interested; if so, what to send and to whom]].

{{signature}}`),
		purchase_order: T('Purchase order', `Hi {{name}},

[[provide: purchase order details or confirmation, delivery date and address]].

{{signature}}`),
		supplier_invoice: T('Supplier invoice and payment', `Hi {{name}},

We have received your invoice{{order_ref}}. [[provide: payment status and expected payment date]].

{{signature}}`),
		carrier_partner: T('Carriers and brokers', `Hi {{name}},

[[provide: response on capacity, setup or the load discussed]].

{{signature}}`),
	},
	people_hr: {
		driver_recruitment: T('Driver recruitment', `Hi {{name}},

Thank you for your interest in driving with Wheel King TransHaul. [[provide: whether we are hiring for this role and the next step: application link, phone screen or road test]].

{{signature}}`),
	},
	events_marketing: {
		trade_show: T('Trade show and event', `${OPEN}

[[provide: whether we will attend or exhibit, and the contact person]].

${CLOSE}`),
		media_request: T('Media request', `${OPEN}

[[provide: response to the media request, and the person who handles media]].

${CLOSE}`),
	},
	other: {
		other: T('General reply', `${OPEN}

[[provide: answer to the message]].

${CLOSE}`),
	},
};

export interface TemplateRow {
	id: number;
	group_key: BusinessCategory;
	subgroup_key: string;
	title: string;
	body: string;
	guidance: string;
	is_active: boolean;
	is_default: boolean;
	updated_at: string;
}

const seeded = new Set<number>();
/** Insert any missing default templates (never overwrites an edited one). */
export async function ensureTemplates(orgId: number) {
	if (seeded.has(orgId)) return;
	for (const [g, list] of Object.entries(DEFAULT_TEMPLATES))
		for (const [sub, t] of Object.entries(list))
			await q(
				`insert into reply_templates (org_id, group_key, subgroup_key, title, body, guidance) values ($1,$2,$3,$4,$5,$6)
				 on conflict (org_id, group_key, subgroup_key) do nothing`,
				[orgId, g, sub, t.title, t.body, t.guidance],
			);
	seeded.add(orgId);
}

export async function listTemplates(orgId: number): Promise<TemplateRow[]> {
	await ensureTemplates(orgId);
	const rows = await q<TemplateRow>('select * from reply_templates where org_id=$1', [orgId]);
	// keep the taxonomy order
	const order = Object.entries(SUBCATEGORIES).flatMap(([g, l]) => l.map((x) => `${g}/${x.key}`));
	return rows.sort((a, b) => order.indexOf(`${a.group_key}/${a.subgroup_key}`) - order.indexOf(`${b.group_key}/${b.subgroup_key}`));
}

/** Active templates for one group, for the AI prompt. */
export async function templatesForGroup(orgId: number, group: BusinessCategory, firstSub?: string) {
	await ensureTemplates(orgId);
	const rows = await q<TemplateRow>('select * from reply_templates where org_id=$1 and group_key=$2 and is_active', [orgId, group]);
	rows.sort((a, b) => (a.subgroup_key === firstSub ? -1 : b.subgroup_key === firstSub ? 1 : 0));
	return rows.map((t) => ({
		group: group,
		subgroup: t.subgroup_key,
		label: subgroupOf(group, t.subgroup_key)?.label || t.title,
		body: t.guidance ? `${t.body}\n(Guidance for the writer: ${t.guidance})` : t.body,
	}));
}

export async function getTemplate(orgId: number, group: string, sub: string) {
	await ensureTemplates(orgId);
	return one<TemplateRow>('select * from reply_templates where org_id=$1 and group_key=$2 and subgroup_key=$3 and is_active', [orgId, group, sub]);
}

export async function updateTemplate(orgId: number, userId: number, id: number, input: { title?: string; body?: string; guidance?: string; is_active?: boolean }) {
	const t = await one<TemplateRow>('select * from reply_templates where id=$1 and org_id=$2', [id, orgId]);
	if (!t) throw new HttpError(404, 'Template not found');
	if (input.body !== undefined && !String(input.body).trim()) throw new HttpError(400, 'The template cannot be empty');
	await q(
		`update reply_templates set title=coalesce($3,title), body=coalesce($4,body), guidance=coalesce($5,guidance), is_active=coalesce($6,is_active),
		   is_default=false, updated_at=now(), updated_by=$7 where id=$1 and org_id=$2`,
		[id, orgId, input.title?.slice(0, 120) ?? null, input.body?.slice(0, 6000) ?? null, input.guidance?.slice(0, 1000) ?? null, input.is_active ?? null, userId],
	);
	return one<TemplateRow>('select * from reply_templates where id=$1', [id]);
}

export async function resetTemplate(orgId: number, id: number) {
	const t = await one<TemplateRow>('select * from reply_templates where id=$1 and org_id=$2', [id, orgId]);
	if (!t) throw new HttpError(404, 'Template not found');
	const d = DEFAULT_TEMPLATES[t.group_key]?.[t.subgroup_key];
	if (!d) throw new HttpError(400, 'This template has no built-in default');
	await q('update reply_templates set title=$2, body=$3, guidance=$4, is_active=true, is_default=true, updated_at=now() where id=$1', [id, d.title, d.body, d.guidance]);
	return one<TemplateRow>('select * from reply_templates where id=$1', [id]);
}

/** Fill a template's {{fields}} for the rules engine (the AI does this itself). */
export function renderTemplate(body: string, f: { name?: string; orderRef?: string; book?: string; signature: string }) {
	return body
		.replace(/\{\{\s*name\s*\}\}/g, f.name || 'there')
		.replace(/\{\{\s*order_ref\s*\}\}/g, f.orderRef ? ` ${f.orderRef}` : '')
		.replace(/\{\{\s*(?:book|unit)\s*\}\}/g, f.book || '[[provide: truck or trailer number]]')
		.replace(/\{\{\s*signature\s*\}\}/g, f.signature)
		.replace(/\n(?:\(Guidance[^\n]*\))$/, '');
}

export const groupLabel = (g: string) => BUSINESS_LABELS[g as BusinessCategory] || g;
