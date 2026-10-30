import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { MdArrowForward } from 'react-icons/md';
import { api, qs } from '../api/client';
import { useFilters } from '../contexts/FilterContext';
import FilterBar from '../components/FilterBar';
import { EmailTabs } from './Conversations';
import Chart from '../components/Chart';
import { Card, Kpi, Loader, PageHead, RagDot } from '../components/ui';
import { BUSINESS_COLORS, BUSINESS_LABELS, COLORS, ago, fmtDate } from '../lib/format';

export default function AllEmail() {
	const { params, set } = useFilters();
	const nav = useNavigate();
	const { data, isLoading } = useQuery({ queryKey: ['categories', params], queryFn: () => api(`/views/categories${qs({ ...params, type: undefined })}`), refetchInterval: 60_000 });
	const open = (category: string) => { set({ type: [category] }); nav('/conversations?audience=all'); };

	const cats = (data?.categories || []).filter((c: any) => c.conversations > 0);
	const days = [...new Set((data?.trend || []).map((t: any) => t.bucket))].sort() as string[];
	const series = cats.slice(0, 8).map((c: any) => ({
		name: BUSINESS_LABELS[c.category],
		data: days.map((d) => data.trend.find((t: any) => t.bucket === d && t.category === c.category)?.n || 0),
	}));

	return (
		<>
			<PageHead kw="Email" rest="by category"
				sub="Every thread in every mailbox, sorted into business categories: customer issues, proposals, operations, finance, vendors, people and internal." />
			<EmailTabs />
			<FilterBar show={['mailbox', 'sentiment', 'rag', 'status']} />
			{isLoading || !data ? <Loader /> : (
				<>
					<div className="grid g-4 mb-16">
						<Kpi label="Emails analysed" value={data.audience.emails} accent={COLORS.general} foot={`${data.audience.duplicates} duplicates removed`} />
						<Kpi label="External threads" value={data.audience.external} accent={COLORS.pink} foot="Customers, prospects, vendors" />
						<Kpi label="Internal threads" value={data.audience.internal} accent={COLORS.navy} />
						<Kpi label="Automated" value={data.audience.automated} accent={COLORS.grey} foot="Newsletters and notifications" />
					</div>
					<Card title="Email volume by category" accent={COLORS.teal} className="mb-16">
						{series.length ? (
							<Chart type="bar" height={260} series={series}
								options={{
									chart: { stacked: true }, colors: cats.slice(0, 8).map((c: any) => BUSINESS_COLORS[c.category]),
									plotOptions: { bar: { columnWidth: '65%', borderRadius: 2 } },
									xaxis: { categories: days.map((d) => fmtDate(d, 'd MMM')), tickAmount: 10 },
								}} />
						) : <div className="faint">No email in this period</div>}
					</Card>
					<div className="grid g-3">
						{data.categories.map((c: any) => (
							<Card key={c.category} accent={BUSINESS_COLORS[c.category]}
								title={c.category === 'customer_service' ? <h2><span className="kw">Customer</span> service and issues</h2> : BUSINESS_LABELS[c.category]}
								sub={c.last_activity ? `Last activity ${ago(c.last_activity)}` : 'No activity in this period'}
								actions={c.conversations > 0 && <button className="btn sm" onClick={() => open(c.category)}>Open <MdArrowForward /></button>}>
								<div className="grid g-4" style={{ gap: 8 }}>
									<div><div className="xs faint">Threads</div><b style={{ fontSize: 20 }}>{c.conversations}</b></div>
									<div><div className="xs faint">Awaiting reply</div><b style={{ fontSize: 20, color: c.overdue_replies ? COLORS.red : undefined }}>{c.awaiting}</b></div>
									<div><div className="xs faint">Open actions</div><b style={{ fontSize: 20 }}>{c.open_actions}</b></div>
									<div><div className="xs faint">Negative</div><b style={{ fontSize: 20, color: c.negative ? COLORS.amber : undefined }}>{c.negative}</b></div>
								</div>
								{c.recent.length > 0 && (
									<div className="mt-16 col gap-4">
										{c.recent.map((r: any) => (
											<div key={r.id} className="row small cursor" onClick={() => nav(`/conversations/${r.id}`)} style={{ alignItems: 'flex-start' }}>
												<RagDot rag={r.rag} />
												<div className="grow">
													<div className="truncate" style={{ fontWeight: 700 }}>{r.customer_name || (r.is_automated ? 'Automated' : 'Internal')} · {r.subject}</div>
													<div className="xs faint clamp-2">{r.summary}</div>
												</div>
											</div>
										))}
									</div>
								)}
							</Card>
						))}
					</div>
				</>
			)}
		</>
	);
}
