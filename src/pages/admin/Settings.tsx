import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MdCheckCircle, MdErrorOutline, MdSave } from 'react-icons/md';
import { api } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { Card, Loader, PageHead, Switch } from '../../components/ui';
import { COLORS, ago } from '../../lib/format';

const Status = ({ ok, label, detail }: { ok: boolean; label: string; detail?: string }) => (
	<div className="row-between mb-8">
		<span className="row">{ok ? <MdCheckCircle style={{ color: COLORS.green }} /> : <MdErrorOutline style={{ color: COLORS.amber }} />} {label}</span>
		<span className="small faint">{detail}</span>
	</div>
);

export default function Settings() {
	const { can } = useAuth();
	const toast = useToast();
	const qc = useQueryClient();
	const s = useQuery({ queryKey: ['settings'], queryFn: () => api('/settings') });
	const sys = useQuery({ queryKey: ['system-status'], queryFn: () => api('/system/status'), refetchInterval: 30_000 });
	const [form, setForm] = useState<any>(null);
	useEffect(() => {
		if (s.data) setForm({ name: s.data.name, internalDomains: s.data.internalDomains.join(', '), ...s.data.settings });
	}, [s.data]);
	const save = useMutation({
		mutationFn: () => api('/settings', {
			method: 'PATCH',
			body: {
				name: form.name,
				internalDomains: form.internalDomains.split(',').map((d: string) => d.trim()).filter(Boolean),
				settings: { slaHours: form.slaHours, piiRedaction: form.piiRedaction, retentionDays: form.retentionDays, analysisWindowDays: form.analysisWindowDays, ignoreAutomated: form.ignoreAutomated },
			},
		}),
		onSuccess: () => { qc.invalidateQueries(); toast('Settings saved'); },
		onError: (e: any) => toast(e.message, 'error'),
	});
	if (!form) return <Loader />;
	const d = sys.data;
	const admin = can('admin');
	return (
		<>
			<PageHead kw="Settings" rest="and system status" actions={admin && <button className="btn primary" onClick={() => save.mutate()} disabled={save.isPending}><MdSave /> Save settings</button>} />
			<div className="grid g-2">
				<div className="col gap-16">
					<Card title="Organisation" accent={COLORS.navy}>
						<div className="col gap-16">
							<div className="field"><label>Organisation name</label><input className="input" disabled={!admin} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
							<div className="field"><label>Internal email domains</label><input className="input" disabled={!admin} value={form.internalDomains} onChange={(e) => setForm({ ...form, internalDomains: e.target.value })} />
								<span className="hint">Senders on these domains are treated as your staff, so their emails count as replies, not customer messages.</span></div>
						</div>
					</Card>
					<Card title="Analysis and service levels" accent={COLORS.pink}>
						<div className="col gap-16">
							<div className="grid g-2">
								<div className="field"><label>Reply SLA (hours)</label><input className="input" type="number" disabled={!admin} value={form.slaHours} onChange={(e) => setForm({ ...form, slaHours: Number(e.target.value) })} /></div>
								<div className="field"><label>Health window (days)</label><input className="input" type="number" disabled={!admin} value={form.analysisWindowDays} onChange={(e) => setForm({ ...form, analysisWindowDays: Number(e.target.value) })} /></div>
							</div>
							<Switch checked={form.ignoreAutomated} onChange={(v) => admin && setForm({ ...form, ignoreAutomated: v })} label="Ignore newsletters, notifications and no-reply senders" />
						</div>
					</Card>
					<Card title="Data protection" accent={COLORS.purple}>
						<div className="col gap-16">
							<Switch checked={form.piiRedaction} onChange={(v) => admin && setForm({ ...form, piiRedaction: v })} label="Redact card, bank, ID and password details before AI analysis" />
							<div className="field"><label>Retain email bodies for (days)</label><input className="input" type="number" disabled={!admin} value={form.retentionDays} onChange={(e) => setForm({ ...form, retentionDays: Number(e.target.value) })} />
								<span className="hint">After this period the email text is erased; summaries, ratings and metrics are kept.</span></div>
						</div>
					</Card>
				</div>
				<div className="col gap-16">
					<Card title="System status" accent={COLORS.teal}>
						{!d ? <Loader /> : (
							<>
								<Status ok={d.ai.provider !== 'heuristic'} label="AI analysis" detail={d.ai.provider === 'heuristic' ? 'Built-in rules (add an AI key for full analysis)' : `${d.ai.provider} · ${d.ai.model}`} />
								<Status ok={d.mailer !== 'none'} label="Email delivery for alerts and reports" detail={d.mailer === 'none' ? 'Not configured' : d.mailer} />
								<Status ok={d.connectors.microsoftApp} label="Microsoft 365 organisation mailboxes" detail={d.connectors.microsoftApp ? 'Configured' : 'Not configured'} />
								<Status ok={d.connectors.microsoft} label="Outlook account connection" detail={d.connectors.microsoft ? 'Configured' : 'Not configured'} />
								<Status ok={d.connectors.google} label="Gmail connection" detail={d.connectors.google ? 'Configured' : 'Not configured'} />
								<Status ok={d.webhooks.teams || d.webhooks.slack} label="Teams or Slack alerts" detail={[d.webhooks.teams && 'Teams', d.webhooks.slack && 'Slack'].filter(Boolean).join(', ') || 'Not configured'} />
								<Status ok={d.auth !== 'local'} label="Sign-in" detail={d.auth === 'local' ? 'remail passwords' : d.auth === 'ravity' ? 'Ravity sign-in' : 'Ravity sign-in with password fallback'} />
								<Status ok={d.mailboxes.errors === 0} label="Mailboxes" detail={`${d.mailboxes.total} connected · ${d.mailboxes.errors} with errors`} />
								<Status ok={d.pendingAnalysis < 50} label="Analysis queue" detail={`${d.pendingAnalysis} conversations waiting`} />
								<div className="small faint mt-16">Last worker run {ago(d.lastWorkerRun)} · last mailbox sync {ago(d.mailboxes.last_synced)}</div>
							</>
						)}
					</Card>
					<Card title="AI usage this month" accent={COLORS.amber}>
						{d && (
							<div className="grid g-3">
								<div><div className="faint small">Calls</div><b style={{ fontSize: 20 }}>{d.aiUsageThisMonth.calls}</b></div>
								<div><div className="faint small">Input tokens</div><b style={{ fontSize: 20 }}>{d.aiUsageThisMonth.input_tokens.toLocaleString()}</b></div>
								<div><div className="faint small">Output tokens</div><b style={{ fontSize: 20 }}>{d.aiUsageThisMonth.output_tokens.toLocaleString()}</b></div>
							</div>
						)}
					</Card>
					<Card title="Security model" accent={COLORS.general}>
						<ul className="small muted" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8 }}>
							<li>Read-only Microsoft Graph and Gmail permissions</li>
							<li>OAuth refresh tokens encrypted at rest (AES-256-GCM)</li>
							<li>Signed sessions with server-side revocation and 12-hour expiry</li>
							<li>Role-based access with optional per-mailbox restriction</li>
							<li>Audit log of sign-ins, views, exports and configuration changes</li>
							<li>PII redaction before AI processing; configurable data retention</li>
						</ul>
					</Card>
				</div>
			</div>
		</>
	);
}
