// The owner's word to one sub-agent, written in its split. It goes through the main process straight to the worker (never pasted into the
// planner's input), and the receipt says how far it got; nothing here is ever typed into a terminal.
import { type KeyboardEvent, useRef, useState } from 'react';
import { PaperPlaneRight, Stop } from '@phosphor-icons/react';
import type { AgentIntervention, Result } from '../../shared/types';
import { t } from '../../shared/i18n';
import { fullHintProps, HIDDEN_NOTE, useFittingHint } from '../../shared/useFittingHint';
import { receiptWord } from '../native-session/native-words';
import './subagent-input.css';

export const MAX_INTERVENTION = 4000;

// The hint, longest first: the box shows the first that fits its width, so a narrow split gets a short one instead of a cut-off one. None
// carries the worker's name (a long task title would push every one out of the box; the box's accessible name has it), and the last is short
// enough for any box, so an empty box always says what it is for.
const openHints = () => [t('给它发消息，Enter 发送，Shift+Enter 换行'), t('给它发消息，Enter 发送'), t('给它发消息'), t('发消息')];
const closedHints = () => [t('它已结束或不可用，不能再发消息'), t('已结束，不能再发消息')];

export function SubagentInput({ terminalId, callId, name, closed, onSent }: {
  terminalId: string; callId: string; name: string; closed: boolean; onSent(intervention: AgentIntervention): void;
}) {
  const box = useRef<HTMLTextAreaElement>(null), hints = closed ? closedHints() : openHints(), hint = useFittingHint(box, hints) || hints.at(-1)!;
  const hintId = `subagent-hint-${terminalId}-${callId}`, fullHint = fullHintProps(hints, hint, hintId);
  const [text, setText] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [receipt, setReceipt] = useState<string | null>(null);
  async function run(request: Promise<Result<AgentIntervention>>, done: (value: AgentIntervention) => void) {
    setBusy(true); setError(null); setReceipt(null);
    const result = await request.catch(error => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }));
    setBusy(false);
    if (result.ok) done(result.value); else setError(result.error);
  }
  // The receipt is the status main gives with the accepted word: queued, delivered to the worker, read by it, or refused.
  const received = (done: AgentIntervention) => setReceipt([receiptWord(done.status) ?? t('送达状态未知'), done.status === 'rejected' ? done.reason || t('工作者未提供原因。') : null].filter(Boolean).join(' · '));
  const send = () => {
    const value = text.trim();
    if (value && !busy && !closed) void run(window.agentrix.interveneAgent(terminalId, callId, value), sent => {
      received(sent);
      if (sent.status === 'rejected') return;
      setText(current => current.trim() === value ? '' : current); onSent(sent);
    });
  };
  const stop = () => { if (!closed && !busy) void run(window.agentrix.stopAgent(terminalId, callId), received); };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault(); send();
  };
  const note = error ? `${t('未送达')} · ${error}` : receipt;
  return <div className="subagent-input">
    <div className="subagent-input-row reading-composer">
      <textarea ref={box} rows={1} value={text} maxLength={MAX_INTERVENTION} disabled={closed} aria-label={t('给 {name} 发消息', { name })} placeholder={hint} {...fullHint}
        onChange={event => setText(event.target.value)} onKeyDown={onKeyDown} />
      {fullHint['aria-describedby'] && <span id={hintId} style={HIDDEN_NOTE}>{hints[0]}</span>}
      {!closed && <button type="button" className="icon-button" disabled={busy} title={t('停下')} aria-label={t('停下')} onClick={stop}><Stop size={15} weight="fill" /></button>}
      {!closed && <button type="button" className="icon-button reading-send" disabled={busy || !text.trim()} title={t('发送')} aria-label={t('发送')} onClick={send}><PaperPlaneRight size={15} weight="fill" /></button>}
    </div>
    {note && <p className={error ? 'subagent-input-note is-error' : 'subagent-input-note'} role={error ? 'alert' : 'status'}>{note}</p>}
  </div>;
}
