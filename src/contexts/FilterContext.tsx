import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { subDays, startOfDay } from 'date-fns';

export interface Filters {
	range: '7d' | '30d' | '90d' | '180d' | 'custom';
	from?: string;
	to?: string;
	customer: number[];
	mailbox: number[];
	sentiment: string[];
	rag: string[];
	status: string[];
	category: string[];
	tier: string[];
	type: string[];
	view: 'all' | 'me';
}

const DEFAULT: Filters = { range: '30d', customer: [], mailbox: [], sentiment: [], rag: [], status: [], category: [], tier: [], type: [], view: 'all' };

function load(): Filters {
	try {
		const raw = localStorage.getItem('remail_filters');
		return raw ? { ...DEFAULT, ...JSON.parse(raw) } : DEFAULT;
	} catch {
		return DEFAULT;
	}
}

interface Ctx {
	filters: Filters;
	set: (patch: Partial<Filters>) => void;
	reset: () => void;
	params: Record<string, unknown>;
	activeCount: number;
}
const FilterContext = createContext<Ctx>(null as any);

export function FilterProvider({ children }: { children: ReactNode }) {
	const [filters, setFilters] = useState<Filters>(load);
	const set = (patch: Partial<Filters>) =>
		setFilters((f) => {
			const next = { ...f, ...patch };
			try { localStorage.setItem('remail_filters', JSON.stringify(next)); } catch { /* ignore */ }
			return next;
		});
	const reset = () => set({ ...DEFAULT, view: filters.view });
	const params = useMemo(() => {
		const days = { '7d': 7, '30d': 30, '90d': 90, '180d': 180 } as Record<string, number>;
		let from: string | undefined;
		let to: string | undefined;
		if (filters.range === 'custom') {
			from = filters.from ? new Date(filters.from).toISOString() : undefined;
			to = filters.to ? new Date(`${filters.to}T23:59:59`).toISOString() : undefined;
		} else {
			from = startOfDay(subDays(new Date(), days[filters.range] - 1)).toISOString();
		}
		return {
			from, to,
			customer: filters.customer, mailbox: filters.mailbox, sentiment: filters.sentiment, rag: filters.rag,
			status: filters.status, category: filters.category, tier: filters.tier, type: filters.type,
			view: filters.view === 'me' ? 'me' : undefined,
		};
	}, [filters]);
	const activeCount = ['customer', 'mailbox', 'sentiment', 'rag', 'status', 'category', 'tier', 'type'].reduce(
		(n, k) => n + ((filters as any)[k].length ? 1 : 0), 0,
	);
	return <FilterContext.Provider value={{ filters, set, reset, params, activeCount }}>{children}</FilterContext.Provider>;
}

export const useFilters = () => useContext(FilterContext);
