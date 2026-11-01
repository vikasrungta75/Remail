/** The same compact filter bar on every list page: a search box and labelled dropdowns on one line. */
import type { ReactNode } from 'react';
import { MdRefresh, MdSearch } from 'react-icons/md';

export const countLabel = (n?: number) => (n !== undefined && n !== null ? ` (${n.toLocaleString('en-CA')})` : '');

export function Drop({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][] }) {
	return (
		<select className={`input sm drop ${value ? 'on' : ''}`} value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} title={label}>
			{options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
		</select>
	);
}

export function FilterStrip({ search, onSearch, placeholder = 'Search', children, active = 0, onClear }: {
	search?: string; onSearch?: (v: string) => void; placeholder?: string; children?: ReactNode; active?: number; onClear?: () => void;
}) {
	return (
		<div className="filter-strip mb-16">
			{onSearch && (
				<div className="search-box">
					<MdSearch />
					<input className="input sm" placeholder={placeholder} value={search || ''} onChange={(e) => onSearch(e.target.value)} aria-label={placeholder} />
				</div>
			)}
			{children}
			{active > 0 && onClear && <button className="btn ghost sm nowrap" onClick={onClear}><MdRefresh /> Clear ({active})</button>}
		</div>
	);
}
