// The notice over a card about its session's path. While a run-mode change is on its way to a terminal card: the line saying where it goes
// and when, and the question when switching would end background tasks (a native card draws both in its own view). Afterwards, when the path
// did not go as chosen: Claude left the API for the terminal (the terminal's reading view takes the same cell and this says why), or a switch
// failed and the session stayed on its old path. The owner dismisses the notes.
import { Info, X } from '@phosphor-icons/react';
import { useState } from 'react';
import { t } from '../../shared/i18n';
import { dismissNote, dismissSwitchNote, resolveSwitch, terminalSwitch, useNativeEntries, useSwitchNoteShown } from './native-store.ts';
import { messageText, reasonWords, switchFailure, switchLine } from './native-words';
import { copyNativeText, type SwitchState } from './native-bridge.ts';
import { asksChoice, SwitchLine, SwitchQuestion } from './SwitchNotice';
import './native-session.css';

// terminalActive: the card shows the terminal, the only place the move to the terminal and a change in flight are told here. A failed switch is
// told wherever the card is. sessionId: the card's native runtime session, when it has one (a terminal session has none).
export function NativePathNote({ terminalId, terminalActive = true, switchState = null, sessionId = null }: { terminalId: string; terminalActive?: boolean; switchState?: SwitchState | null; sessionId?: string | null }) {
  const entry = useNativeEntries().get(terminalId), state = resolveSwitch(switchState, entry), shown = useSwitchNoteShown(terminalId, state), failure = state && shown && switchFailure(state);
  const path = terminalActive ? terminalSwitch(entry) : null, moving = terminalActive ? state : null;
  const [error, setError] = useState<string | null>(null);
  const note = state && failure ? { text: failure, dismiss: () => dismissSwitchNote(terminalId, state) }
    : path ? { text: t('已改用终端 · {reason}', { reason: reasonWords(path.reason) ?? t('API 暂时不可用') }), dismiss: () => dismissNote(terminalId) } : null;
  const line = switchLine(moving), asking = asksChoice(moving);
  if (!note && !line && !asking) return null;
  const unsent = entry?.model.order.map(id => entry.model.items[id]).filter(item => item.kind === 'user-message' && item.content.unsent === true) ?? [];
  const copy = async (text: string) => {
    const result = await copyNativeText(text).catch(error => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }));
    setError(result.ok ? null : result.error);
  };
  return <div className="native-path-note" role="status">
    {line && <div className="native-path-summary"><Info size={14} aria-hidden="true" /><SwitchLine state={moving} /></div>}
    <SwitchQuestion terminalId={terminalId} sessionId={entry?.model.identity?.runtimeSessionId ?? sessionId} state={moving} />
    {note && <div className="native-path-summary"><Info size={14} aria-hidden="true" /><span>{note.text}</span>
      <button type="button" className="icon-button" title={t('知道了')} aria-label={t('知道了')} onClick={note.dismiss}><X size={13} /></button>
    </div>}
    {note && unsent.map(item => <details key={item.id} className="native-unsent"><summary>{t('未发送的消息')}</summary>
      <textarea readOnly aria-label={t('未发送的消息')} value={messageText(item)} />
      <button type="button" className="button" onClick={() => void copy(messageText(item))}>{t('复制未发送的消息')}</button>
    </details>)}
    {error && <p role="alert">{error}</p>}
  </div>;
}
