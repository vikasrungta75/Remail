import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { MdArrowBack, MdEdit, MdSearch, MdTrendingDown, MdTrendingUp } from 'react-icons/md';
import { api, qs } from '../api/client';
import { useFilters } from '../contexts/FilterContext';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import FilterBar from '../components/FilterBar';
import Chart from '../components/Chart';
import { Card, Empty, Health, Kpi, Loader, Modal, PageHead, RagBar, RagDot, StateBadge, StatusBadge, TierBadge } from '../components/ui';
import { COLORS, ago, catLabel, fmtDate } from '../lib/format';

export default function Customers() {
	const { params } = useFilters();
	const nav = useNavigate();
	const [q, setQ] = useState('');
	const [state, setState] = useState<string>('all');
	const { data, isLoading } = useQuery({ queryKey: ['customers', params, q], queryFn: () => api(`/customers${qs({ ...params, q })}`), refetchInterval: 60_000 });
	const rows = (data?.rows || []).filter((c: any) => state === 'all' || c.health_status === state || (state === 'risk' && ['at_risk', 'dissatisfied'].includes(c.health_status)));
	const count = (s: string) => (data?.rows || []).filter((c: any) => c.health_status === s).length;

	return (
		<>
			<PageHead kw="Customer" rest="health" sub="Health score blends sentiment, red and amber issues, overdue commitments and reply times over the last 30 days." />
			<FilterBar show={['customer', 'mailbox', 'tier', 'category']} />
			<div className="grid g-4 mb-16">
				<Kpi label="Satisfied" value={count('satisfied')} accent={COLORS.green} onClick={() => setState('satisfied')} />
				<Kpi label="Neutral" value={count('neutral')} accent={COLORS.blue} onClick={() => setState('neutral')} />
				<Kpi label="At risk" value={count('at_risk')} accent={COLORS.amber} onClick={() => setState('at_risk')} />
				<Kpi label="Dissatisfied" value={count('dissatisfied')} accent={COLORS.red} onClick={() => setState('dissatisfied')} />
			</div>
			<Card flush
				title={<div className="row wrap">
					<div style={{ position: 'relative' }}>
						<MdSearch style={{ position: 'absolute', left: 10, top: 11, color: 'var(--text-3)' }} />
						<input className="input" style={{ paddingLeft: 32, width: 260 }} placeholder="Search customers" value={q} onChange={(e) => setQ(e.target.value)} />
					</div>
					<select className="input" style={{ width: 180 }} value={state} onChange={(e) => setState(e.target.value)} aria-label="Health status">
						<option value="all">All customers</option>
						<option value="risk">At risk or dissatisfied</option>
						<option value="satisfied">Satisfied</option>
						<option value="neutral">Neutral</option>
						<option value="at_risk">At risk</option>
						<option value="dissatisfied">Dissatisfied</option>
					</select>
				</div>}>
				{isLoading ? <Loader /> : !rows.length ? <Empty text="No customers match" /> : (
					<div className="table-wrap">
						<table className="table">
							<thead>
								<tr>
									<th>Customer</th>
									<th style={{ width: 180 }}>Health</th>
									<th>Status</th>
									<th>Traffic light mix</th>
									<th className="num">Conversations</th>
									<th className="num">Awaiting</th>
									<th>Top issues</th>
									<th>Last contact</th>
								</tr>
							</thead>
							<tbody>
								{rows.map((c: any) => (
									<tr key={c.id} className="click" onClick={() => nav(`/customers/${c.id}`)}>
										<td>
											<div className="row" style={{ fontWeight: 700 }}>{c.name} <TierBadge tier={c.tier} /></div>
											<div className="xs faint">{(c.domains || []).join(', ')}</div>
										</td>
										<td>
											<Health score={c.health_score} />
											{c.health_trend !== 0 && (
												<div className={`xs row gap-4 ${c.health_trend < 0 ? 'up-bad' : 'up-good'}`} style={{ color: c.health_trend < 0 ? COLORS.red : COLORS.green }}>
													{c.health_trend < 0 ? <MdTrendingDown /> : <MdTrendingUp />} {c.health_trend > 0 ? '+' : ''}{c.health_trend} in 7 days
												</div>
											)}
										</td>
										<td><StateBadge s={c.health_status} /></td>
										<td style={{ minWidth: 140 }}>
											<RagBar red={c.red} amber={c.amber} green={c.green} />
											<div className="xs faint mt-8">{c.red} red · {c.amber} amber · {c.green} green</div>
										</td>
										<td className="num">{c.conversations}</td>
										<td className="num">{c.awaiting ? <span className="badge amber">{c.awaiting}</span> : '–'}</td>
										<td><div className="row wrap gap-4">{(c.top_categories || []).map((x: string) => <span key={x} className="chip">{catLabel(x)}</span>)}</div></td>
										<td className="small nowrap">{ago(c.last_contact_at)}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</Card>
		</>
	);
}

export function CustomerDetail() {
	const { id } = useParams();
	const nav = useNavigate();
	const { can } = useAuth();
	const toast = useToast();
	const qc = useQueryClient();
	const [edit, setEdit] = useState(false);
	const { data, isLoading } = useQuery({ queryKey: ['customer', id], queryFn: () => api(`/customers/${id}`) });
	const [form, setForm] = useState<any>(null);
	const save = useMutation({
		mutationFn: () => api(`/customers/${id}`, { method: 'PATCH', body: { ...form, domains: String(form.domains || '').split(',').map((d: string) => d.trim()).filter(Boolean) } }),
		onSuccess: () => { setEdit(false); qc.invalidateQueries(); toast('Customer saved'); },
		onError: (e: any) => toast(e.message, 'error'),
	});
	if (isLoading || !data) return <Loader />;
	const c = data.customer;
	const open = data.conversations.filter((x: any) => x.status !== 'resolved' && x.status !== 'ignored');
	return (
		<>
			<button className="btn ghost sm mb-8" onClick={() => nav(-1)}><MdArrowBack /> Back</button>
			<PageHead
				kw={c.name}
				sub={<span className="row wrap"><TierBadge tier={c.tier} /><StateBadge s={c.health_status} /> <span className="faint">{(c.domains || []).join(', ')} · account owner {c.account_owner || 'not set'} · last contact {ago(c.last_contact_at)}</span></span>}
				actions={can('manager') && <button className="btn" onClick={() => { setForm({ name: c.name, tier: c.tier, domains: (c.domains || []).join(', '), accountOwner: c.account_owner || '', notes: c.notes || '' }); setEdit(true); }}><MdEdit /> Edit customer</button>}
			/>
			<div className="grid g-4 mb-16">
				<Kpi label="Health score" value={c.health_score ?? 'n/a'} accent={COLORS.purple} delta={c.health_trend || null} foot="vs 7 days ago" />
				<Kpi label="Open conversations" value={open.length} accent={COLORS.blue} foot={`${data.conversations.length} in total`} />
				<Kpi label="Open red" value={open.filter((x: any) => x.rag === 'red').length} accent={COLORS.red} />
				<Kpi label="Open actions" value={data.actions.length} accent={COLORS.general} foot={`${data.actions.filter((a: any) => a.due_date && new Date(a.due_date) < new Date()).length} overdue`} />
			</div>
			<div className="grid g-2 mb-16">
				<Card title="Health over time" accent={COLORS.purple}>
					{data.health.length > 1 ? (
						<Chart type="area" height={240}
							series={[{ name: 'Health', data: data.health.map((h: any) => h.health_score) }]}
							options={{ colors: [COLORS.purple], stroke: { curve: 'smooth', width: 2 }, fill: { type: 'solid', opacity: 0.12 }, yaxis: { min: 0, max: 100 }, xaxis: { categories: data.health.map((h: any) => fmtDate(h.day, 'd MMM')), tickAmount: 8 } }} />
					) : <Empty text="Not enough history yet" />}
				</Card>
				<Card title="Sentiment by week" accent={COLORS.teal}>
					{data.sentiment.length ? (
						<Chart type="bar" height={240}
							series={[{ name: 'Customer emails', data: data.sentiment.map((s: any) => s.n) }, { name: 'Negative', data: data.sentiment.map((s: any) => s.negative) }]}
							options={{ colors: [COLORS.teal, COLORS.red], plotOptions: { bar: { columnWidth: '55%', borderRadius: 3 } }, xaxis: { categories: data.sentiment.map((s: any) => fmtDate(s.bucket, 'd MMM')) } }} />
					) : <Empty text="No customer emails yet" />}
				</Card>
			</div>
			<div className="grid g-2-1">
				<Card title="Conversations" flush accent={COLORS.blue}>
					{data.conversations.map((x: any) => (
						<div key={x.id} className="list-item" onClick={() => nav(`/conversations/${x.id}`)}>
							<RagDot rag={x.rag} />
							<div className="grow">
								<div className="row-between"><span className="li-title truncate">{x.subject}</span><span className="small faint nowrap">{ago(x.last_message_at)}</span></div>
								<div className="small muted clamp-2">{x.summary}</div>
								<div className="row wrap gap-4 mt-8"><StatusBadge s={x.status} />{(x.categories || []).slice(0, 3).map((k: string) => <span key={k} className="chip">{catLabel(k)}</span>)}</div>
							</div>
						</div>
					))}
				</Card>
				<div className="col gap-16">
					<Card title="Recurring issues" accent={COLORS.amber}>
						{data.issues.length ? data.issues.map((i: any) => (
							<div key={i.category} className="row-between mb-8"><span>{catLabel(i.category)}</span><b>{i.n}</b></div>
						)) : <div className="faint small">None detected</div>}
					</Card>
					<Card title="Open actions" accent={COLORS.general}>
						{data.actions.length ? data.actions.map((a: any) => (
							<div key={a.id} className="small mb-8" style={{ cursor: 'pointer' }} onClick={() => nav(`/conversations/${a.conversation_id}`)}>
								{a.description}
								<div className="xs faint">{a.due_date ? `Due ${fmtDate(a.due_date)}` : 'No due date'} · {a.owner_side === 'us' ? 'owed by us' : 'customer'}</div>
							</div>
						)) : <div className="faint small">Nothing open</div>}
					</Card>
					<Card title="Contacts" accent={COLORS.navy}>
						{data.contacts.map((ct: any) => <div key={ct.email} className="small mb-8">{ct.name || ct.email} <span className="faint">{ct.email}</span></div>)}
					</Card>
					{c.notes && <Card title="Account notes"><div className="small" style={{ whiteSpace: 'pre-wrap' }}>{c.notes}</div></Card>}
				</div>
			</div>
			{edit && form && (
				<Modal title="Edit customer" onClose={() => setEdit(false)} footer={<><button className="btn" onClick={() => setEdit(false)}>Cancel</button><button className="btn primary" onClick={() => save.mutate()} disabled={save.isPending}>Save</button></>}>
					<div className="field"><label>Name</label><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
					<div className="field"><label>Tier</label>
						<select className="input" value={form.tier} onChange={(e) => setForm({ ...form, tier: e.target.value })}>
							<option value="strategic">Strategic</option><option value="key">Key</option><option value="standard">Standard</option>
						</select>
						<span className="hint">Strategic and key customers raise alerts sooner and rank higher in priority.</span>
					</div>
					<div className="field"><label>Email domains</label><input className="input" value={form.domains} onChange={(e) => setForm({ ...form, domains: e.target.value })} /><span className="hint">Comma separated. New emails from these domains are linked to this customer.</span></div>
					<div className="field"><label>Account owner</label><input className="input" value={form.accountOwner} onChange={(e) => setForm({ ...form, accountOwner: e.target.value })} /></div>
					<div className="field"><label>Notes</label><textarea className="input" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></div>
				</Modal>
			)}
		</>
	);
}
