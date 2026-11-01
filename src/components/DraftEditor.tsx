/**
 * Edits an AI-drafted reply. Facts the AI could not know appear as yellow [[provide: …]] placeholders;
 * click one and type over it. Nothing is sent until Send is pressed, and Send stays disabled while any
 * yellow item remains. Sending goes through Gmail as a reply in the same thread.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MdSend, MdSave, MdRefresh, MdClose, MdContentCopy, MdArrowForward, MdInfoOutline, MdAutoAwesome, MdEditNote } from 'react-icons/md';
import { api } from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { ago } from '../lib/format';

const PH = /\[\[\s*provide\s*:(.*?)\]\](?!\])/gis;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** text → HTML with yellow, clickable placeholders */
function toHtml(text: string) {
	return esc(text).replace(PH, (_m, p) => `<mark class="ph" data-ph="${esc(p.trim())}">${esc(p.trim())}</mark>`);
}
/** editor DOM → text; an untouched placeholder is written back as [[provide: …]] */
function fromDom(el: HTMLElement): string {
	let out = '';
	const walk = (n: Node) => {
		if (n.nodeType === Node.TEXT_NODE) { out += n.textContent || ''; return; }
		if (!(n instanceof HTMLElement)) return;
		if (n.tagName === 'BR') { out += '\n'; return; }
		if (n.tagName === 'MARK' && n.dataset.ph !== undefined) {
			const t = n.textContent || '';
			out += t === n.dataset.ph ? `[[provide: ${t}]]` : t;
			return;
		}
		const block = n.tagName === 'DIV' || n.tagName === 'P';
		if (block && out && !out.endsWith('\n')) out += '\n';
		n.childNodes.forEach(walk);
	};
	el.childNodes.forEach(walk);
	return out;
}

export const countPlaceholders = (body: string) => (body.match(PH) || []).length;
/** the distinct yellow items in a draft, in order */
export const placeholderList = (body: string) => [...new Set([...body.matchAll(PH)].map((m) => m[1].trim()))];

