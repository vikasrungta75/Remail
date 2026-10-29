/** Pipeline self-test against a throwaway database: npm test (needs DATABASE_URL to an empty test DB) */
import assert from 'node:assert/strict';
import { ensureSchema, getPool, q, one } from '../server/db';
import { defaultOrgId } from '../server/auth';
import { getOrg } from '../server/settings';
import { ingestMessages } from '../server/ingest';
import { analysePending } from '../server/analyze';
import { heuristicAnalyse } from '../server/ai/heuristic';
import { cleanBody, normalizeSubject, redactPII } from '../server/text';

assert.equal(normalizeSubject('RE: Fwd: [EXT] Late delivery'), 'late delivery');
assert.match(cleanBody('Thanks, done.\n\nOn Mon, 1 Jan 2026 at 10:00, Bob <b@x.com> wrote:\n> old text'), /^Thanks, done\.$/);
assert.equal(redactPII('card 4111 1111 1111 1111'), 'card [card-number]');

const a = heuristicAnalyse({ conversationId: 1, customerName: 'Acme', customerTier: 'key', orgName: 'WK', messages: [
	{ index: 0, emailId: 1, direction: 'inbound', from: 'a@acme.ca', fromName: 'A', sentAt: new Date().toISOString(), subject: 'Late again', body: 'This is unacceptable, the load is late again. If this continues we will switch supplier. Please confirm ETA urgently.' },
] });
assert.equal(a.sentiment, 'negative');
assert.equal(a.rag_suggestion, 'red');
assert.ok(a.legal_or_churn_signal);

await ensureSchema();
const orgId = await defaultOrgId();
await q(`update organisations set internal_domains='{wheelking.com}' where id=$1`, [orgId]);
const org = await getOrg(orgId, true);
const mk = async (addr: string) => one<any>(`insert into mailboxes (org_id, provider, address) values ($1,'demo',$2) on conflict (org_id, provider, lower(address)) do update set status='active' returning *`, [orgId, addr]);
const m1 = await mk('cs@wheelking.com');
const m2 = await mk('ops@wheelking.com');
const base = { threadId: null, inReplyTo: null, references: [], cc: [], hasAttachments: false, importance: null, webLink: null, folder: 'inbox' as const, isAutomated: false };
const email = { ...base, providerMessageId: 'p1', internetMessageId: '<abc@acme.ca>', from: { address: 'jo@acme.ca', name: 'Jo' }, to: [{ address: 'cs@wheelking.com', name: '' }], subject: 'Damaged pallets', bodyText: 'Three pallets arrived damaged. Please call me.', sentAt: new Date() };
const r1 = await ingestMessages(org, m1, [email]);
const r2 = await ingestMessages(org, m2, [{ ...email, providerMessageId: 'p2' }]);
assert.equal(r1.inserted, 1);
assert.equal(r2.duplicates, 1, 'same Message-ID in a second mailbox must be a duplicate');
const reply = { ...base, providerMessageId: 'p3', internetMessageId: '<r1@wheelking.com>', inReplyTo: '<abc@acme.ca>', from: { address: 'priya@wheelking.com', name: 'Priya' }, to: [{ address: 'jo@acme.ca', name: '' }], subject: 'RE: Damaged pallets', bodyText: 'Sorry Jo, we will send a claim form by Friday.', sentAt: new Date(Date.now() + 60_000), folder: 'sent' as const };
await ingestMessages(org, m1, [reply]);
const conv = await one<any>(`select * from conversations where normalized_subject='damaged pallets'`);
assert.equal(conv.message_count, 2);
assert.equal(conv.duplicate_count, 1);
assert.equal(conv.awaiting_reply, false);
await analysePending(orgId, 10);
const acts = await q<any>('select * from action_items where conversation_id=$1', [conv.id]);
assert.ok(acts.some((x) => x.is_commitment && x.due_date), 'commitment with due date extracted');
console.log('All pipeline tests passed');
await getPool().end();
