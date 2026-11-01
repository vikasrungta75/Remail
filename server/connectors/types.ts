export interface Address {
	address: string;
	name: string;
}

export interface NormalizedMessage {
	providerMessageId: string;
	internetMessageId: string | null;
	threadId: string | null;
	inReplyTo: string | null;
	references: string[];
	from: Address;
	to: Address[];
	cc: Address[];
	subject: string;
	bodyText: string;
	sentAt: Date;
	hasAttachments: boolean;
	importance: string | null;
	webLink: string | null;
	folder: 'inbox' | 'sent' | 'other';
	isAutomated: boolean;
}

export interface SyncBatch {
	messages: NormalizedMessage[];
	/** new sync_state to persist after the batch has been ingested */
	state: Record<string, any>;
	/** true when the provider has more pages waiting */
	more: boolean;
	/** refreshed (rotated) credentials to persist, if any */
	credentials?: string;
}

export interface MailboxRow {
	id: number;
	org_id: number;
	provider: 'microsoft' | 'microsoft_app' | 'gmail' | 'gmail_app' | 'upload' | 'demo';
	address: string;
	display_name: string;
	credentials_enc: string | null;
	status: string;
	sync_state: Record<string, any>;
	backfill_days: number;
}
