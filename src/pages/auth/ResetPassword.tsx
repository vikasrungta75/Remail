import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../../api/client';
import AuthShell from './AuthShell';

export default function ResetPassword() {
	const [sp] = useSearchParams();
	const nav = useNavigate();
	const token = sp.get('token') || '';
	const invite = sp.get('invite') === '1';
	const [pw, setPw] = useState('');
	const [pw2, setPw2] = useState('');
	const [err, setErr] = useState('');
	const [busy, setBusy] = useState(false);
	const [done, setDone] = useState(false);
	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (pw !== pw2) return setErr('Passwords do not match');
		setBusy(true);
		setErr('');
		try {
			await api('/auth/reset-password', { body: { token, password: pw } });
			setDone(true);
			setTimeout(() => nav('/auth/login'), 1800);
		} catch (e: any) {
			setErr(e.message);
		} finally {
			setBusy(false);
		}
	};
	return (
		<AuthShell>
			<h2>{invite ? 'Set your password' : 'Choose a new password'}</h2>
			{done ? (
				<div className="notice ok">Password saved. Taking you to sign in…</div>
			) : !token ? (
				<div className="col gap-16"><div className="notice error">This link is missing its token.</div><Link to="/auth/forgot-password">Request a new link</Link></div>
			) : (
				<form onSubmit={submit} className="col gap-16">
					<div className="field">
						<label htmlFor="pw">New password</label>
						<input id="pw" className="auth-input" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
						<span className="hint">At least 10 characters with letters and numbers</span>
					</div>
					<div className="field">
						<label htmlFor="pw2">Confirm password</label>
						<input id="pw2" className={`auth-input ${err ? 'err' : ''}`} type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
						{err && <div className="auth-err">{err}</div>}
					</div>
					<button className="auth-btn" disabled={busy || !pw}>{busy ? 'Saving…' : 'Save password'}</button>
				</form>
			)}
		</AuthShell>
	);
}
