import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { MdAdd, MdSync, MdPause, MdPlayArrow, MdDelete, MdUpload, MdScience, MdMail, MdBusiness, MdInfoOutline, MdRestartAlt } from 'react-icons/md';
import { api } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { Card, Empty, Loader, Modal, PageHead } from '../../components/ui';
import { COLORS, ago } from '../../lib/format';

const PROVIDER: Record<string, string> = {
	microsoft_app: 'Microsoft 365 (organisation)',
	microsoft: 'Outlook (connected account)',
	gmail: 'Gmail',
	upload: 'Imported files',
	demo: 'Demo data',
};

export default function Mailboxes() {
	const { can } = useAuth();
	const toast = useToast();
	const qc = useQueryClient();
	const [sp, setSp] = useSearchParams();
	const [add, setAdd] = useState(false);
	const [addr, setAddr] = useState('');
	const [name, setName] = useState('');
	const [backfill, setBackfill] = useState(30);
	const fileRef = useRef<HTMLInputElement>(null);
	const { data, isLoading } = useQuery({ queryKey: ['mailboxes'], queryFn: () => api('/mailboxes'), refetchInterval: 15_000 });
	const refresh = () => { qc.invalidateQueries(); };

	useEffect(() => {
		if (sp.get('connected')) { toast(`Connected ${sp.get('connected')}. The first sync has started.`); setSp({}); }
		if (sp.get('error')) { toast(`Connection failed: ${sp.get('error')}`, 'error'); setSp({}); }
	}, [sp, setSp, toast]);

	const connect = useMutation({
		mutationFn: (provider: string) => api(`/connect/${provider}/start`, { body: { backfillDays: backfill } }),
		onSuccess: (r) => { window.location.href = r.url; },
		onError: (e: any) => toast(e.message, 'error'),
	});
	const addApp = useMutation({
		mutationFn: () => api('/mailboxes', { body: { address: addr, displayName: name, backfillDays: backfill } }),
		onSuccess: (mb) => { setAdd(false); setAddr(''); setName(''); refresh(); toast('Mailbox added. Starting the first sync.'); api(`/mailboxes/${mb.id}/sync`, { body: {} }).then(refresh).catch(() => {}); },
		onError: (e: any) => toast(e.message, 'error'),
	});
	const sync = useMutation({
		mutationFn: (id: number) => api(`/mailboxes/${id}/sync`, { body: {} }),
		onSuccess: (r) => { refresh(); toast(r.queued ? 'Sync started' : 'Sync complete'); },
		onError: (e: any) => toast(e.message, 'error'),
	});
	const patch = useMutation({ mutationFn: (b: { id: number; body: any }) => api(`/mailboxes/${b.id}`, { method: 'PATCH', body: b.body }), onSuccess: refresh });
	const remove = useMutation({ mutationFn: (b: { id: number; purge: boolean }) => api(`/mailboxes/${b.id}?purge=${b.purge}`, { method: 'DELETE' }), onSuccess: () => { refresh(); toast('Mailbox removed'); } });
	const demo = useMutation({
		mutationFn: (load: boolean) => api('/system/demo', { method: load ? 'POST' : 'DELETE', body: load ? {} : undefined }),
		onSuccess: (r, load) => { refresh(); toast(load ? `Demo data loaded: ${r.inserted} emails, ${r.duplicates} duplicates removed, ${r.analysed} conversations analysed` : 'Demo data removed'); },
		onError: (e: any) => toast(e.message, 'error'),
	});
	const upload = useMutation({
		mutationFn: async (files: FileList) => {
			const list = await Promise.all([...files].map((f) => new Promise<any>((res) => {
				const r = new FileReader();
				r.onload = () => res({ name: f.name, content: String(r.result).split(',')[1] });
				r.readAsDataURL(f);
			})));
			return api('/mailboxes/upload', { body: { files: list } });
		},
		onSuccess: (r) => { refresh(); toast(`Imported ${r.inserted} emails (${r.duplicates} duplicates, ${r.skipped} skipped), analysed ${r.analysed} conversations`); },
		onError: (e: any) => toast(e.message, 'error'),
	});

	const p = data?.providers || {};
	return (
		<>
			<PageHead kw="Mailboxes" rest="and connections" sub="remail reads email with read-only permissions. It never sends, moves or deletes anything in a monitored mailbox." />
			{can('admin') && (
				<div className="grid g-4 mb-16">
					<Card title="Microsoft 365 shared mailboxes" accent={COLORS.general}>
						<div className="small muted mb-16">For Wheel King production: application permission <b>Mail.Read</b>, limited to the monitored mailboxes by an Exchange access policy.</div>
						<button className="btn action" disabled={!p.microsoftApp} onClick={() => setAdd(true)}><MdBusiness /> Add mailbox</button>
						{!p.microsoftApp && <div className="xs faint mt-8">Set MS_TENANT_ID, MS_CLIENT_ID and MS_CLIENT_SECRET to enable.</div>}
					</Card>
					<Card title="Connect an Outlook account" accent={COLORS.blue}>
						<div className="small muted mb-16">Sign in with any Microsoft account to monitor that mailbox (delegated <b>Mail.Read</b>). Ideal for testing.</div>
						<button className="btn action" disabled={!p.microsoft || connect.isPending} onClick={() => connect.mutate('microsoft')}><MdMail /> Connect Outlook</button>
						{!p.microsoft && <div className="xs faint mt-8">Set MS_CLIENT_ID and MS_CLIENT_SECRET to enable.</div>}
					</Card>
					<Card title="Connect Gmail" accent={COLORS.pink}>
						<div className="small muted mb-16">Sign in with Google to test remail on a Gmail or Google Workspace mailbox (<b>gmail.readonly</b>).</div>
						<button className="btn primary" disabled={!p.google || connect.isPending} onClick={() => connect.mutate('google')}><MdMail /> Connect Gmail</button>
						{!p.google && <div className="xs faint mt-8">Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to enable.</div>}
					</Card>
					<Card title="Import or demo" accent={COLORS.amber}>
						<div className="small muted mb-16">Upload exported .eml files, or load a realistic Wheel King demo dataset.</div>
						<div className="row wrap">
							<input ref={fileRef} type="file" accept=".eml,message/rfc822" multiple hidden onChange={(e) => e.target.files?.length && upload.mutate(e.target.files)} />
							<button className="btn" onClick={() => fileRef.current?.click()} disabled={upload.isPending}><MdUpload /> {upload.isPending ? 'Importing…' : 'Upload .eml'}</button>
							<button className="btn" onClick={() => demo.mutate(true)} disabled={demo.isPending}><MdScience /> {demo.isPending ? 'Loading…' : 'Load demo'}</button>
						</div>
					</Card>
				</div>
			)}
			{can('admin') && (
				<div className="row mb-16 small muted">
					<MdInfoOutline /> When a new mailbox is connected, the first sync looks back
					<select className="input" style={{ width: 120, padding: '5px 8px' }} value={backfill} onChange={(e) => setBackfill(Number(e.target.value))} aria-label="Backfill">
						<option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option><option value={180}>180 days</option>
					</select>
				</div>
			)}
			<Card title="Monitored mailboxes" accent={COLORS.navy} flush
				actions={can('admin') && (data?.rows || []).some((m: any) => m.provider === 'demo') && <button className="btn danger sm" onClick={() => confirm('Remove all demo data?') && demo.mutate(false)}>Remove demo data</button>}>
				{isLoading ? <Loader /> : !data?.rows?.length ? <Empty text="No mailboxes connected yet" /> : (
					<div className="table-wrap">
						<table className="table">
							<thead><tr><th>Mailbox</th><th>Connection</th><th>Status</th><th className="num">Emails</th><th className="num">Duplicates</th><th>Last sync</th><th /></tr></thead>
							<tbody>
								{data.rows.map((m: any) => (
									<tr key={m.id}>
										<td><b>{m.display_name || m.address}</b><div className="xs faint">{m.address}</div></td>
										<td className="small">{PROVIDER[m.provider]}<div className="xs faint">backfill {m.backfill_days} days</div></td>
										<td>
											<span className={`badge ${m.status === 'active' ? 'green' : m.status === 'error' ? 'red' : m.status === 'paused' ? '' : 'amber'}`}>{m.status[0].toUpperCase() + m.status.slice(1)}</span>
											{m.last_error && <div className="xs" style={{ color: COLORS.red, maxWidth: 280 }}>{m.last_error}</div>}
										</td>
										<td className="num">{m.emails}</td>
										<td className="num">{m.duplicates}</td>
										<td className="small">
											{ago(m.last_synced_at)}
											{m.last_run && <div className="xs faint">{m.last_run.fetched} fetched · {m.last_run.inserted} new{m.last_run.error ? ' · failed' : ''}</div>}
										</td>
										<td className="nowrap">
											{['microsoft', 'microsoft_app', 'gmail'].includes(m.provider) && can('manager') && (
												<button className="btn sm" onClick={() => sync.mutate(m.id)} disabled={sync.isPending}><MdSync /> Sync</button>
											)}
											{can('admin') && <>
												{m.status === 'paused'
													? <button className="btn ghost sm" title="Resume" onClick={() => patch.mutate({ id: m.id, body: { status: 'active' } })}><MdPlayArrow /></button>
													: <button className="btn ghost sm" title="Pause" onClick={() => patch.mutate({ id: m.id, body: { status: 'paused' } })}><MdPause /></button>}
												{['microsoft', 'microsoft_app', 'gmail'].includes(m.provider) && <button className="btn ghost sm" title="Re-sync from scratch" onClick={() => confirm('Restart sync from the backfill window? Existing emails are kept and duplicates are skipped.') && patch.mutate({ id: m.id, body: { resetSync: true } })}><MdRestartAlt /></button>}
												<button className="btn ghost sm" title="Remove" onClick={() => {
													if (!confirm(`Stop monitoring ${m.address}?`)) return;
													remove.mutate({ id: m.id, purge: confirm('Also delete the emails and conversations that only came from this mailbox?') });
												}}><MdDelete /></button>
											</>}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</Card>
			{add && (
				<Modal title="Add a Microsoft 365 mailbox" onClose={() => setAdd(false)}
					footer={<><button className="btn" onClick={() => setAdd(false)}>Cancel</button><button className="btn primary" disabled={!addr || addApp.isPending} onClick={() => addApp.mutate()}><MdAdd /> Add mailbox</button></>}>
					<div className="field"><label>Mailbox address</label><input className="input" value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="customerservice@wheelking.com" /></div>
					<div className="field"><label>Display name</label><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Customer Service" /></div>
					<div className="field"><label>Look back</label>
						<select className="input" value={backfill} onChange={(e) => setBackfill(Number(e.target.value))}>
							<option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option><option value={180}>180 days</option>
						</select>
					</div>
					<div className="notice"><MdInfoOutline /><span className="small">The mailbox must be included in the application access policy for the remail app, otherwise Microsoft Graph returns "Access denied".</span></div>
				</Modal>
			)}
		</>
	);
}
