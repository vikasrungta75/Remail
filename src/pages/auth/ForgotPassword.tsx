import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import AuthShell from './AuthShell';

export default function ForgotPassword() {
	const [email, setEmail] = useState('');
	const [sent, setSent] = useState('');
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState('');
	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!email) return setErr('Required');
		setBusy(true);
		setErr('');
		try {
			const r = await api('/auth/forgot-password', { body: { email } });
			setSent(r.message);
		} catch (e: any) {
			setErr(e.message);
		} finally {
			setBusy(false);
		}
	};
	return (
		<AuthShell>
			<h2>Reset your password</h2>
			{sent ? (
				<div className="col gap-16">
					<div className="notice ok">{sent}</div>
					<Link to="/auth/login" className="auth-btn" style={{ textAlign: 'center', textDecoration: 'none' }}>Back to sign in</Link>
				</div>
			) : (
				<form onSubmit={submit} className="col gap-16">
					<div className="field">
						<label htmlFor="email">Email address</label>
						<input id="email" className={`auth-input ${err ? 'err' : ''}`} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Enter your email" />
						{err && <div className="auth-err">{err}</div>}
					</div>
					<button className="auth-btn" disabled={busy}>{busy ? 'Sending…' : 'Send reset link'}</button>
					<div style={{ textAlign: 'center', fontSize: 12 }}><Link to="/auth/login">Back to sign in</Link></div>
				</form>
			)}
		</AuthShell>
	);
}
