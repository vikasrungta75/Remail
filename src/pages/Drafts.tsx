import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { MdExpandLess, MdExpandMore, MdOpenInNew, MdRefresh, MdSearch } from 'react-icons/md';
import { api, qs } from '../api/client';
import { useFilters } from '../contexts/FilterContext';
import DraftEditor, { countPlaceholders, placeholderList } from '../components/DraftEditor';
import { Card, Empty, Facts, Loader, PageHead, RagBadge, RagDot, Segmented, SentimentBadge, Story } from '../components/ui';
import { BUSINESS_LABELS, COLORS, ago, bizLabel, fmtDateTime } from '../lib/format';
import { useTaxonomy } from '../lib/taxonomy';
import { Drop } from '../components/FilterStrip';

interface F { q: string; waiting: string; rag: string[]; ready: string; type: string; sub: string; urgency: string; mailbox: string; sort: string }
const EMPTY: F = { q: '', waiting: '', rag: [], ready: '', type: '', sub: '', urgency: '', mailbox: '', sort: 'priority' };
const KEY = 'remail_reply_filters';
const num = (n?: number) => (n !== undefined && n !== null ? ` (${n.toLocaleString('en-CA')})` : '');

const load = (): F => { try { return { ...EMPTY, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return EMPTY; } };

export default function Drafts() {
	const { params } = useFilters();
	const { groups, subLabel } = useTaxonomy();
	const [status, setStatus] = useState<'draft' | 'sent' | 'dismissed'>('draft');
	const [f, setF] = useState<F>(load);
	const [search, setSearch] = useState(f.q);
	const set = (p: Partial<F>) => setF((x) => { const n = { ...x, ...p }; try { localStorage.setItem(KEY, JSON.stringify(n)); } catch { /* per-viewer convenience only */ } return n; });
	useEffect(() => { const t = setTimeout(() => search !== f.q && set({ q: search }), 350); return () => clearTimeout(t); }, [search]);
	const opts = useQuery({ queryKey: ['filter-options'], queryFn: () => api('/filters/options'), staleTime: 300_000 });

	const query = {
		view: params.view, status, q: f.q, waitingDays: f.waiting, rag: f.rag, ready: f.ready, type: f.type, sub: f.sub,
		urgency: f.urgency, mailbox: f.mailbox || params.mailbox, sort: f.sort,
	};
	const { data, isLoading, isFetching } = useQuery({ queryKey: ['drafts', query], queryFn: () => api(`/drafts${qs(query)}`), refetchInterval: 60_000 });
	const rows: any[] = data?.rows || [];
	const fc = data?.facets || {};
	const [sel, setSel] = useState<number | null>(null);
	useEffect(() => {
		if (!rows.length) setSel(null);
		else if (!rows.some((r) => r.id === sel)) setSel(rows[0].id);
	}, [rows, sel]);
	const cur = rows.find((r) => r.id === sel);
	// J / K move through the list when not typing
	useEffect(() => {
		const h = (e: KeyboardEvent) => {
			const t = e.target as HTMLElement;
			if (e.metaKey || e.ctrlKey || e.altKey || /input|textarea|select/i.test(t.tagName) || t.isContentEditable) return;
			if (e.key !== 'j' && e.key !== 'k') return;
			const i = rows.findIndex((r) => r.id === sel);
			const next = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'j' ? 1 : -1)))];
			if (next) { setSel(next.id); document.querySelector(`[data-draft="${next.id}"]`)?.scrollIntoView({ block: 'nearest' }); }
		};
		window.addEventListener('keydown', h);
		return () => window.removeEventListener('keydown', h);
	}, [rows, sel]);
	const active = (Object.keys(EMPTY) as (keyof F)[]).filter((k) => k !== 'sort' && JSON.stringify(f[k]) !== JSON.stringify(EMPTY[k])).length;

	// the yellow item that holds most drafts back
	const topMissing = useMemo(() => {
		const n: Record<string, number> = {};
		for (const r of rows) for (const p of placeholderList(r.body || '')) { const k = p.toLowerCase().replace(/\d[\d,]*/g, '#'); n[k] = (n[k] || 0) + 1; }
		return Object.entries(n).sort((a, b) => b[1] - a[1]).slice(0, 2);
	}, [rows]);
	const subs = groups.find((g) => g.key === f.type)?.subgroups || [];
	const groupCount = (k: string) => (fc.groups || []).find((g: any) => g.k === k)?.n;

	return (
		<>
			<PageHead kw="Replies" rest="to send"
				sub="A complete reply is drafted for every email waiting on an answer. Answer the yellow items, check the email, and press Send: it goes from Outlook, in the same conversation." />

			{status === 'draft' && data && (
				<Story
					head={<>{(fc.ready || 0).toLocaleString('en-CA')} replies are ready to send and {((fc.total || 0) - (fc.ready || 0)).toLocaleString('en-CA')} need information{active ? ' (with these filters)' : ''}.</>}
					points={[
						fc.total ? <>{(fc.today || 0).toLocaleString('en-CA')} arrived in the last day, {(fc.week || 0).toLocaleString('en-CA')} in the last 7 days; {(fc.older || 0).toLocaleString('en-CA')} are older than 30 days.</> : null,
						fc.red ? <>{fc.red.toLocaleString('en-CA')} are rated red: unhappy customers, claims or legal and cancellation language.</> : null,
						topMissing.length ? <>Most common missing information: {topMissing.map(([k, n]) => `"${k}" (${n})`).join(' and ')}. Adding it to Help → Reference data fills it in automatically.</> : null,
					]}
					next={fc.ready ? <>Select <b>Ready to send</b> and clear those first; then work through one subgroup at a time.</> : fc.older ? <>Old threads can be cleared in Processing status → Old unanswered threads.</> : undefined}
				/>
			)}

			<div className="row-between mb-8">
				<Segmented value={status} onChange={setStatus} options={[{ v: 'draft', l: `To send${data?.counts?.draft ? ` (${data.counts.draft.toLocaleString('en-CA')})` : ''}` }, { v: 'sent', l: `Sent${data?.counts?.sent ? ` (${data.counts.sent})` : ''}` }, { v: 'dismissed', l: 'Dismissed' }]} />
			</div>
			<div className="filter-strip mb-16">
				<div className="search-box">
					<MdSearch />
					<input className="input sm" placeholder="Search name, email, subject or text" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search replies" />
				</div>
				<Drop label="Received" value={f.waiting} onChange={(v) => set({ waiting: v })} options={[['', 'Any time'], ['1', `Last day${num(fc.today)}`], ['7', `Last 7 days${num(fc.week)}`], ['30', 'Last 30 days'], ['90', 'Last 90 days']]} />
				<Drop label="Rating" value={f.rag[0] || ''} onChange={(v) => set({ rag: v ? [v] : [] })} options={[['', 'Any rating'], ['red', `Red${num(fc.red)}`], ['amber', `Amber${num(fc.amber)}`], ['green', `Green${num(fc.green)}`]]} />
				<Drop label="Urgency" value={f.urgency} onChange={(v) => set({ urgency: v })} options={[['', 'Any urgency'], ['critical', 'Critical'], ['high', 'High'], ['medium', 'Medium'], ['low', 'Low']]} />
				<Drop label="Status" value={f.ready} onChange={(v) => set({ ready: v })} options={[['', 'Any status'], ['yes', `Ready to send${num(fc.ready)}`], ['no', `Needs information${fc.total !== undefined ? num(fc.total - (fc.ready || 0)) : ''}`]]} />
				<Drop label="Group" value={f.type} onChange={(v) => set({ type: v, sub: '' })} options={[['', 'All groups'], ...Object.entries(BUSINESS_LABELS).map(([k, l]) => [k, `${l}${num(groupCount(k))}`] as [string, string])]} />
				{f.type && <Drop label="Subgroup" value={f.sub} onChange={(v) => set({ sub: v })} options={[['', 'All subgroups'], ...subs.map((x) => [x.key, x.label] as [string, string])]} />}
				<Drop label="Mailbox" value={f.mailbox} onChange={(v) => set({ mailbox: v })} options={[['', 'All mailboxes'], ...(opts.data?.mailboxes || []).map((m: any) => [String(m.id), m.address] as [string, string])]} />
				{active > 0 && <button className="btn ghost sm" onClick={() => { setSearch(''); set({ ...EMPTY, sort: f.sort }); }}><MdRefresh /> Clear ({active})</button>}
			</div>

			{isLoading ? <Loader text="Loading replies" /> : !rows.length ? (
				<Card><Empty text={status === 'draft' ? (active ? 'No replies match these filters.' : 'Nothing waiting. New drafts appear here as soon as an email needs a reply.') : 'Nothing here yet.'} /></Card>
			) : (
				<div className="drafts-layout">
					<Card flush className="drafts-list" title={<span className="small"><b>{(data.total || rows.length).toLocaleString('en-CA')}</b> {status === 'draft' ? 'to send' : status}{data.total > rows.length ? `, first ${rows.length} shown` : ''}{isFetching ? ' · updating' : ''} <span className="faint xs">· J / K to move</span></span>}
						actions={<Drop label="Sort" value={f.sort} onChange={(v) => set({ sort: v })} options={[['priority', 'Red first'], ['newest', 'Newest'], ['oldest', 'Oldest'], ['ready', 'Ready first']]} />}>
						{rows.map((r) => {
							const n = countPlaceholders(r.body);
							return (
								<button key={r.id} data-draft={r.id} className={`draft-item ${r.id === sel ? 'on' : ''}`} onClick={() => setSel(r.id)}>
									<div className="row" style={{ gap: 8 }}>
										<RagDot rag={r.rag} />
										<b className="truncate grow">{r.customer_name || r.to_addresses?.[0]}</b>
										<span className="xs faint nowrap">{ago(status === 'sent' ? r.sent_at : r.last_inbound_at)}</span>
									</div>
									<div className="small truncate">{r.conv_subject || '(no subject)'}</div>
									<div className="tag-line xs" style={{ marginTop: 4 }}>
										<span className="chip">{subLabel(r.business_category, r.subcategory) || bizLabel(r.business_category)}</span>
										{status === 'draft' && (n > 0 ? <span className="badge amber">{n} to fill in</span> : <span className="badge green">Ready to send</span>)}
									</div>
								</button>
							);
						})}
					</Card>
					{cur && <ReplyPane key={cur.id} d={cur} subLabel={subLabel(cur.business_category, cur.subcategory)} />}
				</div>
			)}
		</>
	);
}

