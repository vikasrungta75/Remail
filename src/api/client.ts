export class ApiError extends Error {
	constructor(public status: number, message: string) {
		super(message);
	}
}

let onUnauthorised: (() => void) | null = null;
export const setUnauthorisedHandler = (fn: () => void) => (onUnauthorised = fn);

export const getToken = () => {
	try {
		return localStorage.getItem('token') || '';
	} catch {
		return '';
	}
};

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; raw?: boolean } = {}): Promise<T> {
	const token = getToken();
	const res = await fetch(`/api${path}`, {
		method: opts.method || (opts.body ? 'POST' : 'GET'),
		headers: {
			...(opts.body ? { 'content-type': 'application/json' } : {}),
			...(token ? { authorization: `Bearer ${token}` } : {}),
		},
		body: opts.body ? JSON.stringify(opts.body) : undefined,
	});
	if (res.status === 401 && token && !path.startsWith('/auth/login')) {
		onUnauthorised?.();
	}
	if (opts.raw) return res as unknown as T;
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new ApiError(res.status, data.error || `Request failed (${res.status})`);
	return data as T;
}

export const qs = (o: Record<string, unknown>) => {
	const p = new URLSearchParams();
	for (const [k, v] of Object.entries(o)) {
		if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) continue;
		p.set(k, Array.isArray(v) ? v.join(',') : String(v));
	}
	const s = p.toString();
	return s ? `?${s}` : '';
};
