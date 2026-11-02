// The owner's word to one sub-agent, written in its split. It goes through the main process (queued for the agent, or relayed to the
// parent session when the agent cannot take it itself); nothing here is ever typed into a terminal.
import { type KeyboardEvent, useState } from 'react';
import type { AgentIntervention, Result } from '../../shared/types';
import { t } from '../../shared/i18n';
import './subagent-input.css';

export const MAX_INTERVENTION = 4000;

export function SubagentInput({ terminalId, callId, name, closed, onSent }: {
  terminalId: string; callId: string; name: string; closed: boolean; onSent(intervention: AgentIntervention): void;
}) {
  const [text, setText] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [stopped, setStopped] = useState<AgentIntervention | null>(null);
  async function run(request: Promise<Result<AgentIntervention>>, done: (value: AgentIntervention) => void) {
    setBusy(true); setError(null);
    const result = await request;
    setBusy(false);
    if (result.ok) done(result.value); else setError(result.error);
  }
  const send = () => {
    const value = text.trim();
    if (value && !busy && !closed) void run(window.agentrix.interveneAgent(terminalId, callId, value), sent => { setText(''); onSent(sent); });
  };
  const stop = () => void run(window.agentrix.stopAgent(terminalId, callId), setStopped);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault(); send();
  };
  const note = error ?? (closed ? t('它已结束或不可用，不能再发消息') : stopped && [t('已请它停下'), stopped.route === 'parent' && t('已转告主会话')].filter(Boolean).join(' · '));
  return <div className="subagent-input">
    <div className="subagent-input-row">
      <textarea rows={1} value={text} maxLength={MAX_INTERVENTION} disabled={closed} aria-label={t('给 {name} 发消息', { name })} placeholder={t('给它发消息 · Enter 发送，Shift+Enter 换行')}
        onChange={event => setText(event.target.value)} onKeyDown={onKeyDown} />
      <button type="button" className="button" disabled={closed || busy} onClick={stop}>{t('停下')}</button>
    </div>
    {note && <p className={error ? 'subagent-input-note is-error' : 'subagent-input-note'} role={error ? 'alert' : 'status'}>{note}</p>}
  </div>;
}
