import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { MdCheckCircle, MdRadioButtonUnchecked, MdDoNotDisturbOn, MdAdd, MdEvent } from 'react-icons/md';
import { downloadIcs } from './MyDay';
import { api, qs } from '../api/client';
import { useFilters } from '../contexts/FilterContext';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import FilterBar, { useFilterOptions } from '../components/FilterBar';
import { Card, Empty, Kpi, Loader, Modal, PageHead, RagDot, Segmented, TierBadge } from '../components/ui';
import { BUSINESS_SHORT, COLORS, fmtDate } from '../lib/format';

export default function Actions() {
	const { params } = useFilters();
	const { can } = useAuth();
	const nav = useNavigate();
	const toast = useToast();
	const qc = useQueryClient();
	const opts = useFilterOptions();
	const [status, setStatus] = useState<'open' | 'done' | 'all'>('open');
	const [owner, setOwner] = useState<'all' | 'us' | 'customer'>('us');
	const [only, setOnly] = useState<'' | 'overdue' | 'commitments'>('');
	const [mine, setMine] = useState(false);
	const [create, setCreate] = useState<any>(null);
	const query = { ...params, from: status === 'open' ? undefined : params.from, actionStatus: status, owner: owner === 'all' ? undefined : owner, overdue: only === 'overdue' || undefined, commitments: only === 'commitments' || undefined, mine: mine || undefined };
	const add = useMutation({
		mutationFn: () => api('/actions', { body: create }),
		onSuccess: () => { setCreate(null); qc.invalidateQueries({ queryKey: ['actions'] }); qc.invalidateQueries({ queryKey: ['my-day'] }); toast('Action added'); },
		onError: (e: any) => toast(e.message, 'error'),
	});
	const { data, isLoading } = useQuery({ queryKey: ['actions', query], queryFn: () => api(`/actions${qs(query)}`), refetchInterval: 60_000 });
	const upd = useMutation({
		mutationFn: (b: { id: number; body: any }) => api(`/actions/${b.id}`, { method: 'PATCH', body: b.body }),
		onSuccess: () => { qc.invalidateQueries({ queryKey: ['actions'] }); qc.invalidateQueries({ queryKey: ['summary'] }); },
		onError: (e: any) => toast(e.message, 'error'),
	});
	const rows = data?.rows || [];
	const today = new Date(new Date().toDateString());
	const overdue = rows.filter((a: any) => a.status === 'open' && a.due_date && new Date(a.due_date) < today).length;
	const dueSoon = rows.filter((a: any) => a.status === 'open' && a.due_date && new Date(a.due_date) >= today && new Date(a.due_date).getTime() - today.getTime() < 3 * 86400_000).length;

	return (
		<>
			<PageHead kw="Actions" rest="and commitments" sub="Promises made by your team and requests people are waiting on, extracted from every thread, plus your own to-dos."
				actions={can('analyst') && <button className="btn primary" onClick={() => setCreate({ description: '', dueDate: '', assigneeId: null })}><MdAdd /> New action</button>} />
			<FilterBar show={['type', 'customer', 'mailbox', 'rag', 'tier']} />
			<div className="grid g-4 mb-16">
				<Kpi label="Showing" value={rows.length} accent={COLORS.blue} />
				<Kpi label="Overdue" value={overdue} accent={COLORS.red} onClick={() => setOnly('overdue')} />
				<Kpi label="Due in 3 days" value={dueSoon} accent={COLORS.amber} />
				<Kpi label="Commitments by us" value={rows.filter((a: any) => a.is_commitment && a.owner_side === 'us').length} accent={COLORS.teal} onClick={() => setOnly('commitments')} />
			</div>
			<div className="row wrap mb-16">
				<Segmented value={status} onChange={setStatus} options={[{ v: 'open', l: 'Open' }, { v: 'done', l: 'Done' }, { v: 'all', l: 'All' }]} />
				<Segmented value={owner} onChange={setOwner} options={[{ v: 'us', l: 'Owed by us' }, { v: 'customer', l: 'Customer to do' }, { v: 'all', l: 'Everyone' }]} />
				<Segmented value={only} onChange={setOnly} options={[{ v: '', l: 'All types' }, { v: 'overdue', l: 'Overdue only' }, { v: 'commitments', l: 'Commitments only' }]} />
				<label className="row small"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} style={{ accentColor: 'var(--pink)' }} /> Assigned to me</label>
			</div>
			<Card flush>
				{isLoading ? <Loader /> : !rows.length ? <Empty text="Nothing here" /> : (
					<div className="table-wrap">
						<table className="table">
							<thead><tr><th style={{ width: 40 }} /><th>Action</th><th>Customer</th><th>Type</th><th>Due</th><th>Owner</th><th /></tr></thead>
							<tbody>
								{rows.map((a: any) => {
									const late = a.status === 'open' && a.due_date && new Date(a.due_date) < today;
									return (
										<tr key={a.id}>
											<td>
												<button className="btn ghost icon" style={{ padding: 2 }} disabled={!can('analyst')} aria-label="Mark done"
													onClick={() => upd.mutate({ id: a.id, body: { status: a.status === 'done' ? 'open' : 'done' } })}>
													{a.status === 'done' ? <MdCheckCircle style={{ color: COLORS.green, fontSize: 20 }} /> : <MdRadioButtonUnchecked style={{ fontSize: 20, color: 'var(--text-3)' }} />}
												</button>
											</td>
											<td style={{ maxWidth: 460 }}>
												<div style={{ textDecoration: a.status === 'done' ? 'line-through' : 'none' }}>{a.description}</div>
												{a.conversation_id
													? <div className="xs faint row gap-4 mt-8 cursor" onClick={() => nav(`/conversations/${a.conversation_id}`)}><RagDot rag={a.rag} /> {a.subject} {a.business_category && <span className="chip">{BUSINESS_SHORT[a.business_category]}</span>}</div>
													: <div className="xs faint mt-8">Added manually{a.notes ? ` · ${a.notes}` : ''}</div>}
											</td>
											<td><div className="row" style={{ fontWeight: 700 }}>{a.customer_name || <span className="faint">Internal</span>} <TierBadge tier={a.customer_tier} /></div></td>
											<td>
												<div className="row wrap gap-4">
													<span className={`badge ${a.owner_side === 'us' ? 'blue' : 'purple'}`}>{a.owner_side === 'us' ? 'Owed by us' : 'Customer'}</span>
													{a.is_commitment && <span className="badge teal">Commitment</span>}
												</div>
											</td>
											<td className="nowrap">
												{can('analyst') ? (
													<input type="date" className="input" style={{ width: 150, padding: '5px 8px', borderColor: late ? COLORS.red : undefined }} value={a.due_date || ''}
														onChange={(e) => upd.mutate({ id: a.id, body: { dueDate: e.target.value || null } })} aria-label="Due date" />
												) : a.due_date ? fmtDate(a.due_date) : '–'}
												{late && <div className="xs" style={{ color: COLORS.red }}>Overdue</div>}
											</td>
											<td>
												{can('analyst') ? (
													<select className="input" style={{ width: 160, padding: '5px 8px' }} value={a.assignee_id || ''} onChange={(e) => upd.mutate({ id: a.id, body: { assigneeId: e.target.value ? Number(e.target.value) : null } })} aria-label="Owner">
														<option value="">{a.owner_name || 'Unassigned'}</option>
														{(opts.data?.users || []).map((u: any) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
													</select>
												) : a.assignee_name || a.owner_name || '–'}
											</td>
											<td className="nowrap">
												<button className="btn ghost sm" title="Add to Outlook calendar" onClick={() => downloadIcs(a.id)}><MdEvent /></button>
												{a.status === 'open' && can('analyst') && <button className="btn ghost sm" title="Dismiss" onClick={() => upd.mutate({ id: a.id, body: { status: 'dismissed' } })}><MdDoNotDisturbOn /></button>}
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>
				)}
			</Card>
			{create && (
				<Modal title="New action" onClose={() => setCreate(null)}
					footer={<><button className="btn" onClick={() => setCreate(null)}>Cancel</button><button className="btn primary" disabled={!create.description.trim() || add.isPending} onClick={() => add.mutate()}>Add action</button></>}>
					<div className="field"><label>What needs to be done</label><textarea className="input" value={create.description} onChange={(e) => setCreate({ ...create, description: e.target.value })} placeholder="Send revised rate card to Northgate" /></div>
					<div className="grid g-2">
						<div className="field"><label>Due date</label><input type="date" className="input" value={create.dueDate} onChange={(e) => setCreate({ ...create, dueDate: e.target.value })} /></div>
						<div className="field"><label>Owner</label>
							<select className="input" value={create.assigneeId || ''} onChange={(e) => setCreate({ ...create, assigneeId: e.target.value ? Number(e.target.value) : null })}>
								<option value="">Me</option>
								{(opts.data?.users || []).map((u: any) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
							</select>
						</div>
					</div>
				</Modal>
			)}
		</>
	);
}
