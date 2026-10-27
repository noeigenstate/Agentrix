import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { CircleNotch } from '@phosphor-icons/react';
import type { ScreenAgent, ScreenChoice } from '../agents/agent-screen-types';
import { selectedChoiceIndex, writeChoiceKeys } from './choice-keys';
import { terminalApprovalCopy } from './approval-action';
import { currentLanguage, t } from '../../shared/i18n';

export function ReadingChoice({ choice, terminalId, onShowTerminal, onError }: { choice: ScreenChoice; terminalId: string; agent: ScreenAgent; onShowTerminal: () => void; onError: (message: string) => void }) {
  const [highlight, setHighlight] = useState(() => selectedChoiceIndex(choice));
  const [pending, setPending] = useState<number | 'cancel' | null>(null);
  const sending = useRef(false), active = useRef(true), latest = useRef(choice), card = useRef<HTMLDivElement>(null);
  latest.current = choice;
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => { card.current?.querySelector<HTMLElement>('[data-highlighted="true"]')?.scrollIntoView({ block: 'nearest' }); }, [highlight]);
  // Keys the CLI did not act on (lost, or the same choice drawn again) leave the card free after a moment, Cancel too.
  useEffect(() => {
    if (pending === null) return;
    const timer = setTimeout(() => { sending.current = false; setPending(null); }, 2500);
    return () => clearTimeout(timer);
  }, [pending]);
  const fail = (error: unknown) => {
    if (!active.current) return;
    sending.current = false; setPending(null);
    onError(error instanceof Error ? t(error.message) : String(error));
  };
  const choose = async (index: number) => {
    if (choice.kind === 'permission' || latest.current.kind === 'permission') return;
    if (sending.current || !latest.current.options[index]) return;
    sending.current = true; card.current?.focus(); setHighlight(index); setPending(index);
    try {
      await writeChoiceKeys(selectedChoiceIndex(latest.current), index, key => window.agentrix.writeTerminal(terminalId, key), () => active.current);
    } catch (error) { fail(error); }
  };
  const cancel = () => {
    if (choice.kind === 'permission' || latest.current.kind === 'permission') return;
    if (sending.current) return;
    sending.current = true; card.current?.focus(); setPending('cancel');
    try {
      window.agentrix.writeTerminal(terminalId, '\x1b');
    } catch (error) { fail(error); }
  };
  const terminalOnly = choice.kind === 'permission', copy = terminalApprovalCopy(currentLanguage());
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    if (!['ArrowUp', 'ArrowDown', 'Enter', 'Escape'].includes(event.key) && !/^[1-9]$/.test(event.key)) return;
    // Enter on a focused button presses that button (Open terminal, Cancel or an option), never another option.
    if (event.key === 'Enter' && (event.target as HTMLElement | null)?.closest?.('button')) return;
    event.preventDefault();
    if (terminalOnly || sending.current) return;
    if (event.key === 'Escape') cancel();
    else if (event.key === 'Enter') void choose(highlight);
    else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') setHighlight(index => Math.max(0, Math.min(choice.options.length - 1, index + (event.key === 'ArrowUp' ? -1 : 1))));
    else {
      const index = choice.options.findIndex(option => option.number === Number(event.key));
      if (index >= 0) void choose(index);
    }
  };
  return <div ref={card} className={`reading-choice is-${choice.kind}`} data-approval-mode={terminalOnly ? 'terminal-only' : undefined} role="group" aria-label={choice.title} aria-busy={pending !== null} tabIndex={-1} onKeyDown={keys}
    onFocus={() => window.agentrix.terminalFocus(terminalId, false)}>
    <div className="reading-choice-head"><strong>{choice.title}</strong>{terminalOnly
      ? <button type="button" className="text-button" data-approval-open-terminal onClick={onShowTerminal}>{copy.open}</button>
      : <button type="button" className="text-button" disabled={pending !== null} onClick={cancel}>{pending === 'cancel' && <CircleNotch size={12} className="loading-spinner" />}{choice.escape === 'new' ? t('开始新会话') : choice.escape === 'back' ? t('返回对话') : t('取消')}</button>}</div>
    {terminalOnly && <p className="reading-choice-hint" role="status">{copy.message}</p>}
    {choice.context.length > 0 && <pre className="reading-choice-context">{choice.context.join('\n')}</pre>}
    <div className="reading-choice-options">{choice.options.map((option, index) => <button type="button" key={option.number}
      className={`reading-choice-option ${option.selected ? 'is-cli-selected' : ''}`} data-highlighted={index === highlight} disabled={terminalOnly || pending !== null} onClick={() => void choose(index)}>
      <span className="reading-choice-number">{option.number}.</span><span className="reading-choice-label"><b>{option.label}</b>{option.detail && <small>{option.detail}</small>}</span>
      {option.hotkey && <kbd>{option.hotkey}</kbd>}{pending === index && <CircleNotch size={13} className="loading-spinner" />}
    </button>)}</div>
    {!terminalOnly && choice.hint && <small className="reading-choice-hint">{choice.hint}</small>}
  </div>;
}
