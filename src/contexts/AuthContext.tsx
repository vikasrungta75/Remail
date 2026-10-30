import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, setUnauthorisedHandler } from '../api/client';
import { queryClient } from '../queryClient';

export interface User {
	id: number;
	email: string;
	fullName: string;
	role: 'admin' | 'manager' | 'analyst' | 'viewer';
	authProvider: 'local' | 'ravity';
	allMailboxes: boolean;
	timezone: string;
	notifyEmail?: boolean;
	digestEnabled?: boolean;
	emailAliases?: string[];
}

interface AuthState {
	user: User | null;
	orgName: string;
	loading: boolean;
	login: (userid: string, password: string) => Promise<void>;
	loginWithToken: (token: string, loginTime?: string) => Promise<void>;
	logout: () => Promise<void>;
	refresh: () => Promise<void>;
	can: (min: User['role']) => boolean;
}

const RANK = { viewer: 1, analyst: 2, manager: 3, admin: 4 } as const;
const AuthContext = createContext<AuthState>(null as any);

const store = {
	get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
	set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
	del: (k: string) => { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

export function AuthProvider({ children }: { children: ReactNode }) {
	const [user, setUser] = useState<User | null>(null);
	const [orgName, setOrgName] = useState('');
	const [loading, setLoading] = useState(true);

	const clear = useCallback(() => {
		store.del('token');
		store.del('login_time');
		queryClient.clear();
		setUser(null);
	}, []);

	const refresh = useCallback(async () => {
		if (!store.get('token')) {
			setLoading(false);
			return;
		}
		try {
			const me = await api('/auth/me');
			setUser(me.user);
			setOrgName(me.org?.name || '');
		} catch {
			clear();
		} finally {
			setLoading(false);
		}
	}, [clear]);

	useEffect(() => {
		setUnauthorisedHandler(clear);
		refresh();
	}, [refresh, clear]);

	const login = async (userid: string, password: string) => {
		queryClient.clear();
		const res = await api('/auth/login', { body: { userid, password } });
		store.set('token', res.token);
		store.set('login_time', res.loginTime);
		setUser(res.user);
		await refresh();
	};

	const loginWithToken = async (token: string, loginTime?: string) => {
		queryClient.clear();
		store.set('token', token);
		store.set('login_time', loginTime || new Date().toISOString());
		setLoading(true);
		await refresh();
	};

	const logout = async () => {
		try {
			await api('/auth/logout', { body: { loginTime: store.get('login_time') } });
		} catch {
			/* always clear locally */
		}
		clear();
	};

	const can = (min: User['role']) => !!user && RANK[user.role] >= RANK[min];

	return <AuthContext.Provider value={{ user, orgName, loading, login, loginWithToken, logout, refresh, can }}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
