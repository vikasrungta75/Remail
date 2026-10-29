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
