import pg from 'pg';
import { migrations } from './migrations';

const { Pool } = pg;

// Parse bigint/int8 and numeric as JS numbers (ids and counts stay well within 2^53)
pg.types.setTypeParser(20, (v) => parseInt(v, 10));
pg.types.setTypeParser(1700, (v) => parseFloat(v));
// Keep DATE columns as plain 'YYYY-MM-DD' strings
pg.types.setTypeParser(1082, (v) => v);

export function databaseUrl(): string {
	const netlifyEnv = (globalThis as any).Netlify?.env;
	const url =
		process.env.DATABASE_URL ||
		// Netlify Database (Data & Storage → Database) exposes NETLIFY_DB_URL
		process.env.NETLIFY_DB_URL ||
		(netlifyEnv?.get?.('NETLIFY_DB_URL') as string | undefined) ||
		process.env.NETLIFY_DATABASE_URL ||
		process.env.NETLIFY_DATABASE_URL_UNPOOLED ||
		'';
	if (!url) throw new Error('DATABASE_URL is not configured');
	return url;
}

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
	if (!pool) {
		const url = databaseUrl();
		const local = /localhost|127\.0\.0\.1|\/var\/run|host=\//.test(url);
		pool = new Pool({
			connectionString: url,
			max: Number(process.env.DB_POOL_MAX || 4),
			idleTimeoutMillis: 10_000,
			connectionTimeoutMillis: 10_000,
			ssl: local || /sslmode=disable/.test(url) ? undefined : { rejectUnauthorized: false },
		});
		pool.on('error', (err) => console.error('[db] idle client error', err.message));
	}
	return pool;
}

export async function q<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
	const res = await getPool().query(text, params as any[]);
	return res.rows as T[];
}

export async function one<T = any>(text: string, params: unknown[] = []): Promise<T | null> {
	const rows = await q<T>(text, params);
	return rows[0] ?? null;
}

export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
	const client = await getPool().connect();
	try {
		await client.query('begin');
		const out = await fn(client);
		await client.query('commit');
		return out;
	} catch (e) {
		await client.query('rollback');
		throw e;
	} finally {
		client.release();
	}
}

let migrated = false;

/** Idempotent; guarded by an advisory lock so concurrent cold starts don't race. */
export async function ensureSchema(): Promise<void> {
	if (migrated) return;
	const client = await getPool().connect();
	try {
		await client.query('select pg_advisory_lock(727274)');
		await client.query(
			'create table if not exists schema_migrations (id text primary key, applied_at timestamptz not null default now())',
		);
		const done = new Set(
			(await client.query('select id from schema_migrations')).rows.map((r) => r.id),
		);
		for (const m of migrations) {
			if (done.has(m.id)) continue;
			await client.query('begin');
			try {
				await client.query(m.sql);
				await client.query('insert into schema_migrations (id) values ($1)', [m.id]);
				await client.query('commit');
				console.log(`[db] applied migration ${m.id}`);
			} catch (e) {
				await client.query('rollback');
				throw e;
			}
		}
		migrated = true;
	} finally {
		await client.query('select pg_advisory_unlock(727274)').catch(() => {});
		client.release();
	}
}
