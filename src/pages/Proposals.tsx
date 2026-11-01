import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, qs } from '../api/client';
import { useFilters } from '../contexts/FilterContext';
import { useAuth } from '../contexts/AuthContext';
import { useFilterOptions } from '../components/FilterBar';
import { Drop, FilterStrip, countLabel } from '../components/FilterStrip';
import { Kpi, Loader, PageHead, TierBadge } from '../components/ui';
import { COLORS, KIND_LABELS, STAGE_LABELS, ago, fmtDate } from '../lib/format';

const STAGES = ['request_received', 'in_preparation', 'submitted', 'negotiation', 'won', 'lost', 'no_response'];
const STAGE_COLORS: Record<string, string> = {
	request_received: COLORS.blue, in_preparation: COLORS.amber, submitted: COLORS.purple, negotiation: COLORS.pink,
	won: COLORS.green, lost: '#8A90A8', no_response: '#C9CDE0',
};

export default function Proposals() {
	const { params } = useFilters();
	const { can } = useAuth();
	const nav = useNavigate();
	const qc = useQueryClient();
	const { data, isLoading } = useQuery({ queryKey: ['proposals', params.view], queryFn: () => api(`/views/proposals${qs({ view: params.view, from: new Date(Date.now() - 180 * 86400_000).toISOString() })}`) });
	const move = useMutation({
		mutationFn: (b: { id: number; stage: string }) => api(`/conversations/${b.id}`, { method: 'PATCH', body: { proposalStage: b.stage } }),
		onSuccess: () => qc.invalidateQueries({ queryKey: ['proposals'] }),
	});
	const opts = useFilterOptions();
	const EMPTYF = { q: '', days: '', kind: '', deadline: '', waiting: '', rag: '', mailbox: '' };
	const [pf, setPf] = useState(EMPTYF);
	const today0 = new Date().toISOString().slice(0, 10);
	const in7 = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10);
	const all: any[] = data?.rows || [];
	const kinds = [...new Set(all.map((r) => r.proposal?.kind).filter(Boolean))] as string[];
	const dl = (r: any) => r.proposal?.deadline as string | undefined;
	const match = (r: any, skip?: string) =>
		(skip === 'days' || !pf.days || Date.now() - new Date(r.last_message_at).getTime() < Number(pf.days) * 86400_000) &&
		(skip === 'kind' || !pf.kind || r.proposal?.kind === pf.kind) &&
		(skip === 'deadline' || !pf.deadline || (pf.deadline === 'overdue' ? !!dl(r) && dl(r)! < today0 && !['won', 'lost'].includes(r.stage) : pf.deadline === 'week' ? !!dl(r) && dl(r)! >= today0 && dl(r)! <= in7 : !dl(r))) &&
		(skip === 'waiting' || !pf.waiting || (pf.waiting === 'yes' ? r.awaiting_reply : !r.awaiting_reply)) &&
		(skip === 'rag' || !pf.rag || r.rag === pf.rag) &&
		(skip === 'mailbox' || !pf.mailbox || (r.mailbox_ids || []).map(String).includes(pf.mailbox)) &&
		(!pf.q || `${r.customer_name || ''} ${r.subject || ''} ${r.summary || ''} ${r.proposal?.value || ''} ${r.proposal?.lanes_or_scope || ''}`.toLowerCase().includes(pf.q.toLowerCase()));
	const cnt = (skip: string, t: (r: any) => boolean) => all.filter((r) => match(r, skip) && t(r)).length;
	const rows = all.filter((r) => match(r));
	const today = new Date().toISOString().slice(0, 10);
	const dueSoon = rows.filter((r: any) => r.proposal?.deadline && r.proposal.deadline >= today && !['won', 'lost'].includes(r.stage) && (new Date(r.proposal.deadline).getTime() - Date.now()) < 7 * 86400_000).length;
	const won = rows.filter((r: any) => r.stage === 'won').length;
	const lost = rows.filter((r: any) => r.stage === 'lost').length;

	return (
		<>
			<PageHead kw="Proposals" rest="and quotes"
				sub="Quote requests, RFPs and tenders, new lanes and contract renewals detected in email, tracked from request to decision. Change the stage on any card when it moves." />
			<FilterStrip search={pf.q} onSearch={(q) => setPf({ ...pf, q })} placeholder="Search name, subject, lane or value" active={Object.values(pf).filter(Boolean).length} onClear={() => setPf(EMPTYF)}>
				<Drop label="Received" value={pf.days} onChange={(v) => setPf({ ...pf, days: v })} options={[['', 'Last 6 months'], ['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days']]} />
				<Drop label="Type" value={pf.kind} onChange={(v) => setPf({ ...pf, kind: v })} options={[['', 'Any type'], ...kinds.map((k) => [k, `${k.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())}${countLabel(cnt('kind', (r) => r.proposal?.kind === k))}`] as [string, string])]} />
				<Drop label="Deadline" value={pf.deadline} onChange={(v) => setPf({ ...pf, deadline: v })} options={[['', 'Any deadline'], ['overdue', `Overdue${countLabel(cnt('deadline', (r) => !!dl(r) && dl(r)! < today0 && !['won', 'lost'].includes(r.stage)))}`], ['week', `Next 7 days${countLabel(cnt('deadline', (r) => !!dl(r) && dl(r)! >= today0 && dl(r)! <= in7))}`], ['none', 'No deadline']]} />
				<Drop label="Waiting" value={pf.waiting} onChange={(v) => setPf({ ...pf, waiting: v })} options={[['', 'Waiting or not'], ['yes', `Waiting for us${countLabel(cnt('waiting', (r) => r.awaiting_reply))}`], ['no', 'Not waiting']]} />
				<Drop label="Rating" value={pf.rag} onChange={(v) => setPf({ ...pf, rag: v })} options={[['', 'Any rating'], ['red', `Red${countLabel(cnt('rag', (r) => r.rag === 'red'))}`], ['amber', `Amber${countLabel(cnt('rag', (r) => r.rag === 'amber'))}`], ['green', `Green${countLabel(cnt('rag', (r) => r.rag === 'green'))}`]]} />
				<Drop label="Mailbox" value={pf.mailbox} onChange={(v) => setPf({ ...pf, mailbox: v })} options={[['', 'All mailboxes'], ...(opts.data?.mailboxes || []).map((m: any) => [String(m.id), m.address] as [string, string])]} />
			</FilterStrip>
			<div className="grid g-4 mb-16">
				<Kpi label="Open opportunities" value={rows.filter((r: any) => !['won', 'lost', 'no_response'].includes(r.stage)).length} accent={COLORS.purple} />
				<Kpi label="Deadlines in 7 days" value={dueSoon} accent={COLORS.pink} />
				<Kpi label="Won" value={won} accent={COLORS.green} foot={won + lost ? `${Math.round((won / (won + lost)) * 100)}% win rate` : undefined} />
				<Kpi label="Awaiting our response" value={rows.filter((r: any) => r.awaiting_reply).length} accent={COLORS.amber} />
			</div>
			{isLoading ? <Loader /> : (
				<div style={{ display: 'grid', gridTemplateColumns: `repeat(${STAGES.length}, minmax(220px, 1fr))`, gap: 12, overflowX: 'auto', paddingBottom: 8 }}>
					{STAGES.map((st) => {
						const items = rows.filter((r: any) => r.stage === st);
						return (
							<div key={st} className="kanban-col">
								<div className="row-between" style={{ padding: '4px 6px 10px' }}>
									<b className="row"><span className="rag-dot" style={{ background: STAGE_COLORS[st] }} />{STAGE_LABELS[st]}</b>
									<span className="badge">{items.length}</span>
								</div>
								<div className="col gap-8">
									{items.map((r: any) => {
										const late = r.proposal?.deadline && r.proposal.deadline < today && !['won', 'lost'].includes(st);
										return (
											<div key={r.id} className="card kanban-card" style={{ borderLeftColor: STAGE_COLORS[st] }}>
												<div className="cursor" onClick={() => nav(`/conversations/${r.id}`)}>
													<div className="row" style={{ fontWeight: 700 }}><span className="truncate">{r.customer_name || 'Unknown'}</span> <TierBadge tier={r.customer_tier} /></div>
													<div className="small muted clamp-2">{r.subject}</div>
													{r.proposal?.lanes_or_scope && <div className="xs faint truncate">{r.proposal.lanes_or_scope}</div>}
													<div className="row wrap gap-4 mt-8">
														{r.proposal?.kind && <span className="chip">{String(r.proposal.kind).replace(/_/g, ' ').toUpperCase().length <= 4 ? String(r.proposal.kind).toUpperCase() : String(r.proposal.kind).replace(/_/g, ' ')}</span>}
														{r.proposal?.value && <span className="chip">{r.proposal.value}</span>}
														{r.proposal?.deadline && <span className={`badge ${late ? 'red' : ''}`}>Due {fmtDate(r.proposal.deadline, 'd MMM')}</span>}
														{r.awaiting_reply && <span className="badge amber">Reply owed</span>}
													</div>
													{r.proposal?.next_step && <div className="xs mt-8">Next: {r.proposal.next_step}</div>}
													<div className="xs faint mt-8">{r.assignee_name ? `${r.assignee_name} · ` : ''}{ago(r.last_message_at)}</div>
												</div>
												{can('analyst') && (
													<select className="input mt-8" style={{ padding: '4px 8px', fontSize: 12 }} value={st} onChange={(e) => move.mutate({ id: r.id, stage: e.target.value })} aria-label="Stage">
														{STAGES.map((x) => <option key={x} value={x}>{STAGE_LABELS[x]}</option>)}
													</select>
												)}
											</div>
										);
									})}
								</div>
							</div>
						);
					})}
				</div>
			)}
			<p className="xs faint mt-16">Prospects are organisations that have only sent requests for quotes so far. {KIND_LABELS.prospect} and customer records are kept separately under Customers and accounts.</p>
		</>
	);
}