export default function DraftEditor({ draft, onDone, compact }: { draft: any; onDone?: () => void; compact?: boolean }) {
	const { can } = useAuth();
	const toast = useToast();
	const qc = useQueryClient();
	const ref = useRef<HTMLDivElement>(null);
	const [body, setBody] = useState<string>(draft.body);
	const [to, setTo] = useState<string>((draft.to_addresses || []).join(', '));
	const [cc, setCc] = useState<string>((draft.cc_addresses || []).join(', '));
	const [subject, setSubject] = useState<string>(draft.subject || '');
	const [dirty, setDirty] = useState(false);
	const sent = draft.status === 'sent';
	const editable = can('analyst') && !sent;

	// load a different draft (or a regenerated one) into the editor
	useEffect(() => {
		setBody(draft.body);
		setTo((draft.to_addresses || []).join(', '));
		setCc((draft.cc_addresses || []).join(', '));
		setSubject(draft.subject || '');
		setDirty(false);
		if (ref.current) ref.current.innerHTML = toHtml(draft.body);
	}, [draft.id, draft.body, draft.updated_at]);

	const footerQ = useQuery({ queryKey: ['draft-footer', draft.id], queryFn: () => api(`/drafts/${draft.id}/footer`), staleTime: 300_000, enabled: draft.status !== 'sent' });
	const open = useMemo(() => countPlaceholders(body), [body]);
	const items = useMemo(() => placeholderList(body), [body]);
	const [answers, setAnswers] = useState<Record<string, string>>({});
	useEffect(() => setAnswers({}), [draft.id]);
	const typed = items.filter((i) => answers[i]?.trim()).length;
	const refresh = () => { qc.invalidateQueries({ queryKey: ['drafts'] }); qc.invalidateQueries({ queryKey: ['draft'] }); qc.invalidateQueries({ queryKey: ['conversation'] }); qc.invalidateQueries({ queryKey: ['nav-drafts'] }); };
	const payload = () => ({ body: ref.current ? fromDom(ref.current) : body, to, cc, subject });

	const save = useMutation({ mutationFn: () => api(`/drafts/${draft.id}`, { method: 'PUT', body: payload() }), onSuccess: () => { setDirty(false); refresh(); toast('Draft saved'); }, onError: (e: any) => toast(e.message, 'error') });
	const send = useMutation({
		mutationFn: () => api(`/drafts/${draft.id}/send`, { body: payload() }),
		onSuccess: (r) => { refresh(); toast(`Sent from ${r.from}`); onDone?.(); },
		onError: (e: any) => { refresh(); toast(e.message, 'error'); },
	});
	const regen = useMutation({ mutationFn: () => api(`/drafts/${draft.id}/regenerate`, { body: {} }), onSuccess: () => { refresh(); toast('A new draft was written'); }, onError: (e: any) => toast(e.message, 'error') });
	const fill = useMutation({
		mutationFn: async (rewrite: boolean) => {
			if (dirty) await api(`/drafts/${draft.id}`, { method: 'PUT', body: payload() });
			return api(`/drafts/${draft.id}/fill`, { body: { rewrite, answers: items.filter((i) => answers[i]?.trim()).map((i) => ({ item: i, value: answers[i] })) } });
		},
		onSuccess: (r: any) => {
			setAnswers({});
			setDirty(false);
			refresh();
			toast(`${r.how === 'rewritten by AI' ? 'Email rewritten with your answers' : 'Answers added to the email'}${r.remaining ? `; ${r.remaining} item${r.remaining > 1 ? 's' : ''} still to fill in` : '; ready to send'}`);
		},
		onError: (e: any) => toast(e.message, 'error'),
	});
	const dismiss = useMutation({ mutationFn: () => api(`/drafts/${draft.id}/dismiss`, { body: {} }), onSuccess: () => { refresh(); toast('Draft dismissed'); onDone?.(); } });

	const onInput = () => { if (ref.current) { setBody(fromDom(ref.current)); setDirty(true); } };
	const nextPlaceholder = () => {
		const m = ref.current?.querySelector('mark.ph') as HTMLElement | null;
		if (!m) return;
		m.scrollIntoView({ block: 'center' });
		const r = document.createRange();
		r.selectNodeContents(m);
		const sel = window.getSelection();
		sel?.removeAllRanges();
		sel?.addRange(r);
		ref.current?.focus();
	};
	const onKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === 'Enter') { e.preventDefault(); document.execCommand('insertText', false, '\n'); }
	};
	const onPaste = (e: React.ClipboardEvent) => { e.preventDefault(); document.execCommand('insertText', false, e.clipboardData.getData('text/plain')); };

	return (
		<div className="draft-editor">
			{!compact && draft.summary && <div className="small muted mb-8">{draft.summary}</div>}
			<div className="draft-fields">
				<label>From</label><div className="mono small">{draft.send_from || <span className="faint">No connected mailbox received this email</span>}</div>
				<label htmlFor={`to-${draft.id}`}>To</label><input id={`to-${draft.id}`} className="input" value={to} disabled={!editable} onChange={(e) => { setTo(e.target.value); setDirty(true); }} />
				<label htmlFor={`cc-${draft.id}`}>Cc</label><input id={`cc-${draft.id}`} className="input" value={cc} disabled={!editable} placeholder="Optional" onChange={(e) => { setCc(e.target.value); setDirty(true); }} />
				<label htmlFor={`su-${draft.id}`}>Subject</label><input id={`su-${draft.id}`} className="input" value={subject} disabled={!editable} onChange={(e) => { setSubject(e.target.value); setDirty(true); }} />
			</div>
			{open > 0 && editable && (
				<div className="info-needed mt-8">
					<div className="row-between">
						<b className="row" style={{ gap: 6 }}><MdEditNote /> Information needed ({items.length})</b>
						<button className="btn ghost sm" onClick={nextPlaceholder} title="Jump to the next yellow item in the email">Show in email <MdArrowForward /></button>
					</div>
					<div className="xs faint">Type each answer in its box. Then press <b>Add and rewrite</b>: the email is rewritten so your answers read naturally, in the customer's language.</div>
					<div className="info-items">
						{items.map((it, k) => (
							<label key={it} className="info-item">
								<span>{k + 1}. {it}</span>
								<textarea className="input" rows={1} value={answers[it] || ''} placeholder="Type the answer"
									onChange={(e) => setAnswers({ ...answers, [it]: e.target.value })}
									onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && typed) fill.mutate(true); }} />
							</label>
						))}
					</div>
					<div className="row wrap" style={{ gap: 8 }}>
						<button className="btn primary sm" disabled={!typed || fill.isPending} onClick={() => fill.mutate(true)}>
							<MdAutoAwesome /> {fill.isPending ? 'Rewriting…' : `Add and rewrite${typed && typed < items.length ? ` (${typed} of ${items.length})` : ''}`}
						</button>
						<button className="btn ghost sm" disabled={!typed || fill.isPending} onClick={() => fill.mutate(false)} title="Put the answers in exactly as typed, without rewriting">Insert as typed</button>
						<span className="xs faint">You can answer some now and the rest later. Ctrl+Enter also submits.</span>
					</div>
				</div>
			)}
			<div
				ref={ref}
				className={`draft-body ${editable ? '' : 'readonly'}`}
				contentEditable={editable}
				suppressContentEditableWarning
				onInput={onInput}
				onKeyDown={onKeyDown}
				onPaste={onPaste}
				aria-label="Reply text"
				role="textbox"
				aria-multiline="true"
			/>
			{footerQ.data?.footer && (
				<div className="draft-footer" title="Added automatically when the reply is sent">
					<div dangerouslySetInnerHTML={{ __html: footerQ.data.footer.html }} />
					<div className="xs faint mt-8">Added when sent. Address: {footerQ.data.footer.branch.city === 'Head office' ? 'head office' : `${footerQ.data.footer.branch.city} location`}, because {footerQ.data.footer.why}. Locations and the head office are in Settings → Reply drafts.</div>
				</div>
			)}
			{draft.last_error && !sent && <div className="notice error small mt-8"><MdInfoOutline /><span>Last send failed: {draft.last_error}</span></div>}
			<div className="row wrap mt-8" style={{ gap: 8 }}>
				{sent ? (
					<span className="badge green">Sent {ago(draft.sent_at)}{draft.sent_by_name ? ` by ${draft.sent_by_name}` : ''} from {draft.send_from}</span>
				) : editable ? (
					<>
						<button className="btn primary" disabled={open > 0 || send.isPending || !draft.canSend || !to.trim()} title={open > 0 ? 'Fill in the highlighted items first' : !draft.canSend ? 'This email did not arrive in a connected mailbox' : 'Send from the mailbox the customer wrote to'} onClick={() => send.mutate()}>
							<MdSend /> {send.isPending ? 'Sending…' : 'Send'}
						</button>
						<button className="btn" disabled={!dirty || save.isPending} onClick={() => save.mutate()}><MdSave /> Save draft</button>
						<button className="btn ghost" disabled={regen.isPending} onClick={() => (!draft.edited && !dirty) || confirm('Replace your edits with a newly written draft?') ? regen.mutate() : null}><MdRefresh /> {regen.isPending ? 'Writing…' : 'Rewrite'}</button>
						<button className="btn ghost" onClick={() => { navigator.clipboard.writeText(payload().body); toast('Copied'); }}><MdContentCopy /> Copy</button>
						<button className="btn ghost" style={{ marginLeft: 'auto' }} onClick={() => dismiss.mutate()}><MdClose /> No reply needed</button>
					</>
				) : <span className="small faint">Viewers can read drafts but not send them.</span>}
			</div>
			<div className="xs faint mt-8">
				Drafted {ago(draft.generated_at)}{draft.model ? ` by ${draft.model}` : ''}{draft.edited ? ` · edited${draft.updated_by_name ? ` by ${draft.updated_by_name}` : ''}` : ''}. Nothing is sent until you press Send; it then goes from Outlook (or Gmail) as a reply in the same thread.
			</div>
		</div>
	);
}
