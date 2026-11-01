/**
 * Email groups (headings) and subgroups (subheadings). Every analysed conversation gets one group
 * (business_category) and one subgroup (subcategory). The same structure drives the category report,
 * the Help section and the default reply templates.
 */
import type { BusinessCategory } from './types';

export interface Subgroup {
	key: string;
	label: string;
	description: string;
	/** true when the subgroup normally needs an answer, so it gets a default reply template */
	replies: boolean;
}

export const GROUP_DESCRIPTIONS: Record<BusinessCategory, string> = {
	customer_service: 'Customers raising a problem, complaint, question or feedback about a load or the service.',
	sales_proposal: 'Quotes, rate requests, RFPs and tenders, new lanes, negotiations and contract renewals.',
	operations: 'Loads, bookings, pickups and deliveries, appointments, tracking, detention and border crossings.',
	fleet_maintenance: 'Trucks, trailers, breakdowns, repairs, parts and telematics equipment.',
	billing_finance: 'Invoices, disputes, payments, accessorials, fuel surcharges, credit notes and statements.',
	compliance_safety: 'Accidents and incidents, cargo claims, insurance certificates, audits and hours of service.',
	vendor_partner: 'Suppliers, carriers, brokers and service providers.',
	people_hr: 'Driver recruitment, staff matters and payroll.',
	internal: 'Staff talking to each other.',
	events_marketing: 'Trade shows, media and newsletters.',
	notifications: 'Automated messages from tracking, ELD, portals and systems.',
	other: 'Anything that fits no other group.',
};

const s = (key: string, label: string, description: string, replies = true): Subgroup => ({ key, label, description, replies });

export const SUBCATEGORIES: Record<BusinessCategory, Subgroup[]> = {
	customer_service: [
		s('delay_eta', 'Delivery delay or ETA', 'A load is late, or the customer wants a firm ETA.'),
		s('missed_pickup', 'Missed pickup', 'The truck did not arrive for a collection, or arrived outside the window.'),
		s('damage_shortage', 'Damage, loss or shortage', 'Freight arrived damaged, short or did not arrive.'),
		s('pod_request', 'POD and paperwork', 'Proof of delivery, BOL or other documents requested.'),
		s('complaint_service', 'Service complaint', 'Unhappy with communication, a driver, or how a problem was handled.'),
		s('general_enquiry', 'General enquiry', 'Questions about services, coverage, hours or how to book.'),
		s('feedback', 'Feedback and thanks', 'Thanks or suggestions; usually a short acknowledgement.'),
	],
	sales_proposal: [
		s('quote_request', 'Quote or rate request', 'A spot quote or rate for a lane, equipment or volume.'),
		s('rfp_tender', 'RFP or tender', 'A formal bid, RFP or tender with a deadline.'),
		s('new_lane', 'New lane or service', 'A customer asking about a new lane, equipment type or service.'),
		s('negotiation', 'Rate negotiation and follow-up', 'Follow-up on a quote: rate, transit time or terms.'),
		s('contract_renewal', 'Contract renewal', 'Renewal, rate review or extension of an existing contract.'),
		s('onboarding', 'New customer setup', 'Credit application, account setup, insurance or carrier packet.'),
	],
	operations: [
		s('booking', 'Load booking', 'A new load tendered or booked.'),
		s('tracking_eta', 'Tracking and ETA', 'Where a load is now and when it will arrive.'),
		s('appointment', 'Appointment and scheduling', 'Pickup or delivery appointments, reschedules and dock times.'),
		s('dispatch_change', 'Changes and cancellations', 'Changes to a load, extra stops or cancellations.'),
		s('detention', 'Detention and waiting time', 'Driver held at a dock; detention time and charges.'),
		s('border_customs', 'Border and customs', 'Customs paperwork, PARS/PAPS, brokers and border delays.'),
	],
	fleet_maintenance: [
		s('breakdown', 'Breakdown and roadside', 'A truck or trailer broke down on the road.'),
		s('repair_service', 'Repair and service', 'Scheduled maintenance, repairs and inspections.'),
		s('parts_equipment', 'Parts and equipment', 'Parts, tyres, trailers and equipment orders.'),
		s('telematics_eld', 'Telematics and ELD', 'ELD devices, GPS units, cameras and telematics issues.'),
	],
	billing_finance: [
		s('invoice_query', 'Invoice query or dispute', 'A question about, or a dispute of, an invoice.'),
		s('payment_status', 'Payment status and remittance', 'When a payment will be made, or proof of payment.'),
		s('accessorials', 'Accessorials and fuel surcharge', 'Detention, layover, lumper, TONU or fuel surcharge charges.'),
		s('credit_note', 'Credit note or refund', 'A credit or refund requested or issued.'),
		s('statements', 'Statements and account', 'Statements of account, credit limits and setup.'),
	],
	compliance_safety: [
		s('accident_incident', 'Accident or incident', 'A collision, injury or safety incident.'),
		s('cargo_claim', 'Cargo claim', 'A formal claim for damaged or lost freight.'),
		s('insurance_coi', 'Insurance and certificates', 'Certificates of insurance and coverage questions.'),
		s('audit_inspection', 'Audit and inspection', 'Roadside inspections, audits and regulator requests.'),
		s('hos_eld', 'Hours of service and ELD', 'Hours of service, logs and ELD compliance.'),
	],
	vendor_partner: [
		s('vendor_offer', 'Vendor offer', 'A supplier or service provider offering products or services.'),
		s('purchase_order', 'Purchase order', 'Purchase orders and their confirmations.'),
		s('supplier_invoice', 'Supplier invoice and payment', 'A supplier invoice, or a supplier chasing payment.'),
		s('carrier_partner', 'Carriers and brokers', 'Partner carriers and brokers: capacity, setup and loads.'),
	],
	people_hr: [
		s('driver_recruitment', 'Driver recruitment', 'Driver applications and questions about jobs.'),
		s('staff_matter', 'Staff matter', 'Leave, payroll and other staff matters.', false),
	],
	internal: [
		s('internal_coordination', 'Team coordination', 'Staff coordinating work between teams.', false),
		s('ops_planning', 'Operations planning', 'Capacity, driver and equipment planning.', false),
	],
	events_marketing: [
		s('trade_show', 'Trade show and event', 'Invitations to or arrangements for trade shows.'),
		s('media_request', 'Media request', 'Journalists, interviews and publications.'),
		s('newsletter', 'Newsletter and promotion', 'Newsletters and promotions sent to us.', false),
	],
	notifications: [
		s('tracking_alert', 'Tracking and portal alerts', 'Automatic load, portal and tracking notifications.', false),
		s('eld_alert', 'ELD and telematics alerts', 'Automatic ELD, GPS and camera alerts.', false),
		s('system', 'System message', 'Other automated messages.', false),
	],
	other: [s('other', 'Other', 'Does not fit any subgroup.')],
};

