import { Fragment, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { MdArrowBack, MdAutoAwesome, MdContentCopy, MdRefresh, MdOpenInNew, MdCheckCircle, MdRadioButtonUnchecked, MdAttachFile, MdAdd } from 'react-icons/md';
import { downloadIcs } from './MyDay';
import { api } from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { useFilterOptions } from '../components/FilterBar';
import { Card, Empty, Health, Loader, RagBadge, SentimentBadge, StateBadge, StatusBadge, TierBadge, UrgencyBadge } from '../components/ui';
import { BUSINESS_COLORS, BUSINESS_LABELS, COLORS, STAGE_LABELS, ago, bizLabel, catLabel, fmtDate, fmtDateTime, minutes, hoursSince } from '../lib/format';

export default function ConversationDetail() {
	const { id } = useParams();
	const nav = useNavigate();
	const { can } = useAuth();
	const toast = useToast();
	const qc = useQueryClient();
	const opts = useFilterOptions();
	const [note, setNote] = useState('');
	const [showDupes, setShowDupes] = useState(false);
	const { data, isLoading, error } = useQuery({ queryKey: ['conversation', id], queryFn: () => api(`/conversations/${id}`) });
	const refresh = () => {
		qc.invalidateQueries({ queryKey: ['conversation', id] });
		qc.invalidateQueries({ queryKey: ['conversations'] });
		qc.invalidateQueries({ queryKey: ['summary'] });
	};
	const update = useMutation({ mutationFn: (body: any) => api(`/conversations/${id}`, { method: 'PATCH', body }), onSuccess: () => { refresh(); toast('Conversation updated'); }, onError: (e: any) => toast(e.message, 'error') });
	const reanalyse = useMutation({ mutationFn: () => api(`/conversations/${id}/reanalyse`, { body: {} }), onSuccess: () => { refresh(); toast('Re-analysed'); }, onError: (e: any) => toast(e.message, 'error') });
	const addNote = useMutation({ mutationFn: () => api(`/conversations/${id}/notes`, { body: { body: note } }), onSuccess: () => { setNote(''); refresh(); } });
	const [newAction, setNewAction] = useState<{ description: string; dueDate: string } | null>(null);
	const addAction = useMutation({
		mutationFn: () => api('/actions', { body: { ...newAction, conversationId: Number(id) } }),
		onSuccess: () => { setNewAction(null); refresh(); toast('Action added'); },
		onError: (e: any) => toast(e.message, 'error'),
	});
	const setAction = useMutation({ mutationFn: (a: { id: number; status: string }) => api(`/actions/${a.id}`, { method: 'PATCH', body: { status: a.status } }), onSuccess: refresh });

	if (isLoading) return <Loader />;
	if (error || !data) return <Empty text={(error as any)?.message || 'Conversation not found'} />;
	const c = data.conversation;
	const emails = data.emails.filter((e: any) => showDupes || !e.is_duplicate);
	const dupes = data.emails.filter((e: any) => e.is_duplicate).length;
	const ent = c.entities || {};
	const entityGroups: [string, string[]][] = [
		['Shipments', ent.shipment_refs], ['Invoices', ent.invoice_refs], ['Vehicles', ent.vehicle_regs], ['Amounts', ent.amounts], ['Locations', ent.locations],
	].filter(([, v]) => Array.isArray(v) && v.length) as any;

	return (
		<>
			<button className="btn ghost sm mb-8" onClick={() => nav(-1)}><MdArrowBack /> Back</button>
			<div className="page-head">
				<div className="grow">
					<div className="row wrap mb-8">
						<span className="badge" style={{ background: (BUSINESS_COLORS[c.business_category] || '#ccc') + '22', color: 'var(--text)' }}>{bizLabel(c.business_category)}</span>
						{c.is_internal && <span className="badge navy">Internal</span>}
						{c.is_automated && <span className="badge">Automated</span>}
						<RagBadge rag={c.rag} />
						<SentimentBadge s={c.sentiment} score={c.sentiment_score} />
						<UrgencyBadge u={c.urgency} />
						<StatusBadge s={c.status} />
						{c.awaiting_reply && c.status !== 'resolved' && <span className={`badge ${hoursSince(c.last_inbound_at) > 4 ? 'red' : 'amber'}`}>Awaiting reply {Math.round(hoursSince(c.last_inbound_at))}h</span>}
					</div>
					<h1 style={{ fontSize: 22 }}>{c.subject || '(no subject)'}</h1>
					<p className="row wrap">
						{c.customer_id ? <Link to={`/customers/${c.customer_id}`} style={{ fontWeight: 700 }}>{c.customer_name || 'Unknown'}</Link> : <b>{c.is_automated ? 'Automated sender' : 'Internal thread'}</b>}
						<TierBadge tier={c.customer_tier} />
						<span className="faint">· {c.message_count} messages · started {fmtDate(c.first_message_at)} · last {ago(c.last_message_at)}</span>
					</p>
				</div>
				{can('analyst') && (
					<div className="row wrap">
						<select className="input" style={{ width: 160 }} value={c.status} onChange={(e) => update.mutate({ status: e.target.value })} aria-label="Status">
							<option value="open">Open</option>
							<option value="in_progress">In progress</option>
							<option value="resolved">Resolved</option>
							<option value="ignored">Ignore</option>
						</select>
						<select className="input" style={{ width: 190 }} value={c.assignee_id || ''} onChange={(e) => update.mutate({ assigneeId: e.target.value ? Number(e.target.value) : null })} aria-label="Assignee">
							<option value="">Unassigned</option>
							{(opts.data?.users || []).map((u: any) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
						</select>
						<select className="input" style={{ width: 230 }} value={c.business_category} onChange={(e) => update.mutate({ businessCategory: e.target.value })} aria-label="Email type" title="Correct the email type">
							{Object.entries(BUSINESS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
						</select>
						<button className="btn" onClick={() => reanalyse.mutate()} disabled={reanalyse.isPending}><MdRefresh /> {reanalyse.isPending ? 'Analysing…' : 'Re-analyse'}</button>
					</div>
				)}
			</div>

			<div className="grid g-2-1">
				<div className="col gap-16">
					<Card accent={COLORS.pink}>
						<div className="summary-box" style={{ border: 0, padding: 0 }}>
							<div className="lbl"><MdAutoAwesome /> AI summary</div>
							<div style={{ fontSize: 15, lineHeight: 1.6 }}>{c.summary || 'Analysis pending.'}</div>
						</div>
						{c.rag_reason && (
							<div className="mt-16 small">
								<span className="faint">Why {c.rag || 'this rating'}: </span>{c.rag_reason}
							</div>
						)}
						<div className="faint xs mt-8">Model: {c.analysis_model || 'n/a'} · analysed {ago(c.analysed_at)}</div>
					</Card>

					<Card title={`Email thread (${data.emails.length - dupes})`} sub={dupes ? `${dupes} duplicate copies from other mailboxes were excluded from analysis` : 'Oldest first'}
						actions={dupes ? <label className="row small"><input type="checkbox" checked={showDupes} onChange={(e) => setShowDupes(e.target.checked)} /> Show duplicates</label> : null}>
						<div className="thread">
							{emails.map((e: any) => (
								<div key={e.id} className={`msg ${e.direction} ${e.is_duplicate ? 'duplicate' : ''}`}>
									<div className="msg-head">
										<div>
											<div style={{ fontWeight: 700 }}>{e.from_name || e.from_address} <span className="faint small">&lt;{e.from_address}&gt;</span></div>
											<div className="xs faint">to {(e.to_addresses || []).join(', ')}{e.cc_addresses?.length ? ` · cc ${e.cc_addresses.join(', ')}` : ''}</div>
										</div>
										<div className="row wrap" style={{ alignItems: 'flex-start' }}>
											{e.is_duplicate && <span className="badge"><MdContentCopy /> Duplicate</span>}
											<span className="chip">{e.direction === 'inbound' ? 'Customer' : e.direction === 'outbound' ? 'Our reply' : 'Internal'}</span>
											{e.direction === 'inbound' && <SentimentBadge s={e.sentiment} score={e.sentiment_score} />}
											{e.has_attachments && <MdAttachFile className="faint" title="Has attachments" />}
											<span className="small faint nowrap">{fmtDateTime(e.sent_at)}</span>
											{e.web_link && <a href={e.web_link} target="_blank" rel="noreferrer" title="Open in mailbox"><MdOpenInNew /></a>}
										</div>
									</div>
									<div className="msg-body">{e.body_clean || e.body_text}</div>
									<div className="xs faint" style={{ padding: '0 16px 10px' }}>Mailbox: {e.mailbox_address}</div>
								</div>
							))}
						</div>
					</Card>
				</div>

				<div className="col gap-16">
					{c.business_category === 'sales_proposal' && (
						<Card title={<h2><span className="kw">Proposal</span> tracker</h2>} accent={COLORS.purple}>
							<div className="kv">
								<span className="k">Stage</span>
								<span>{can('analyst') ? (
									<select className="input" style={{ padding: '4px 8px' }} value={c.proposal_stage || 'request_received'} onChange={(e) => update.mutate({ proposalStage: e.target.value })} aria-label="Proposal stage">
										{Object.entries(STAGE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
									</select>
								) : STAGE_LABELS[c.proposal_stage] || 'Request received'}</span>
								{c.proposal?.kind && <><span className="k">Type</span><span>{String(c.proposal.kind).replace(/_/g, ' ')}</span></>}
								{c.proposal?.deadline && <><span className="k">Deadline</span><span><b>{fmtDate(c.proposal.deadline)}</b></span></>}
								{c.proposal?.value && <><span className="k">Value or rates</span><span>{c.proposal.value}</span></>}
								{c.proposal?.lanes_or_scope && <><span className="k">Scope</span><span>{c.proposal.lanes_or_scope}</span></>}
								{c.proposal?.next_step && <><span className="k">Next step</span><span>{c.proposal.next_step}</span></>}
							</div>
						</Card>
					)}
					<Card title="Details" accent={COLORS.navy}>
						<div className="kv">
							<span className="k">Customer health</span><span><Health score={c.customer_health} /></span>
							<span className="k">Customer state</span><span><StateBadge s={c.customer_state} /></span>
							<span className="k">Escalation risk</span><span><b>{c.escalation_risk ?? 'n/a'}</b>/100</span>
							<span className="k">Priority</span><span><b>{c.priority_score}</b>/100</span>
							<span className="k">First response</span><span>{minutes(c.first_response_minutes)}</span>
							<span className="k">Issue types</span><span className="row wrap gap-4">{(c.categories || []).map((x: string) => <span key={x} className="chip">{catLabel(x)}</span>)}</span>
							{c.topics?.length > 0 && <><span className="k">Topics</span><span className="small">{c.topics.join(', ')}</span></>}
							<span className="k">Assigned to</span><span>{c.assignee_name || 'Unassigned'}</span>
						</div>
					</Card>

					{data.issues.length > 0 && (
						<Card title="Issues detected" accent={COLORS.amber}>
							<div className="col gap-12">
								{data.issues.map((i: any) => (
									<div key={i.id}>
										<div className="row"><span className={`badge ${i.severity === 'critical' || i.severity === 'high' ? 'red' : i.severity === 'medium' ? 'amber' : ''}`}>{i.severity}</span><b>{catLabel(i.category)}</b></div>
										<div className="small muted mt-8">{i.description}</div>
									</div>
								))}
							</div>
						</Card>
					)}

					<Card title="Actions and commitments" accent={COLORS.general}
						actions={can('analyst') && <button className="btn sm" onClick={() => setNewAction({ description: '', dueDate: '' })}><MdAdd /> Add</button>}>
						{newAction && (
							<div className="col gap-8 mb-16">
								<input className="input" placeholder="What needs to be done" value={newAction.description} onChange={(e) => setNewAction({ ...newAction, description: e.target.value })} autoFocus />
								<div className="row">
									<input type="date" className="input" value={newAction.dueDate} onChange={(e) => setNewAction({ ...newAction, dueDate: e.target.value })} aria-label="Due date" />
									<button className="btn primary sm" disabled={!newAction.description.trim()} onClick={() => addAction.mutate()}>Save</button>
									<button className="btn ghost sm" onClick={() => setNewAction(null)}>Cancel</button>
								</div>
							</div>
						)}
						{data.actions.length ? (
							<div className="col gap-12">
								{data.actions.map((a: any) => (
									<div key={a.id} className="row" style={{ alignItems: 'flex-start' }}>
										<button className="btn ghost icon" style={{ padding: 2 }} disabled={!can('analyst')}
											onClick={() => setAction.mutate({ id: a.id, status: a.status === 'done' ? 'open' : 'done' })} aria-label="Toggle done">
											{a.status === 'done' ? <MdCheckCircle style={{ color: COLORS.green, fontSize: 20 }} /> : <MdRadioButtonUnchecked style={{ fontSize: 20, color: 'var(--text-3)' }} />}
										</button>
										<div className="grow">
											<div className="small" style={{ textDecoration: a.status === 'done' ? 'line-through' : 'none' }}>{a.description}</div>
											<div className="row wrap gap-4 mt-8">
												<span className={`badge ${a.owner_side === 'us' ? 'blue' : 'purple'}`}>{a.owner_side === 'us' ? 'Owed by us' : 'Customer'}</span>
												{a.is_commitment && <span className="badge teal">Commitment</span>}
												{a.due_date && <span className={`badge ${a.status === 'open' && new Date(a.due_date) < new Date(new Date().toDateString()) ? 'red' : ''}`}>Due {fmtDate(a.due_date)}</span>}
												{a.assignee_name && <span className="chip">{a.assignee_name}</span>}
												<a className="xs" style={{ cursor: 'pointer' }} onClick={() => downloadIcs(a.id)}>Add to Outlook</a>
											</div>
										</div>
									</div>
								))}
							</div>
						) : <div className="faint small">No action items found</div>}
					</Card>

					{c.suggested_reply && (
						<Card title="Suggested reply" sub="Draft only. remail never sends email from your mailboxes." accent={COLORS.blue}
							actions={<button className="btn sm" onClick={() => { navigator.clipboard.writeText(c.suggested_reply); toast('Copied to clipboard'); }}><MdContentCopy /> Copy</button>}>
							<div className="small" style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{c.suggested_reply}</div>
						</Card>
					)}

					{entityGroups.length > 0 && (
						<Card title="Key references" accent={COLORS.teal}>
							<div className="kv">
								{entityGroups.map(([k, v]) => (
									<Fragment key={k}><span className="k">{k}</span><span className="row wrap gap-4">{v.map((x) => <span key={x} className="chip mono">{x}</span>)}</span></Fragment>
								))}
							</div>
						</Card>
					)}

					<Card title="Team notes" accent={COLORS.purple}>
						<div className="col gap-12">
							{data.notes.map((n: any) => (
								<div key={n.id} className="small">
									<div style={{ whiteSpace: 'pre-wrap' }}>{n.body}</div>
									<div className="xs faint">{n.author} · {ago(n.created_at)}</div>
								</div>
							))}
							{can('analyst') && (
								<>
									<textarea className="input" placeholder="Add a note for the team" value={note} onChange={(e) => setNote(e.target.value)} />
									<button className="btn sm" style={{ alignSelf: 'flex-end' }} disabled={!note.trim() || addNote.isPending} onClick={() => addNote.mutate()}>Add note</button>
								</>
							)}
						</div>
					</Card>

					{data.alerts.length > 0 && (
						<Card title="Alerts raised" accent={COLORS.red}>
							{data.alerts.map((a: any) => (
								<div key={a.id} className="row-between small mb-8">
									<span className="truncate">{a.title}</span>
									<StatusBadge s={a.status} />
								</div>
							))}
						</Card>
					)}
				</div>
			</div>
		</>
	);
}
