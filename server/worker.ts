import { one, q, ensureSchema } from './db';
import { defaultOrgId } from './auth';
import { getOrg } from './settings';
import { microsoftSync } from './connectors/microsoft';
import { gmailSync } from './connectors/gmail';
import type { MailboxRow, SyncBatch } from './connectors/types';
import { ingestMessages } from './ingest';
import { analysePending, backfillHealthHistory } from './analyze';
import { evaluateSlaAlerts, processEscalations } from './alerts';
import { runDueReports } from './reports';

export async function syncMailbox(mailboxId: number, maxMessages = 300) {
	const mb = await one<MailboxRow>('select * from mailboxes where id=$1', [mailboxId]);
	if (!mb || mb.status === 'paused') return null;
	if (mb.provider === 'upload' || mb.provider === 'demo') return null;
	const org = await getOrg(mb.org_id);
	const run = await one<{ id: number }>('insert into sync_runs (mailbox_id) values ($1) returning id', [mb.id]);
	try {
		let batch: SyncBatch;
		if (mb.provider === 'gmail') batch = await gmailSync(mb, maxMessages);
		else batch = await microsoftSync(mb, maxMessages);
		const res = await ingestMessages(org, mb, batch.messages);
		await q(
			`update mailboxes set sync_state=$2, last_synced_at=now(), status='active', last_error=null,
			   messages_synced = messages_synced + $3, credentials_enc = coalesce($4, credentials_enc) where id=$1`,
			[mb.id, JSON.stringify(batch.state), res.inserted + res.duplicates, batch.credentials ?? null],
		);
		await q('update sync_runs set finished_at=now(), fetched=$2, inserted=$3, duplicates=$4 where id=$1', [
			run!.id, batch.messages.length, res.inserted, res.duplicates,
		]);
		return { fetched: batch.messages.length, ...res, conversationsTouched: res.conversationsTouched.size, more: batch.more };
	} catch (e: any) {
		console.error('[sync] mailbox', mb.address, e.message);
		const auth = /invalid_grant|AADSTS|401|403|not connected|consent/i.test(e.message);
		await q(`update mailboxes set status=$2, last_error=$3 where id=$1`, [mb.id, auth ? 'error' : mb.status, e.message.slice(0, 500)]);
		await q('update sync_runs set finished_at=now(), error=$2 where id=$1', [run!.id, e.message.slice(0, 500)]);
		return { error: e.message };
	}
}

/**
 * One worker cycle: sync every active mailbox (resuming large backfills), analyse changed
 * conversations, evaluate SLA alerts and escalations, send due reports.
 */
export async function runTick(opts: { budgetMs?: number; mailboxId?: number; reports?: boolean } = {}) {
	await ensureSchema();
	const orgId = await defaultOrgId();
	const deadline = Date.now() + (opts.budgetMs ?? 12 * 60_000);
	const log: Record<string, unknown> = {};

	const mailboxes = await q<{ id: number; address: string }>(
		`select id, address from mailboxes where org_id=$1 and status in ('active','error') and provider in ('microsoft','microsoft_app','gmail')
		 ${opts.mailboxId ? 'and id=$2' : ''} order by last_synced_at nulls first`,
		opts.mailboxId ? [orgId, opts.mailboxId] : [orgId],
	);
	for (const mb of mailboxes) {
		let rounds = 0;
		while (Date.now() < deadline - 60_000 && rounds < 20) {
			const r: any = await syncMailbox(mb.id);
			log[mb.address] = r;
			rounds++;
			if (!r?.more) break;
		}
	}
	let analysed = 0;
	while (Date.now() < deadline - 20_000) {
		const n = await analysePending(orgId, 20, deadline - 15_000);
		analysed += n;
		if (n === 0) break;
	}
	log.analysed = analysed;
	// once a day, make sure history exists for every customer (cheap when already present)
	if (new Date().getUTCHours() === 2 || analysed > 50) await backfillHealthHistory(orgId, 60).catch((e) => console.error('[history]', e.message));
	await evaluateSlaAlerts(orgId).catch((e) => console.error('[sla]', e.message));
	log.escalated = await processEscalations(orgId).catch((e) => (console.error('[esc]', e.message), 0));
	if (opts.reports !== false) log.reports = await runDueReports(orgId).catch((e) => (console.error('[reports]', e.message), 0));
	await purgeExpired(orgId).catch(() => {});
	return log;
}

/** Data retention: remove email bodies beyond the configured retention period. */
async function purgeExpired(orgId: number) {
	const org = await getOrg(orgId);
	const days = org.settings.retentionDays;
	if (!days || days < 30) return;
	await q(
		`update emails set body_text='', body_clean='', snippet='[expired under retention policy]'
		  where org_id=$1 and sent_at < now() - make_interval(days => $2) and body_text <> ''`,
		[orgId, days],
	);
	await q(`delete from oauth_states where created_at < now() - interval '1 hour'`);
	await q(`delete from sessions where expires_at < now() - interval '7 days'`);
}