export const ALL_SUBCATEGORIES = Object.values(SUBCATEGORIES).flatMap((l) => l.map((x) => x.key));
const BY_KEY = new Map<string, Subgroup & { group: BusinessCategory }>();
for (const [g, list] of Object.entries(SUBCATEGORIES)) for (const x of list) if (!BY_KEY.has(x.key)) BY_KEY.set(x.key, { ...x, group: g as BusinessCategory });

/** key is unique per group; some keys (wrong_item, not_received, address_change) are shared by meaning across groups */
export const subgroupOf = (group: BusinessCategory, key: string | null | undefined) =>
	SUBCATEGORIES[group]?.find((x) => x.key === key) || null;

export const subcategoryLabel = (key: string | null | undefined) => (key && BY_KEY.get(key)?.label) || 'Not set';

/** The subgroup used when nothing more specific fits. */
const FALLBACK: Partial<Record<BusinessCategory, string>> = {
	customer_service: 'general_enquiry',
	sales_proposal: 'quote_request',
	operations: 'tracking_eta',
	fleet_maintenance: 'repair_service',
	billing_finance: 'invoice_query',
	compliance_safety: 'insurance_coi',
	vendor_partner: 'vendor_offer',
	people_hr: 'staff_matter',
	internal: 'internal_coordination',
	events_marketing: 'newsletter',
	notifications: 'system',
}

/** Make sure a subgroup belongs to its group; otherwise pick the group's first. */
export function normaliseSubcategory(group: BusinessCategory, key: unknown): string {
	const list = SUBCATEGORIES[group] || SUBCATEGORIES.other;
	const k = String(key || '').trim().toLowerCase();
	return list.find((x) => x.key === k)?.key || FALLBACK[group] || list[0].key;
}

/** For the prompt: one line per group with its subgroups. */
export function taxonomyForPrompt(): string {
	return Object.entries(SUBCATEGORIES)
		.map(([g, list]) => `${g}: ${list.map((x) => `${x.key} (${x.label})`).join(', ')}`)
		.join('\n');
}

export function taxonomyTree() {
	return (Object.keys(SUBCATEGORIES) as BusinessCategory[]).map((g) => ({
		key: g,
		description: GROUP_DESCRIPTIONS[g],
		subgroups: SUBCATEGORIES[g],
	}));
}
