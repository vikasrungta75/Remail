import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, qs } from '../api/client';
import { useFilters } from '../contexts/FilterContext';
import { useAuth } from '../contexts/AuthContext';
import FilterBar from '../components/FilterBar';
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
	const { data, isLoading } = useQuery({ queryKey: ['proposals', params], queryFn: () => api(`/views/proposals${qs({ ...params, from: new Date(Date.now() - 180 * 86400_000).toISOString() })}`) });
	const move = useMutation({
		mutationFn: (b: { id: number; stage: string }) => api(`/conversations/${b.id}`, { method: 'PATCH', body: { proposalStage: b.stage } }),
		onSuccess: () => qc.invalidateQueries({ queryKey: ['proposals'] }),
	});
	const rows = data?.rows || [];
	const today = new Date().toISOString().slice(0, 10);
	const dueSoon = rows.filter((r: any) => r.proposal?.deadline && r.proposal.deadline >= today && !['won', 'lost'].includes(r.stage) && (new Date(r.proposal.deadline).getTime() - Date.now()) < 7 * 86400_000).length;
	const won = rows.filter((r: any) => r.stage === 'won').length;
	const lost = rows.filter((r: any) => r.stage === 'lost').length;

	return (
		<>
			<PageHead kw="Proposals" rest="and quotes"
				sub="RFQs, rate requests, tenders and contract renewals detected in email, tracked from request to decision. Change the stage on any card when it moves." />
			<FilterBar show={['customer', 'mailbox']} />
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
							<div key={st} style={{ background: '#ECEEF5', borderRadius: 14, padding: 10, minHeight: 200 }}>
								<div className="row-between" style={{ padding: '4px 6px 10px' }}>
									<b className="row"><span className="rag-dot" style={{ background: STAGE_COLORS[st] }} />{STAGE_LABELS[st]}</b>
									<span className="badge">{items.length}</span>
								</div>
								<div className="col gap-8">
									{items.map((r: any) => {
										const late = r.proposal?.deadline && r.proposal.deadline < today && !['won', 'lost'].includes(st);
										return (
											<div key={r.id} className="card accent" style={{ '--accent': STAGE_COLORS[st], padding: 12 } as any}>
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
