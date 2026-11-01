import { useEffect, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { MdAutoAwesome, MdDownload, MdOpenInNew, MdSearch } from 'react-icons/md';
import { api, getToken, qs } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { Card, Empty, Facts, Loader, Modal, PageHead, Story } from '../../components/ui';
import { ago, fmtDate } from '../../lib/format';

const TYPES: Record<string, string> = { shipper: 'Shipper', broker: 'Broker or 3PL', carrier: 'Carrier', consignee: 'Consignee', supplier: 'Supplier', other: 'Other', customer: 'Customer', prospect: 'Prospect', vendor: 'Vendor', partner: 'Partner', candidate: 'Candidate' };
const LIST_FIELDS = ['emails', 'phones', 'order_refs', 'account_numbers', 'lanes', 'tax_ids'];
const FIELDS: [string, string, boolean?][] = [
	['type', 'Type'], ['organisation', 'Company'], ['phones', 'Phone numbers', true], ['emails', 'Email addresses', true],
	['address', 'Address'], ['city', 'City'], ['state', 'Province or state'], ['postal_code', 'Postal or ZIP code'], ['country', 'Country'], ['language', 'Writes in'],
	['account_numbers', 'Account numbers', true], ['order_refs', 'Load, PRO and BOL numbers', true], ['lanes', 'Lanes', true], ['tax_ids', 'GST/HST, USDOT and MC', true], ['notes', 'Notes'],
];
const n = (v?: number) => (v ?? 0).toLocaleString('en-CA');
const list = (v: any) => (Array.isArray(v) ? v.join(', ') : v || '');

/** Every shipper, broker, carrier, consignee and supplier, with what their emails say about them. */
export default function CustomerDb() {
	const [f, setF] = useState({ q: '', type: '', language: '', has: '', sort: 'recent' });
	const [search, setSearch] = useState('');
	const [limit, setLimit] = useState(50);
	const [open, setOpen] = useState<any>(null);
	useEffect(() => { const t = setTimeout(() => setF((x) => ({ ...x, q: search })), 350); return () => clearTimeout(t); }, [search]);
	const { data, isLoading, isFetching } = useQuery({ queryKey: ['customer-db', f, limit], queryFn: () => api(`/customer-db${qs({ ...f, limit })}`), placeholderData: keepPreviousData });
	const t = data?.totals || {};
	const download = async () => {
		const res = await fetch(`/api/customer-db${qs({ ...f, format: 'csv' })}`, { headers: { authorization: `Bearer ${getToken()}` } });
		const a = document.createElement('a');
		a.href = URL.createObjectURL(await res.blob());
		a.download = `remail-customers-${new Date().toISOString().slice(0, 10)}.csv`;
		a.click();
	};
	const pct = (x: number) => (t.total ? Math.round((x / t.total) * 100) : 0);

	return (
		<>
			<PageHead kw="Customer" rest="database"
				sub="Every shipper, broker, carrier, consignee and supplier who has written, with the details their emails contain. Built automatically; Claude refines active customers, and anything you edit is kept."
				actions={<button className="btn" onClick={download}><MdDownload /> Download CSV</button>} />
			{data && (
				<Story
					head={<>{n(t.total)} customers on file{f.q || f.type || f.language || f.has ? ' with these filters' : ''}: {pct(t.with_phone)}% have a phone number and {pct(t.with_address)}% a postal address.</>}
					points={[
						<>{n(t.with_orders)} have quoted a load or PRO number, {n(t.with_lanes)} have lanes on file and {n(t.with_tax)} a GST/HST, USDOT or MC number.</>,
						<>{n(t.by_ai)} records were read by Claude; the rest by the rules engine.{t.pending ? ` ${n(t.pending)} are still being built in the background.` : ''}</>,
					]}
					next={<>Claude uses these details when drafting replies, so customers are not asked again for an address or account number already on file.</>}
				/>
			)}
			<div className="filter-strip mb-16">
				<div className="search-box">
					<MdSearch />
					<input className="input sm" placeholder="Search company, email, phone, postal code, load or account number" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search customers" />
				</div>
				<select className={`input sm drop ${f.type ? 'on' : ''}`} value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })} aria-label="Type">
					<option value="">All types</option>
					{(t.types || []).map((x: any) => <option key={x.k} value={x.k}>{TYPES[x.k] || x.k} ({n(x.n)})</option>)}
				</select>
				<select className={`input sm drop ${f.language ? 'on' : ''}`} value={f.language} onChange={(e) => setF({ ...f, language: e.target.value })} aria-label="Language">
					<option value="">Any language</option><option value="English">English</option><option value="French">French</option>
				</select>
				<select className={`input sm drop ${f.has ? 'on' : ''}`} value={f.has} onChange={(e) => setF({ ...f, has: e.target.value })} aria-label="Has">
					<option value="">Any details</option>
					<option value="phone">Has phone ({n(t.with_phone)})</option>
					<option value="address">Has address ({n(t.with_address)})</option>
					<option value="orders">Has load numbers ({n(t.with_orders)})</option>
					<option value="lanes">Has lanes ({n(t.with_lanes)})</option>
					<option value="tax">Has GST/HST, USDOT or MC ({n(t.with_tax)})</option>
				</select>
				<select className="input sm drop" value={f.sort} onChange={(e) => setF({ ...f, sort: e.target.value })} aria-label="Sort">
					<option value="recent">Latest contact</option><option value="threads">Most threads</option><option value="name">Name</option>
				</select>
			</div>
			<Card flush>
				{isLoading ? <Loader text="Loading customers" /> : !data?.rows?.length ? <Empty text="No customers match." /> : (
					<>
						<div className="table-wrap">
							<table className="table">
								<thead><tr><th>Name</th><th>Type</th><th>Phone</th><th>Place</th><th>Language</th><th>Lanes and loads</th><th className="num">Threads</th><th>Last contact</th></tr></thead>
								<tbody>
									{data.rows.map((r: any) => (
										<tr key={r.id} className="click" onClick={() => setOpen(r)}>
											<td style={{ maxWidth: 260 }}><b className="truncate" style={{ display: 'block' }}>{r.name}</b><div className="xs faint truncate">{r.p.organisation || r.p.emails?.[0]}</div></td>
											<td className="small nowrap">{TYPES[r.p.type || r.kind] || r.p.type || r.kind}</td>
											<td className="small mono nowrap">{r.p.phones?.[0] || <span className="faint">–</span>}</td>
											<td className="small" style={{ maxWidth: 200 }}>{[r.p.city, r.p.state || r.enrichment?.region?.province, r.p.postal_code].filter(Boolean).join(', ') || <span className="faint">–</span>}{r.enrichment?.possible_duplicates?.length ? <div className="xs" style={{ color: 'var(--amber)' }}>Possible duplicate</div> : null}</td>
											<td className="small">{r.p.language || <span className="faint">–</span>}</td>
											<td className="xs" style={{ maxWidth: 220 }}>
												{r.p.lanes?.length > 0 && <div className="truncate">{r.p.lanes.slice(0, 2).join('; ')}</div>}
												{r.p.order_refs?.length > 0 && <div className="truncate faint">{r.p.order_refs.slice(0, 3).join(', ')}</div>}
											</td>
											<td className="num small">{r.threads}{r.waiting ? <span className="badge amber" style={{ marginLeft: 6 }}>{r.waiting} waiting</span> : null}</td>
											<td className="small nowrap">{ago(r.last_contact_at)}</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
						<div className="row-between" style={{ padding: '10px 20px' }}>
							<span className="small faint">{n(data.rows.length)} of {n(t.total)} shown{isFetching ? ' · updating' : ''}</span>
							{data.rows.length < t.total && <button className="btn sm" onClick={() => setLimit(limit + 100)}>Show 100 more</button>}
						</div>
					</>
				)}
			</Card>
			{open && <CustomerModal c={open} onClose={() => setOpen(null)} />}
		</>
	);
}

function CustomerModal({ c, onClose }: { c: any; onClose: () => void }) {
	const { can } = useAuth();
	const toast = useToast();
	const qc = useQueryClient();
	const [cur, setCur] = useState(c);
	const [edit, setEdit] = useState<Record<string, string> | null>(null);
	const save = useMutation({
		mutationFn: () => api(`/customer-db/${c.id}`, { method: 'PATCH', body: edit }),
		onSuccess: (r) => { setCur({ ...cur, ...r }); setEdit(null); qc.invalidateQueries({ queryKey: ['customer-db'] }); toast('Customer saved'); },
		onError: (e: any) => toast(e.message, 'error'),
	});
	const refresh = useMutation({
		mutationFn: () => api(`/customer-db/${c.id}/refresh`, { body: { ai: true } }),
		onSuccess: (r) => { setCur({ ...cur, ...r.customer }); qc.invalidateQueries({ queryKey: ['customer-db'] }); toast(r.source === 'ai' ? 'Read again by Claude' : 'Read again by the rules engine (Claude unavailable)'); },
		onError: (e: any) => toast(e.message, 'error'),
	});
	const p = cur.p || {};
	const manual = cur.profile_manual || {};
	return (
		<Modal wide title={cur.name} onClose={onClose}
			footer={edit ? <><button className="btn" onClick={() => setEdit(null)}>Cancel</button><button className="btn primary" onClick={() => save.mutate()} disabled={save.isPending}>Save</button></> : <>
				<Link className="btn ghost" to={`/customers/${c.id}`}><MdOpenInNew /> Threads and health</Link>
				<span style={{ flex: 1 }} />
				{can('analyst') && <button className="btn" onClick={() => refresh.mutate()} disabled={refresh.isPending}><MdAutoAwesome /> {refresh.isPending ? 'Reading…' : 'Read emails again'}</button>}
				{can('analyst') && <button className="btn primary" onClick={() => setEdit(Object.fromEntries(FIELDS.map(([k]) => [k, list(p[k])])))}>Edit</button>}
			</>}>
			{edit ? (
				<div className="grid g-2">
					{FIELDS.map(([k, l, multi]) => (
						<div key={k} className="field" style={k === 'address' || k === 'notes' ? { gridColumn: '1 / -1' } : undefined}>
							<label>{l}{multi ? ' (separate with commas)' : ''}</label>
							{k === 'type' ? (
								<select className="input" value={edit.type} onChange={(e) => setEdit({ ...edit, type: e.target.value })}>
									{['shipper', 'broker', 'carrier', 'consignee', 'supplier', 'other'].map((x) => <option key={x} value={x}>{TYPES[x]}</option>)}
								</select>
							) : <input className="input" value={edit[k] || ''} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })} />}
						</div>
					))}
				</div>
			) : (
				<>
					<Facts items={[
						['Type', TYPES[p.type || cur.kind] || p.type],
						['Threads', `${cur.threads ?? ''}${cur.waiting ? ` (${cur.waiting} waiting)` : ''}`],
						['First contact', cur.first_contact ? fmtDate(cur.first_contact) : ''],
						['Last contact', cur.last_contact_at ? fmtDate(cur.last_contact_at) : ''],
						['Writes in', p.language],
						['Record built by', cur.profile_source === 'ai' ? `Claude, ${ago(cur.profile_at)}` : cur.profile_source ? `Rules, ${ago(cur.profile_at)}` : 'Not yet'],
					]} />
					<div className="kv mt-16">
						{FIELDS.filter(([k]) => k !== 'type' && k !== 'language').map(([k, l]) => (
							<FragmentRow key={k} k={l} v={LIST_FIELDS.includes(k) ? (p[k] || []).join(', ') : p[k]} edited={k in manual} />
						))}
					</div>
					<Enrichment e={cur.enrichment} />
				</>
			)}
		</Modal>
	);
}


