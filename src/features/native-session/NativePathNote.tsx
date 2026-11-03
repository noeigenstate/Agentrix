// The notice a card shows when its Claude session left the API for the terminal: the terminal's reading view takes the same cell and
// this says why, until the owner dismisses it.
import { Info, X } from '@phosphor-icons/react';
import { t } from '../../shared/i18n';
import { dismissNote, terminalSwitch, useNativeEntries } from './native-store.ts';
import { reasonWords } from './native-words';
import './native-session.css';

export function NativePathNote({ terminalId }: { terminalId: string }) {
  const path = terminalSwitch(useNativeEntries().get(terminalId));
  if (!path) return null;
  const words = reasonWords(path.reason) ?? t('API 暂时不可用');
  return <div className="native-path-note" role="status">
    <Info size={14} aria-hidden="true" /><span>{t('已改用终端 · {reason}', { reason: words })}</span>
    <button type="button" className="icon-button" title={t('知道了')} aria-label={t('知道了')} onClick={() => dismissNote(terminalId)}><X size={13} /></button>
  </div>;
}
