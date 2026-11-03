// A session that runs without a terminal: the Claude Agent SDK on the API key, or Codex's app-server. Its view is drawn from the events the main
// process publishes — no pty, no screen to read — in the reading view's look: your messages, the agent's words and steps, the requests it waits
// on, and a message box that stays usable while it works (what you send is queued by the runtime, with its receipt shown).
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowDown, PaperPlaneRight, Stop } from '@phosphor-icons/react';
import { t } from '../../shared/i18n';
import { UserAvatar } from '../../shared/UserAvatar';
import { fullHintProps, HIDDEN_NOTE, useFittingHint } from '../../shared/useFittingHint';
import { ClaudeLogo, CodexLogo } from '../agents/AgentBrandIcon.ts';
import { nativeBridge } from './native-bridge.ts';
import { canSend, groups, isOver, isWorking } from './native-model.ts';
import { dismissNative, nativeShown, useNativeEntries, type NativeEntry } from './native-store.ts';
import { NativeItemView, NativeSummary } from './NativeItems';
import { NativeRequestCard } from './NativeRequestCard';
import { itemState, messageText, reasonWords, receiptWord, routeWord, runtimeWord, sessionWord, turnWord } from './native-words';
import './native-session.css';

// Within this many pixels of the end, the view follows the newest step.
const FOLLOW_SLACK = 40;
const hints = () => [t('给它发消息 · Enter 发送，Shift+Enter 换行'), t('给它发消息 · Enter 发送'), t('给它发消息'), t('发消息')];
const failure = (error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) });

type Sent = { id: string; text: string };

// One speaker's step on the reading view's rail (reading-flow.css): its node with the speaker's mark, then its name and what it said or did.
function RailStep({ kind, agent, who, state, latest, mark, children }: {
  kind: 'user' | 'agent'; agent?: 'claude' | 'codex'; who: string; state?: 'running' | 'failed' | null; latest: boolean; mark: ReactNode; children: ReactNode;
}) {
  return <div className={`reading-step is-${kind}${agent ? ` is-${agent}` : ''}${state ? ` is-${state}` : ''}${latest ? ' is-latest' : ''}`}>
    <span className="reading-node" aria-hidden="true">{mark}</span>
    <div className="reading-step-body"><div className="reading-step-head"><b className="reading-step-label">{who}</b></div>{children}</div>
  </div>;
}

const TurnItem = ({ kind, children }: { kind: 'message' | 'tools'; children: ReactNode }) => <div className={`reading-turn-${kind}`}><div className="reading-turn-item-body">{children}</div></div>;

function Header({ entry, onStop }: { entry: NativeEntry; onStop: (() => void) | null }) {
  const { model } = entry, identity = model.identity!, Mark = identity.provider === 'claude' ? ClaudeLogo : CodexLogo;
  const state = model.session?.state ?? null, why = isOver(model) ? reasonWords(model.session?.reason) : null;
  const moved = model.path && `${routeWord(model.path.previous)} → ${routeWord(model.path.selected)}${model.path.reason ? ` · ${reasonWords(model.path.reason)}` : ''}`;
  return <header className="native-head">
    <span className="native-runtime"><Mark size={14} />{runtimeWord(identity)}</span>
    <span className={`native-state is-${state ?? 'unknown'}`}>{sessionWord(state)}</span>
    {(moved || why) && <small className="native-route" title={moved || why || undefined}>{moved || why}</small>}
    <span className="native-spacer" />
    {onStop && <button type="button" className="button native-stop" onClick={onStop}><Stop size={13} weight="fill" />{t('停止')}</button>}
  </header>;
}

