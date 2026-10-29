/**
 * Scheduled function: every 5 minutes hand off to the background worker.
 * (Scheduled functions are limited to 30 seconds, so the real work runs in worker-background.)
 */
import type { Config } from '@netlify/functions';

export default async () => {
	const base = process.env.URL;
	const secret = process.env.INTERNAL_API_SECRET;
	if (!base || !secret) {
		console.error('[scheduler] URL or INTERNAL_API_SECRET missing');
		return new Response('not configured', { status: 500 });
	}
	const res = await fetch(`${base}/.netlify/functions/worker-background`, {
		method: 'POST',
		headers: { 'x-remail-secret': secret, 'content-type': 'application/json' },
		body: '{}',
	});
	console.log('[scheduler] worker queued', res.status);
	return new Response('queued');
};

export const config: Config = {
	schedule: '*/5 * * * *',
};
