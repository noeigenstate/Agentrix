import type { ScreenChoice } from '../agents/agent-screen-types';
import { terminalApprovalCopy } from './approval-action';
import { currentLanguage } from '../../shared/i18n';

// A permission prompt read from the screen: shown here, answered only in the terminal it came from. Menus such as /model
// have no card; they are answered in the terminal popup.
export function ReadingChoice({ choice, terminalId, onShowTerminal }: { choice: ScreenChoice; terminalId: string; onShowTerminal: () => void }) {
  const copy = terminalApprovalCopy(currentLanguage());
  // Keys pressed on the card stay with it: Escape or Enter must not reach the project or the composer around it.
  return <div className="reading-choice is-permission" data-approval-mode="terminal-only" role="group" aria-label={choice.title} tabIndex={-1}
    onKeyDown={event => event.stopPropagation()} onFocus={() => window.agentrix.terminalFocus(terminalId, false)}>
    <div className="reading-choice-head"><strong>{choice.title}</strong>
      <button type="button" className="text-button" data-approval-open-terminal onClick={onShowTerminal}>{copy.open}</button></div>
    <p className="reading-choice-hint" role="status">{copy.message}</p>
    {choice.context.length > 0 && <pre className="reading-choice-context">{choice.context.join('\n')}</pre>}
    <div className="reading-choice-options">{choice.options.map(option => <button type="button" key={option.number}
      className={`reading-choice-option ${option.selected ? 'is-cli-selected' : ''}`} data-highlighted={option.selected} disabled>
      <span className="reading-choice-number">{option.number}.</span><span className="reading-choice-label"><b>{option.label}</b>{option.detail && <small>{option.detail}</small>}</span>
      {option.hotkey && <kbd>{option.hotkey}</kbd>}
    </button>)}</div>
  </div>;
}
