import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { MdForum, MdErrorOutline, MdSentimentDissatisfied, MdPersonSearch, MdTimer, MdChecklist, MdSync, MdDownload, MdContentCopy } from 'react-icons/md';
import { api, qs, getToken } from '../api/client';
import { useFilters } from '../contexts/FilterContext';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import FilterBar from '../components/FilterBar';
import Chart from '../components/Chart';
import { Card, Empty, Health, Kpi, Loader, PageHead, RagDot, TierBadge, StateBadge, UrgencyBadge } from '../components/ui';
import { COLORS, ago, catLabel, minutes, pct, hoursSince, fmtDate } from '../lib/format';

export default function Overview() {
	const { params } = useFilters();
	const { can } = useAuth();
	const nav = useNavigate();
	const toast = useToast();
	const qc = useQueryClient();
	const summary = useQuery({ queryKey: ['summary', params], queryFn: () => api(`/dashboard/summary${qs(params)}`), refetchInterval: 30_000 });
	const trends = useQuery({ queryKey: ['trends', params], queryFn: () => api(`/dashboard/trends${qs(params)}`), refetchInterval: 60_000 });
	const customers = useQuery({ queryKey: ['customers', params], queryFn: () => api(`/customers${qs(params)}`), refetchInterval: 60_000 });
	const sync = useMutation({
		mutationFn: () => api('/system/run', { body: {} }),
		onSuccess: (r) => {
			toast(r.queued ? 'Sync started. New emails will appear in a few minutes.' : 'Sync and analysis complete');
			qc.invalidateQueries();
		},
		onError: (e: any) => toast(e.message, 'error'),
	});

	const s = summary.data;
	const t = trends.data;
	const k = s?.kpis;
	const p = s?.previous;

	const exportCsv = async () => {
		const res = await fetch(`/api/conversations/export${qs(params)}`, { headers: { authorization: `Bearer ${getToken()}` } });
		const blob = await res.blob();
		const a = document.createElement('a');
		a.href = URL.createObjectURL(blob);
		a.download = `remail-conversations-${new Date().toISOString().slice(0, 10)}.csv`;
		a.click();
	};

	const fmtBucket = (b: string) => fmtDate(b, t?.bucket === 'day' ? 'd MMM' : t?.bucket === 'week' ? "'w/c' d MMM" : 'MMM yyyy');

	return (
		<>
			<PageHead
				kw="Customer"
				rest="communication health"
				sub={s ? <>Live view of {k?.emails ?? 0} emails across {s.sync?.mailboxes ?? 0} mailboxes · updated {ago(summary.dataUpdatedAt ? new Date(summary.dataUpdatedAt) : null)}</> : 'Loading the latest picture…'}
				actions={
					<>
						{can('analyst') && <button className="btn" onClick={exportCsv}><MdDownload /> Export</button>}
						{can('manager') && <button className="btn primary" onClick={() => sync.mutate()} disabled={sync.isPending}><MdSync /> {sync.isPending ? 'Syncing…' : 'Sync now'}</button>}
					</>
				}
			/>
			<FilterBar />

			{!s ? <Loader /> : (
				<>
					<div className="grid g-6 mb-16">
						<Kpi label="Conversations" icon={<MdForum />} value={k.conversations} delta={k.conversations - p.conversations} accent={COLORS.blue}
							foot={<span>{k.emails} emails · {k.duplicates} duplicates removed</span>} onClick={() => nav('/conversations')} />
						<Kpi label="Red issues" icon={<MdErrorOutline />} value={k.red} delta={k.red - p.red} invert accent={COLORS.pink}
							foot={<span>{k.amber} amber · {k.green} green</span>} onClick={() => nav('/critical')} />
						<Kpi label="Negative sentiment" icon={<MdSentimentDissatisfied />} value={`${pct(k.negative, k.conversations)}%`}
							delta={pct(k.negative, k.conversations) - pct(p.negative, p.conversations)} invert accent={COLORS.amber}
							foot={<span>{k.negative} of {k.conversations} conversations</span>} />
						<Kpi label="At-risk customers" icon={<MdPersonSearch />} value={(s.customers?.at_risk || 0) + (s.customers?.dissatisfied || 0)} accent={COLORS.purple}
							foot={<span>{s.customers?.dissatisfied || 0} dissatisfied · avg health {s.customers?.avg_health ?? 'n/a'}</span>} onClick={() => nav('/customers')} />
						<Kpi label="Avg first response" icon={<MdTimer />} value={minutes(k.avg_first_response_min)} accent={COLORS.teal}
							delta={k.avg_first_response_min != null && p.avg_first_response_min != null ? k.avg_first_response_min - p.avg_first_response_min : null} invert
							foot={<span className={k.sla_breaches ? 'up-bad' : ''}>{k.awaiting} awaiting · {k.sla_breaches} beyond {s.slaHours}h SLA</span>} />
						<Kpi label="Open commitments" icon={<MdChecklist />} value={s.actions?.open || 0} accent={COLORS.general}
							foot={<span className={s.actions?.overdue ? 'up-bad' : ''}>{s.actions?.overdue || 0} overdue · {s.actions?.commitments || 0} promised by us</span>} onClick={() => nav('/actions')} />
					</div>

					<div className="grid g-2-1 mb-16">
						<Card title="Sentiment trend" sub="Customer emails by sentiment" accent={COLORS.teal}>
							{t?.sentiment?.length ? (
								<Chart
									type="bar"
									height={290}
									series={[
										{ name: 'Negative', data: t.sentiment.map((r: any) => r.negative) },
										{ name: 'Neutral', data: t.sentiment.map((r: any) => r.neutral) },
										{ name: 'Positive', data: t.sentiment.map((r: any) => r.positive) },
									]}
									options={{
										chart: { stacked: true },
										colors: [COLORS.red, '#C9CDE0', COLORS.green],
										plotOptions: { bar: { columnWidth: '62%', borderRadius: 3 } },
										xaxis: { categories: t.sentiment.map((r: any) => fmtBucket(r.bucket)), tickAmount: 10 },
									}}
								/>
							) : <Empty text="No customer emails in this period" />}
						</Card>
						<Card title="Traffic light status" sub="Conversations by rating" accent={COLORS.pink}>
							{k.conversations ? (
								<>
									<Chart
										type="donut"
										height={220}
										series={[k.red, k.amber, k.green]}
										options={{
											labels: ['Red', 'Amber', 'Green'],
											colors: [COLORS.red, COLORS.amber, COLORS.green],
											legend: { position: 'bottom' },
											plotOptions: { pie: { donut: { size: '68%', labels: { show: true, total: { show: true, label: 'Conversations', fontWeight: 600 } } } } },
											chart: { events: { dataPointSelection: () => nav('/conversations') } },
										}}
									/>
									<div className="grid g-3 mt-8" style={{ textAlign: 'center' }}>
										<div><div className="faint small">Satisfied</div><b>{s.customers?.satisfied || 0}</b></div>
										<div><div className="faint small">At risk</div><b style={{ color: COLORS.amber }}>{s.customers?.at_risk || 0}</b></div>
										<div><div className="faint small">Dissatisfied</div><b style={{ color: COLORS.red }}>{s.customers?.dissatisfied || 0}</b></div>
									</div>
								</>
							) : <Empty text="Nothing to rate yet" />}
						</Card>
					</div>

					<div className="grid g-2-1 mb-16">
						<Card title={<h2><span className="kw">Critical</span> issues requiring attention</h2>} sub="Open red and amber conversations, highest priority first" accent={COLORS.pink}
							actions={<button className="btn sm" onClick={() => nav('/critical')}>View all</button>} flush>
							{s.critical.length ? s.critical.map((c: any) => (
								<div key={c.id} className="list-item" onClick={() => nav(`/conversations/${c.id}`)}>
									<RagDot rag={c.rag} />
									<div className="grow">
										<div className="row-between">
											<div className="li-title truncate">{c.customer_name || 'Unknown customer'} <TierBadge tier={c.customer_tier} /></div>
											<span className="faint small nowrap">{ago(c.last_message_at)}</span>
										</div>
										<div className="truncate" style={{ color: 'var(--text-2)' }}>{c.subject}</div>
										<div className="small faint clamp-2" style={{ marginTop: 2 }}>{c.summary}</div>
										<div className="row wrap mt-8">
											<UrgencyBadge u={c.urgency} />
											{c.awaiting_reply && <span className={`badge ${hoursSince(c.last_inbound_at) > s.slaHours ? 'red' : 'amber'}`}>Awaiting reply {Math.round(hoursSince(c.last_inbound_at))}h</span>}
											{(c.categories || []).slice(0, 3).map((x: string) => <span key={x} className="chip">{catLabel(x)}</span>)}
										</div>
									</div>
									<div style={{ textAlign: 'right' }}>
										<div className="faint xs">Priority</div>
										<div style={{ fontFamily: 'var(--font-head)', fontWeight: 800, fontSize: 18 }}>{c.priority_score}</div>
									</div>
								</div>
							)) : <Empty text="No open red or amber conversations. Nice." />}
						</Card>
						<Card title="Customer health watchlist" sub="Lowest health first" accent={COLORS.purple} flush
							actions={<button className="btn sm" onClick={() => nav('/customers')}>All customers</button>}>
							{customers.data?.rows?.length ? customers.data.rows.slice(0, 8).map((c: any) => (
								<div key={c.id} className="list-item" onClick={() => nav(`/customers/${c.id}`)}>
									<div className="grow">
										<div className="row-between">
											<span className="li-title truncate">{c.name}</span>
											<StateBadge s={c.health_status} />
										</div>
										<div className="row mt-8">
											<div className="grow"><Health score={c.health_score} /></div>
											<span className="small faint nowrap">{c.red ? <span style={{ color: COLORS.red }}>{c.red} red</span> : null}{c.red && c.amber ? ' · ' : ''}{c.amber ? `${c.amber} amber` : ''}</span>
										</div>
									</div>
								</div>
							)) : <Empty text="No customers yet" />}
						</Card>
					</div>

					<div className="grid g-3">
						<Card title="Top issue types" sub="Detected across conversations" accent={COLORS.amber}>
							{t?.categories?.length ? (
								<Chart
									type="bar"
									height={300}
									series={[{ name: 'Issues', data: t.categories.slice(0, 8).map((c: any) => c.count) }, { name: 'High severity', data: t.categories.slice(0, 8).map((c: any) => c.severe) }]}
									options={{
										plotOptions: { bar: { horizontal: true, barHeight: '70%', borderRadius: 3 } },
										colors: [COLORS.amber, COLORS.red],
										xaxis: { categories: t.categories.slice(0, 8).map((c: any) => catLabel(c.category)) },
										yaxis: { labels: { maxWidth: 170 } },
									}}
								/>
							) : <Empty text="No issues detected" />}
						</Card>
						<Card title="Mailbox volume" sub="Emails and duplicates removed" accent={COLORS.general}>
							{t?.mailboxes?.length ? (
								<Chart
									type="bar"
									height={300}
									series={[
										{ name: 'Unique', data: t.mailboxes.map((m: any) => m.emails - m.duplicates) },
										{ name: 'Duplicates', data: t.mailboxes.map((m: any) => m.duplicates) },
									]}
									options={{
										chart: { stacked: true },
										colors: [COLORS.general, '#C9CDE0'],
										plotOptions: { bar: { columnWidth: '55%', borderRadius: 3 } },
										xaxis: { categories: t.mailboxes.map((m: any) => m.display_name || m.address) },
									}}
								/>
							) : <Empty text="No mailbox activity" icon={<MdContentCopy />} />}
						</Card>
						<Card title="Satisfaction trend" sub="Average customer health score" accent={COLORS.green}>
							{t?.health?.length ? (
								<Chart
									type="line"
									height={300}
									series={[
										{ name: 'Average health', type: 'area', data: t.health.map((h: any) => h.avg_health) },
										{ name: 'Customers below 55', type: 'column', data: t.health.map((h: any) => h.at_risk) },
									]}
									options={{
										colors: [COLORS.green, COLORS.amber],
										stroke: { curve: 'smooth', width: [2, 0] },
										fill: { type: 'solid', opacity: [0.14, 0.85] },
										plotOptions: { bar: { columnWidth: '50%', borderRadius: 2 } },
										xaxis: { categories: t.health.map((h: any) => fmtBucket(h.bucket)), tickAmount: 6 },
										yaxis: [{ min: 0, max: 100, title: { text: 'Health' } }, { opposite: true, min: 0, forceNiceScale: true, title: { text: 'At risk' } }],
									}}
								/>
							) : <Empty text="Health history builds up daily" />}
						</Card>
					</div>
				</>
			)}
		</>
	);
}
