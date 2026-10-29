import type { ReactNode } from 'react';
import { useEffect } from 'react';

export default function AuthShell({ children }: { children: ReactNode }) {
	useEffect(() => {
		const prev = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
		return () => { document.body.style.overflow = prev; };
	}, []);
	return (
		<div className="auth">
			<img className="auth-bg" src="/login-bg.jpg" alt="" />
			<div className="auth-card">
				<div className="auth-brand">
					<div className="name"><span>re</span>mail</div>
					<div className="tag">AI-first email intelligence for customer experience</div>
				</div>
				{children}
				<div className="auth-foot">Powered by <img src="/ravity-logo.svg" alt="Ravity" /></div>
			</div>
		</div>
	);
}
