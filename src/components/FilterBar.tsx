import { useQuery } from '@tanstack/react-query';
import { MdBusiness, MdCalendarToday, MdFilterList, MdInbox, MdRefresh } from 'react-icons/md';
import { api } from '../api/client';
import { useFilters } from '../contexts/FilterContext';
import { MultiSelect } from './ui';

export function useFilterOptions() {
	return useQuery({ queryKey: ['filter-options'], queryFn: () => api('/filters/options'), staleTime: 60_000 });
}

export default function FilterBar({ show = ['customer', 'mailbox', 'sentiment', 'rag', 'status'] as string[], extra }: { show?: string[]; extra?: React.ReactNode }) {
	const { filters, set, reset, activeCount } = useFilters();
	const { data } = useFilterOptions();
	return (
		<div className="filterbar">
			<span className="fb-label row gap-4"><MdFilterList /> Filters</span>
			<div className="ms">
				<select
					className="ms-btn on"
					value={filters.range}
					onChange={(e) => set({ range: e.target.value as any })}
					aria-label="Date range"
					style={{ appearance: 'auto' }}
				>
					<option value="7d">Last 7 days</option>
					<option value="30d">Last 30 days</option>
					<option value="90d">Last 90 days</option>
					<option value="180d">Last 6 months</option>
					<option value="custom">Custom range</option>
				</select>
			</div>
			{filters.range === 'custom' && (
				<span className="row gap-4">
					<MdCalendarToday className="faint" />
					<input type="date" className="input" style={{ width: 150, padding: '6px 8px' }} value={filters.from || ''} onChange={(e) => set({ from: e.target.value })} aria-label="From date" />
					<span className="faint">to</span>
					<input type="date" className="input" style={{ width: 150, padding: '6px 8px' }} value={filters.to || ''} onChange={(e) => set({ to: e.target.value })} aria-label="To date" />
				</span>
			)}
			{show.includes('customer') && (
				<MultiSelect
					label="Customer" icon={<MdBusiness />} searchable
					options={(data?.customers || []).map((c: any) => ({ v: c.id, l: c.name }))}
					value={filters.customer} onChange={(v) => set({ customer: v })}
				/>
			)}
			{show.includes('mailbox') && (
				<MultiSelect
					label="Mailbox" icon={<MdInbox />}
					options={(data?.mailboxes || []).map((m: any) => ({ v: m.id, l: m.display_name || m.address }))}
					value={filters.mailbox} onChange={(v) => set({ mailbox: v })}
				/>
			)}
			{show.includes('sentiment') && (
				<MultiSelect
					label="Sentiment"
					options={[{ v: 'positive', l: 'Positive' }, { v: 'neutral', l: 'Neutral' }, { v: 'negative', l: 'Negative' }]}
					value={filters.sentiment} onChange={(v) => set({ sentiment: v })}
				/>
			)}
			{show.includes('rag') && (
				<MultiSelect
					label="Rating"
					options={[
						{ v: 'red', l: 'Red', extra: <span className="rag-dot red" /> },
						{ v: 'amber', l: 'Amber', extra: <span className="rag-dot amber" /> },
						{ v: 'green', l: 'Green', extra: <span className="rag-dot green" /> },
					]}
					value={filters.rag} onChange={(v) => set({ rag: v })}
				/>
			)}
			{show.includes('status') && (
				<MultiSelect
					label="Status"
					options={[{ v: 'open', l: 'Open' }, { v: 'in_progress', l: 'In progress' }, { v: 'resolved', l: 'Resolved' }, { v: 'ignored', l: 'Ignored' }]}
					value={filters.status} onChange={(v) => set({ status: v })}
				/>
			)}
			{show.includes('category') && (
				<MultiSelect
					label="Issue type" searchable
					options={(data?.categories || []).map((c: any) => ({ v: c.id, l: c.label }))}
					value={filters.category} onChange={(v) => set({ category: v })}
				/>
			)}
			{show.includes('tier') && (
				<MultiSelect
					label="Tier"
					options={[{ v: 'strategic', l: 'Strategic' }, { v: 'key', l: 'Key' }, { v: 'standard', l: 'Standard' }]}
					value={filters.tier} onChange={(v) => set({ tier: v })}
				/>
			)}
			{extra}
			{activeCount > 0 && (
				<button className="btn ghost sm" onClick={reset} style={{ marginLeft: 'auto' }}>
					<MdRefresh /> Reset filters
				</button>
			)}
		</div>
	);
}
