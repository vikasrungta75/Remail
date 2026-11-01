import { Fragment, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import { MdDelete, MdDownload, MdEdit, MdRestore, MdSearch, MdUpload } from 'react-icons/md';
import { api, getToken } from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { Card, Loader, Modal, PageHead, Segmented, Switch } from '../components/ui';
import { BUSINESS_COLORS, COLORS, ago } from '../lib/format';
import { useTaxonomy, type Group } from '../lib/taxonomy';

const SECTIONS = [
	{ id: 'how', label: 'How it works' },
	{ id: 'categories', label: 'Email categories' },
	{ id: 'templates', label: 'Reply templates' },
	{ id: 'reference', label: 'Reference data' },
] as const;
type Section = (typeof SECTIONS)[number]['id'];

/** Shows {{fields}} in colour and [[provide: …]] in yellow, as in the draft editor. */
export function TemplatePreview({ body }: { body: string }) {
	const parts: ReactNode[] = [];
	const re = /(\[\[\s*provide\s*:.*?\]\](?!\]))|(\{\{\s*\w+\s*\}\})/gis;
	let last = 0;
	let m: RegExpExecArray | null;
	let i = 0;
	while ((m = re.exec(body))) {
		if (m.index > last) parts.push(body.slice(last, m.index));
		parts.push(m[1]
			? <mark key={i++} className="ph">{m[1].replace(/^\[\[\s*provide\s*:\s*/i, '').replace(/\]\]$/, '')}</mark>
			: <span key={i++} className="fld">{m[2]}</span>);
		last = m.index + m[0].length;
	}
	parts.push(body.slice(last));
	return <pre className="tpl-body">{parts}</pre>;
}

export default function Help() {
	const loc = useLocation();
	const nav = useNavigate();
	const section = (SECTIONS.find((s) => `#${s.id}` === loc.hash)?.id || 'how') as Section;
	const go = (s: Section) => nav({ hash: s }, { replace: true });
	return (
		<>
			<PageHead kw="Help" rest="and reply templates"
				sub="How remail sorts email, the default reply for every subgroup, and the reference data that makes drafts more complete." />
			<div className="help-layout">
				<Card className="help-nav-card" style={{ position: 'sticky', top: 80 }}>
					<nav className="help-nav" aria-label="Help sections">
						{SECTIONS.map((s) => <button key={s.id} className={section === s.id ? 'on' : ''} onClick={() => go(s.id)}>{s.label}</button>)}
					</nav>
				</Card>
				<div>
					{section === 'how' && <HowItWorks go={go} />}
					{section === 'categories' && <Categories go={go} />}
					{section === 'templates' && <Templates />}
					{section === 'reference' && <Reference />}
				</div>
			</div>
		</>
	);
}

function HowItWorks({ go }: { go: (s: Section) => void }) {
	return (
		<Card title={<h2><span className="kw">How</span> remail handles an email</h2>} accent={COLORS.pink}>
			<div className="help-prose">
				<ol>
					<li><b>Read.</b> New mail is collected from every connected mailbox every five minutes. Threads are rebuilt across mailboxes and duplicates removed.</li>
					<li><b>Sort.</b> Claude puts each thread into a group (the heading, such as Operations and dispatch) and a subgroup (the subheading, such as Detention and waiting time). <a onClick={() => go('categories')} href="#categories">See all groups and subgroups</a>.</li>
					<li><b>Rate.</b> Each thread gets a sentiment, urgency and a red, amber or green rating with the reason.</li>
					<li><b>Draft.</b> When a reply is needed, Claude writes it from the default template for that subgroup, in the language the customer used, and fills in what it can from the email and the <a onClick={() => go('reference')} href="#reference">reference data</a>.</li>
					<li><b>Check.</b> Anything only the team can know is shown in yellow. Send stays disabled until every yellow item is filled in.</li>
					<li><b>Send.</b> Pressing Send replies from Outlook, from the mailbox the customer wrote to, in the same conversation.</li>
				</ol>
				<h3>Making drafts better</h3>
				<ul>
					<li>Edit the <a onClick={() => go('templates')} href="#templates">reply templates</a> so they say exactly what Wheel King would say. Every new draft follows them.</li>
					<li>Upload rates and services, FAQs and policies under <a onClick={() => go('reference')} href="#reference">Reference data</a>. Matching entries are given to Claude for each email, so rates, transit times and rules are filled in instead of left yellow.</li>
					<li>Add standing facts (dispatch times, fees, refund timelines) and the signature in Settings → Reply drafts.</li>
					<li>If a thread is in the wrong group or subgroup, correct it on the thread. Corrections are kept and are not overwritten by later analysis.</li>
				</ul>
				<h3>Template fields</h3>
				<ul>
					<li><span className="fld" style={{ color: 'var(--pink)', fontWeight: 700 }}>{'{{name}}'}</span> the customer's name, <b>{'{{order_ref}}'}</b> the load, PRO, BOL or invoice number, <b>{'{{unit}}'}</b> the truck or trailer, <b>{'{{signature}}'}</b> the signature from Settings.</li>
					<li><mark className="ph" style={{ background: '#fff176' }}>{'[[provide: …]]'}</mark> information the team must fill in before sending.</li>
				</ul>
			</div>
		</Card>
	);
}

