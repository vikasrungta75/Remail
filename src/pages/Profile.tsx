import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { Card, PageHead, Switch } from '../components/ui';
import { COLORS } from '../lib/format';

export default function Profile() {
	const { user, refresh } = useAuth();
	const toast = useToast();
	const [name, setName] = useState(user?.fullName || '');
	const [notify, setNotify] = useState(user?.notifyEmail ?? true);
	const [cur, setCur] = useState('');
	const [pw, setPw] = useState('');
	const save = useMutation({ mutationFn: () => api('/auth/profile', { method: 'PATCH', body: { fullName: name, notifyEmail: notify } }), onSuccess: () => { refresh(); toast('Profile saved'); } });
	const change = useMutation({
		mutationFn: () => api('/auth/change-password', { body: { currentPassword: cur, newPassword: pw } }),
		onSuccess: () => { setCur(''); setPw(''); toast('Password changed. Other sessions were signed out.'); },
		onError: (e: any) => toast(e.message, 'error'),
	});
	return (
		<>
			<PageHead kw="My" rest="profile" />
			<div className="grid g-2">
				<Card title="Details" accent={COLORS.navy}>
					<div className="col gap-16">
						<div className="field"><label>Email</label><input className="input" value={user?.email} disabled /></div>
						<div className="field"><label>Full name</label><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></div>
						<div className="field"><label>Role</label><input className="input" value={user?.role} disabled /></div>
						<Switch checked={notify} onChange={setNotify} label="Email me alerts (managers and admins)" />
						<button className="btn primary" style={{ alignSelf: 'flex-start' }} onClick={() => save.mutate()}>Save</button>
					</div>
				</Card>
				<Card title="Password" accent={COLORS.pink}>
					{user?.authProvider === 'ravity' ? (
						<div className="small muted">Your password is managed by Ravity sign-in. Use "Forgot password" on the sign-in page to change it.</div>
					) : (
						<div className="col gap-16">
							<div className="field"><label>Current password</label><input className="input" type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" /></div>
							<div className="field"><label>New password</label><input className="input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" /><span className="hint">At least 10 characters with letters and numbers</span></div>
							<button className="btn" style={{ alignSelf: 'flex-start' }} disabled={!cur || !pw || change.isPending} onClick={() => change.mutate()}>Change password</button>
						</div>
					)}
				</Card>
			</div>
		</>
	);
}
