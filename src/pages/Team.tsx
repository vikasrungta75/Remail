import { useQuery } from '@tanstack/react-query';
import { api, qs } from '../api/client';
import { useFilters } from '../contexts/FilterContext';
import FilterBar from '../components/FilterBar';
import Chart from '../components/Chart';
import { Card, Empty, Loader, PageHead } from '../components/ui';
import { COLORS, minutes } from '../lib/format';

export default function Team() {
	const { params } = useFilters();
	const { data, isLoading } = useQuery({ queryKey: ['team', params], queryFn: () => api(`/views/team${qs({ ...params, view: undefined })}`) });
	const rows = (data?.rows || []).filter((r: any) => r.replies || r.userId);
	const withReplies = rows.filter((r: any) => r.replies);
	return (
		<>
			<PageHead kw="Team" rest="performance" sub="Who is answering customers, how fast, and what is still on each person's plate. Based on who actually sent each reply." />
			<FilterBar show={['customer', 'mailbox', 'tier']} />
			{isLoading ? <Loader /> : (
				<>
					{withReplies.length > 0 && (
						<Card title="Replies and response time by person" accent={COLORS.teal} className="mb-16">
							<Chart type="bar" height={280}
								series={[
									{ name: 'Replies sent', type: 'column', data: withReplies.slice(0, 15).map((r: any) => r.replies) },
									{ name: 'Median response (hours)', type: 'line', data: withReplies.slice(0, 15).map((r: any) => r.median_response_min == null ? null : Math.round((r.median_response_min / 60) * 10) / 10) },
								]}
								options={{
									colors: [COLORS.general, COLORS.pink], stroke: { width: [0, 3] }, plotOptions: { bar: { columnWidth: '50%', borderRadius: 3 } },
									xaxis: { categories: withReplies.slice(0, 15).map((r: any) => r.name || r.email) },
									yaxis: [{ title: { text: 'Replies' } }, { opposite: true, title: { text: 'Hours' } }],
								}} />
						</Card>
					)}
					<Card flush accent={COLORS.navy}>
						{!rows.length ? <Empty text="No replies in this period" /> : (
							<div className="table-wrap">
								<table className="table">
									<thead><tr><th>Person</th><th className="num">Replies</th><th className="num">Threads</th><th className="num">Avg response</th><th className="num">Median</th><th className="num">Awaiting</th><th className="num">Assigned open</th><th className="num">Open actions</th><th className="num">Overdue</th><th className="num">Done (30d)</th></tr></thead>
									<tbody>
										{rows.map((r: any) => (
											<tr key={r.email}>
												<td><b>{r.name || r.email}</b><div className="xs faint">{r.email}{r.userId ? '' : ' · not a remail user'}</div></td>
												<td className="num">{r.replies || 0}</td>
												<td className="num">{r.conversations || 0}</td>
												<td className="num">{minutes(r.avg_response_min)}</td>
												<td className="num">{minutes(r.median_response_min)}</td>
												<td className="num">{r.awaiting ?? '–'}</td>
												<td className="num">{r.assigned_open ?? '–'}</td>
												<td className="num">{r.actions_open ?? '–'}</td>
												<td className="num" style={{ color: r.actions_overdue ? COLORS.red : undefined }}>{r.actions_overdue ?? '–'}</td>
												<td className="num">{r.actions_done_30d ?? '–'}</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						)}
					</Card>
				</>
			)}
		</>
	);
}
