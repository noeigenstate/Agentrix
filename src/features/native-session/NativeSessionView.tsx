// A session that runs without a terminal: the Claude Agent SDK on the API key, or Codex's app-server. The events the main process publishes are the
// data; the view is the reading view's own: the conversation is native-entries.ts's ConversationEntry[] drawn by ConversationFeed, with the same
// scroll, working line, result card and message box. Only what a terminal session does not have is added at the end of the timeline: the requests
// waiting on the owner and the question about a run-mode change.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import { ArrowDown, Image as ImageIcon, PaperPlaneRight, Stop } from '@phosphor-icons/react';
import { t } from '../../shared/i18n';
import { fullHintProps, HIDDEN_NOTE, useFittingHint } from '../../shared/useFittingHint';
import { actionText } from '../agents/action-text';
import { ConversationDecorations, ConversationFeed } from '../reading/ConversationFeed';
import { AgentMark, latestResult, pastedPicture, PendingPromptEntries, QuoteChip, quoteExcerpt, ResultActions, ResultChecks, ResultStatus, TimelineStep, useStickToBottom, UserImages, withQuote, WorkingLine, type MessageQuote, type PendingPrompt } from '../reading/feed-parts';
import { nativeBridge, type NativePendingInput, type SwitchState } from './native-bridge.ts';
import type { Handoff } from './draft-handoff.ts';
import { nativeEntries, nativePending, runningStep, type SentMessage } from './native-entries.ts';
import { canSend, isOver, isWorking } from './native-model.ts';
import { MAX_PICTURES, picturesOnly, readPictures } from './native-pictures.ts';
import { dismissNative, nativeShown, resolveSwitch, useNativeEntries, type NativeEntry } from './native-store.ts';
import { NativeRequestCard } from './NativeRequestCard';
import { asksChoice, SwitchLine, SwitchQuestion } from './SwitchNotice';
import { noticeWords, reasonWords, sentence, switchLine, turnFacts, turnFailed } from './native-words';
import './native-session.css';

const hints = () => [t('给它发消息 · Enter 发送，Shift+Enter 换行'), t('给它发消息 · Enter 发送'), t('给它发消息'), t('发消息')];
const failure = (error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) });
const NO_PICTURES: string[] = [];

type SessionProps = {
  terminalId: string; projectId: string; entry: NativeEntry; autoFocus: boolean; switchState?: SwitchState | null; handoff: Handoff;
  onError: (message: string) => void; onOpenLink: (target: string) => void;
};

