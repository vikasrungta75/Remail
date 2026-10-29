import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { MdTrendingUp, MdTrendingDown, MdRepeat, MdNewReleases } from 'react-icons/md';
import { api, qs } from '../api/client';
import { useFilters } from '../contexts/FilterContext';
import FilterBar from '../components/FilterBar';
import Chart from '../components/Chart';
import { Card, Empty, Health, Loader, PageHead, StateBadge, TierBadge } from '../components/ui';
import { COLORS, CATEGORY_LABELS, ago, catLabel, fmtDate } from '../lib/format';

export default function Insights() {
	const { params, set } = useFilters();
	const nav = useNavigate();
	const { data, isLoading } = useQuery({ queryKey: ['insights', params], queryFn: () => api(`/insights${qs(params)}`) });
	const trends = useQuery({ queryKey: ['trends', params], queryFn: () => api(`/dashboard/trends${qs(params)}`) });

	if (isLoading || !data) return (<><PageHead kw="Trends" rest="and insights" /><FilterBar /><Loader /></>);

	// heatmap: category x week
	const weeks = [...new Set(data.heat.map((h: any) => h.week))].sort() as string[];
	const cats = [...new Set(data.heat.map((h: any) => h.category))] as string[];
	const heatSeries = cats.map((c) => ({
		name: catLabel(c),
		data: weeks.map((w) => ({ x: fmtDate(w, 'd MMM'), y: data.heat.find((h: any) => h.week === w && h.category === c)?.n || 0 })),
	}));

	return (
		<>
			<PageHead kw="Trends" rest="and insights" sub="Recurring problems, emerging topics and how issue volumes are changing versus the previous period." />
			<FilterBar show={['customer', 'mailbox', 'sentiment', 'rag', 'tier']} />

			<div className="grid g-2 mb-16">
				<Card title="Issue types: this period vs previous" accent={COLORS.amber}>
					{data.categoryChange.length ? (
						<div className="table-wrap">
							<table className="table">
								<thead><tr><th>Issue type</th><th className="num">Now</th><th className="num">Before</th><th className="num">Change</th><th className="num">Customers</th></tr></thead>
								<tbody>
									{data.categoryChange.map((c: any) => (
										<tr key={c.category} className="click" onClick={() => { set({ category: [c.category] }); nav('/conversations'); }}>
											<td style={{ fontWeight: 700 }}>{catLabel(c.category)}</td>
											<td className="num"><b>{c.n}</b></td>
											<td className="num faint">{c.previous}</td>
											<td className="num">
												{c.change === 0 ? <span className="faint">0</span> : (
													<span className="row gap-4" style={{ justifyContent: 'flex-end', color: c.change > 0 ? COLORS.red : COLORS.green }}>
														{c.change > 0 ? <MdTrendingUp /> : <MdTrendingDown />}{c.change > 0 ? '+' : ''}{c.change}
													</span>
												)}
											</td>
											<td className="num">{c.customers}</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					) : <Empty text="No issues in this period" />}
				</Card>
				<Card title="Issue heatmap by week" accent={COLORS.pink}>
					{heatSeries.length ? (
						<Chart type="heatmap" height={Math.max(260, cats.length * 28 + 60)} series={heatSeries}
							options={{
								colors: [COLORS.pink],
								plotOptions: { heatmap: { radius: 4, shadeIntensity: 0.6, colorScale: { ranges: [{ from: 0, to: 0, color: '#F4F5F9', name: 'none' }] } } },
								dataLabels: { enabled: true, style: { colors: ['#0B1143'], fontWeight: 600 } },
								legend: { show: false },
								stroke: { width: 2, colors: ['#fff'] },
							}} />
					) : <Empty text="Not enough data" />}
				</Card>
			</div>

			<div className="grid g-2-1 mb-16">
				<Card title={<h2><MdRepeat style={{ verticalAlign: -3, color: COLORS.pink }} /> Recurring customer issues</h2>} sub="The same type of problem for the same customer in two or more conversations" accent={COLORS.red} flush>
					{data.recurring.length ? (
						<div className="table-wrap">
							<table className="table">
								<thead><tr><th>Customer</th><th>Recurring issue</th><th className="num">Conversations</th><th>Last seen</th></tr></thead>
								<tbody>
									{data.recurring.map((r: any) => (
										<tr key={`${r.customer_id}-${r.category}`} className="click" onClick={() => nav(`/customers/${r.customer_id}`)}>
											<td><div className="row" style={{ fontWeight: 700 }}>{r.customer_name} <TierBadge tier={r.tier} /></div></td>
											<td>{catLabel(r.category)}</td>
											<td className="num"><span className={`badge ${r.conversations >= 3 ? 'red' : 'amber'}`}>{r.conversations}x</span></td>
											<td className="small">{ago(r.last_seen)}</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					) : <Empty text="No recurring issues detected" />}
				</Card>
				<div className="col gap-16">
					<Card title={<h2><MdNewReleases style={{ verticalAlign: -3, color: COLORS.amber }} /> Emerging topics</h2>} sub="Growing at least 50% versus the previous period" accent={COLORS.amber}>
						{data.emerging.length ? data.emerging.map((t: any) => (
							<div key={t.topic} className="row-between mb-8"><span>{t.topic}</span><span className="small"><b>{t.n}</b> <span className="faint">was {t.previous}</span></span></div>
						)) : <div className="faint small">Nothing unusual</div>}
					</Card>
					<Card title="Most discussed topics" accent={COLORS.teal}>
						<div className="row wrap gap-4">
							{data.topics.slice(0, 24).map((t: any) => <span key={t.topic} className="chip" style={{ fontSize: 11 + Math.min(5, t.n / 4) }}>{t.topic} · {t.n}</span>)}
							{!data.topics.length && <span className="faint small">No topics yet</span>}
						</div>
					</Card>
				</div>
			</div>

			<div className="grid g-2">
				<Card title="Customers with the most problems" accent={COLORS.purple} flush>
					{data.worstCustomers.map((c: any) => (
						<div key={c.id} className="list-item" onClick={() => nav(`/customers/${c.id}`)}>
							<div className="grow">
								<div className="row-between"><span className="li-title">{c.name} <TierBadge tier={c.tier} /></span><StateBadge s={c.health_status} /></div>
								<div className="row mt-8"><div className="grow"><Health score={c.health_score} /></div><span className="small faint">{c.red} red · {c.issues} issues</span></div>
							</div>
						</div>
					))}
				</Card>
				<Card title="Red, amber and green over time" accent={COLORS.general}>
					{trends.data?.rag?.length ? (
						<Chart type="area" height={300}
							series={['red', 'amber', 'green'].map((k) => ({ name: k[0].toUpperCase() + k.slice(1), data: trends.data.rag.map((r: any) => r[k]) }))}
							options={{
								chart: { stacked: true }, colors: [COLORS.red, COLORS.amber, COLORS.green], stroke: { curve: 'smooth', width: 1.5 }, fill: { type: 'solid', opacity: 0.35 },
								xaxis: { categories: trends.data.rag.map((r: any) => fmtDate(r.bucket, 'd MMM')), tickAmount: 8 },
							}} />
					) : <Empty text="No data" />}
				</Card>
			</div>
			<p className="xs faint mt-16">Issue taxonomy: {Object.values(CATEGORY_LABELS).join(', ')}.</p>
		</>
	);
}
