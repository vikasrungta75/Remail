import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MdAdd, MdEdit, MdLink, MdContentCopy } from 'react-icons/md';
import { api } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { Card, Loader, Modal, PageHead } from '../../components/ui';
import { COLORS, ago } from '../../lib/format';

const ROLES = [
	{ v: 'admin', l: 'Admin', d: 'Everything, including mailboxes, users and settings' },
	{ v: 'manager', l: 'Manager', d: 'All mailboxes, alert rules, reports, customer tiers' },
	{ v: 'analyst', l: 'Analyst', d: 'Work conversations: status, notes, actions' },
	{ v: 'viewer', l: 'Viewer', d: 'Read-only dashboards' },
];

export default function Users() {
	const { can, user: me } = useAuth();
	const toast = useToast();
	const qc = useQueryClient();
	const users = useQuery({ queryKey: ['users'], queryFn: () => api('/users') });
	const mbs = useQuery({ queryKey: ['mailboxes'], queryFn: () => api('/mailboxes') });
	const [edit, setEdit] = useState<any>(null);
	const [link, setLink] = useState<string | null>(null);
	const save = useMutation({
		mutationFn: (u: any) => u.id
			? api(`/users/${u.id}`, { method: 'PATCH', body: { role: u.role, fullName: u.full_name, isActive: u.is_active, allMailboxes: u.all_mailboxes, mailboxIds: u.mailbox_ids, emailAliases: String(u.aliasesText ?? (u.email_aliases || []).join(', ')).split(',').map((x: string) => x.trim()).filter(Boolean) } })
			: api('/users', { body: { email: u.email, fullName: u.full_name, role: u.role, allMailboxes: u.all_mailboxes, mailboxIds: u.mailbox_ids, authProvider: u.auth_provider } }),
		onSuccess: (r) => { setEdit(null); qc.invalidateQueries({ queryKey: ['users'] }); toast('User saved'); if (r?.inviteLink) setLink(r.inviteLink); },
		onError: (e: any) => toast(e.message, 'error'),
	});
	const reset = useMutation({ mutationFn: (id: number) => api(`/users/${id}/reset-link`, { body: {} }), onSuccess: (r) => setLink(r.link) });

	return (
		<>
			<PageHead kw="Users" rest="and access" sub="Role-based access, with optional restriction to specific mailboxes. Every sign-in and change is written to the audit log."
				actions={can('admin') && <button className="btn primary" onClick={() => setEdit({ email: '', full_name: '', role: 'analyst', all_mailboxes: true, mailbox_ids: [], is_active: true, auth_provider: 'local' })}><MdAdd /> Invite user</button>} />
			<Card flush accent={COLORS.purple}>
				{users.isLoading ? <Loader /> : (
					<div className="table-wrap">
						<table className="table">
							<thead><tr><th>User</th><th>Role</th><th>Mailbox access</th><th>Sign-in</th><th>Status</th><th>Last sign-in</th><th /></tr></thead>
							<tbody>
								{(users.data?.rows || []).map((u: any) => (
									<tr key={u.id}>
										<td><b>{u.full_name}</b><div className="xs faint">{u.email}</div></td>
										<td><span className={`badge ${u.role === 'admin' ? 'navy' : u.role === 'manager' ? 'purple' : u.role === 'analyst' ? 'blue' : ''}`}>{u.role}</span></td>
										<td className="small">{u.all_mailboxes || u.role === 'admin' || u.role === 'manager' ? 'All mailboxes' : `${u.mailbox_ids.length} mailbox${u.mailbox_ids.length === 1 ? '' : 'es'}`}</td>
										<td className="small">{u.auth_provider === 'ravity' ? 'Ravity sign-in' : u.auth_provider === 'google' ? 'Google' : u.auth_provider === 'microsoft' ? 'Microsoft' : 'Password'}</td>
										<td><span className={`badge ${u.is_active ? 'green' : ''}`}>{u.is_active ? 'Active' : 'Disabled'}</span></td>
										<td className="small">{ago(u.last_login_at)}</td>
										<td className="nowrap">
											{can('admin') && <>
												<button className="btn ghost sm" onClick={() => setEdit({ ...u })}><MdEdit /></button>
												{u.auth_provider === 'local' && <button className="btn ghost sm" title="Create password reset link" onClick={() => reset.mutate(u.id)}><MdLink /></button>}
											</>}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</Card>
			{edit && (
				<Modal title={edit.id ? 'Edit user' : 'Invite user'} onClose={() => setEdit(null)}
					footer={<><button className="btn" onClick={() => setEdit(null)}>Cancel</button><button className="btn primary" disabled={save.isPending || (!edit.id && !edit.email)} onClick={() => save.mutate(edit)}>{edit.id ? 'Save' : 'Send invite'}</button></>}>
					{!edit.id && <div className="field"><label>Email</label><input className="input" type="email" value={edit.email} onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></div>}
					<div className="field"><label>Full name</label><input className="input" value={edit.full_name} onChange={(e) => setEdit({ ...edit, full_name: e.target.value })} /></div>
					{edit.id && <div className="field"><label>Other email addresses</label><input className="input" value={edit.aliasesText ?? (edit.email_aliases || []).join(', ')} onChange={(e) => setEdit({ ...edit, aliasesText: e.target.value })} /><span className="hint">Used to attribute replies and build this person's individual view.</span></div>}
					{!edit.id && (
						<div className="field"><label>Sign-in method</label>
							<select className="input" value={edit.auth_provider} onChange={(e) => setEdit({ ...edit, auth_provider: e.target.value })}>
								<option value="local">Password (invite link by email)</option>
								<option value="ravity">Ravity sign-in (same as rfleet)</option>
								<option value="microsoft">Sign in with Microsoft</option>
								<option value="google">Sign in with Google</option>
							</select>
						</div>
					)}
					<div className="field"><label>Role</label>
						<select className="input" value={edit.role} onChange={(e) => setEdit({ ...edit, role: e.target.value })} disabled={edit.id === me?.id}>
							{ROLES.map((r) => <option key={r.v} value={r.v}>{r.l}: {r.d}</option>)}
						</select>
					</div>
					{(edit.role === 'analyst' || edit.role === 'viewer') && (
						<div className="field"><label>Mailbox access</label>
							<label className="row small"><input type="checkbox" checked={edit.all_mailboxes} onChange={(e) => setEdit({ ...edit, all_mailboxes: e.target.checked })} /> All mailboxes</label>
							{!edit.all_mailboxes && (mbs.data?.rows || []).map((m: any) => (
								<label key={m.id} className="row small"><input type="checkbox" checked={edit.mailbox_ids.includes(m.id)}
									onChange={(e) => setEdit({ ...edit, mailbox_ids: e.target.checked ? [...edit.mailbox_ids, m.id] : edit.mailbox_ids.filter((x: number) => x !== m.id) })} /> {m.display_name || m.address}</label>
							))}
						</div>
					)}
					{edit.id && edit.id !== me?.id && <label className="row small"><input type="checkbox" checked={edit.is_active} onChange={(e) => setEdit({ ...edit, is_active: e.target.checked })} /> Account active</label>}
				</Modal>
			)}
			{link && (
				<Modal title="Password link" onClose={() => setLink(null)}>
					<div className="small muted">Share this one-time link securely. It expires in one hour.</div>
					<div className="row"><input className="input mono" readOnly value={link} /><button className="btn" onClick={() => { navigator.clipboard.writeText(link); toast('Copied'); }}><MdContentCopy /></button></div>
				</Modal>
			)}
		</>
	);
}
