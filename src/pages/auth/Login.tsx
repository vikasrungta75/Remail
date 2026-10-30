import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
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
	const cfg = useQuery({ queryKey: ['auth-config'], queryFn: () => api('/auth/config') });
	const [ssoError, setSsoError] = useState('');
	const [msBusy, setMsBusy] = useState(false);
	useEffect(() => {
		const e = new URLSearchParams(window.location.search).get('error');
		if (e) setSsoError(e);
	}, []);
	const microsoft = async () => {
		setMsBusy(true);
		try {
			const r = await api('/auth/microsoft/start', { body: {} });
			window.location.href = r.url;
		} catch (e: any) {
			setSsoError(e.message);
			setMsBusy(false);
		}
	};

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
			nav(loc.state?.from || '/my-day', { replace: true });
		} catch (err: any) {
			setErrors({ password: err.message || 'Login failed. Please try again.' });
		} finally {
			setBusy(false);
		}
	};

	return (
		<AuthShell>
			<h2>Sign in</h2>
			{ssoError && <div className="notice error mb-16 small">{ssoError}</div>}
			{cfg.isError && (
				<div className="notice warn mb-16 small">
					<span>The server is not fully set up yet. Open <a href="/api/health" target="_blank" rel="noreferrer">the setup check</a> to see what is missing in Netlify.</span>
				</div>
			)}
			{cfg.data?.microsoft && (
				<>
					<button type="button" className="auth-btn" onClick={microsoft} disabled={msBusy}
						style={{ background: '#fff', color: 'var(--text)', border: '1px solid #c9cde0', boxShadow: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
						<svg width="18" height="18" viewBox="0 0 21 21" aria-hidden="true"><rect x="1" y="1" width="9" height="9" fill="#f25022" /><rect x="11" y="1" width="9" height="9" fill="#7fba00" /><rect x="1" y="11" width="9" height="9" fill="#00a4ef" /><rect x="11" y="11" width="9" height="9" fill="#ffb900" /></svg>
						{msBusy ? 'Redirecting…' : 'Sign in with Microsoft'}
					</button>
					<div className="row" style={{ margin: '18px 0', color: 'var(--text-3)', fontSize: 12 }}><span className="grow" style={{ height: 1, background: '#d9dcea' }} />or with your {cfg.data?.ravity ? 'Ravity' : 'remail'} account<span className="grow" style={{ height: 1, background: '#d9dcea' }} /></div>
				</>
			)}
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
