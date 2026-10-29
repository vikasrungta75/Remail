/**
 * Background function (up to 15 minutes): mailbox sync, AI analysis, alerts, escalations, reports.
 * Invoked by the scheduler every 5 minutes and by "Sync now" in the UI.
 */
import { runTick } from '../../server/worker';
import { safeEqual } from '../../server/crypto';

export default async (req: Request) => {
	const secret = process.env.INTERNAL_API_SECRET || '';
	if (!secret || !safeEqual(req.headers.get('x-remail-secret') || '', secret)) {
		return new Response('Unauthorised', { status: 401 });
	}
	let body: any = {};
	try { body = await req.json(); } catch { body = {}; }
	const started = Date.now();
	const log = await runTick({ mailboxId: body.mailboxId, budgetMs: 13 * 60_000, reports: body.mailboxId ? false : true });
	console.log('[worker] done in', Date.now() - started, 'ms', JSON.stringify(log).slice(0, 2000));
	return new Response('ok');
};
