import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { MdSearch, MdAttachFile, MdContentCopy, MdChevronLeft, MdChevronRight } from 'react-icons/md';
import { api, qs } from '../api/client';
import { useFilters } from '../contexts/FilterContext';
import FilterBar from '../components/FilterBar';
import { Card, Empty, Loader, PageHead, RagDot, SentimentBadge, StatusBadge, TierBadge, UrgencyBadge } from '../components/ui';
import { BUSINESS_COLORS, BUSINESS_SHORT, STAGE_LABELS, ago, catLabel, hoursSince } from '../lib/format';

const SORTS = [
	{ v: 'priority', l: 'Priority' },
	{ v: 'recent', l: 'Most recent' },
	{ v: 'oldest_waiting', l: 'Longest waiting' },
	{ v: 'risk', l: 'Escalation risk' },
	{ v: 'sentiment', l: 'Most negative' },
];

const AUDIENCES = [
	{ v: 'all', l: 'All email' },
	{ v: 'human', l: 'All except automated' },
	{ v: 'external', l: 'External (customers, prospects, vendors)' },
	{ v: 'customers', l: 'Customers only' },
	{ v: 'internal', l: 'Internal team' },
	{ v: 'automated', l: 'Automated and newsletters' },
];

export function ConversationList({ preset = {}, defaultSort = 'priority', showSearch = true, showAudience = false }: { preset?: Record<string, unknown>; defaultSort?: string; showSearch?: boolean; showAudience?: boolean }) {
	const { params } = useFilters();
	const nav = useNavigate();
	const [sp, setSp] = useSearchParams();
	const [q, setQ] = useState(sp.get('q') || '');
	const [sort, setSort] = useState(defaultSort);
	const [awaiting, setAwaiting] = useState(false);
	const [mine, setMine] = useState(false);
	const [page, setPage] = useState(0);
	const [audience, setAudience] = useState(sp.get('audience') || 'human');
	const limit = 40;
	useEffect(() => setQ(sp.get('q') || ''), [sp]);
	useEffect(() => setPage(0), [params, q, sort, awaiting, mine, audience]);

	const query = { ...params, audience: showAudience ? audience : undefined, ...preset, q: sp.get('q') || undefined, sort, awaiting: awaiting || undefined, assignee: mine ? 'me' : undefined, limit, offset: page * limit };
	const { data, isLoading } = useQuery({ queryKey: ['conversations', query], queryFn: () => api(`/conversations${qs(query)}`), refetchInterval: 30_000 });

	return (
		<>
			<div className="row-between wrap mb-16">
				{showSearch && (
					<form className="row" style={{ position: 'relative' }} onSubmit={(e) => { e.preventDefault(); setSp(q ? { q } : {}); }}>
						<MdSearch style={{ position: 'absolute', left: 10, color: 'var(--text-3)' }} />
						<input className="input" style={{ paddingLeft: 32, width: 320 }} placeholder="Search subject, summary, customer or email text" value={q} onChange={(e) => setQ(e.target.value)} />
						{sp.get('q') && <button type="button" className="btn ghost sm" onClick={() => { setQ(''); setSp({}); }}>Clear</button>}
					</form>
				)}
				<div className="row wrap">
					{showAudience && (
						<select className="input" style={{ width: 260 }} value={audience} onChange={(e) => setAudience(e.target.value)} aria-label="Which email">
							{AUDIENCES.map((a) => <option key={a.v} value={a.v}>{a.l}</option>)}
						</select>
					)}
					<label className="row small"><input type="checkbox" checked={awaiting} onChange={(e) => setAwaiting(e.target.checked)} style={{ accentColor: 'var(--pink)' }} /> Awaiting reply</label>
					<label className="row small"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} style={{ accentColor: 'var(--pink)' }} /> Assigned to me</label>
					<select className="input" style={{ width: 180 }} value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort">
						{SORTS.map((s) => <option key={s.v} value={s.v}>Sort: {s.l}</option>)}
					</select>
				</div>
			</div>
			<Card flush>
				{isLoading ? <Loader /> : !data?.rows?.length ? <Empty text="No conversations match these filters" /> : (
					<div className="table-wrap">
						<table className="table">
							<thead>
								<tr>
									<th style={{ width: 28 }} />
									<th>Customer and subject</th>
									<th>Summary</th>
									<th>Sentiment</th>
									<th>Status</th>
									<th className="num">Risk</th>
									<th>Last activity</th>
								</tr>
							</thead>
							<tbody>
								{data.rows.map((c: any) => (
									<tr key={c.id} className="click" onClick={() => nav(`/conversations/${c.id}`)}>
										<td><RagDot rag={c.rag} /></td>
										<td style={{ minWidth: 240, maxWidth: 320 }}>
											<div className="row" style={{ fontWeight: 700 }}>
												<span className="truncate">{c.customer_name || (c.is_automated ? 'Automated' : 'Internal')}</span> <TierBadge tier={c.customer_tier} />
											</div>
											<div className="row gap-4"><span className="chip" style={{ background: BUSINESS_COLORS[c.business_category] + '22', color: 'var(--text)' }}>{BUSINESS_SHORT[c.business_category] || 'Other'}</span>{c.proposal_stage && <span className="chip">{STAGE_LABELS[c.proposal_stage]}</span>}</div>
											<div className="truncate muted">{c.subject || '(no subject)'}</div>
											<div className="row wrap mt-8 gap-4">
												{(c.categories || []).slice(0, 3).map((x: string) => <span key={x} className="chip">{catLabel(x)}</span>)}
											</div>
										</td>
										<td style={{ maxWidth: 420 }}>
											<div className="small clamp-2 muted">{c.summary || <span className="faint">Analysis pending</span>}</div>
											<div className="row wrap mt-8 gap-4">
												<UrgencyBadge u={c.urgency} />
												{c.awaiting_reply && c.status !== 'resolved' && <span className="badge amber">Awaiting reply {Math.round(hoursSince(c.last_inbound_at))}h</span>}
												{c.open_actions > 0 && <span className="badge blue">{c.open_actions} action{c.open_actions > 1 ? 's' : ''}</span>}
											</div>
										</td>
										<td><SentimentBadge s={c.sentiment} score={c.sentiment_score} /></td>
										<td>
											<StatusBadge s={c.status} />
											{c.assignee_name && <div className="xs faint mt-8">{c.assignee_name}</div>}
										</td>
										<td className="num"><b>{c.escalation_risk ?? '–'}</b></td>
										<td className="nowrap small">
											{ago(c.last_message_at)}
											<div className="xs faint row gap-4">
												{c.message_count} msg{c.message_count > 1 ? 's' : ''}
												{c.duplicate_count > 0 && <span title="Duplicates removed"><MdContentCopy /> {c.duplicate_count}</span>}
												{c.has_attachments && <MdAttachFile />}
											</div>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
				{data?.total > limit && (
					<div className="row-between" style={{ padding: '12px 20px', borderTop: '1px solid var(--border-2)' }}>
						<span className="small faint">{page * limit + 1}–{Math.min((page + 1) * limit, data.total)} of {data.total}</span>
						<div className="row">
							<button className="btn sm" disabled={page === 0} onClick={() => setPage(page - 1)}><MdChevronLeft /> Previous</button>
							<button className="btn sm" disabled={(page + 1) * limit >= data.total} onClick={() => setPage(page + 1)}>Next <MdChevronRight /></button>
						</div>
					</div>
				)}
			</Card>
		</>
	);
}

/** One "Email" area: by category, needs attention, and every thread. */
export function EmailTabs() {
	const loc = useLocation();
	const nav = useNavigate();
	const tabs = [
		{ path: '/all-email', label: 'By category' },
		{ path: '/critical', label: 'Needs attention' },
		{ path: '/conversations', label: 'All threads' },
	];
	return (
		<div className="tabs">
			{tabs.map((t) => <button key={t.path} className={loc.pathname === t.path ? 'on' : ''} onClick={() => nav(t.path)}>{t.label}</button>)}
		</div>
	);
}

export default function Conversations() {
	return (
		<>
			<PageHead kw="Email" rest="threads" sub="Every thread, of every type. Threads are rebuilt across mailboxes and duplicates are removed before analysis." />
			<EmailTabs />
			<FilterBar show={['type', 'customer', 'mailbox', 'sentiment', 'rag', 'status', 'category', 'tier']} />
			<ConversationList showAudience />
		</>
	);
}

export function CriticalIssues() {
	return (
		<>
			<PageHead kw="Email" rest="that needs attention" sub="Open red and amber threads ranked by priority: rating, escalation risk, customer tier, urgency and time waiting." />
			<EmailTabs />
			<FilterBar show={['customer', 'mailbox', 'category', 'tier']} />
			<ConversationList preset={{ rag: ['red', 'amber'], status: ['open', 'in_progress'] }} />
		</>
	);
}
