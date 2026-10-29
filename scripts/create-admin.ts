/** Usage: DATABASE_URL=... npm run create-admin -- you@company.com "Your Name" 'StrongPassword1' */
import bcrypt from 'bcryptjs';
import { ensureSchema, getPool, q } from '../server/db';
import { defaultOrgId } from '../server/auth';

const [email, name, password] = process.argv.slice(2);
if (!email || !password) {
	console.error('Usage: npm run create-admin -- <email> "<full name>" <password>');
	process.exit(1);
}
await ensureSchema();
const org = await defaultOrgId();
await q(
	`insert into users (org_id, email, full_name, role, password_hash, all_mailboxes) values ($1,$2,$3,'admin',$4,true)
	 on conflict (lower(email)) do update set password_hash=excluded.password_hash, role='admin', is_active=true, auth_provider='local'`,
	[org, email.toLowerCase(), name || email, await bcrypt.hash(password, 11)],
);
console.log(`Admin ${email} ready.`);
await getPool().end();
