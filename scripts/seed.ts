/** Load the Wheel King demo dataset and analyse it: npm run seed */
import { ensureSchema, getPool, q } from '../server/db';
import { defaultOrgId } from '../server/auth';
import { loadDemoData } from '../server/demo';
import { analysePending, backfillHealthHistory, updateCustomerHealth } from '../server/analyze';

await ensureSchema();
const org = await defaultOrgId();
const admin = await q<{ id: number }>(`select id from users where role='admin' order by id limit 1`);
const res = await loadDemoData(org, admin[0]?.id);
console.log('[seed] demo data', res);
let total = 0;
for (;;) {
	const n = await analysePending(org, 50, Date.now() + 10 * 60_000);
	total += n;
	if (!n) break;
}
console.log(`[seed] analysed ${total} conversations`);
// closed threads: customer requests are done; commitments older than a week were delivered
await q(`update action_items a set status='done', completed_at=now() from conversations c
         where c.id=a.conversation_id and c.status='resolved' and a.status='open' and (not a.is_commitment or a.created_at < now() - interval '7 days' or c.last_message_at < now() - interval '10 days')`);
await backfillHealthHistory(org, 45);
for (const c of await q<{ id: number }>('select id from customers where org_id=$1', [org])) await updateCustomerHealth(c.id);
console.log('[seed] health history reconstructed');
await getPool().end();
