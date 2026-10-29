/** Local API server for development: serves /api/* on :8888 (Vite proxies to it). */
import http from 'node:http';
import { handle } from '../server/api';
import { runTick } from '../server/worker';

const port = Number(process.env.PORT || 8888);
http
	.createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const c of req) chunks.push(c as Buffer);
		const body = Buffer.concat(chunks);
		const request = new Request(`http://localhost:${port}${req.url}`, {
			method: req.method,
			headers: req.headers as any,
			body: ['GET', 'HEAD'].includes(req.method || 'GET') ? undefined : body,
		});
		const response = await handle(request);
		res.writeHead(response.status, Object.fromEntries((response.headers as any).entries()));
		res.end(Buffer.from(await response.arrayBuffer()));
	})
	.listen(port, () => console.log(`remail API on http://localhost:${port}`));

// local stand-in for the Netlify scheduler
if (process.env.LOCAL_WORKER !== 'false') {
	setInterval(() => runTick({ budgetMs: 4 * 60_000 }).catch((e) => console.error('[tick]', e.message)), 5 * 60_000);
}
