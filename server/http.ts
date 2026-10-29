import type { SessionUser } from './auth';

export class HttpError extends Error {
	constructor(public status: number, message: string, public details?: unknown) {
		super(message);
	}
}

export interface Ctx {
	req: Request;
	url: URL;
	method: string;
	params: Record<string, string>;
	query: URLSearchParams;
	body: any;
	ip: string;
	ua: string;
	user?: SessionUser;
}

export type Handler = (ctx: Ctx) => Promise<Response | unknown>;

interface Route {
	method: string;
	parts: string[];
	handler: Handler;
	auth: 'public' | 'user' | 'internal';
	roles?: string[];
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
	});
}

export function redirect(location: string): Response {
	return new Response(null, { status: 302, headers: { location } });
}

export class Router {
	routes: Route[] = [];

	add(method: string, path: string, handler: Handler, opts: { auth?: Route['auth']; roles?: string[] } = {}) {
		this.routes.push({
			method,
			parts: path.split('/').filter(Boolean),
			handler,
			auth: opts.auth ?? 'user',
			roles: opts.roles,
		});
		return this;
	}
	get(p: string, h: Handler, o?: { auth?: Route['auth']; roles?: string[] }) { return this.add('GET', p, h, o); }
	post(p: string, h: Handler, o?: { auth?: Route['auth']; roles?: string[] }) { return this.add('POST', p, h, o); }
	put(p: string, h: Handler, o?: { auth?: Route['auth']; roles?: string[] }) { return this.add('PUT', p, h, o); }
	patch(p: string, h: Handler, o?: { auth?: Route['auth']; roles?: string[] }) { return this.add('PATCH', p, h, o); }
	del(p: string, h: Handler, o?: { auth?: Route['auth']; roles?: string[] }) { return this.add('DELETE', p, h, o); }

	match(method: string, pathname: string): { route: Route; params: Record<string, string> } | null {
		const parts = pathname.split('/').filter(Boolean);
		for (const route of this.routes) {
			if (route.method !== method || route.parts.length !== parts.length) continue;
			const params: Record<string, string> = {};
			let ok = true;
			for (let i = 0; i < parts.length; i++) {
				const rp = route.parts[i];
				if (rp.startsWith(':')) params[rp.slice(1)] = decodeURIComponent(parts[i]);
				else if (rp !== parts[i]) { ok = false; break; }
			}
			if (ok) return { route, params };
		}
		return null;
	}
}

export const intParam = (v: string | null | undefined, def?: number): number | undefined => {
	if (v === null || v === undefined || v === '') return def;
	const n = Number(v);
	return Number.isFinite(n) ? n : def;
};

export const listParam = (v: string | null): string[] =>
	v ? v.split(',').map((s) => s.trim()).filter(Boolean) : [];
