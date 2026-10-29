import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { MdClose, MdExpandMore, MdInbox, MdTrendingDown, MdTrendingUp } from 'react-icons/md';
import { COLORS, stateLabel } from '../lib/format';

/** Heading pattern: pink keyword + rest of heading */
export function Title({ kw, rest, as = 'h1' }: { kw: string; rest?: string; as?: 'h1' | 'h2' }) {
	const T = as;
	return (
		<T>
			<span className="kw">{kw}</span>
			{rest ? ` ${rest}` : ''}
		</T>
	);
}

export function PageHead({ kw, rest, sub, actions }: { kw: string; rest?: string; sub?: ReactNode; actions?: ReactNode }) {
	return (
		<div className="page-head">
			<div>
				<Title kw={kw} rest={rest} />
				{sub && <p>{sub}</p>}
			</div>
			{actions && <div className="row wrap">{actions}</div>}
		</div>
	);
}

export function Card({
	title, sub, accent, actions, children, flush, className = '', style, onClick,
}: {
	title?: ReactNode; sub?: ReactNode; accent?: string; actions?: ReactNode; children?: ReactNode; flush?: boolean;
	className?: string; style?: CSSProperties; onClick?: () => void;
}) {
	return (
		<div className={`card ${accent ? 'accent' : ''} ${className}`} style={{ ...(accent ? ({ '--accent': accent } as any) : {}), ...style }} onClick={onClick}>
			{(title || actions) && (
				<div className="card-head">
					<div>
						{typeof title === 'string' ? <h2>{title}</h2> : title}
						{sub && <div className="sub">{sub}</div>}
					</div>
					{actions}
				</div>
			)}
			<div className={`card-body ${flush ? 'flush' : ''}`}>{children}</div>
		</div>
	);
}

export function Kpi({
	label, value, icon, accent = COLORS.blue, delta, invert, foot, onClick,
}: {
	label: string; value: ReactNode; icon?: ReactNode; accent?: string; delta?: number | null; invert?: boolean; foot?: ReactNode; onClick?: () => void;
}) {
	const good = delta === undefined || delta === null || delta === 0 ? null : invert ? delta < 0 : delta > 0;
	return (
		<div className={`card accent kpi ${onClick ? 'cursor' : ''}`} style={{ '--accent': accent } as any} onClick={onClick}>
			<div className="kpi-label">{icon}{label}</div>
			<div className="kpi-value">{value}</div>
			<div className="kpi-foot">
				{delta !== undefined && delta !== null && delta !== 0 && (
					<span className={good ? 'up-good' : 'up-bad'} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
						{delta > 0 ? <MdTrendingUp /> : <MdTrendingDown />} {delta > 0 ? '+' : ''}{delta}
					</span>
				)}
				{foot}
			</div>
		</div>
	);
}

export const RagDot = ({ rag }: { rag?: string | null }) => <span className={`rag-dot ${rag || 'none'}`} title={rag || 'Not rated'} />;

export function RagBadge({ rag }: { rag?: string | null }) {
	if (!rag) return <span className="badge">Pending</span>;
	const label = rag === 'red' ? 'Red' : rag === 'amber' ? 'Amber' : 'Green';
	return <span className={`badge ${rag}`}><span className="d" />{label}</span>;
}

export function SentimentBadge({ s, score }: { s?: string | null; score?: number | null }) {
	if (!s) return null;
	const cls = s === 'negative' ? 'red' : s === 'positive' ? 'green' : '';
	return (
		<span className={`badge ${cls}`} title={score !== undefined && score !== null ? `Score ${score}` : undefined}>
			{s[0].toUpperCase() + s.slice(1)}
		</span>
	);
}

export function StateBadge({ s }: { s?: string | null }) {
	if (!s) return null;
	const cls = s === 'dissatisfied' ? 'red' : s === 'at_risk' ? 'amber' : s === 'satisfied' ? 'green' : '';
	return <span className={`badge ${cls}`}>{stateLabel(s)}</span>;
}

export function TierBadge({ tier }: { tier?: string | null }) {
	if (!tier || tier === 'standard') return null;
	return <span className={`badge ${tier === 'strategic' ? 'purple' : 'blue'}`}>{tier === 'strategic' ? 'Strategic' : 'Key'}</span>;
}

export function StatusBadge({ s }: { s: string }) {
	const map: Record<string, [string, string]> = {
		open: ['Open', 'blue'], in_progress: ['In progress', 'amber'], resolved: ['Resolved', 'green'], ignored: ['Ignored', ''],
		acknowledged: ['Acknowledged', 'amber'], done: ['Done', 'green'], dismissed: ['Dismissed', ''],
	};
	const [l, c] = map[s] || [s, ''];
	return <span className={`badge ${c}`}>{l}</span>;
}

