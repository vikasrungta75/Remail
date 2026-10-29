import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { MdAdd, MdCheck, MdDelete, MdEdit, MdDoneAll, MdNotificationsActive } from 'react-icons/md';
import { api } from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { Card, Empty, Loader, Modal, PageHead, Segmented, StatusBadge, Switch } from '../components/ui';
import { COLORS, ago } from '../lib/format';

const RULE_TYPES: Record<string, { label: string; help: string }> = {
	rag_red: { label: 'Conversation turns red', help: 'Any conversation rated red.' },
	negative_key_customer: { label: 'Negative email from key customers', help: 'Negative sentiment from customers in the selected tiers.' },
	escalation_risk: { label: 'High escalation risk', help: 'Escalation risk score at or above the threshold.' },
	keyword: { label: 'Watch-words', help: 'Customer emails containing any of the listed phrases.' },
	sla_breach: { label: 'Reply SLA breach', help: 'Customer waiting longer than the set hours for a reply.' },
	health_drop: { label: 'Customer health drop', help: 'Health score falls by at least the set number of points.' },
};

export default function Alerts() {
	const { can } = useAuth();
	const nav = useNavigate();
	const toast = useToast();
	const qc = useQueryClient();
	const [tab, setTab] = useState<'feed' | 'rules'>('feed');
	const [status, setStatus] = useState<'open' | 'acknowledged' | 'resolved' | 'all'>('open');
	const feed = useQuery({ queryKey: ['alerts', status], queryFn: () => api(`/alerts?status=${status}`), refetchInterval: 30_000 });
	const rules = useQuery({ queryKey: ['alert-rules'], queryFn: () => api('/alert-rules'), enabled: tab === 'rules' });
	const act = useMutation({
		mutationFn: (a: { id: number; action: string }) => api(`/alerts/${a.id}/${a.action}`, { body: {} }),
		onSuccess: () => { qc.invalidateQueries({ queryKey: ['alerts'] }); qc.invalidateQueries({ queryKey: ['alert-counts'] }); },
	});
	const [edit, setEdit] = useState<any>(null);
	const saveRule = useMutation({
		mutationFn: (r: any) => {
			const body = {
				...r,
				recipients: String(r.recipientsText || '').split(',').map((s: string) => s.trim()).filter(Boolean),
				escalation_recipients: String(r.escText || '').split(',').map((s: string) => s.trim()).filter(Boolean),
				escalate_after_minutes: r.escalate_after_minutes === '' || r.escalate_after_minutes === null ? null : Number(r.escalate_after_minutes),
				params: r.rule_type === 'keyword' ? { keywords: String(r.keywordsText || '').split(',').map((s: string) => s.trim()).filter(Boolean) } : r.params,
			};
			return r.id ? api(`/alert-rules/${r.id}`, { method: 'PATCH', body }) : api('/alert-rules', { body });
		},
		onSuccess: () => { setEdit(null); qc.invalidateQueries({ queryKey: ['alert-rules'] }); toast('Alert rule saved'); },
		onError: (e: any) => toast(e.message, 'error'),
	});
	const delRule = useMutation({ mutationFn: (id: number) => api(`/alert-rules/${id}`, { method: 'DELETE' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['alert-rules'] }) });
	const toggle = useMutation({ mutationFn: (r: any) => api(`/alert-rules/${r.id}`, { method: 'PATCH', body: { enabled: !r.enabled } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['alert-rules'] }) });

	const openEdit = (r?: any) => setEdit(r ? {
		...r, recipientsText: (r.recipients || []).join(', '), escText: (r.escalation_recipients || []).join(', '),
		keywordsText: (r.params?.keywords || []).join(', '), escalate_after_minutes: r.escalate_after_minutes ?? '',
	} : { name: '', rule_type: 'rag_red', severity: 'high', channels: ['in_app', 'email'], params: {}, recipientsText: '', escText: '', escalate_after_minutes: 60, enabled: true });

	return (
		<>
			<PageHead kw="Alerts" rest="and escalations"
				sub="Raised automatically for high-risk communications. Unacknowledged alerts escalate to the next level after the time set on each rule." />
			<div className="tabs">
				<button className={tab === 'feed' ? 'on' : ''} onClick={() => setTab('feed')}>Alert feed {feed.data?.counts?.open ? `(${feed.data.counts.open})` : ''}</button>
				<button className={tab === 'rules' ? 'on' : ''} onClick={() => setTab('rules')}>Rules and recipients</button>
			</div>

			{tab === 'feed' && (
				<>
					<div className="row mb-16">
						<Segmented value={status} onChange={setStatus} options={[{ v: 'open', l: 'Open' }, { v: 'acknowledged', l: 'Acknowledged' }, { v: 'resolved', l: 'Resolved' }, { v: 'all', l: 'All' }]} />
					</div>
					<Card flush>
						{feed.isLoading ? <Loader /> : !feed.data?.rows?.length ? <Empty text="No alerts" icon={<MdNotificationsActive />} /> : feed.data.rows.map((a: any) => (
							<div key={a.id} className="list-item" style={{ cursor: 'default' }}>
								<span className="badge" style={{ background: a.severity === 'critical' ? COLORS.pink : a.severity === 'high' ? COLORS.amber : COLORS.blue, color: '#fff', alignSelf: 'flex-start' }}>
									{a.severity[0].toUpperCase() + a.severity.slice(1)}
								</span>
								<div className="grow">
									<div className="row-between">
										<span className="li-title cursor" onClick={() => a.conversation_id ? nav(`/conversations/${a.conversation_id}`) : a.customer_id && nav(`/customers/${a.customer_id}`)}>{a.title}</span>
										<span className="small faint nowrap">{ago(a.created_at)}</span>
									</div>
									<div className="small muted clamp-2" style={{ whiteSpace: 'pre-line' }}>{a.body.split('\n').slice(3, 6).join(' ')}</div>
									<div className="row wrap gap-4 mt-8">
										<StatusBadge s={a.status} />
										{a.rule_name && <span className="chip">{a.rule_name}</span>}
										{a.escalation_level > 0 && <span className="badge red">Escalated L{a.escalation_level}</span>}
										{a.acknowledged_by_name && <span className="xs faint">Acknowledged by {a.acknowledged_by_name} {ago(a.acknowledged_at)}</span>}
										{Object.entries(a.delivered || {}).map(([k, v]) => <span key={k} className="xs faint">{k.replace('_l', ' L')}: {String(v)}</span>)}
									</div>
								</div>
								{can('analyst') && (
									<div className="row" style={{ alignSelf: 'flex-start' }}>
										{a.status === 'open' && <button className="btn sm" onClick={() => act.mutate({ id: a.id, action: 'ack' })}><MdCheck /> Acknowledge</button>}
										{a.status !== 'resolved' && <button className="btn sm" onClick={() => act.mutate({ id: a.id, action: 'resolve' })}><MdDoneAll /> Resolve</button>}
										{a.status === 'resolved' && <button className="btn ghost sm" onClick={() => act.mutate({ id: a.id, action: 'reopen' })}>Reopen</button>}
									</div>
								)}
							</div>
						))}
					</Card>
				</>
			)}

			{tab === 'rules' && (
				<Card title="Alert rules" sub="Channels: in-app, email, Microsoft Teams and Slack webhooks" accent={COLORS.pink}
					actions={can('manager') && <button className="btn primary" onClick={() => openEdit()}><MdAdd /> New rule</button>} flush>
					{rules.isLoading ? <Loader /> : (
						<div className="table-wrap">
							<table className="table">
								<thead><tr><th>On</th><th>Rule</th><th>Trigger</th><th>Severity</th><th>Channels</th><th>Recipients</th><th>Escalation</th><th /></tr></thead>
								<tbody>
									{(rules.data?.rows || []).map((r: any) => (
										<tr key={r.id}>
											<td><Switch checked={r.enabled} onChange={() => can('manager') && toggle.mutate(r)} label="Enabled" /></td>
											<td style={{ fontWeight: 700 }}>{r.name}</td>
											<td className="small">{RULE_TYPES[r.rule_type]?.label}
												{r.rule_type === 'escalation_risk' && ` ≥ ${r.params?.threshold ?? 70}`}
												{r.rule_type === 'sla_breach' && ` > ${r.params?.hours ?? 4}h`}
												{r.rule_type === 'health_drop' && ` ≥ ${r.params?.points ?? 15} pts`}
												{r.rule_type === 'keyword' && <div className="xs faint clamp-2">{(r.params?.keywords || []).join(', ')}</div>}
											</td>
											<td><span className={`badge ${r.severity === 'critical' ? 'red' : r.severity === 'high' ? 'amber' : 'blue'}`}>{r.severity}</span></td>
											<td className="small">{(r.channels || []).map((c: string) => c.replace('in_app', 'in-app')).join(', ')}</td>
											<td className="small" style={{ maxWidth: 220 }}><span className="clamp-2">{(r.recipients || []).join(', ') || <span className="faint">Admins and managers</span>}</span></td>
											<td className="small">{r.escalate_after_minutes ? `After ${r.escalate_after_minutes} min` : <span className="faint">Off</span>}</td>
											<td className="nowrap">
												{can('manager') && <>
													<button className="btn ghost sm" onClick={() => openEdit(r)} aria-label="Edit"><MdEdit /></button>
													<button className="btn ghost sm" onClick={() => confirm('Delete this rule?') && delRule.mutate(r.id)} aria-label="Delete"><MdDelete /></button>
												</>}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)}
				</Card>
			)}

			{edit && (
				<Modal title={edit.id ? 'Edit alert rule' : 'New alert rule'} onClose={() => setEdit(null)}
					footer={<><button className="btn" onClick={() => setEdit(null)}>Cancel</button><button className="btn primary" onClick={() => saveRule.mutate(edit)} disabled={saveRule.isPending || !edit.name}>Save rule</button></>}>
					<div className="field"><label>Name</label><input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></div>
					<div className="grid g-2">
						<div className="field"><label>Trigger</label>
							<select className="input" value={edit.rule_type} onChange={(e) => setEdit({ ...edit, rule_type: e.target.value, params: {} })}>
								{Object.entries(RULE_TYPES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
							</select>
							<span className="hint">{RULE_TYPES[edit.rule_type]?.help}</span>
						</div>
						<div className="field"><label>Severity</label>
							<select className="input" value={edit.severity} onChange={(e) => setEdit({ ...edit, severity: e.target.value })}>
								<option value="medium">Medium</option><option value="high">High</option><option value="critical">Critical</option>
							</select>
						</div>
					</div>
					{edit.rule_type === 'escalation_risk' && <div className="field"><label>Risk threshold (0 to 100)</label><input className="input" type="number" value={edit.params?.threshold ?? 70} onChange={(e) => setEdit({ ...edit, params: { threshold: Number(e.target.value) } })} /></div>}
					{edit.rule_type === 'sla_breach' && <div className="field"><label>Hours without a reply</label><input className="input" type="number" value={edit.params?.hours ?? 4} onChange={(e) => setEdit({ ...edit, params: { hours: Number(e.target.value) } })} /></div>}
					{edit.rule_type === 'health_drop' && <div className="field"><label>Drop of at least (points)</label><input className="input" type="number" value={edit.params?.points ?? 15} onChange={(e) => setEdit({ ...edit, params: { points: Number(e.target.value) } })} /></div>}
					{edit.rule_type === 'negative_key_customer' && (
						<div className="field"><label>Customer tiers</label>
							<div className="row">{['strategic', 'key', 'standard'].map((t) => (
								<label key={t} className="row small"><input type="checkbox" checked={(edit.params?.tiers || ['strategic', 'key']).includes(t)}
									onChange={(e) => { const cur = edit.params?.tiers || ['strategic', 'key']; setEdit({ ...edit, params: { tiers: e.target.checked ? [...cur, t] : cur.filter((x: string) => x !== t) } }); }} /> {t}</label>
							))}</div>
						</div>
					)}
					{edit.rule_type === 'keyword' && <div className="field"><label>Watch-words</label><textarea className="input" value={edit.keywordsText} onChange={(e) => setEdit({ ...edit, keywordsText: e.target.value })} /><span className="hint">Comma separated, case-insensitive phrases</span></div>}
					<div className="field"><label>Channels</label>
						<div className="row wrap">{[['in_app', 'In-app'], ['email', 'Email'], ['teams', 'Microsoft Teams'], ['slack', 'Slack']].map(([k, l]) => (
							<label key={k} className="row small"><input type="checkbox" checked={edit.channels.includes(k)} onChange={(e) => setEdit({ ...edit, channels: e.target.checked ? [...edit.channels, k] : edit.channels.filter((x: string) => x !== k) })} /> {l}</label>
						))}</div>
					</div>
					<div className="field"><label>Email recipients</label><input className="input" value={edit.recipientsText} onChange={(e) => setEdit({ ...edit, recipientsText: e.target.value })} placeholder="cs-lead@wheelking.com, ops@wheelking.com" /><span className="hint">Admins and managers who opted in also receive alerts.</span></div>
					<div className="grid g-2">
						<div className="field"><label>Escalate if not acknowledged within (minutes)</label><input className="input" type="number" value={edit.escalate_after_minutes} onChange={(e) => setEdit({ ...edit, escalate_after_minutes: e.target.value })} placeholder="Leave empty to disable" /></div>
						<div className="field"><label>Escalation recipients</label><input className="input" value={edit.escText} onChange={(e) => setEdit({ ...edit, escText: e.target.value })} placeholder="head-of-cs@wheelking.com" /></div>
					</div>
				</Modal>
			)}
		</>
	);
}
