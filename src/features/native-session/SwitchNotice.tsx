// A run-mode change on its way to a running session (contract addendum): the header's line saying where it goes and when, and the question
// the owner answers when switching would end background tasks. Both read one SwitchState — ProjectTerminal's, or a newer copy from the event
// stream (resolveSwitch) — so a native card and a terminal card say the same thing. Nothing here is a notification or a completion.
import { useState } from 'react';
import { t } from '../../shared/i18n';
import { nativeBridge, type SwitchState } from './native-bridge.ts';
import { backgroundWords, routeWord, switchLine } from './native-words';
import './native-session.css';

export function SwitchLine({ state }: { state: SwitchState | null }) {
  const line = switchLine(state);
  return line ? <small className="native-switch" role="status" title={line}>{line}</small> : null;
}

// Whether main is asking the owner now (awaiting-choice with its request id).
export const asksChoice = (state: SwitchState | null): state is SwitchState & { requestId: string } => state?.phase === 'awaiting-choice' && !!state.requestId;

// The question card, only while main asks. It looks like a request card but is no request: a terminal session has no request list. An answer
// shuts the card until main moves the switch on; a refused one opens it again with the reason. A late answer is ignored by main.
export function SwitchQuestion({ terminalId, sessionId, state }: { terminalId: string; sessionId: string | null; state: SwitchState | null }) {
  const [answeredFor, setAnsweredFor] = useState<string | null>(null), [error, setError] = useState<string | null>(null);
  if (!asksChoice(state)) return null;
  const { changeId, requestId } = state, busy = answeredFor === requestId;
  const answer = async (action: 'wait' | 'now') => {
    const bridge = nativeBridge();
    if (busy || !bridge) return;
    setAnsweredFor(requestId); setError(null);
    // A terminal session has no runtime session id; main finds it by the terminal.
    const result = await bridge.answer(terminalId, sessionId ?? terminalId, requestId, { switch: { changeId, requestId, action } })
      .catch((failure: unknown) => ({ ok: false as const, error: failure instanceof Error ? failure.message : String(failure) }));
    if (!result.ok) { setError(result.error); setAnsweredFor(null); }
  };
  const title = t('现在切到 {path}？', { path: routeWord(state.target) });
  return <section className="reading-choice native-request native-switch-question" role="group" aria-label={title} aria-busy={busy}>
    <div className="reading-choice-head"><strong>{title}</strong></div>
    <p className="native-switch-text">{backgroundWords(state.background)}</p>
    <div className="reading-question-actions">
      <button type="button" className="button primary" disabled={busy} onClick={() => void answer('wait')}>{t('等它们结束')}</button>
      <button type="button" className="button" disabled={busy} onClick={() => void answer('now')}>{t('现在切换')}</button>
    </div>
    {error && <p className="form-error" role="alert">{error}</p>}
  </section>;
}
