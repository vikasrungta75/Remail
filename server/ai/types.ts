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
	complaint: 'General complaint',
	compliment: 'Compliment',
	enquiry: 'Enquiry',
};

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
	messages: ThreadMessage[];
}

export interface Analysis {
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
		'summary', 'sentiment', 'sentiment_score', 'customer_state', 'urgency', 'escalation_risk', 'categories', 'topics',
		'issues', 'action_items', 'entities', 'message_sentiments', 'requires_reply', 'suggested_reply', 'rag_suggestion',
		'rag_reason', 'legal_or_churn_signal',
	],
} as const;
