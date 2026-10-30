import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { MdCheckCircle, MdRadioButtonUnchecked, MdEvent, MdMarkEmailUnread, MdWarningAmber, MdRequestQuote, MdForum } from 'react-icons/md';
import { api, getToken } from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import { Card, Empty, Kpi, Loader, PageHead, RagDot, TierBadge } from '../components/ui';
import { BUSINESS_SHORT, COLORS, STAGE_LABELS, ago, fmtDate, hoursSince } from '../lib/format';

export async function downloadIcs(id: number) {
	const res = await fetch(`/api/actions/${id}/ics`, { headers: { authorization: `Bearer ${getToken()}` } });
	const a = document.createElement('a');
	a.href = URL.createObjectURL(await res.blob());
	a.download = `remail-action-${id}.ics`;
	a.click();
}

export default function MyDay() {
	const { user } = useAuth();
	const nav = useNavigate();
	const qc = useQueryClient();
	const { data, isLoading } = useQuery({ queryKey: ['my-day'], queryFn: () => api('/views/my-day'), refetchInterval: 60_000 });
	const done = useMutation({
		mutationFn: (id: number) => api(`/actions/${id}`, { method: 'PATCH', body: { status: 'done' } }),
		onSuccess: () => qc.invalidateQueries({ queryKey: ['my-day'] }),
	});
	const hour = new Date().getHours();
	const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
	const today = new Date().toISOString().slice(0, 10);
	if (isLoading || !data) return <Loader />;
	const s = data.stats;
	return (
		<>
			<PageHead kw={greet} rest={(user?.fullName || '').split(' ')[0]}
				sub="Everything waiting on you across your email: replies owed, promises made, proposals due." />
			<div className="grid g-6 mb-16">
				<Kpi label="Waiting for my reply" value={s.awaiting} icon={<MdMarkEmailUnread />} accent={COLORS.pink} foot={`${s.sla_breaches} beyond ${data.slaHours}h`} />
				<Kpi label="Overdue actions" value={s.actionsOverdue} icon={<MdWarningAmber />} accent={COLORS.red} />
				<Kpi label="Due today" value={s.actionsToday} icon={<MdEvent />} accent={COLORS.amber} />
				<Kpi label="My open actions" value={s.actionsOpen} accent={COLORS.general} onClick={() => nav('/actions')} />
				<Kpi label="Open proposals" value={data.proposals.length} icon={<MdRequestQuote />} accent={COLORS.purple} onClick={() => nav('/proposals')} />
				<Kpi label="My threads (24h)" value={s.last_24h} icon={<MdForum />} accent={COLORS.teal} foot={`${s.conversations} in 90 days · ${s.red} red`} />
			</div>
			<div className="grid g-2 mb-16">
				<Card title={<h2><span className="kw">Waiting</span> for my reply</h2>} sub="Highest priority first" accent={COLORS.pink} flush>
					{data.awaiting.length ? data.awaiting.slice(0, 10).map((c: any) => (
						<div key={c.id} className="list-item" onClick={() => nav(`/conversations/${c.id}`)}>
							<RagDot rag={c.rag} />
							<div className="grow">
								<div className="row-between"><span className="li-title truncate">{c.customer_name || 'Internal'} <TierBadge tier={c.customer_tier} /></span>
									<span className={`badge ${hoursSince(c.last_inbound_at) > data.slaHours ? 'red' : 'amber'}`}>{Math.round(hoursSince(c.last_inbound_at))}h</span></div>
								<div className="truncate muted">{c.subject}</div>
								<div className="small faint clamp-2">{c.summary}</div>
								<div className="row gap-4 mt-8"><span className="chip">{BUSINESS_SHORT[c.business_category]}</span></div>
							</div>
						</div>
					)) : <Empty text="Inbox zero. Nothing is waiting on you." />}
					{data.awaiting.length > 10 && <div className="list-item" style={{ justifyContent: 'center' }} onClick={() => nav('/conversations?audience=all')}><b className="kw">View all {data.awaiting.length} waiting</b></div>}
				</Card>
				<Card title={<h2><span className="kw">My</span> actions and commitments</h2>} sub="Tick them off as you deliver" accent={COLORS.general} flush>
					{data.actions.length ? data.actions.slice(0, 12).map((a: any) => {
						const late = a.due_date && a.due_date < today;
						return (
							<div key={a.id} className="list-item" style={{ cursor: 'default' }}>
								<button className="btn ghost icon" style={{ padding: 2, alignSelf: 'flex-start' }} onClick={() => done.mutate(a.id)} aria-label="Mark done">
									{done.isPending && done.variables === a.id ? <MdCheckCircle style={{ color: COLORS.green, fontSize: 20 }} /> : <MdRadioButtonUnchecked style={{ fontSize: 20, color: 'var(--text-3)' }} />}
								</button>
								<div className="grow">
									<div>{a.description}</div>
									<div className="row wrap gap-4 mt-8">
										{a.due_date && <span className={`badge ${late ? 'red' : a.due_date === today ? 'amber' : ''}`}>{late ? 'Overdue ' : 'Due '}{fmtDate(a.due_date, 'd MMM')}</span>}
										{a.is_commitment && <span className="badge teal">Commitment</span>}
										{a.customer_name && <span className="chip">{a.customer_name}</span>}
										{a.conversation_id && <a className="xs" onClick={() => nav(`/conversations/${a.conversation_id}`)} style={{ cursor: 'pointer' }}>Open thread</a>}
										<a className="xs" style={{ cursor: 'pointer' }} onClick={() => downloadIcs(a.id)}>Add to Outlook</a>
									</div>
								</div>
							</div>
						);
					}) : <Empty text="No open actions" />}
					{data.actions.length > 12 && <div className="list-item" style={{ justifyContent: 'center' }} onClick={() => nav('/actions')}><b className="kw">View all {data.actions.length} actions</b></div>}
				</Card>
			</div>
			<div className="grid g-2">
				<Card title="My proposals and quotes" accent={COLORS.purple} flush actions={<button className="btn sm" onClick={() => nav('/proposals')}>Pipeline</button>}>
					{data.proposals.length ? data.proposals.map((p: any) => (
						<div key={p.id} className="list-item" onClick={() => nav(`/conversations/${p.id}`)}>
							<div className="grow">
								<div className="row-between"><span className="li-title truncate">{p.customer_name || 'Prospect'}</span><span className="badge purple">{STAGE_LABELS[p.proposal_stage] || 'Open'}</span></div>
								<div className="truncate muted">{p.subject}</div>
								<div className="xs faint">{p.proposal?.deadline ? `Deadline ${fmtDate(p.proposal.deadline)}` : 'No deadline found'}{p.proposal?.next_step ? ` · Next: ${p.proposal.next_step}` : ''}</div>
							</div>
						</div>
					)) : <Empty text="No open proposals" />}
				</Card>
				<Card title="My recent threads" accent={COLORS.teal} flush>
					{data.recent.length ? data.recent.map((c: any) => (
						<div key={c.id} className="list-item" onClick={() => nav(`/conversations/${c.id}`)}>
							<RagDot rag={c.rag} />
							<div className="grow">
								<div className="row-between"><span className="li-title truncate">{c.customer_name || 'Internal'} · {c.subject}</span><span className="small faint nowrap">{ago(c.last_message_at)}</span></div>
								<div className="small faint clamp-2">{c.summary}</div>
							</div>
							<span className="chip" style={{ alignSelf: 'flex-start' }}>{BUSINESS_SHORT[c.business_category]}</span>
						</div>
					)) : <Empty text="Connect your mailbox under Mailboxes to see your own email here." />}
				</Card>
			</div>
		</>
	);
}