export function UrgencyBadge({ u }: { u?: string | null }) {
	if (!u || u === 'low') return null;
	const cls = u === 'critical' ? 'red' : u === 'high' ? 'amber' : '';
	return <span className={`badge outline ${cls}`}>{u[0].toUpperCase() + u.slice(1)} urgency</span>;
}

export function Health({ score }: { score?: number | null }) {
	if (score === null || score === undefined) return <span className="faint">n/a</span>;
	const color = score >= 70 ? COLORS.green : score >= 55 ? COLORS.blue : score >= 35 ? COLORS.amber : COLORS.red;
	return (
		<div className="health">
			<div className="bar"><span style={{ width: `${score}%`, background: color }} /></div>
			<span className="val" style={{ color }}>{score}</span>
		</div>
	);
}

export function RagBar({ red, amber, green }: { red: number; amber: number; green: number }) {
	const t = red + amber + green || 1;
	return (
		<div className="ragbar" title={`${red} red · ${amber} amber · ${green} green`}>
			<span style={{ width: `${(red / t) * 100}%`, background: COLORS.red }} />
			<span style={{ width: `${(amber / t) * 100}%`, background: COLORS.amber }} />
			<span style={{ width: `${(green / t) * 100}%`, background: COLORS.green }} />
		</div>
	);
}

export const Loader = ({ text = 'Loading' }: { text?: string }) => (
	<div className="loader"><span className="spin" />{text}</div>
);

export const Empty = ({ text, icon }: { text: ReactNode; icon?: ReactNode }) => (
	<div className="empty">{icon || <MdInbox />}{text}</div>
);

export function Modal({ title, onClose, children, footer, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
	useEffect(() => {
		const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
		window.addEventListener('keydown', h);
		return () => window.removeEventListener('keydown', h);
	}, [onClose]);
	return (
		<div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
			<div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true">
				<div className="modal-head">
					<h2>{title}</h2>
					<button className="btn ghost icon" onClick={onClose} aria-label="Close"><MdClose /></button>
				</div>
				<div className="modal-body">{children}</div>
				{footer && <div className="modal-foot">{footer}</div>}
			</div>
		</div>
	);
}

export const Switch = ({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) => (
	<label className="row" style={{ cursor: 'pointer' }}>
		<span className="switch">
			<input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} aria-label={label} />
			<span />
		</span>
		{label && <span>{label}</span>}
	</label>
);

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { v: T; l: string }[]; onChange: (v: T) => void }) {
	return (
		<div className="segmented">
			{options.map((o) => (
				<button key={o.v} className={value === o.v ? 'on' : ''} onClick={() => onChange(o.v)}>{o.l}</button>
			))}
		</div>
	);
}

export function MultiSelect({
	label, options, value, onChange, searchable, icon,
}: {
	label: string; options: { v: string | number; l: string; extra?: ReactNode }[]; value: (string | number)[]; onChange: (v: any[]) => void;
	searchable?: boolean; icon?: ReactNode;
}) {
	const [open, setOpen] = useState(false);
	const [q, setQ] = useState('');
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
		document.addEventListener('mousedown', h);
		return () => document.removeEventListener('mousedown', h);
	}, []);
	const shown = options.filter((o) => !q || o.l.toLowerCase().includes(q.toLowerCase()));
	const names = options.filter((o) => value.includes(o.v)).map((o) => o.l);
	return (
		<div className="ms" ref={ref}>
			<button className={`ms-btn ${value.length ? 'on' : ''}`} onClick={() => setOpen(!open)} type="button">
				{icon}
				{value.length === 0 ? label : value.length === 1 ? names[0] || label : `${label}: ${value.length}`}
				<MdExpandMore />
			</button>
			{open && (
				<div className="ms-pop">
					{searchable && <input className="input" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />}
					<div className="ms-list">
						{shown.map((o) => (
							<label key={o.v} className="ms-opt">
								<input
									type="checkbox"
									checked={value.includes(o.v)}
									onChange={(e) => onChange(e.target.checked ? [...value, o.v] : value.filter((x) => x !== o.v))}
								/>
								<span className="grow truncate">{o.l}</span>
								{o.extra}
							</label>
						))}
						{!shown.length && <div className="faint small" style={{ padding: 8 }}>No matches</div>}
					</div>
					<div className="ms-foot">
						<button className="btn ghost sm" onClick={() => onChange([])}>Clear</button>
						<button className="btn sm" onClick={() => setOpen(false)}>Done</button>
					</div>
				</div>
			)}
		</div>
	);
}
