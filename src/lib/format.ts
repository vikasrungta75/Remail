import { formatDistanceToNowStrict, format } from 'date-fns';

export const ago = (d?: string | Date | null) => (d ? `${formatDistanceToNowStrict(new Date(d))} ago` : 'never');
export const fmtDate = (d?: string | Date | null, f = 'd MMM yyyy') => (d ? format(new Date(d), f) : '');
export const fmtDateTime = (d?: string | Date | null) => (d ? format(new Date(d), 'd MMM yyyy, HH:mm') : '');
export const minutes = (m?: number | null) => {
	if (m === null || m === undefined) return 'n/a';
	if (m < 60) return `${m}m`;
	if (m < 60 * 48) return `${(m / 60).toFixed(m < 600 ? 1 : 0)}h`;
	return `${Math.round(m / 1440)}d`;
};
export const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
export const hoursSince = (d?: string | null) => (d ? (Date.now() - new Date(d).getTime()) / 3600_000 : 0);

export const CATEGORY_LABELS: Record<string, string> = {
	service_failure: 'Service failure',
	delay: 'Delay',
	missed_collection: 'Missed collection',
	damage: 'Damage or loss',
	billing: 'Billing issue',
	payment: 'Payment',
	pricing: 'Pricing and rates',
	booking: 'Booking',
	tracking: 'Tracking and visibility',
	documentation: 'Documentation and POD',
	driver_conduct: 'Driver conduct',
	communication: 'Poor communication',
	contract: 'Contract and escalation',
	compliance: 'Compliance and safety',
	breakdown_maintenance: 'Breakdown and maintenance',
	accident_claim: 'Accident or cargo claim',
	detention: 'Detention and waiting time',
	border_customs: 'Border and customs',
	eld_hos: 'ELD and hours of service',
	fuel: 'Fuel and surcharges',
	complaint: 'General complaint',
	compliment: 'Compliment',
	enquiry: 'Enquiry',
};
export const catLabel = (c: string) => CATEGORY_LABELS[c] || c;
export const stateLabel = (s?: string | null) => (s ? s.replace('_', ' ').replace(/^./, (c) => c.toUpperCase()) : '');

export const COLORS = {
	pink: '#F00D69',
	navy: '#0B1143',
	blue: '#4C80FF',
	amber: '#E89040',
	purple: '#5D2CA4',
	teal: '#00D3CF',
	general: '#2C55BA',
	green: '#12B886',
	red: '#F00D69',
	grey: '#A3A9C2',
};
export const RAG_COLORS: Record<string, string> = { red: COLORS.red, amber: COLORS.amber, green: COLORS.green };
export const SENT_COLORS: Record<string, string> = { negative: COLORS.red, neutral: '#A3A9C2', positive: COLORS.green };

export const BUSINESS_LABELS: Record<string, string> = {
	customer_service: 'Customer service and issues',
	sales_proposal: 'Sales, quotes and proposals',
	operations: 'Operations and dispatch',
	fleet_maintenance: 'Fleet, equipment and maintenance',
	billing_finance: 'Billing, payments and finance',
	compliance_safety: 'Compliance, safety and claims',
	vendor_partner: 'Vendors, suppliers and partners',
	people_hr: 'Drivers, people and recruitment',
	internal: 'Internal team',
	events_marketing: 'Events, marketing and newsletters',
	notifications: 'Automated notifications',
	other: 'Other',
};
export const BUSINESS_SHORT: Record<string, string> = {
	customer_service: 'Customer service', sales_proposal: 'Proposals', operations: 'Operations', fleet_maintenance: 'Fleet',
	billing_finance: 'Finance', compliance_safety: 'Compliance', vendor_partner: 'Vendors', people_hr: 'People',
	internal: 'Internal', events_marketing: 'Events', notifications: 'Notifications', other: 'Other',
};
export const BUSINESS_COLORS: Record<string, string> = {
	customer_service: '#F00D69', sales_proposal: '#5D2CA4', operations: '#E89040', fleet_maintenance: '#2C55BA',
	billing_finance: '#00A8A5', compliance_safety: '#B4600F', vendor_partner: '#4C80FF', people_hr: '#12B886',
	internal: '#0B1143', events_marketing: '#8A90A8', notifications: '#A3A9C2', other: '#C9CDE0',
};
export const bizLabel = (c?: string | null) => (c ? BUSINESS_LABELS[c] || c : '');
export const STAGE_LABELS: Record<string, string> = {
	request_received: 'Request received', in_preparation: 'In preparation', submitted: 'Submitted', negotiation: 'Negotiation',
	won: 'Won', lost: 'Lost', no_response: 'No response',
};
export const KIND_LABELS: Record<string, string> = { customer: 'Customer', prospect: 'Prospect', vendor: 'Vendor', partner: 'Partner', candidate: 'Candidate', other: 'Other' };
