import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { Card, Kpi, Loader, Modal, PageHead, Story } from '../../components/ui';
import { COLORS, ago, fmtDate, fmtDateTime } from '../../lib/format';

const n = (v: number | null | undefined) => (v ?? 0).toLocaleString('en-CA');

/** Where every email went: read, de-duplicated, grouped into threads, analysed, drafted, alerted. */
export default function Processing() {
	const { data: d, isLoading } = useQuery({ queryKey: ['processing'], queryFn: () => api('/system/processing'), refetchInterval: 30_000 });
	if (isLoading || !d) return <Loader />;
	const t = d.threads;
	const e = d.emails;
	const analysed = t.by_ai + t.by_rules + t.by_fallback;
	const paused = d.ai.paused_until && new Date(d.ai.paused_until) > new Date();
	const backfilling = d.mailboxes.filter((m: any) => !m.backfill_done && m.status !== 'paused');

	const steps: [string, number, string, string?][] = [
		['Emails read', e.stored, 'Every message fetched from the connected mailboxes, including copies of the same email in several mailboxes.'],
		['Copies removed', e.duplicates, 'The same email received in more than one mailbox (for example sent to dispatch@ and customerservice@) is counted once.'],
		['Unique emails', e.stored - e.duplicates, `${n(e.inbound)} from customers and other outside senders, ${n(e.outbound)} replies from Wheel King, ${n(e.internal)} between staff.`],
		['Threads', t.total, 'Emails grouped into conversations. Most counts in the app are threads, not emails.', '/conversations?audience=all'],
		['Threads with customers, partners and suppliers', t.external, 'What the customer views (Overview, Customers and accounts, Trends) are built from.', '/all-email'],
		['Staff-only threads', t.internal, 'Shown under Email with "Internal" selected. Not rated as customer risk.'],
		['Automated messages', t.automated, 'Gateway, courier and newsletter mail. Sorted by rules, never sent to the AI.'],
		['Analysed by Claude', t.by_ai, `Summary, sentiment, group and subgroup, rating and draft written by ${d.ai.model}.`],
		['Analysed by the rules engine', t.by_rules + t.by_fallback, `${n(t.by_rules)} by design (automated messages, or no AI key set), plus ${n(t.by_fallback)} where Claude was unavailable; those are retried with Claude automatically.`],
		['Waiting for analysis', t.waiting, paused ? 'Paused: see the AI status below.' : 'Being worked through in the background, about every 5 minutes.'],
		['Awaiting a reply from us', t.awaiting, 'Open threads where the customer wrote last.', '/conversations?audience=all'],
		['Draft replies ready', t.drafts, `${n(t.sent)} replies sent from remail so far.`, '/replies'],
		['Red and amber threads open', t.red + t.amber, `${n(t.red)} red, ${n(t.amber)} amber.`, '/critical'],
		['Open alerts', t.alerts_open, 'Raised only for high-risk threads (escalation risk, legal language, health drops, overdue replies), so far fewer than emails.', '/alerts'],
	];

	return (
		<>
			<PageHead kw="Processing" rest="status"
				sub="How many emails have been read, how they were grouped into threads, and how far analysis and drafting have got. Refreshes every 30 seconds." />
			<Story
				head={<>{n(e.stored)} emails read into {n(t.total)} threads; {t.total ? Math.round((t.by_ai / t.total) * 100) : 0}% analysed by Claude so far.</>}
				points={[
					paused ? <>Claude is paused: {d.ai.last_error}</> : d.ai.last_error && d.ai.last_error_at && Date.now() - new Date(d.ai.last_error_at).getTime() < 3600_000 ? <>Last Claude error, {ago(d.ai.last_error_at)}: {d.ai.last_error}</> : null,
					t.by_fallback ? <>{n(t.by_fallback)} threads were sorted by the rules engine while Claude was unavailable; recent and waiting ones are retried with Claude automatically.</> : null,
					<>{n(t.awaiting)} threads are waiting for a reply and {n(t.drafts)} drafts are ready to check.</>,
				]}
				next={paused ? <>Fix the key or credit in Netlify (ANTHROPIC_API_KEY), then redeploy.</> : t.awaiting > 500 ? <>Clear old unanswered threads below so the waiting lists show current mail.</> : undefined}
			/>
			<div className="grid g-4 mb-16">
				<Kpi label="Emails read" value={n(e.stored)} accent={COLORS.general} foot={`${n(e.last_30_days)} in the last 30 days`} />
				<Kpi label="Threads" value={n(t.total)} accent={COLORS.navy} foot={`${n(t.last_30_days)} active in the last 30 days`} />
				<Kpi label="Analysed" value={`${t.total ? Math.round((analysed / t.total) * 100) : 0}%`} accent={COLORS.teal} foot={`${n(analysed)} of ${n(t.total)} threads`} />
				<Kpi label="Waiting for analysis" value={n(t.waiting)} accent={t.waiting ? COLORS.amber : COLORS.green} foot={paused ? 'AI paused' : t.waiting ? 'In progress' : 'All done'} />
			</div>

			{(paused || backfilling.length > 0 || d.ai.provider === 'heuristic') && (
				<Card className="mb-16" accent={COLORS.amber} title="Still working">
					<ul className="small" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
						{d.ai.provider === 'heuristic' && <li>No AI key is set, so everything is analysed by the rules engine. Set <code>AI_PROVIDER=anthropic</code> and <code>ANTHROPIC_API_KEY</code> in Netlify.</li>}
						{paused && <li>Claude analysis is paused until {fmtDateTime(d.ai.paused_until)}: {d.ai.last_error}</li>}
						{backfilling.map((m: any) => <li key={m.id}>{m.address} is still reading its first {m.backfill_days} days of history ({n(m.emails)} emails so far, oldest {fmtDate(m.oldest) || 'none yet'}).</li>)}
					</ul>
				</Card>
			)}

			<Card className="mb-16" accent={COLORS.pink} title={<h2><span className="kw">From</span> email to alert</h2>}
				sub="Read each line as a step. Counts across the app are threads, not emails, and most views are limited by the date range, the filters and My view or Management view." flush>
				<table className="table">
					<tbody>
						{steps.map(([label, value, note, link]) => (
							<tr key={label}>
								<td style={{ width: 300 }}><b>{link ? <Link to={link}>{label}</Link> : label}</b></td>
								<td className="num" style={{ width: 110, fontSize: 18, fontWeight: 700 }}>{n(value)}</td>
								<td className="small faint">{note}</td>
							</tr>
						))}
					</tbody>
				</table>
			</Card>

			<OldUnanswered />

			<Card className="mb-16" accent={COLORS.blue} title="Mailboxes" flush>
				<div className="table-wrap">
					<table className="table">
						<thead><tr><th>Mailbox</th><th>Status</th><th>History</th><th className="num">Emails</th><th className="num">Copies</th><th className="num">Threads</th><th>Oldest</th><th>Newest</th><th>Last sync</th></tr></thead>
						<tbody>
							{d.mailboxes.map((m: any) => (
								<tr key={m.id}>
									<td><b>{m.address}</b>{m.display_name && <div className="xs faint">{m.display_name}</div>}</td>
									<td>{m.status === 'error' ? <span className="badge red" title={m.last_error}>Error</span> : <span className={`badge ${m.status === 'active' ? 'green' : ''}`}>{m.status}</span>}{m.last_error && m.status === 'error' && <div className="xs faint" style={{ maxWidth: 240 }}>{m.last_error}</div>}</td>
									<td className="small">{m.backfill_done ? `${m.backfill_days} days read` : <span style={{ color: COLORS.amber }}>Reading {m.backfill_days} days</span>}</td>
									<td className="num">{n(m.emails)}</td>
									<td className="num">{n(m.duplicates)}</td>
									<td className="num">{n(m.threads)}</td>
									<td className="small">{fmtDate(m.oldest)}</td>
									<td className="small">{fmtDate(m.newest)}</td>
									<td className="small">{m.last_synced_at ? ago(m.last_synced_at) : 'never'}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</Card>

			<div className="grid g-2">
				<Card accent={COLORS.teal} title="AI">
					<div className="small" style={{ lineHeight: 1.8 }}>
						<div>Provider <b>{d.ai.provider}</b>, model <b>{d.ai.model}</b></div>
						<div>Last 24 hours: <b>{n(d.ai.last24h?.calls)}</b> analyses, {n(Number(d.ai.last24h?.input_tokens))} input and {n(Number(d.ai.last24h?.output_tokens))} output tokens</div>
						<div>Last error: {d.ai.last_error ? <>{d.ai.last_error} <span className="faint">({ago(d.ai.last_error_at)})</span></> : <span className="faint">none</span>}</div>
					</div>
				</Card>
				<Card accent={COLORS.navy} title="Recent sync runs" flush>
					<table className="table">
						<thead><tr><th>When</th><th>Mailbox</th><th className="num">Fetched</th><th className="num">New</th><th className="num">Copies</th></tr></thead>
						<tbody>
							{d.runs.map((r: any, i: number) => (
								<tr key={i}>
									<td className="small">{ago(r.started_at)}</td>
									<td className="small">{r.address}{r.error && <div className="xs" style={{ color: COLORS.red }}>{r.error}</div>}</td>
									<td className="num small">{r.fetched}</td>
									<td className="num small">{r.inserted}</td>
									<td className="num small">{r.duplicates}</td>
								</tr>
							))}
						</tbody>
					</table>
				</Card>
			</div>
		</>
	);
}

/** Months of history arrive with thousands of threads nobody answered; this takes them off the waiting lists. */
function OldUnanswered() {
	const { can } = useAuth();
	const toast = useToast();
	const qc = useQueryClient();
	const [days, setDays] = useState(45);
	const [confirm, setConfirm] = useState(false);
	const preview = useQuery({ queryKey: ['old-unanswered', days], queryFn: () => api(`/system/old-unanswered?days=${days}`), enabled: can('manager') });
	const run = useMutation({
		mutationFn: () => api('/system/old-unanswered', { body: { days } }),
		onSuccess: (r: any) => { setConfirm(false); qc.invalidateQueries(); toast(`${r.threads.toLocaleString('en-CA')} old threads no longer counted as waiting`); },
		onError: (e: any) => toast(e.message, 'error'),
	});
	if (!can('manager')) return null;
	const n = preview.data?.threads || 0;
	return (
		<Card className="mb-16" accent={COLORS.amber} title="Old unanswered threads"
			sub="History read from the mailboxes includes threads nobody answered months ago. They inflate Awaiting reply, Replies to send and alerts. Taking them off the waiting lists does not delete anything; a new message from the customer puts the thread back.">
			<div className="row wrap" style={{ gap: 12 }}>
				<span className="small">Customer wrote last more than</span>
				<select className="input" style={{ width: 110 }} value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Days">
					{[14, 30, 45, 60, 90].map((d) => <option key={d} value={d}>{d} days</option>)}
				</select>
				<span className="small">ago: <b>{n.toLocaleString('en-CA')}</b> threads, {(preview.data?.drafts || 0).toLocaleString('en-CA')} drafts</span>
				<button className="btn" disabled={!n || run.isPending} onClick={() => setConfirm(true)}>Mark as no reply needed</button>
			</div>
			{confirm && (
				<Modal title="Mark old threads as no reply needed?" onClose={() => setConfirm(false)}
					footer={<><button className="btn" onClick={() => setConfirm(false)}>Cancel</button><button className="btn primary" onClick={() => run.mutate()} disabled={run.isPending}>{run.isPending ? 'Working' : `Yes, ${n.toLocaleString('en-CA')} threads`}</button></>}>
					<p className="small">{n.toLocaleString('en-CA')} threads where the customer last wrote more than {days} days ago will stop counting as waiting. Their drafts move to Dismissed and their alerts are resolved. The threads and emails stay in remail, and any new message from the customer brings the thread back.</p>
				</Modal>
			)}
		</Card>
	);
}
