import crypto from 'node:crypto';

function key(): Buffer {
	const raw = process.env.ENCRYPTION_KEY || '';
	if (!raw) throw new Error('ENCRYPTION_KEY is not configured');
	// Accept a 64-char hex key, a base64 key, or any passphrase (hashed to 32 bytes)
	if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
	const b = Buffer.from(raw, 'base64');
	if (b.length === 32) return b;
	return crypto.createHash('sha256').update(raw).digest();
}

/** AES-256-GCM. Output: base64(iv | tag | ciphertext) */
export function encrypt(plain: string): string {
	const iv = crypto.randomBytes(12);
	const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
	const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
	return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}

export function decrypt(payload: string): string {
	const buf = Buffer.from(payload, 'base64');
	const iv = buf.subarray(0, 12);
	const tag = buf.subarray(12, 28);
	const data = buf.subarray(28);
	const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
	decipher.setAuthTag(tag);
	return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

export function safeEqual(a: string, b: string): boolean {
	const ab = Buffer.from(a);
	const bb = Buffer.from(b);
	return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
