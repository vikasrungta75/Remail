import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { MdDownload, MdPrint } from 'react-icons/md';
import { api, getToken, qs } from '../api/client';
import { useFilters } from '../contexts/FilterContext';
import FilterBar from '../components/FilterBar';
import { EmailTabs } from './Conversations';
import { Card, Kpi, Loader, Meter, PageHead, RagDot, Sparkline, Story, Switch } from '../components/ui';
import { BUSINESS_COLORS, COLORS, fmtDate } from '../lib/format';

const n = (v: number) => (v ? v.toLocaleString('en-CA') : <span className="faint">0</span>);

/** Headings are the email groups, subheadings the subgroups. */
export default function CategoryReport() {
	const { params, set } = useFilters();
	const nav = useNavigate();
	const [showEmpty, setShowEmpty] = useState(false);
	const p = { ...params, type: undefined, sub: undefined };
	const { data, isLoading } = useQuery({ queryKey: ['category-report', p], queryFn: () => api(`/views/category-report${qs(p)}`), refetchInterval: 120_000 });

	const open = (group: string, sub?: string) => {
		set({ type: [group], sub: sub ? [sub] : [] });
		nav('/conversations?audience=all');
	};
	const download = async () => {
		const res = await fetch(`/api/views/category-report.csv${qs(p)}`, { headers: { authorization: `Bearer ${getToken()}` } });
		const a = document.createElement('a');
		a.href = URL.createObjectURL(await res.blob());
		a.download = `remail-category-report-${new Date().toISOString().slice(0, 10)}.csv`;
		a.click();
	};

	const groups = (data?.groups || []).filter((g: any) => showEmpty || g.conversations > 0);

	return (
		<div className="category-report">
			<PageHead kw="Category" rest="report"
				sub="Every email thread sorted into groups and subgroups. Each group is a heading and each subgroup a subheading, with the same names used for the default reply templates in Help."
				actions={<>
					<button className="btn" onClick={() => window.print()}><MdPrint /> Print</button>
					<button className="btn" onClick={download}><MdDownload /> Download CSV</button>
				</>} />
			<div className="no-print"><EmailTabs /></div>
			<div className="no-print"><FilterBar show={['mailbox', 'sentiment', 'rag', 'status']} /></div>
			{isLoading || !data ? <Loader /> : (
				<>
					<p className="print-only small">Period {fmtDate(data.from)} to {fmtDate(data.to)}</p>
					{(() => {
						const live = data.groups.filter((g: any) => g.conversations > 0);
						const top = live[0];
						const waitTop = [...live].sort((a: any, b: any) => b.awaiting - a.awaiting)[0];
						const redTop = [...live].sort((a: any, b: any) => b.red - a.red)[0];
						const subs = live.flatMap((g: any) => g.subgroups.filter((s: any) => s.key).map((s: any) => ({ ...s, group: g.label })));
						const slow = subs.filter((s: any) => s.conversations >= 5 && s.avg_first_response_hours !== null).sort((a: any, b: any) => b.avg_first_response_hours - a.avg_first_response_hours)[0];
						return top ? (
							<Story
								head={<>{top.label} is the largest group with {top.conversations.toLocaleString('en-CA')} threads ({Math.round((top.conversations / Math.max(1, data.totals.conversations)) * 100)}%){waitTop.key === top.key ? <> and also has the most waiting for a reply ({waitTop.awaiting.toLocaleString('en-CA')})</> : <>; {waitTop.label.toLowerCase()} has the most waiting for a reply ({waitTop.awaiting.toLocaleString('en-CA')})</>}.</>}
								points={[
									redTop?.red ? <>{redTop.label} has the most red threads open: {redTop.red}.</> : null,
									slow ? <>Slowest first reply: {slow.label} ({slow.group}), {Math.round(slow.avg_first_response_hours)} hours on average.</> : null,
									<>{data.totals.drafts_waiting.toLocaleString('en-CA')} drafts are waiting in Replies to send.</>,
								]}
								next={<>Open the group with the most waiting, then send its ready drafts.</>}
							/>
						) : null;
					})()}
					<div className="grid g-4 mb-16">
						<Kpi label="Threads" value={data.totals.conversations.toLocaleString('en-CA')} accent={COLORS.general} foot={`${data.totals.emails.toLocaleString('en-CA')} emails`} />
						<Kpi label="Awaiting reply" value={data.totals.awaiting} accent={COLORS.blue} foot={`${data.totals.overdue_replies} past the reply target`} />
						<Kpi label="Drafts ready to send" value={data.totals.drafts_waiting} accent={COLORS.teal} onClick={() => nav('/replies')} />
						<Kpi label="Red threads open" value={data.totals.red} accent={COLORS.red} foot={`${data.totals.negative} negative in total`} />
					</div>
					<div className="row-between mb-16 no-print">
						<span className="small faint">Select a subgroup to open its threads.</span>
						<Switch checked={showEmpty} onChange={setShowEmpty} label="Show groups with no email" />
					</div>
					{groups.map((g: any) => (
						<Card key={g.key} accent={BUSINESS_COLORS[g.key] || COLORS.grey} className="mb-16 report-group"
							title={<h2 className="row wrap" style={{ gap: 10 }}>{g.label} <span className="faint" style={{ fontWeight: 600, fontSize: 14 }}>· {g.conversations.toLocaleString('en-CA')} threads</span>
								{g.weekly?.some((x: number) => x) && <span className="row xs faint" style={{ gap: 6, fontWeight: 600 }} title="New threads per week, last 12 weeks"><Sparkline v={g.weekly} color={BUSINESS_COLORS[g.key] || COLORS.pink} /> 12 weeks</span>}</h2>}
							sub={g.description}
							actions={g.conversations > 0 && <button className="btn sm no-print" onClick={() => open(g.key)}>Open group</button>}
							flush>
							<div className="table-wrap">
								<table className="table">
									<thead>
										<tr>
											<th>Subgroup</th>
											<th className="num">Threads</th>
											<th className="num">Awaiting</th>
											<th className="num">Past target</th>
											<th className="num">Negative</th>
											<th className="num">Red</th>
											<th className="num">Drafts</th>
											<th className="num">First reply</th>
											<th>Latest</th>
										</tr>
									</thead>
									<tbody>
										{g.subgroups.filter((s: any) => showEmpty || s.conversations > 0).map((s: any) => (
											<tr key={s.key || 'unsorted'} className={s.conversations ? 'click' : ''} onClick={() => s.conversations && s.key && open(g.key, s.key)}>
												<td style={{ minWidth: 220 }}>
													<h3 className="report-sub">{s.label}</h3>
													<div className="xs faint">{s.description}</div>
												</td>
												<td className="num nowrap"><Meter v={s.conversations} max={g.conversations} w={56} /> <b>{n(s.conversations)}</b></td>
												<td className="num">{n(s.awaiting)}</td>
												<td className="num" style={{ color: s.overdue_replies ? COLORS.red : undefined }}>{n(s.overdue_replies)}</td>
												<td className="num" style={{ color: s.negative ? COLORS.amber : undefined }}>{n(s.negative)}</td>
												<td className="num" style={{ color: s.red ? COLORS.red : undefined }}>{n(s.red)}</td>
												<td className="num">{n(s.drafts_waiting)}</td>
												<td className="num">{s.avg_first_response_hours === null ? <span className="faint">–</span> : `${s.avg_first_response_hours} h`}</td>
												<td style={{ maxWidth: 320 }}>
													{s.recent.map((r: any) => (
														<div key={r.id} className="xs row gap-4 ellipsis" onClick={(e) => { e.stopPropagation(); nav(`/conversations/${r.id}`); }} style={{ cursor: 'pointer' }}>
															<RagDot rag={r.rag} /> <span className="ellipsis">{r.subject || '(no subject)'}</span>
														</div>
													))}
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						</Card>
					))}
					{!groups.length && <Card><div className="faint">No email in this period.</div></Card>}
				</>
			)}
		</div>
	);
}
