export const CATEGORIES = [
	'service_failure',
	'delay',
	'missed_collection',
	'damage',
	'billing',
	'payment',
	'pricing',
	'booking',
	'tracking',
	'documentation',
	'driver_conduct',
	'communication',
	'contract',
	'compliance',
	'breakdown_maintenance',
	'accident_claim',
	'detention',
	'border_customs',
	'eld_hos',
	'fuel',
	'complaint',
	'compliment',
	'enquiry',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABELS: Record<Category, string> = {
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

/** What kind of email this is — gives a comprehensive view across all mail, not only complaints. */
export const BUSINESS_CATEGORIES = [
	'customer_service',
	'sales_proposal',
	'operations',
	'fleet_maintenance',
	'billing_finance',
	'compliance_safety',
	'vendor_partner',
	'people_hr',
	'internal',
	'events_marketing',
	'notifications',
	'other',
] as const;
export type BusinessCategory = (typeof BUSINESS_CATEGORIES)[number];

export const BUSINESS_LABELS: Record<BusinessCategory, string> = {
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

export const PROPOSAL_STAGES = ['request_received', 'in_preparation', 'submitted', 'negotiation', 'won', 'lost', 'no_response'] as const;
export type ProposalStage = (typeof PROPOSAL_STAGES)[number];

export type Sentiment = 'positive' | 'neutral' | 'negative';
export type Severity = 'low' | 'medium' | 'high' | 'critical';

export interface ThreadMessage {
	index: number;
	emailId: number;
	direction: 'inbound' | 'outbound' | 'internal';
	from: string;
	fromName: string;
	sentAt: string;
	subject: string;
	body: string;
}

export interface ThreadInput {
	conversationId: number;
	customerName: string;
	customerTier: string;
	orgName: string;
	isInternal: boolean;
	isAutomated: boolean;
	messages: ThreadMessage[];
}

export interface Analysis {
	business_category: BusinessCategory;
	proposal: null | {
		kind: string; // rfq, rfp, tender, quote, rate_request, proposal, contract_renewal
		stage: ProposalStage;
		deadline: string | null;
		value: string | null;
		lanes_or_scope: string | null;
		next_step: string | null;
	};
	summary: string;
	sentiment: Sentiment;
	sentiment_score: number;
	customer_state: 'satisfied' | 'neutral' | 'at_risk' | 'dissatisfied';
	urgency: 'low' | 'medium' | 'high' | 'critical';
	escalation_risk: number;
	categories: Category[];
	topics: string[];
	issues: { category: Category; description: string; severity: Severity }[];
	action_items: {
		description: string;
		owner_side: 'us' | 'customer';
		owner_name?: string | null;
		is_commitment: boolean;
		due_date?: string | null;
		message_index?: number | null;
	}[];
	entities: {
		shipment_refs: string[];
		invoice_refs: string[];
		vehicle_regs: string[];
		amounts: string[];
		locations: string[];
		dates: string[];
	};
	message_sentiments: { index: number; sentiment: Sentiment; score: number }[];
	requires_reply: boolean;
	suggested_reply: string;
	rag_suggestion: 'red' | 'amber' | 'green';
	rag_reason: string;
	legal_or_churn_signal: boolean;
}

/** JSON schema handed to the LLM as a tool so the output is always structured. */
export const ANALYSIS_SCHEMA = {
	type: 'object',
	properties: {
		business_category: { type: 'string', enum: [...BUSINESS_CATEGORIES], description: 'What kind of email thread this is. customer_service = a customer raising an issue or service request; sales_proposal = quotes, rate requests, RFQ/RFP/tenders, proposals, contract renewals (either direction); operations = loads, dispatch, pickups, deliveries, scheduling; fleet_maintenance = trucks, trailers, repairs, telematics/ELD equipment; billing_finance = invoices, payments, credit, accounting; compliance_safety = safety, insurance, accidents, claims, audits, regulations; vendor_partner = suppliers, partners, software and service providers; people_hr = drivers, staff, hiring, payroll; internal = only staff talking to each other about anything not above; events_marketing = events, webinars, newsletters, marketing; notifications = automated system messages.' },
		proposal: {
			type: ['object', 'null'],
			description: 'Only for sales_proposal threads, otherwise null.',
			properties: {
				kind: { type: 'string', description: 'rfq, rfp, tender, quote, rate_request, proposal, contract_renewal' },
				stage: { type: 'string', enum: ['request_received', 'in_preparation', 'submitted', 'negotiation', 'won', 'lost', 'no_response'] },
				deadline: { type: ['string', 'null'], description: 'YYYY-MM-DD submission or decision deadline' },
				value: { type: ['string', 'null'], description: 'Commercial value or rates mentioned' },
				lanes_or_scope: { type: ['string', 'null'] },
				next_step: { type: ['string', 'null'] },
			},
		},
		summary: { type: 'string', description: '2-3 sentence factual summary of the conversation: what the customer wants, what has been done, current state.' },
		sentiment: { type: 'string', enum: ['positive', 'neutral', 'negative'], description: 'Overall customer sentiment, weighted to the most recent customer messages.' },
		sentiment_score: { type: 'number', description: '-1 (very negative) to 1 (very positive)' },
		customer_state: { type: 'string', enum: ['satisfied', 'neutral', 'at_risk', 'dissatisfied'] },
		urgency: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
		escalation_risk: { type: 'integer', description: '0-100 likelihood the customer escalates, churns, claims or involves management/legal.' },
		categories: { type: 'array', items: { type: 'string', enum: [...CATEGORIES] } },
		topics: { type: 'array', items: { type: 'string' }, description: 'Up to 5 short lowercase topic tags, e.g. "late delivery manchester depot".' },
		issues: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					category: { type: 'string', enum: [...CATEGORIES] },
					description: { type: 'string' },
					severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
				},
				required: ['category', 'description', 'severity'],
			},
		},
		action_items: {
			type: 'array',
			description: 'Concrete follow-ups and commitments. owner_side=us when the logistics company must act or promised something; customer when the customer must act.',
			items: {
				type: 'object',
				properties: {
					description: { type: 'string' },
					owner_side: { type: 'string', enum: ['us', 'customer'] },
					owner_name: { type: ['string', 'null'] },
					is_commitment: { type: 'boolean', description: 'true if someone explicitly promised to do this' },
					due_date: { type: ['string', 'null'], description: 'YYYY-MM-DD if a deadline is stated or clearly implied' },
					message_index: { type: ['integer', 'null'] },
				},
				required: ['description', 'owner_side', 'is_commitment'],
			},
		},
		entities: {
			type: 'object',
			properties: {
				shipment_refs: { type: 'array', items: { type: 'string' } },
				invoice_refs: { type: 'array', items: { type: 'string' } },
				vehicle_regs: { type: 'array', items: { type: 'string' } },
				amounts: { type: 'array', items: { type: 'string' } },
				locations: { type: 'array', items: { type: 'string' } },
				dates: { type: 'array', items: { type: 'string' } },
			},
		},
		message_sentiments: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					index: { type: 'integer' },
					sentiment: { type: 'string', enum: ['positive', 'neutral', 'negative'] },
					score: { type: 'number' },
				},
				required: ['index', 'sentiment', 'score'],
			},
		},
		requires_reply: { type: 'boolean' },
		suggested_reply: { type: 'string', description: 'A short, professional draft reply from the logistics company, or empty if none needed. Never invent facts; use placeholders like [ETA].' },
		rag_suggestion: { type: 'string', enum: ['red', 'amber', 'green'] },
		rag_reason: { type: 'string', description: 'One sentence explaining the RAG rating.' },
		legal_or_churn_signal: { type: 'boolean', description: 'Mentions of legal action, contract termination, switching supplier, formal claims or penalties.' },
	},
	required: [
		'business_category', 'proposal', 'summary', 'sentiment', 'sentiment_score', 'customer_state', 'urgency', 'escalation_risk', 'categories', 'topics',
		'issues', 'action_items', 'entities', 'message_sentiments', 'requires_reply', 'suggested_reply', 'rag_suggestion',
		'rag_reason', 'legal_or_churn_signal',
	],
} as const;