function Categories({ go }: { go: (s: Section) => void }) {
	const { groups } = useTaxonomy();
	const nav = useNavigate();
	if (!groups.length) return <Loader />;
	return (
		<>
			<Card className="mb-16" accent={COLORS.teal} title={<h2><span className="kw">Email</span> categories</h2>}
				sub="Every thread belongs to one group and one subgroup. The category report uses these as headings and subheadings."
				actions={<button className="btn sm" onClick={() => nav('/category-report')}>Open category report</button>} />
			{groups.map((g: Group) => (
				<Card key={g.key} accent={BUSINESS_COLORS[g.key] || COLORS.grey} className="mb-16" title={g.label} sub={g.description} flush>
					<table className="table">
						<thead><tr><th>Subgroup</th><th>What it covers</th><th>Default reply</th></tr></thead>
						<tbody>
							{g.subgroups.map((s) => (
								<tr key={s.key}>
									<td style={{ width: 240 }}><h3 className="report-sub">{s.label}</h3></td>
									<td className="small">{s.description}</td>
									<td className="small" style={{ width: 130 }}>{s.replies ? <a href="#templates" onClick={(e) => { e.preventDefault(); go('templates'); }}>Template</a> : <span className="faint">No reply needed</span>}</td>
								</tr>
							))}
						</tbody>
					</table>
				</Card>
			))}
		</>
	);
}

