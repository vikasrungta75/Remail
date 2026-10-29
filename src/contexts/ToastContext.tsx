import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

interface Toast { id: number; text: string; kind: 'ok' | 'error' }
const ToastContext = createContext<(text: string, kind?: 'ok' | 'error') => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
	const [toasts, setToasts] = useState<Toast[]>([]);
	const push = useCallback((text: string, kind: 'ok' | 'error' = 'ok') => {
		const id = Date.now() + Math.random();
		setToasts((t) => [...t, { id, text, kind }]);
		setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
	}, []);
	return (
		<ToastContext.Provider value={push}>
			{children}
			<div className="toasts" role="status">
				{toasts.map((t) => (
					<div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>
				))}
			</div>
		</ToastContext.Provider>
	);
}

export const useToast = () => useContext(ToastContext);
