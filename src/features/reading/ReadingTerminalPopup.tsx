import { useLayoutEffect, useRef } from 'react';
import { TerminalWindow, X } from '@phosphor-icons/react';
import { mountReadingTerminal } from '../terminal/terminal-popup';
import { t } from '../../shared/i18n';
import './reading-terminal-popup.css';

export function ReadingTerminalPopup({ terminalId, sessionId, command, focus = true, onReady, onClose, onError }: {
  terminalId: string; sessionId: string | null; command: string; focus?: boolean;
  onReady: () => void; onClose: (restoreFocus?: boolean, implicit?: boolean) => void; onError: (message: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onReady, onClose, onError }); callbacks.current = { onReady, onClose, onError };
  useLayoutEffect(() => {
    try {
      const restore = mountReadingTerminal(terminalId, sessionId, host.current!, focus);
      callbacks.current.onReady();
      return restore;
    } catch (error) { callbacks.current.onClose(false, true); callbacks.current.onError(String(error)); }
  }, [terminalId, sessionId]);
  useLayoutEffect(() => {
    const switched = (event: Event) => {
      const split = (event.target as Element | null)?.closest?.<HTMLElement>('.terminal-split');
      const panel = host.current?.closest('.project-panel');
      if (panel && split?.closest('.project-panel') === panel && split.dataset.terminalId !== terminalId) callbacks.current.onClose(false, true);
    };
    document.addEventListener('pointerdown', switched, true); document.addEventListener('focusin', switched);
    return () => { document.removeEventListener('pointerdown', switched, true); document.removeEventListener('focusin', switched); };
  }, [terminalId]);
  return <div className="reading-terminal-overlay" onMouseDown={event => {
    // The press would otherwise focus what lies under the backdrop once it is gone, taking focus from the composer.
    if (event.button === 0 && event.target === event.currentTarget) { event.preventDefault(); onClose(); }
  }}
    onKeyDown={event => event.stopPropagation()} onKeyUp={event => event.stopPropagation()}>
    {/* Keys inside this modeless dialog belong to the CLI, including Escape; other app controls keep their shortcuts. */}
    <dialog open className="reading-terminal-popup" aria-modal="true" aria-label={command || t('项目终端')} data-terminal-popup-id={terminalId} onCancel={event => { event.preventDefault(); onClose(); }}>
      <header><TerminalWindow size={16} /><strong>{command || t('项目终端')}</strong>
        <button type="button" className="icon-button" title={t('关闭')} aria-label={t('关闭')} onClick={() => onClose()}><X size={16} /></button>
      </header>
      <div className="terminal-host" ref={host} />
    </dialog>
  </div>;
}
