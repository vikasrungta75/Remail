import { Fragment, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { MdAutoAwesome, MdSend } from 'react-icons/md';
import { api } from '../api/client';
import { useFilters } from '../contexts/FilterContext';
import { Card, PageHead, RagDot } from '../components/ui';
import { COLORS } from '../lib/format';

interface Msg { role: 'me' | 'ai'; text: string; refs?: any[] }

/** Render [#123] citations as links to the conversation */
function withLinks(text: string) {
	const parts = text.split(/(\[#\d+\])/g);
	return parts.map((p, i) => {
		const m = /^\[#(\d+)\]$/.exec(p);
		return m ? <Link key={i} to={`/conversations/${m[1]}`} style={{ fontWeight: 700 }}>#{m[1]}</Link> : <Fragment key={i}>{p}</Fragment>;
	});
}

export default function MailSage() {
	const { params } = useFilters();
	const [msgs, setMsgs] = useState<Msg[]>([]);
	const [q, setQ] = useState('');
	const [busy, setBusy] = useState(false);
	const log = useRef<HTMLDivElement>(null);
	const sugg = useQuery({ queryKey: ['sage-suggestions'], queryFn: () => api('/copilot/suggestions') });
	useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight, behavior: 'smooth' }); }, [msgs]);

	const ask = async (question: string) => {
		if (!question.trim() || busy) return;
		setMsgs((m) => [...m, { role: 'me', text: question }]);
		setQ('');
		setBusy(true);
		try {
			const filters: Record<string, string> = {};
			Object.entries(params).forEach(([k, v]) => { if (v && (!Array.isArray(v) || v.length)) filters[k] = Array.isArray(v) ? v.join(',') : String(v); });
			const r = await api('/copilot/ask', { body: { question, filters } });
			setMsgs((m) => [...m, { role: 'ai', text: r.answer, refs: r.references }]);
		} catch (e: any) {
			setMsgs((m) => [...m, { role: 'ai', text: `Sorry, I could not answer that: ${e.message}` }]);
		} finally {
			setBusy(false);
		}
	};

	return (
		<>
			<PageHead kw="Mail" rest="Sage" sub="Ask anything about your customer email. Answers are grounded in your analysed conversations and cite them." />
			<div className="sage">
				<Card className="chat" accent={COLORS.pink} style={{ display: 'flex', flexDirection: 'column' }}>
					<div className="chat-log" ref={log} style={{ minHeight: 360 }}>
						{!msgs.length && (
							<div className="empty" style={{ margin: 'auto' }}>
								<MdAutoAwesome style={{ color: COLORS.pink }} />
								<div style={{ fontWeight: 700, color: 'var(--text)' }}>What would you like to know?</div>
								<div className="small">Try one of the suggested questions on the right.</div>
							</div>
						)}
						{msgs.map((m, i) => (
							<div key={i} className={`bubble ${m.role}`}>
								{m.role === 'ai' ? withLinks(m.text) : m.text}
								{m.refs && m.refs.length > 0 && (
									<div className="mt-8 col gap-4">
										<div className="xs faint">Sources</div>
										{m.refs.slice(0, 5).map((r) => (
											<Link key={r.id} to={`/conversations/${r.id}`} className="small row gap-4"><RagDot rag={r.rag} /> {r.customer}: {r.subject}</Link>
										))}
									</div>
								)}
							</div>
						))}
						{busy && <div className="bubble ai faint">Thinking…</div>}
					</div>
					<form className="chat-input" onSubmit={(e) => { e.preventDefault(); ask(q); }}>
						<input className="input" placeholder="Ask about customers, issues, commitments or trends" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Question" />
						<button className="btn primary" disabled={busy || !q.trim()}><MdSend /> Ask</button>
					</form>
				</Card>
				<div className="col gap-16">
					<Card title="Suggested questions" accent={COLORS.purple}>
						<div className="col">
							{(sugg.data?.suggestions || []).map((s: string) => (
								<button key={s} className="btn" style={{ justifyContent: 'flex-start', whiteSpace: 'normal', textAlign: 'left' }} onClick={() => ask(s)}>{s}</button>
							))}
						</div>
					</Card>
					<Card title="How it works" accent={COLORS.teal}>
						<div className="small muted">
							Mail Sage searches the analysed conversations within your current filters, then {sugg.data?.mode === 'ai' ? 'asks the AI model to answer using only that data' : 'answers with built-in rules (connect an AI provider for free-form answers)'}. Every answer links back to the source threads.
						</div>
					</Card>
				</div>
			</div>
		</>
	);
}