/** What remail adds: activity, region from the postal code, registrations, FMCSA snapshot, possible duplicates, a company's website. */
function Enrichment({ e }: { e: any }) {
	if (!e || !e.activity) return <div className="small faint mt-16">Enrichment is added in the background within a few minutes.</div>;
	const a = e.activity;
	const r = e.region || {};
	const g = e.registrations || {};
	return (
		<div className="mt-16">
			<h3 className="report-sub mb-8">What remail adds</h3>
			<Facts items={[
				['Emails from them', a.emails_from_them],
				['Waiting for a reply', a.waiting],
				['Red threads', a.red],
				['Average first reply', a.avg_first_reply_hours != null ? `${a.avg_first_reply_hours} h` : ''],
				['Usually writes to', a.usual_mailbox],
				['Last reply sent from remail', a.last_reply_sent ? fmtDate(a.last_reply_sent) : ''],
			]} />
			<div className="kv mt-16">
				{a.groups?.length > 0 && <><span className="k">Writes about</span><span>{a.groups.map((x: any) => `${x.label} (${x.n})`).join(', ')}</span></>}
				{r.province && <><span className="k">Region</span><span>{r.province} (from the postal code){r.mismatch && <span className="badge amber" style={{ marginLeft: 6 }}>Postal code and province differ</span>}</span></>}
				{(g.gst_hst || g.usdot || g.mc) && <><span className="k">Registrations</span><span>{[g.gst_hst && 'GST/HST registered', g.usdot && `USDOT ${g.usdot}`, g.mc && `MC ${g.mc}`].filter(Boolean).join(' · ')}</span></>}
				{e.fmcsa && <><span className="k">FMCSA record</span><span><a href={e.fmcsa.url} target="_blank" rel="noreferrer">{e.fmcsa.legal_name}</a>{e.fmcsa.dba ? ` (${e.fmcsa.dba})` : ''}<div className="small muted">{[e.fmcsa.operating_status && `Status: ${e.fmcsa.operating_status}`, e.fmcsa.power_units && `${e.fmcsa.power_units} power units`, e.fmcsa.drivers && `${e.fmcsa.drivers} drivers`].filter(Boolean).join(' · ')}</div></span></>}
				{e.website && <><span className="k">Website</span><span><a href={e.website.url} target="_blank" rel="noreferrer">{e.website.title || e.org_domain}</a>{e.website.description && <div className="small muted">{e.website.description}</div>}</span></>}
				{!e.website && e.org_domain && <><span className="k">Company domain</span><span>{e.org_domain} <span className="faint small">(no website information found)</span></span></>}
				{e.possible_duplicates?.length > 0 && <><span className="k">Same phone or address</span><span>{e.possible_duplicates.map((d: any) => <Link key={d.id} to={`/customers/${d.id}`} style={{ marginRight: 10 }}>{d.name}</Link>)}</span></>}
			</div>
			<div className="xs faint mt-8">Individuals are not looked up on the internet. Companies with their own email domain get their public website details, and carriers or brokers with a USDOT number get their public FMCSA record.</div>
		</div>
	);
}

const FragmentRow = ({ k, v, edited }: { k: string; v: any; edited: boolean }) => (
	<>
		<span className="k">{k}</span>
		<span className={v ? '' : 'faint'}>{v || 'Not known'}{edited && <span className="badge" style={{ marginLeft: 6 }}>edited</span>}</span>
	</>
);
