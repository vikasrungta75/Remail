import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, qs } from '../../api/client';
import { Card, Empty, Loader, PageHead } from '../../components/ui';
import { COLORS, fmtDateTime } from '../../lib/format';

const GROUPS = [
	{ v: '', l: 'All activity' },
	{ v: 'auth.', l: 'Sign-in and passwords' },
	{ v: 'conversation.', l: 'Conversations' },
	{ v: 'export.', l: 'Exports' },
	{ v: 'mailbox.', l: 'Mailboxes' },
	{ v: 'user.', l: 'Users' },
	{ v: 'settings.', l: 'Settings' },
	{ v: 'alert', l: 'Alerts' },
	{ v: 'report', l: 'Reports' },
];

export default function Audit() {
	const [action, setAction] = useState('');
	const [user, setUser] = useState('');
	const [offset, setOffset] = useState(0);
	const { data, isLoading } = useQuery({ queryKey: ['audit', action, user, offset], queryFn: () => api(`/audit${qs({ action, user, offset })}`) });
	return (
		<>
			<PageHead kw="Audit" rest="log" sub="Append-only record of who did what and when." />
			<div className="row wrap mb-16">
				<select className="input" style={{ width: 220 }} value={action} onChange={(e) => { setAction(e.target.value); setOffset(0); }} aria-label="Activity">
					{GROUPS.map((g) => <option key={g.v} value={g.v}>{g.l}</option>)}
				</select>
				<input className="input" style={{ width: 240 }} placeholder="Filter by user email" value={user} onChange={(e) => { setUser(e.target.value); setOffset(0); }} />
			</div>
			<Card flush accent={COLORS.navy}>
				{isLoading ? <Loader /> : !data?.rows?.length ? <Empty text="No activity" /> : (
					<div className="table-wrap">
						<table className="table">
							<thead><tr><th>Time</th><th>User</th><th>Action</th><th>Entity</th><th>Details</th><th>IP address</th></tr></thead>
							<tbody>
								{data.rows.map((r: any) => (
									<tr key={r.id}>
										<td className="small nowrap">{fmtDateTime(r.created_at)}</td>
										<td className="small">{r.user_email || 'system'}</td>
										<td><span className={`badge ${r.action.includes('failed') ? 'red' : r.action.startsWith('auth') ? 'blue' : ''}`}>{r.action}</span></td>
										<td className="small">{r.entity_type ? `${r.entity_type} ${r.entity_id || ''}` : ''}</td>
										<td className="mono" style={{ maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={JSON.stringify(r.details)}>
											{Object.keys(r.details || {}).length ? JSON.stringify(r.details) : ''}
										</td>
										<td className="small faint">{r.ip_address}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
				<div className="row-between" style={{ padding: '12px 20px' }}>
					<button className="btn sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 200))}>Newer</button>
					<button className="btn sm" disabled={(data?.rows?.length || 0) < 200} onClick={() => setOffset(offset + 200)}>Older</button>
				</div>
			</Card>
		</>
	);
}