function Templates() {
	const { can } = useAuth();
	const toast = useToast();
	const qc = useQueryClient();
	const { groups, subLabel } = useTaxonomy();
	const { data, isLoading } = useQuery({ queryKey: ['templates'], queryFn: () => api('/templates') });
	const [edit, setEdit] = useState<any>(null);
	const [group, setGroup] = useState<string>('all');
	const save = useMutation({
		mutationFn: (t: any) => api(`/templates/${t.id}`, { method: 'PUT', body: { title: t.title, body: t.body, guidance: t.guidance, is_active: t.is_active } }),
		onSuccess: () => { qc.invalidateQueries({ queryKey: ['templates'] }); setEdit(null); toast('Template saved. New drafts will follow it.'); },
		onError: (e: any) => toast(e.message, 'error'),
	});
	const reset = useMutation({
		mutationFn: (id: number) => api(`/templates/${id}/reset`, { method: 'POST', body: {} }),
		onSuccess: () => { qc.invalidateQueries({ queryKey: ['templates'] }); setEdit(null); toast('Template restored to the default'); },
		onError: (e: any) => toast(e.message, 'error'),
	});
	if (isLoading || !groups.length) return <Loader />;
	const list: any[] = data.templates;
	const shown = groups.filter((g) => list.some((t) => t.group_key === g.key) && (group === 'all' || g.key === group));
	return (
		<>
			<Card className="mb-16" accent={COLORS.pink} title={<h2><span className="kw">Reply</span> templates</h2>}
				sub={`${list.length} default replies, one for each subgroup that normally needs an answer. Claude follows the template for the subgroup and writes it in French when the customer wrote in French. ${can('manager') ? 'Select Edit to change one.' : 'Managers can edit them.'}`}>
				<select className="input" style={{ maxWidth: 320 }} value={group} onChange={(e) => setGroup(e.target.value)} aria-label="Group">
					<option value="all">All groups</option>
					{groups.filter((g) => list.some((t) => t.group_key === g.key)).map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}
				</select>
			</Card>
			{shown.map((g) => (
				<Fragment key={g.key}>
					<h2 className="mb-8 mt-16" style={{ fontSize: 18 }}>{g.label}</h2>
					<div className="grid g-2 mb-16">
						{list.filter((t) => t.group_key === g.key).map((t) => (
							<Card key={t.id} accent={BUSINESS_COLORS[g.key] || COLORS.grey}
								title={<h3 className="report-sub" style={{ fontSize: 15 }}>{subLabel(t.group_key, t.subgroup_key) || t.title}</h3>}
								sub={<>{t.is_default ? 'Default wording' : `Edited ${ago(t.updated_at)}`}{!t.is_active && ' · switched off'}</>}
								actions={can('manager') && <button className="btn sm" onClick={() => setEdit({ ...t })}><MdEdit /> Edit</button>}>
								<TemplatePreview body={t.body} />
								{t.guidance && <div className="xs faint mt-8">Guidance: {t.guidance}</div>}
							</Card>
						))}
					</div>
				</Fragment>
			))}
			{edit && (
				<Modal wide title={`Edit template: ${subLabel(edit.group_key, edit.subgroup_key) || edit.title}`} onClose={() => setEdit(null)}
					footer={<>
						{!edit.is_default && <button className="btn" onClick={() => reset.mutate(edit.id)} disabled={reset.isPending}><MdRestore /> Restore default</button>}
						<span style={{ flex: 1 }} />
						<button className="btn" onClick={() => setEdit(null)}>Cancel</button>
						<button className="btn primary" onClick={() => save.mutate(edit)} disabled={save.isPending}>Save template</button>
					</>}>
					<div className="col gap-16">
						<div className="field"><label>Reply</label>
							<textarea className="input tpl-edit" value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} />
							<span className="hint">Fields: {'{{name}}'}, {'{{order_ref}}'}, {'{{unit}}'}, {'{{signature}}'}. Write {'[[provide: what the team must fill in]]'} for anything only the team knows.</span>
						</div>
						<div className="field"><label>Preview</label><TemplatePreview body={edit.body} /></div>
						<div className="field"><label>Guidance for Claude (optional)</label>
							<input className="input" value={edit.guidance} onChange={(e) => setEdit({ ...edit, guidance: e.target.value })} placeholder="For example: always offer a replacement first" />
						</div>
						<Switch checked={edit.is_active} onChange={(v) => setEdit({ ...edit, is_active: v })} label="Use this template for new drafts" />
					</div>
				</Modal>
			)}
		</>
	);
}

const KINDS = [
	{ v: 'book', l: 'Rates and services' },
	{ v: 'faq', l: 'FAQs' },
	{ v: 'policy', l: 'Policies' },
] as const;
const COLUMNS: Record<string, string> = {
	book: 'code, title, price, in_stock, notes, keywords (title = lane or service; price = rate)',
	faq: 'question, answer, keywords',
	policy: 'title, text, keywords',
};

