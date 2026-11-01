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
				settings: { slaHours: form.slaHours, piiRedaction: form.piiRedaction, retentionDays: form.retentionDays, analysisWindowDays: form.analysisWindowDays, ignoreAutomated: form.ignoreAutomated, autoDrafts: form.autoDrafts, replyKnowledge: form.replyKnowledge, replySignature: form.replySignature, defaultBackfillDays: form.defaultBackfillDays, replyFooter: form.replyFooter, branches: form.branches, headOffice: form.headOffice },
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
							<Switch checked={form.ignoreAutomated} onChange={(v) => admin && setForm({ ...form, ignoreAutomated: v })} label="Skip newsletters and automated email entirely (by default they are stored, categorised and never sent to AI)" />
						</div>
					</Card>
					<Card title={<h2><span className="kw">Reply</span> drafts</h2>} accent={COLORS.amber} style={{ gridColumn: '1 / -1' }}
						sub="A complete reply is drafted for every email waiting on an answer. It stays in remail until someone presses Send.">
						<div className="col gap-16">
							<Switch checked={form.autoDrafts} onChange={(v) => admin && setForm({ ...form, autoDrafts: v })} label="Draft a reply for every email that needs one" />
							<div className="field"><label>Reference information for replies</label>
								<textarea className="input" rows={7} disabled={!admin} value={form.replyKnowledge || ''} onChange={(e) => setForm({ ...form, replyKnowledge: e.target.value })}
									placeholder={'Facts the AI may use instead of leaving a yellow placeholder, for example:\nFree time at shipper and consignee: 2 hours, then detention at 85 CAD per hour.\nStandard transit Toronto to Montreal: next day; Toronto to Chicago: 2 days.\nCertificates of insurance: request from safety@wheelking.com, sent within 1 business day.\nInvoices are payable in 30 days; remittance to accounts@wheelking.com.'} />
								<span className="hint">The AI uses these facts in drafts. Anything not covered here, or not in the email itself, is left as a yellow item for your team to fill in. The default reply for each subgroup and the rates, services, FAQs and policies are in <a href="/help#templates">Help and templates</a>.</span></div>
							<div className="grid g-2">
								<div className="field"><label>Signature</label><textarea className="input" rows={3} disabled={!admin} value={form.replySignature || ''} onChange={(e) => setForm({ ...form, replySignature: e.target.value })} /></div>
								<div className="field"><label>History read when a mailbox is first connected (days)</label>
									<select className="input" disabled={!admin} value={form.defaultBackfillDays || 90} onChange={(e) => setForm({ ...form, defaultBackfillDays: Number(e.target.value) })}>
										<option value={30}>30 days</option><option value={90}>90 days (recommended)</option><option value={180}>180 days</option><option value={365}>365 days</option>
									</select></div>
							</div>
							<Switch checked={form.replyFooter !== false} onChange={(v) => admin && setForm({ ...form, replyFooter: v })} label="Add the company name, address, website and logo under every reply" />
							{form.replyFooter !== false && (
								<>
									<div className="field">
										<label>Head office (used when the customer's city has no location below)</label>
										<div className="grid g-2">
											{([['name', 'Company name'], ['phone', 'Phone'], ['address', 'Address'], ['email', 'Email'], ['website', 'Website'], ['logoUrl', 'Logo image URL (https)']] as const).map(([k, l]) => (
												<input key={k} className="input sm" disabled={!admin} placeholder={l} aria-label={l} value={form.headOffice?.[k] || ''}
													onChange={(e) => setForm({ ...form, headOffice: { ...(form.headOffice || {}), [k]: e.target.value } })} />
											))}
										</div>
									</div>
									<div className="field">
										<label>Terminals and offices</label>
										<span className="hint">A customer in one of these cities sees that location's address; everyone else sees the head office.</span>
										<div className="table-wrap mt-8">
											<table className="table">
												<thead><tr><th>City</th><th>Province or state</th><th>Address</th><th>Phone</th><th>Email</th><th /></tr></thead>
												<tbody>
													{(form.branches || []).map((b: any, i: number) => (
														<tr key={i}>
															{(['city', 'state', 'address', 'phone', 'email'] as const).map((k) => (
																<td key={k} style={{ minWidth: k === 'address' ? 280 : 120 }}>
																	<input className="input sm" style={{ width: '100%' }} disabled={!admin} value={b[k] || ''} placeholder={k === 'address' ? 'Full address with postal code' : ''}
																		onChange={(e) => setForm({ ...form, branches: form.branches.map((x: any, j: number) => (j === i ? { ...x, [k]: e.target.value } : x)) })} />
																</td>
															))}
															<td>{admin && <button className="btn ghost sm" onClick={() => setForm({ ...form, branches: form.branches.filter((_x: any, j: number) => j !== i) })} aria-label="Remove">✕</button>}</td>
														</tr>
													))}
												</tbody>
											</table>
										</div>
										{admin && <button className="btn sm mt-8" onClick={() => setForm({ ...form, branches: [...(form.branches || []), { city: '', state: '', address: '', phone: '', email: '' }] })}>Add a location</button>}
									</div>
								</>
							)}
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
								<Status ok={d.connectors.googleWorkspace} label="Google Workspace shared mailboxes" detail={d.connectors.googleWorkspace ? d.connectors.googleServiceAccount : 'Set GOOGLE_SERVICE_ACCOUNT_JSON'} />
								<Status ok={d.connectors.google} label="Sign in with Google and own Gmail" detail={d.connectors.google ? 'Enabled' : 'Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET'} />
								<Status ok={d.webhooks.teams || d.webhooks.slack} label="Teams or Slack alerts" detail={[d.webhooks.teams && 'Teams', d.webhooks.slack && 'Slack'].filter(Boolean).join(', ') || 'Not configured'} />
								<Status ok={d.gmailSend} label="Send replies through Gmail" detail={d.gmailSend ? 'Enabled: replies go out only when someone presses Send' : 'Off (GMAIL_SEND_ENABLED=false)'} />
								{d.progress && (
									<>
										<Status ok={!d.progress.waiting_for_analysis} label="Analysis progress" detail={`${d.progress.analysed_by_ai} analysed by AI · ${d.progress.waiting_for_analysis} waiting · ${d.progress.rules_engine_fallback} on the rules engine for now`} />
										{d.progress.ai_paused_until && new Date(d.progress.ai_paused_until) > new Date() && (
											<Status ok={false} label="AI paused: quota reached" detail={`Resumes ${new Date(d.progress.ai_paused_until).toLocaleString()}. Enable billing on the Google Cloud project, or set AI_MIN_INTERVAL_MS, to go faster.`} />
										)}
										{d.progress.ai_last_error && <Status ok={false} label="Last AI error" detail={`${d.progress.ai_last_error}${d.progress.ai_last_error_at ? ` (${new Date(d.progress.ai_last_error_at).toLocaleString()})` : ''}`} />}
									</>
								)}
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
							<li>Gmail read-only access for analysis; replies are sent only when a person presses Send</li>
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