// The view of a known session (exported for its tests); NativeSessionView below finds the terminal's session and shows this.
export function NativeSession({ terminalId, entry, autoFocus }: { terminalId: string; entry: NativeEntry; autoFocus: boolean }) {
  const { model } = entry, identity = model.identity!, sessionId = identity.runtimeSessionId;
  const [text, setText] = useState(''), [sent, setSent] = useState<Sent[]>([]), [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null), scroller = useRef<HTMLDivElement>(null), following = useRef(true), [behind, setBehind] = useState(false);
  const open = canSend(model), over = isOver(model), working = !over && isWorking(model), waiting = model.session?.state === 'waiting';
  const turns = groups(model), echoed = new Set(Object.values(model.items).map(item => item.content.clientMessageId));
  const pending = sent.filter(item => !echoed.has(item.id));
  const shownHints = open ? hints() : [t('会话已结束，不能再发消息')], hint = useFittingHint(box, shownHints) || shownHints.at(-1)!, hintId = `native-hint-${terminalId}`, fullHint = fullHintProps(shownHints, hint, hintId);

  // New steps keep the end in view while the owner is at the end; scrolling up pauses that until they come back. A new request waits at the
  // end of the conversation, so it pulls the view down to it.
  const asked = model.requests.length, askedBefore = useRef(0);
  useLayoutEffect(() => {
    const node = scroller.current;
    if (asked > askedBefore.current) following.current = true;
    askedBefore.current = asked;
    if (node && following.current) node.scrollTop = node.scrollHeight;
  }, [model.lastSequence, pending.length, asked]);
  useEffect(() => { if (autoFocus && open) box.current?.focus(); }, [autoFocus, sessionId]);

  const send = async () => {
    const value = text.trim(), bridge = nativeBridge(), id = crypto.randomUUID();
    if (!value || !open || !bridge) return;
    // The box empties at once and takes the words back if the main process refuses them, unless something new was typed meanwhile.
    setText(''); setError(null); setSent(list => [...list, { id, text: value }]);
    const result = await bridge.send(terminalId, sessionId, id, value).catch(failure);
    if (result.ok) return;
    setSent(list => list.filter(item => item.id !== id)); setText(current => current || value); setError(result.error);
  };
  const stop = async () => {
    const result = await nativeBridge()?.interrupt(terminalId, sessionId).catch(failure);
    if (result && !result.ok) setError(result.error);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault(); void send();
  };
  const status = waiting ? t('等你确认') : working ? t('正在工作…') : turnWord(model.turn.status);
  const finished = model.error ?? (model.turn.error ? { message: model.turn.error, willRetry: false } : null);

  return <div className="reading-view native-view" data-agent={identity.provider} data-native-session={sessionId}>
    <Header entry={entry} onStop={working ? () => void stop() : null} />
    <div className="reading-scroll-area">
      <div className="reading-scroll native-scroll" ref={scroller} role="log" aria-live="off" aria-label={t('{name} 的对话', { name: runtimeWord(identity) })}
        onScroll={event => { const node = event.currentTarget, end = node.scrollHeight - node.scrollTop - node.clientHeight <= FOLLOW_SLACK; following.current = end; setBehind(!end); }}>
        <div className="reading-content conversation-feed" data-agent={identity.provider}>
          {turns.length === 0 && pending.length === 0 && <p className="reading-status"><span>{t('会话已就绪，说点什么吧')}</span></p>}
          {turns.map((turn, index) => {
            const latest = index >= turns.length - 2;
            if (turn.kind === 'user') {
              const sentId = turn.item.content.clientMessageId, receipt = typeof sentId === 'string' ? receiptWord(model.receipts[sentId]) : null;
              return <RailStep key={turn.item.id} kind="user" who={t('你')} latest={latest} mark={<UserAvatar />}>
                <div className="reading-user"><p>{messageText(turn.item)}</p>{receipt && <small className="native-receipt">{receipt}</small>}</div>
              </RailStep>;
            }
            const marks = turn.items.map(itemState), mark = marks.includes('running') ? 'running' : marks.includes('failed') ? 'failed' : null;
            return <RailStep key={turn.items[0].id} kind="agent" agent={identity.provider} who={identity.provider === 'claude' ? 'Claude' : 'Codex'} state={mark} latest={latest} mark={identity.provider === 'claude' ? <ClaudeLogo /> : <CodexLogo />}>
              <div className="reading-turn">{turn.items.map(item => <TurnItem key={item.id} kind={item.kind === 'agent-message' ? 'message' : 'tools'}><NativeItemView item={item} /></TurnItem>)}</div>
            </RailStep>;
          })}
          {pending.map(item => <RailStep key={item.id} kind="user" who={t('你')} latest mark={<UserAvatar />}>
            <div className="reading-user"><p>{item.text}</p><small className="native-receipt">{receiptWord(model.receipts[item.id]) ?? t('发送中')}</small></div>
          </RailStep>)}
          <NativeSummary model={model} />
          {status && <p className={`reading-status is-${identity.provider}${waiting ? ' is-waiting' : ''}`} role="status"><i className="reading-status-mark" aria-hidden="true" /><span>{status}</span></p>}
          {finished?.message && <p className="form-error" role="alert">{finished.message}{finished.willRetry ? ` · ${t('正在重试')}` : ''}</p>}
          {model.requests.length > 0 && <div className="native-requests">{model.requests.map(request => <NativeRequestCard key={request.id} request={request} terminalId={terminalId} sessionId={sessionId} />)}</div>}
        </div>
      </div>
      {behind && <div className="reading-latest"><button type="button" className="icon-button reading-jump" title={t('回到最新')} aria-label={t('回到最新')} onClick={() => { following.current = true; setBehind(false); scroller.current?.scrollTo({ top: scroller.current.scrollHeight }); }}><ArrowDown size={16} /></button></div>}
    </div>
    {error && <p className="form-error native-error" role="alert">{error}</p>}
    {over && <div className="native-ended"><span>{reasonWords(model.session?.reason) ?? t('这个会话已经结束')}</span><button type="button" className="button secondary small" onClick={() => dismissNative(terminalId)}>{t('开始新的对话')}</button></div>}
    <div className="reading-composer">
      <textarea ref={box} rows={1} value={text} disabled={!open} aria-label={t('给 {name} 发消息', { name: runtimeWord(identity) })} placeholder={hint} {...fullHint}
        onChange={event => setText(event.target.value)} onKeyDown={onKeyDown} />
      {fullHint['aria-describedby'] && <span id={hintId} style={HIDDEN_NOTE}>{shownHints[0]}</span>}
      <button type="button" className="icon-button reading-send" title={t('发送')} aria-label={t('发送')} disabled={!open || !text.trim()} onClick={() => void send()}><PaperPlaneRight size={15} weight="fill" /></button>
    </div>
  </div>;
}

export function NativeSessionView({ terminalId, autoFocus = false }: { terminalId: string; autoFocus?: boolean }) {
  const entry = useNativeEntries().get(terminalId);
  return nativeShown(entry) ? <NativeSession key={entry.model.identity!.runtimeSessionId} terminalId={terminalId} entry={entry} autoFocus={autoFocus} /> : null;
}