// The view of a known session (exported for its tests); NativeSessionView below finds the terminal's session and shows this.
export function NativeSession({ terminalId, projectId, entry, autoFocus, switchState = null, handoff, onError, onOpenLink }: SessionProps) {
  const { model } = entry, identity = model.identity!, kind = identity.provider, sessionId = identity.runtimeSessionId, change = resolveSwitch(switchState, entry);
  const agent = kind === 'claude' ? 'Claude Code' : 'Codex';
  const [text, setText] = useState(''), [sent, setSent] = useState<SentMessage[]>([]), [discarded, setDiscarded] = useState<ReadonlySet<string>>(new Set()), [error, setError] = useState<string | null>(null);
  // What a switch carries in: pictures that go with the next message, and messages the previous session never delivered. Neither is ever sent by itself.
  const [carried, setCarried] = useState<string[]>([]), [unsent, setUnsent] = useState<NativePendingInput[]>([]);
  // One quoted message waits for the next message; the newest wins.
  const [quote, setQuote] = useState<MessageQuote | null>(null);
  // A file is being dragged over the view (the box takes it as a picture).
  const [dropping, setDropping] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null), scroller = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null);
  const locked = handoff.locked, open = canSend(model) && !locked, over = isOver(model), working = !over && isWorking(model), waiting = model.session?.state === 'waiting';
  const entries = useMemo(() => nativeEntries(model, Object.fromEntries(sent.flatMap(message => message.images?.length ? [[message.id, message.images]] : []))), [model, sent]);
  const pending = useMemo(() => nativePending(model, sent, discarded), [model, sent, discarded]);
  const shownHints = open ? hints() : [locked ? t('正在切换运行方式，稍后继续') : t('会话已结束，不能再发消息')];
  const hint = useFittingHint(box, shownHints) || shownHints.at(-1)!, hintId = `native-hint-${terminalId}`, fullHint = fullHintProps(shownHints, hint, hintId);

  // New steps keep the end in view while the owner is at the end; scrolling up pauses that until they come back. A new request waits at the end of the
  // conversation, so it pulls the view down to it.
  const { stuck, unseen, toBottom, ready } = useStickToBottom(scroller, content, entries, sessionId);
  const asked = model.requests.length + (asksChoice(change) ? 1 : 0), askedBefore = useRef(0);
  useLayoutEffect(() => { if (asked > askedBefore.current) toBottom(); askedBefore.current = asked; }, [asked]);
  useEffect(() => { if (autoFocus && open) box.current?.focus(); }, [autoFocus, sessionId]);

  // The draft goes to main when a switch prepares: the words, the pictures, and the messages never delivered: those carried in and those main refused.
  // One it has queued or read is its own and never offered again.
  const refused = pending.prompts.filter(prompt => pending.lost.has(prompt.id)).map(prompt => ({ clientMessageId: prompt.id, text: prompt.text, images: prompt.images }));
  const offering = JSON.stringify([text, carried, unsent, refused]);
  useEffect(() => { handoff.offer({ text, images: carried, undelivered: [...unsent, ...refused] }); }, [offering]);
  // A draft that came with the session goes into the box, or beside what was already typed there. One that came back to the box it left (a switch
  // that failed) is there already: it is shown once.
  useEffect(() => {
    const draft = handoff.incoming && handoff.take();
    if (!draft) return;
    const typed = text.trim(), words = draft.text.trim() ? { clientMessageId: crypto.randomUUID(), text: draft.text } : null;
    if (words && !typed) setText(draft.text);
    setCarried(list => [...list, ...draft.images.filter(image => !list.includes(image))]);
    setUnsent(list => [...list, ...(words && typed && typed !== draft.text.trim() ? [words] : []),
      ...draft.undelivered.filter(message => !pending.lost.has(message.clientMessageId) && !list.some(held => held.clientMessageId === message.clientMessageId))]);
  }, [handoff.incoming]);

  // The message goes to the main process as it is; one it refuses is shown no more as sent.
  const post = async (value: string, pictures: string[]) => {
    const bridge = nativeBridge(), id = crypto.randomUUID();
    if (!bridge) return false;
    setError(null); setSent(list => [...list, { id, text: value, images: pictures.length ? pictures : undefined, at: Date.now() }]);
    const result = await bridge.send(terminalId, sessionId, id, value, pictures.length ? pictures : undefined).catch(failure);
    if (!result.ok) { setSent(list => list.filter(message => message.id !== id)); setError(result.error); }
    return result.ok;
  };
  // The box empties at once and takes the words back if the main process refuses them, unless something new was typed meanwhile. Pictures alone are a message too.
  const send = async () => {
    const value = text.trim(), pictures = carried, quoted = quote;
    if (!(value || pictures.length) || !open) return;
    setText(''); setCarried([]); setQuote(null);
    if (!await post(withQuote(quoted?.excerpt, value || picturesOnly()), pictures)) { setText(current => current || value); setCarried(current => current.length ? current : pictures); setQuote(current => current ?? quoted); }
  };
  // A picture pasted or dropped joins the ones that go with the next message; one the runtime would refuse is refused here, with the reason.
  const attach = async (files: File[]) => {
    const { pictures, error: problem } = await readPictures(files, MAX_PICTURES - carried.length);
    setCarried(list => [...list, ...pictures.filter(picture => !list.includes(picture))].slice(0, MAX_PICTURES));
    setError(problem);
  };
  const pasteImage = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const file = pastedPicture(event.clipboardData)?.getAsFile();
    if (!file) return;
    event.preventDefault(); void attach([file]);
  };
  const carriesFiles = (event: DragEvent) => event.dataTransfer.types.includes('Files');
  const dragOver = (event: DragEvent) => { if (carriesFiles(event)) { event.preventDefault(); event.dataTransfer.dropEffect = open ? 'copy' : 'none'; setDropping(open); } };
  const drop = (event: DragEvent) => {
    if (!carriesFiles(event)) return;
    event.preventDefault(); setDropping(false);
    if (open) void attach([...event.dataTransfer.files]);
  };
  // A message that was never delivered is sent again only by the owner's click; its card goes, and comes back if this one is refused too.
  const discard = (prompt: PendingPrompt) => setDiscarded(list => new Set(list).add(prompt.id));
  const resend = async (prompt: PendingPrompt) => {
    if (!open) return;
    discard(prompt);
    if (!await post(prompt.text, prompt.images ?? NO_PICTURES)) setDiscarded(list => { const rest = new Set(list); rest.delete(prompt.id); return rest; });
  };
  const stop = async () => {
    const result = await nativeBridge()?.interrupt(terminalId, sessionId).catch(failure);
    if (result && !result.ok) setError(result.error);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { if (working && open) { event.preventDefault(); void stop(); } return; }
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault(); void send();
  };
  // An unsent message returns to the box by the owner's click, when the box is empty; nothing takes it from here.
  const take = (item: NativePendingInput) => { setText(item.text); setCarried(list => [...list, ...item.images ?? []]); setUnsent(list => list.filter(held => held !== item)); };

  // What the agent is doing, written at the end of the conversation the way the reading view writes it.
  const step = runningStep(entries);
  const status = waiting ? <div className="reading-status is-waiting" role="status">{t('等你确认')}</div>
    : working ? <WorkingLine key={sessionId} agent={kind} label={step ? t('正在{step}', { step: actionText(step) }) : t('{agent} 正在思考', { agent })} /> : null;
  // The latest round, once it has ended, gets its status above the result and its actions under it; a turn that failed says how.
  const settled = !over && model.session?.state === 'idle' && !model.turn.running && !pending.prompts.length && !model.requests.length && !asksChoice(change);
  // How the turn ended is the provider's own: its status draws the row (a turn that did not complete is never drawn as done) and the sentence main wrote for
  // it is shown as it is (translated like any interface text). An error event for a limit the provider's notice already tells is not told twice.
  const turnStatus = model.turn.status, failed = turnStatus === 'failed', stopped = turnStatus === 'interrupted', end = model.turn.end;
  const ended = turnStatus && turnStatus !== 'completed' ? sentence(end?.message ?? model.turn.error) : null;
  const noticed = model.limits?.notice?.code !== undefined && model.limits.notice.code === model.error?.code;
  const why = ended ?? (noticed ? null : sentence(model.error?.message));
  const facts = useMemo(() => turnFacts(end, kind, turnStatus === 'completed'), [end, kind, turnStatus]);
  const result = useMemo(() => latestResult(entries, { idle: settled, interrupted: stopped, stopped, failure: failed ? why ?? turnFailed() : undefined, facts }),
    [entries, settled, stopped, failed, why, facts]);
  // Only the owner's click on a message's 引用 gets here.
  const quoteMessage = (who: string, words: string) => { const excerpt = quoteExcerpt(words); if (excerpt) { setQuote({ who, excerpt }); box.current?.focus(); } };
  const continueWith = (prefill?: string) => { if (prefill && !text.trim()) setText(prefill); box.current?.focus(); };
  const resultStatus = result && <ResultStatus result={result} taskTitle={undefined} onError={setError} />;
  const resultActions = result && <>
    {result.kind === 'code' && <ResultChecks result={result} />}
    <ResultActions result={result} projectId={projectId} remote={false} canSend={open} onContinue={continueWith} onRetry={() => void post(result.request, NO_PICTURES)} onError={setError} />
  </>;
  const last = entries.at(-1), statusInTurn = !!last && last.role !== 'user' && pending.prompts.every(prompt => pending.queued.has(prompt.id));
  // An error the result card does not carry (the round is still going, or left nothing to show) is a line of its own.
  // A turn that was stopped is told in a quiet line; one that failed, or an error while it runs, is an alert. The provider's notice that a limit was reached
  // comes with when it recovers, only if the provider says when.
  const errorLine = !result && why ? why : null, retrying = !failed && model.error?.willRetry === true, notice = noticeWords(model.limits?.notice);
  const afterFeed = <>
    <PendingPromptEntries prompts={pending.prompts} queued={prompt => pending.queued.has(prompt.id)} undelivered={prompt => pending.lost.has(prompt.id)} onResend={prompt => void resend(prompt)} onDiscard={discard} />
    {status && !statusInTurn && <TimelineStep at={pending.prompts.at(-1)?.at ?? last?.at} kind="agent" who={agent} state={working ? 'running' : null} agent={kind} mark={<AgentMark agent={kind} />}>{status}</TimelineStep>}
    {(switchLine(change) || errorLine || notice || model.requests.length > 0 || asksChoice(change)) && <div className="native-tail">
      <SwitchLine state={change} />
      {errorLine && (stopped ? <p className="reading-status" role="status">{errorLine}</p> : <p className="form-error" role="alert">{errorLine}{retrying ? ` · ${t('正在重试')}` : ''}</p>)}
      {notice && <p className="reading-status" role="status">{[notice.text, notice.resets].filter(Boolean).join(' · ')}</p>}
      {model.requests.map(request => <NativeRequestCard key={request.id} request={request} terminalId={terminalId} sessionId={sessionId} />)}
      <SwitchQuestion terminalId={terminalId} sessionId={sessionId} state={change} />
    </div>}
  </>;

  return <div className={`reading-view${dropping ? ' is-dropping' : ''}`} data-agent={kind} data-native-session={sessionId} onDragOver={dragOver} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false); }} onDrop={drop}>
    <div className="reading-scroll-area">
      <div className="reading-scroll" ref={scroller} tabIndex={0}>
        <ConversationDecorations.Provider value={{ start: 0, status: statusInTurn ? status : null, running: working, anchor: result?.anchor, beforeResult: resultStatus, afterResult: resultActions,
          quote: { disabled: open ? null : t('输入框暂时不可用，等它可用后再引用'), pick: quoteMessage },
          frame: { ref: content, style: { visibility: entries.length && !ready ? 'hidden' : undefined }, before: null } }}>
          <ConversationFeed entries={entries} agent={kind} projectId={projectId} live={!settled} onError={onError} onOpenLink={onOpenLink}>{afterFeed}</ConversationFeed>
        </ConversationDecorations.Provider>
      </div>
      {!stuck && <div className="reading-latest">
        {unseen > 0 && <span className="reading-unseen" role="status">{t('{count} 条新消息', { count: unseen })}</span>}
        <button type="button" className="icon-button reading-jump" title={t('跳到最新消息')} aria-label={t('跳到最新消息')} onClick={() => toBottom('smooth')}><ArrowDown size={18} /></button>
      </div>}
    </div>
    {error && <p className="form-error native-error" role="alert">{error}</p>}
    {over && <div className="native-ended"><span>{reasonWords(model.session?.reason) ?? t('这个会话已经结束')}</span><button type="button" className="button secondary small" onClick={() => dismissNative(terminalId)}>{t('开始新的对话')}</button></div>}
    {carried.length > 0 && <div className="reading-attachments" role="status"><ImageIcon size={14} />{t('已附加 {count} 张图片，随下一条消息发送', { count: carried.length })}<UserImages images={carried} onRemove={index => setCarried(list => list.filter((_, at) => at !== index))} /></div>}
    {unsent.length > 0 && <div className="reading-outbox" role="status"><span>{t('未发送的消息')}</span><ol>{unsent.map(item => <li key={item.clientMessageId}>{item.text}
      <button type="button" className="text-button" disabled={!!text.trim() || locked} onClick={() => take(item)}>{t('取回')}</button></li>)}</ol></div>}
    {quote && <QuoteChip quote={quote} onRemove={() => { setQuote(null); box.current?.focus(); }} />}
    <div className="reading-composer">
      <textarea ref={box} rows={1} value={text} disabled={!open} aria-label={t('给 {name} 发消息', { name: agent })} placeholder={hint} {...fullHint}
        onChange={event => setText(event.target.value)} onKeyDown={onKeyDown} onPaste={pasteImage} />
      {fullHint['aria-describedby'] && <span id={hintId} style={HIDDEN_NOTE}>{shownHints[0]}</span>}
      {working && <button type="button" className="icon-button" disabled={!open} title={t('中断（Esc）')} aria-label={t('中断（Esc）')} onClick={() => void stop()}><Stop size={15} weight="fill" /></button>}
      <button type="button" className="icon-button reading-send" title={t('发送')} aria-label={t('发送')} disabled={!open || !(text.trim() || carried.length)} onClick={() => void send()}><PaperPlaneRight size={15} weight="fill" /></button>
    </div>
  </div>;
}

export function NativeSessionView({ terminalId, projectId, autoFocus = false, switchState = null, handoff, onError, onOpenLink }: Omit<SessionProps, 'entry'>) {
  const entry = useNativeEntries().get(terminalId);
  return nativeShown(entry) ? <NativeSession key={entry.model.identity!.runtimeSessionId} terminalId={terminalId} projectId={projectId} entry={entry} autoFocus={autoFocus}
    switchState={switchState} handoff={handoff} onError={onError} onOpenLink={onOpenLink} /> : null;
}
