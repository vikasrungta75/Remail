import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { MdVisibility, MdVisibilityOff } from 'react-icons/md';
import { useAuth } from '../../contexts/AuthContext';
import AuthShell from './AuthShell';

export default function Login() {
	const { login } = useAuth();
	const nav = useNavigate();
	const loc = useLocation() as any;
	const [userid, setUserid] = useState('');
	const [password, setPassword] = useState('');
	const [show, setShow] = useState(false);
	const [busy, setBusy] = useState(false);
	const [errors, setErrors] = useState<{ userid?: string; password?: string }>({});

	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		const errs: typeof errors = {};
		if (!userid) errs.userid = 'Required';
		if (!password) errs.password = 'Required';
		setErrors(errs);
		if (Object.keys(errs).length) return;
		setBusy(true);
		try {
			await login(userid.trim(), password);
			nav(loc.state?.from || '/overview', { replace: true });
		} catch (err: any) {
			setErrors({ password: err.message || 'Login failed. Please try again.' });
		} finally {
			setBusy(false);
		}
	};

	return (
		<AuthShell>
			<h2>Sign in</h2>
			<form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }} noValidate>
				<div className="field">
					<label htmlFor="userid">Email address</label>
					<input id="userid" className={`auth-input ${errors.userid ? 'err' : ''}`} type="email" autoComplete="username" placeholder="Enter your email" value={userid} onChange={(e) => setUserid(e.target.value)} />
					{errors.userid && <div className="auth-err">{errors.userid}</div>}
				</div>
				<div className="field">
					<label htmlFor="password">Password</label>
					<div style={{ position: 'relative' }}>
						<input id="password" className={`auth-input ${errors.password ? 'err' : ''}`} type={show ? 'text' : 'password'} autoComplete="current-password" placeholder="Enter your password" value={password} onChange={(e) => setPassword(e.target.value)} style={{ paddingRight: 44 }} />
						<button type="button" onClick={() => setShow(!show)} aria-label={show ? 'Hide password' : 'Show password'} tabIndex={-1}
							style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 0, cursor: 'pointer', color: 'rgba(0,0,0,.45)', fontSize: 20, lineHeight: 0 }}>
							{show ? <MdVisibility /> : <MdVisibilityOff />}
						</button>
					</div>
					{errors.password && <div className="auth-err">{errors.password}</div>}
				</div>
				<div style={{ textAlign: 'right', marginTop: -4, fontSize: 12 }}>
					Forgot password? <Link to="/auth/forgot-password" style={{ color: 'var(--pink)', fontWeight: 700 }}>Click here</Link>
				</div>
				<button className="auth-btn" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
			</form>
		</AuthShell>
	);
}
