import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import AuthShell from './AuthShell';

/** Microsoft sign-in lands here with the remail session in the URL fragment (never sent to servers or logs). */
export default function SsoCallback() {
	const { loginWithToken } = useAuth();
	const nav = useNavigate();
	const [err, setErr] = useState('');
	useEffect(() => {
		const h = new URLSearchParams(window.location.hash.slice(1));
		const token = h.get('token');
		history.replaceState(null, '', window.location.pathname);
		if (!token) { setErr('Sign-in did not complete. Please try again.'); return; }
		loginWithToken(token, h.get('loginTime') || undefined).then(() => nav('/my-day', { replace: true })).catch(() => setErr('Sign-in failed. Please try again.'));
	}, [loginWithToken, nav]);
	return (
		<AuthShell>
			{err ? <div className="notice error">{err} <a href="/auth/login">Back to sign in</a></div> : <div className="loader"><span className="spin" />Signing you in</div>}
		</AuthShell>
	);
}
