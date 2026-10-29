import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MdAdd, MdDelete, MdEdit, MdSend, MdVisibility } from 'react-icons/md';
import { api } from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { Card, Empty, Loader, Modal, PageHead, Switch } from '../components/ui';
import { COLORS, ago, fmtDate, fmtDateTime } from '../lib/format';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export default function Reports() {
	const { can } = useAuth();
	const toast = useToast();
	const qc = useQueryClient();
	const schedules = useQuery({ queryKey: ['report-schedules'], queryFn: () => api('/reports/schedules') });
	const runs = useQuery({ queryKey: ['report-runs'], queryFn: () => api('/reports/runs') });
	const [preview, setPreview] = useState<string | null>(null);
	const [edit, setEdit] = useState<any>(null);
	const [days, setDays] = useState(7);

	const doPreview = useMutation({ mutationFn: () => api('/reports/preview', { body: { days } }), onSuccess: (r) => setPreview(r.html), onError: (e: any) => toast(e.message, 'error') });
	const openRun = async (id: number) => setPreview((await api(`/reports/runs/${id}`)).html);
	const send = useMutation({
		mutationFn: (id: number) => api(`/reports/schedules/${id}/send`, { body: {} }),
		onSuccess: (r) => { qc.invalidateQueries({ queryKey: ['report-runs'] }); toast(r.status === 'sent' ? 'Report sent' : `Report generated (delivery: ${r.status})`); },
		onError: (e: any) => toast(e.message, 'error'),
	});
	const save = useMutation({
		mutationFn: (s: any) => {
			const body = { ...s, recipients: String(s.recipientsText || '').split(',').map((x: string) => x.trim()).filter(Boolean) };
			return s.id ? api(`/reports/schedules/${s.id}`, { method: 'PATCH', body }) : api('/reports/schedules', { body });
		},
		onSuccess: () => { setEdit(null); qc.invalidateQueries({ queryKey: ['report-schedules'] }); toast('Schedule saved'); },
		onError: (e: any) => toast(e.message, 'error'),
	});
	const del = useMutation({ mutationFn: (id: number) => api(`/reports/schedules/${id}`, { method: 'DELETE' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['report-schedules'] }) });
	const toggle = useMutation({ mutationFn: (s: any) => api(`/reports/schedules/${s.id}`, { method: 'PATCH', body: { enabled: !s.enabled } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['report-schedules'] }) });

	const when = (s: any) => {
		const t = `${String(s.hour_utc).padStart(2, '0')}:00 UTC`;
		if (s.frequency === 'daily') return `Every day at ${t}`;
		if (s.frequency === 'weekly') return `Every ${DAYS[s.day_of_week]} at ${t}`;
		return `Monthly on day ${s.day_of_month} at ${t}`;
	};

	return (
		<>
			<PageHead kw="Reports" rest="and scheduled delivery" sub="Branded summaries of communication health, delivered by email on a schedule."
				actions={<>
					<select className="input" style={{ width: 150 }} value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Period">
						<option value={1}>Last 24 hours</option><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option>
					</select>
					<button className="btn" onClick={() => doPreview.mutate()} disabled={doPreview.isPending}><MdVisibility /> {doPreview.isPending ? 'Building…' : 'Preview report'}</button>
					{can('manager') && <button className="btn primary" onClick={() => setEdit({ name: '', frequency: 'weekly', hour_utc: 7, day_of_week: 1, day_of_month: 1, recipientsText: '', enabled: true })}><MdAdd /> New schedule</button>}
				</>} />
			<div className="grid g-1-2">
				<Card title="Schedules" accent={COLORS.pink} flush>
					{schedules.isLoading ? <Loader /> : !schedules.data?.rows?.length ? <Empty text="No schedules yet" /> : schedules.data.rows.map((s: any) => (
						<div key={s.id} className="list-item" style={{ cursor: 'default' }}>
							<div className="grow">
								<div className="row-between"><span className="li-title">{s.name}</span><Switch checked={s.enabled} onChange={() => can('manager') && toggle.mutate(s)} label="Enabled" /></div>
								<div className="small muted">{when(s)}</div>
								<div className="xs faint clamp-2">{(s.recipients || []).join(', ') || 'No recipients'}</div>
								<div className="xs faint">Last sent {ago(s.last_run_at)}</div>
								{can('manager') && (
									<div className="row mt-8">
										<button className="btn sm" onClick={() => send.mutate(s.id)} disabled={send.isPending}><MdSend /> Send now</button>
										<button className="btn ghost sm" onClick={() => setEdit({ ...s, recipientsText: (s.recipients || []).join(', ') })}><MdEdit /> Edit</button>
										<button className="btn ghost sm" onClick={() => confirm('Delete this schedule?') && del.mutate(s.id)}><MdDelete /></button>
									</div>
								)}
							</div>
						</div>
					))}
				</Card>
				<Card title="Report history" accent={COLORS.general} flush>
					{runs.isLoading ? <Loader /> : !runs.data?.rows?.length ? <Empty text="No reports generated yet" /> : (
						<div className="table-wrap">
							<table className="table">
								<thead><tr><th>Report</th><th>Period</th><th className="num">Conversations</th><th className="num">Red</th><th className="num">Negative</th><th>Delivery</th><th /></tr></thead>
								<tbody>
									{runs.data.rows.map((r: any) => (
										<tr key={r.id} className="click" onClick={() => openRun(r.id)}>
											<td><b>{r.schedule_name || 'Ad hoc'}</b><div className="xs faint">{fmtDateTime(r.created_at)}</div></td>
											<td className="small">{fmtDate(r.period_start, 'd MMM')} to {fmtDate(r.period_end, 'd MMM')}</td>
											<td className="num">{r.summary?.conversations}</td>
											<td className="num" style={{ color: COLORS.red }}>{r.summary?.red}</td>
											<td className="num">{r.summary?.negativePct}%</td>
											<td><span className={`badge ${r.delivery_status === 'sent' ? 'green' : r.delivery_status.startsWith('error') ? 'red' : ''}`}>{r.delivery_status.slice(0, 40)}</span></td>
											<td><MdVisibility className="faint" /></td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)}
				</Card>
			</div>

			{preview && (
				<Modal title="Report preview" onClose={() => setPreview(null)} wide>
					<iframe title="Report" srcDoc={preview} style={{ width: '100%', height: '70vh', border: 0, borderRadius: 12, background: '#F4F5F9' }} sandbox="" />
				</Modal>
			)}
			{edit && (
				<Modal title={edit.id ? 'Edit schedule' : 'New report schedule'} onClose={() => setEdit(null)}
					footer={<><button className="btn" onClick={() => setEdit(null)}>Cancel</button><button className="btn primary" disabled={!edit.name || save.isPending} onClick={() => save.mutate(edit)}>Save</button></>}>
					<div className="field"><label>Name</label><input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="Weekly executive summary" /></div>
					<div className="grid g-3">
						<div className="field"><label>Frequency</label>
							<select className="input" value={edit.frequency} onChange={(e) => setEdit({ ...edit, frequency: e.target.value })}>
								<option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option>
							</select>
						</div>
						{edit.frequency === 'weekly' && <div className="field"><label>Day</label><select className="input" value={edit.day_of_week} onChange={(e) => setEdit({ ...edit, day_of_week: Number(e.target.value) })}>{DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</select></div>}
						{edit.frequency === 'monthly' && <div className="field"><label>Day of month</label><input className="input" type="number" min={1} max={28} value={edit.day_of_month} onChange={(e) => setEdit({ ...edit, day_of_month: Number(e.target.value) })} /></div>}
						<div className="field"><label>Hour (UTC)</label><input className="input" type="number" min={0} max={23} value={edit.hour_utc} onChange={(e) => setEdit({ ...edit, hour_utc: Number(e.target.value) })} /></div>
					</div>
					<div className="field"><label>Recipients</label><textarea className="input" value={edit.recipientsText} onChange={(e) => setEdit({ ...edit, recipientsText: e.target.value })} placeholder="md@wheelking.com, cs-team@wheelking.com" /><span className="hint">Comma separated email addresses</span></div>
				</Modal>
			)}
		</>
	);
}
