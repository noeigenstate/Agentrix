// The notice a card shows when its Claude session left the API for the terminal: the terminal's reading view takes the same cell and
// this says why, until the owner dismisses it.
import { Info, X } from '@phosphor-icons/react';
import { useState } from 'react';
import { t } from '../../shared/i18n';
import { dismissNote, terminalSwitch, useNativeEntries } from './native-store.ts';
import { messageText, reasonWords } from './native-words';
import { copyNativeText } from './native-bridge.ts';
import './native-session.css';

export function NativePathNote({ terminalId }: { terminalId: string }) {
  const entry = useNativeEntries().get(terminalId), path = terminalSwitch(entry);
  const [error, setError] = useState<string | null>(null);
  if (!path) return null;
  const unsent = entry?.model.order.map(id => entry.model.items[id]).filter(item => item.kind === 'user-message' && item.content.unsent === true) ?? [];
  const copy = async (text: string) => {
    const result = await copyNativeText(text).catch(error => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }));
    setError(result.ok ? null : result.error);
  };
  const words = reasonWords(path.reason) ?? t('API 暂时不可用');
  return <div className="native-path-note" role="status">
    <div className="native-path-summary"><Info size={14} aria-hidden="true" /><span>{t('已改用终端 · {reason}', { reason: words })}</span>
      <button type="button" className="icon-button" title={t('知道了')} aria-label={t('知道了')} onClick={() => dismissNote(terminalId)}><X size={13} /></button>
    </div>
    {unsent.map(item => <details key={item.id} className="native-unsent"><summary>{t('未发送的消息')}</summary>
      <textarea readOnly aria-label={t('未发送的消息')} value={messageText(item)} />
      <button type="button" className="button" onClick={() => void copy(messageText(item))}>{t('复制未发送的消息')}</button>
    </details>)}
    {error && <p role="alert">{error}</p>}
  </div>;
}