function Reference() {
	const { can } = useAuth();
	const toast = useToast();
	const qc = useQueryClient();
	const [kind, setKind] = useState<'book' | 'faq' | 'policy'>('book');
	const [search, setSearch] = useState('');
	const [replace, setReplace] = useState(false);
	const [test, setTest] = useState('');
	const file = useRef<HTMLInputElement>(null);
	const { data, isLoading } = useQuery({ queryKey: ['reference', kind, search], queryFn: () => api(`/reference?kind=${kind}${search ? `&q=${encodeURIComponent(search)}` : ''}`) });
	const upload = useMutation({
		mutationFn: async (f: File) => api('/reference/import', { body: { kind, csv: await f.text(), replace } }),
		onSuccess: (r: any) => { qc.invalidateQueries({ queryKey: ['reference'] }); toast(`${r.added} added, ${r.updated} updated`); },
		onError: (e: any) => toast(e.message, 'error'),
	});
	const del = useMutation({
		mutationFn: (id: number) => api(`/reference/${id}`, { method: 'DELETE' }),
		onSuccess: () => qc.invalidateQueries({ queryKey: ['reference'] }),
	});
	const tryIt = useMutation({ mutationFn: () => api('/reference/test', { body: { text: test } }) });
	const sample = async () => {
		const res = await fetch(`/api/reference/sample/${kind}`, { headers: { authorization: `Bearer ${getToken()}` } });
		const a = document.createElement('a');
		a.href = URL.createObjectURL(await res.blob());
		a.download = `remail-${kind}-sample.csv`;
		a.click();
	};
	const counts = data?.counts || {};
	const items: any[] = useMemo(() => data?.items || [], [data]);
	return (
		<>
			<Card className="mb-16" accent={COLORS.teal} title={<h2><span className="kw">Reference</span> data</h2>}
				sub="Facts Claude may use in replies. For each email, the matching rates, services, FAQs and policies are added to what Claude reads, so fewer items are left in yellow.">
				<div className="row wrap gap-16">
					<Segmented value={kind} onChange={(v) => setKind(v)} options={KINDS.map((k) => ({ v: k.v, l: `${k.l} (${counts[k.v] || 0})` }))} />
				</div>
				<p className="small mt-16 mb-8">Upload a CSV file (save from Excel as CSV UTF-8) with these columns: <b>{COLUMNS[kind]}</b>. Rows with the same code are updated; keywords are separated by semicolons.</p>
				{can('manager') ? (
					<div className="row wrap gap-16">
						<input ref={file} type="file" accept=".csv,text/csv,.tsv" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) upload.mutate(f); e.target.value = ''; }} />
						<button className="btn primary" onClick={() => file.current?.click()} disabled={upload.isPending}><MdUpload /> {upload.isPending ? 'Uploading' : 'Upload CSV'}</button>
						<button className="btn" onClick={sample}><MdDownload /> Sample file</button>
						<Switch checked={replace} onChange={setReplace} label="Replace everything of this kind" />
					</div>
				) : <div className="small faint">Managers can upload reference data.</div>}
			</Card>
			<Card className="mb-16" title="Try matching" sub="Paste an email to see which entries Claude would be given.">
				<textarea className="input" style={{ width: '100%', minHeight: 90 }} value={test} onChange={(e) => setTest(e.target.value)} placeholder="Can you quote a 53 ft dry van from Toronto to Chicago next week? What are your detention charges?" />
				<div className="row mt-8"><button className="btn sm" onClick={() => tryIt.mutate()} disabled={!test.trim() || tryIt.isPending}>Show matches</button></div>
				{tryIt.data && (
					<div className="mt-8 small">
						{tryIt.data.matches.length ? tryIt.data.matches.map((m: any, i: number) => <div key={i}>· <b>{m.title}</b>: {m.text}</div>) : <span className="faint">No entries match this text.</span>}
					</div>
				)}
			</Card>
			<Card flush title={KINDS.find((k) => k.v === kind)!.l} sub={`${counts[kind] || 0} entries`}
				actions={<div className="row"><MdSearch className="faint" /><input className="input" style={{ width: 220 }} placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} /></div>}>
				{isLoading ? <Loader /> : items.length ? (
					<div className="table-wrap">
						<table className="table">
							<thead><tr>{kind === 'book' && <th>Code</th>}<th>{kind === 'faq' ? 'Question' : 'Title'}</th>{kind === 'book' ? <><th className="num">Rate</th><th>Available</th></> : <th>{kind === 'faq' ? 'Answer' : 'Text'}</th>}<th>Keywords</th><th /></tr></thead>
							<tbody>
								{items.map((it) => (
									<tr key={it.id}>
										{kind === 'book' && <td className="small">{it.code}</td>}
										<td><b>{it.title}</b>{kind === 'book' && it.body && <div className="xs faint">{it.body}</div>}</td>
										{kind === 'book' ? <><td className="num small">{it.data?.price}</td><td className="small">{it.data?.in_stock}</td></> : <td className="small">{it.body}</td>}
										<td className="xs faint">{(it.keywords || []).join('; ')}</td>
										<td>{can('manager') && <button className="btn ghost icon" aria-label="Delete" onClick={() => del.mutate(it.id)}><MdDelete /></button>}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				) : <div className="card-body faint">Nothing uploaded yet. Download the sample file to see the format.</div>}
			</Card>
		</>
	);
}
