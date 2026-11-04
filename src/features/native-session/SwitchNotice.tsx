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

// Whether main is asking the owner now: awaiting-choice with its request id, and while it waits for background tasks (which keeps the request id) the
// owner can still switch at once.
export const asksChoice = (state: SwitchState | null): state is SwitchState & { requestId: string } => (state?.phase === 'awaiting-choice' || state?.phase === 'waiting-background') && !!state.requestId;

// The question card, only while main asks (while it waits, only the choice to switch now is left). It looks like a request card but is no request: a terminal session has no request list. An answer
// shuts the card until main moves the switch on (the phase changes: waiting for the tasks to end opens the choice to switch at once); a refused one opens it again with the reason. A late answer is ignored by main.
export function SwitchQuestion({ terminalId, sessionId, state }: { terminalId: string; sessionId: string | null; state: SwitchState | null }) {
  const [answeredFor, setAnsweredFor] = useState<string | null>(null), [error, setError] = useState<string | null>(null);
  if (!asksChoice(state)) return null;
  // The answer shuts only the question as it was asked: the same request in another phase (after 等它们结束) is a new question.
  const { changeId, requestId } = state, asked = `${requestId}/${state.phase}`, busy = answeredFor === asked;
  const answer = async (action: 'wait' | 'now') => {
    const bridge = nativeBridge();
    if (busy || !bridge) return;
    setAnsweredFor(asked); setError(null);
    // A terminal session has no runtime session id; main finds it by the terminal.
    const result = await bridge.answer(terminalId, sessionId ?? terminalId, requestId, { switch: { changeId, requestId, action } })
      .catch((failure: unknown) => ({ ok: false as const, error: failure instanceof Error ? failure.message : String(failure) }));
    // Main ignores an answer to a change or a question that has moved on: that is not an answer taken.
    const ignored = result.ok && (result.value as { accepted?: boolean } | null)?.accepted === false;
    if (!result.ok || ignored) { setError(result.ok ? t('这个选择已经过期，没有生效。') : result.error); setAnsweredFor(null); }
  };
  const title = t('现在切到 {path}？', { path: routeWord(state.target) });
  return <section className="reading-choice native-request native-switch-question" role="group" aria-label={title} aria-busy={busy}>
    <div className="reading-choice-head"><strong>{title}</strong></div>
    <p className="native-switch-text">{backgroundWords(state.background)}</p>
    <div className="reading-question-actions">
      {state.phase === 'awaiting-choice' && <button type="button" className="button primary" disabled={busy} onClick={() => void answer('wait')}>{t('等它们结束')}</button>}
      <button type="button" className={state.phase === 'awaiting-choice' ? 'button' : 'button primary'} disabled={busy} onClick={() => void answer('now')}>{t('现在切换')}</button>
    </div>
    {error && <p className="form-error" role="alert">{error}</p>}
  </section>;
}
