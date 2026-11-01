import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { MdKeyboardArrowDown, MdKeyboardArrowUp, MdMenu, MdMenuOpen, MdNotificationsNone, MdSearch, MdLogout, MdPerson, MdSync } from 'react-icons/md';
import { menu, titleFor } from '../menu';
import { useAuth } from '../contexts/AuthContext';
import { useFilters } from '../contexts/FilterContext';
import { api } from '../api/client';
import { ago } from '../lib/format';

function useLocal(key: string, def: boolean): [boolean, (v: boolean) => void] {
	const [v, setV] = useState<boolean>(() => {
		try { const s = localStorage.getItem(key); return s === null ? def : s === '1'; } catch { return def; }
	});
	return [v, (n: boolean) => { setV(n); try { localStorage.setItem(key, n ? '1' : '0'); } catch { /* ignore */ } }];
}

export default function Layout() {
	const { user, logout, can, orgName } = useAuth();
	const [min, setMin] = useLocal('remail_aside_min', false);
	const [mobileOpen, setMobileOpen] = useState(false);
	const [menuOpen, setMenuOpen] = useState(false);
	const [search, setSearch] = useState('');
	const loc = useLocation();
	const nav = useNavigate();
	const userMenu = useRef<HTMLDivElement>(null);
	// the menu can be longer than the screen: show arrows when there is more above or below
	const navRef = useRef<HTMLDivElement>(null);
	const [more, setMore] = useState({ up: false, down: false });
	const checkMore = () => {
		const el = navRef.current;
		if (!el) return;
		const up = el.scrollTop > 4;
		const down = el.scrollTop + el.clientHeight < el.scrollHeight - 4;
		setMore((m) => (m.up === up && m.down === down ? m : { up, down }));
	};
	useEffect(() => {
		checkMore();
		window.addEventListener('resize', checkMore);
		return () => window.removeEventListener('resize', checkMore);
	});
	const scrollNav = (dir: number) => navRef.current?.scrollBy({ top: dir * 220, behavior: 'smooth' });

	useEffect(() => setMobileOpen(false), [loc.pathname]);
	useEffect(() => {
		const h = (e: MouseEvent) => userMenu.current && !userMenu.current.contains(e.target as Node) && setMenuOpen(false);
		document.addEventListener('mousedown', h);
		return () => document.removeEventListener('mousedown', h);
	}, []);

	const { filters, set: setFilters } = useFilters();
	const myday = useQuery({ queryKey: ['my-day'], queryFn: () => api('/views/my-day'), refetchInterval: 120_000 });
	const alerts = useQuery({ queryKey: ['alert-counts'], queryFn: () => api('/alerts?status=open'), refetchInterval: 60_000 });
	const sys = useQuery({ queryKey: ['system-status'], queryFn: () => api('/system/status'), refetchInterval: 120_000, enabled: can('manager') });
	const aiPaused = sys.data?.progress?.ai_paused_until && new Date(sys.data.progress.ai_paused_until) > new Date();
	const summary = useQuery({ queryKey: ['nav-summary'], queryFn: () => api('/dashboard/summary'), refetchInterval: 120_000 });
	const drafts = useQuery({ queryKey: ['nav-drafts', filters.view], queryFn: () => api(`/drafts?status=draft${filters.view === 'me' ? '&view=me' : ''}`), refetchInterval: 120_000 });
	const badge = (b?: string) => {
		if (b === 'alerts') return alerts.data?.counts?.open || 0;
		if (b === 'critical') return summary.data?.critical?.filter((c: any) => c.rag === 'red').length || 0;
		if (b === 'drafts') return drafts.data?.counts?.draft || 0;
		if (b === 'myday') return (myday.data?.stats?.awaiting || 0) + (myday.data?.stats?.actionsOverdue || 0);
		return 0;
	};
	const initials = (user?.fullName || user?.email || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

	return (
		<div className={`app ${min ? 'aside-min' : ''} ${mobileOpen ? 'mobile-open' : ''}`}>
			<aside className="aside" aria-label="Main navigation">
				<div className="aside-head">
					<NavLink to="/overview" className="brand" aria-label="remail home">
						<div className="brand-text">
							<div className="brand-name"><span>re</span>mail</div>
							<div className="brand-sub">AI email intelligence</div>
						</div>
						{min && <div className="brand-name" style={{ fontSize: 20 }}><span>r</span></div>}
					</NavLink>
					<button className="aside-toggle" onClick={() => setMin(!min)} aria-label={min ? 'Expand menu' : 'Collapse menu'}>
						{min ? <MdMenu /> : <MdMenuOpen />}
					</button>
				</div>
				{more.up && <button className="aside-scroll up" onClick={() => scrollNav(-1)} aria-label="Scroll menu up"><MdKeyboardArrowUp /></button>}
				<div className="aside-body" ref={navRef} onScroll={checkMore}>
					{menu.map((s) => {
						const items = s.items.filter((i) => !i.minRole || can(i.minRole));
						if (!items.length) return null;
						return (
							<div key={s.section}>
								<span className="aside-section">{s.section}</span>
								{items.map((i) => {
									const n = badge(i.badge);
									return (
										<NavLink key={i.id} to={i.path} className={({ isActive }) => `nav-item ${isActive || i.also?.some((p) => loc.pathname.startsWith(p)) ? 'active' : ''}`} title={i.text}>
											<i.icon />
											<span className="nav-label">{i.text}</span>
											{n > 0 && <span className="nav-badge">{n}</span>}
										</NavLink>
									);
								})}
							</div>
						);
					})}
				</div>
				{more.down && <button className="aside-scroll down" onClick={() => scrollNav(1)} aria-label="Scroll menu down"><MdKeyboardArrowDown /></button>}
				<div className="aside-foot">
					<img src="/ravity-logo.svg" alt="Ravity" />
					<span>{orgName}</span>
				</div>
			</aside>
			<div className="main">
				<header className="header">
					<button className="btn ghost icon mobile-menu" onClick={() => setMobileOpen(!mobileOpen)} aria-label="Open menu"><MdMenu /></button>
					<div className="header-title">{titleFor(loc.pathname)}</div>
					{can('manager') && (
						<div className="segmented" title="Your own email, or everyone's email combined">
							<button className={filters.view === 'me' ? 'on' : ''} onClick={() => setFilters({ view: 'me' })}>My view</button>
							<button className={filters.view !== 'me' ? 'on' : ''} onClick={() => setFilters({ view: 'all' })}>Management view</button>
						</div>
					)}
					{summary.data?.sync?.last_synced_at && (
						<span className="badge outline small cursor" title="Last mailbox sync. Select to see what has been processed" onClick={() => nav('/admin/processing')}><MdSync /> Synced {ago(summary.data.sync.last_synced_at)}</span>
					)}
					<form
						className="header-search"
						onSubmit={(e) => { e.preventDefault(); if (search.trim()) nav(`/conversations?q=${encodeURIComponent(search.trim())}`); }}
					>
						<MdSearch />
						<input placeholder="Search customers, subjects, emails" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search" />
					</form>
					<button className="btn ghost icon icon-btn" onClick={() => nav('/alerts')} aria-label="Alerts">
						<MdNotificationsNone style={{ fontSize: 22 }} />
						{(alerts.data?.counts?.open || 0) > 0 && <span className="dot">{alerts.data.counts.open}</span>}
					</button>
					<div ref={userMenu} style={{ position: 'relative' }}>
						<button className="user-chip" onClick={() => setMenuOpen(!menuOpen)}>
							<span className="avatar">{initials}</span>
							<span className="who">
								<div className="name">{user?.fullName}</div>
								<div className="role">{user?.role && user.role[0].toUpperCase() + user.role.slice(1)}</div>
							</span>
						</button>
						{menuOpen && (
							<div className="ms-pop" style={{ position: 'absolute', right: 0, left: 'auto', top: 'calc(100% + 6px)', minWidth: 200 }}>
								<div className="ms-opt" onClick={() => { setMenuOpen(false); nav('/profile'); }}><MdPerson /> My profile</div>
								<div className="ms-opt" onClick={async () => { await logout(); nav('/auth/login'); }}><MdLogout /> Sign out</div>
							</div>
						)}
					</div>
				</header>
				<main className="content">
					{aiPaused && (
						<div className="ai-banner" role="alert">
							<b>Claude analysis is paused</b> until {new Date(sys.data.progress.ai_paused_until).toLocaleTimeString()}: {sys.data.progress.ai_last_error}. New mail is sorted by the rules engine meanwhile. <a href="/admin/processing">Processing status</a>
						</div>
					)}
					<Outlet />
				</main>
			</div>
		</div>
	);
}