/** The reply on top; the conversation it answers underneath, newest first. */
function ReplyPane({ d, subLabel }: { d: any; subLabel: string }) {
	const thread = useQuery({ queryKey: ['conversation', d.conversation_id], queryFn: () => api(`/conversations/${d.conversation_id}`) });
	const emails: any[] = (thread.data?.emails || []).filter((e: any) => !e.is_duplicate).slice().reverse();
	const [openIds, setOpenIds] = useState<number[] | null>(null);
	const isOpen = (id: number, i: number) => (openIds ? openIds.includes(id) : i === 0);
	const toggle = (id: number, i: number) => setOpenIds((o) => { const cur = o || (emails[0] ? [emails[0].id] : []); return isOpen(id, i) ? cur.filter((x) => x !== id) : [...cur, id]; });
	return (
		<div className="col gap-16">
			<Card title={d.conv_subject || '(no subject)'} accent={COLORS.pink}
				sub={<span>{d.customer_name || d.to_addresses?.[0]} · waiting {ago(d.last_inbound_at)}</span>}
				actions={<Link className="btn sm ghost" to={`/conversations/${d.conversation_id}`}><MdOpenInNew /> Open thread</Link>}>
				<Facts items={[
					['Rating', <RagBadge key="r" rag={d.rag} />],
					['Group', bizLabel(d.business_category)],
					['Subgroup', subLabel || 'Not set'],
					['Customer wrote', d.last_inbound_at ? fmtDateTime(d.last_inbound_at) : ''],
					['Reply from', d.send_from || 'No connected mailbox'],
				]} />
				{d.summary && <div className="small muted mt-16">{d.summary}</div>}
				<div className="mt-16"><DraftEditor draft={d} compact /></div>
			</Card>
			<Card title={`The conversation (${emails.length})`} sub="Newest first. Select a message to open or close it." flush>
				{thread.isLoading ? <Loader small text="Loading the conversation" /> : (
					<div className="thread compact-thread">
						{emails.map((e: any, i: number) => (
							<div key={e.id} className={`msg ${e.direction} ${isOpen(e.id, i) ? '' : 'closed'}`}>
								<button className="msg-head as-button" onClick={() => toggle(e.id, i)} aria-expanded={isOpen(e.id, i)}>
									<div style={{ minWidth: 0 }}>
										<div className="truncate" style={{ fontWeight: 700 }}>{e.from_name || e.from_address}</div>
										{!isOpen(e.id, i) && <div className="xs faint truncate">{String(e.body_clean || e.body_text || '').slice(0, 140)}</div>}
									</div>
									<div className="row" style={{ alignItems: 'flex-start', gap: 6 }}>
										<span className="chip">{e.direction === 'inbound' ? 'Customer' : e.direction === 'outbound' ? 'Our reply' : 'Internal'}</span>
										{e.direction === 'inbound' && <SentimentBadge s={e.sentiment} />}
										<span className="xs faint nowrap">{fmtDateTime(e.sent_at)}</span>
										{isOpen(e.id, i) ? <MdExpandLess /> : <MdExpandMore />}
									</div>
								</button>
								{isOpen(e.id, i) && <div className="msg-body">{e.body_clean || e.body_text}</div>}
							</div>
						))}
					</div>
				)}
			</Card>
		</div>
	);
}
