import { t } from '../../shared/i18n';
import './result-card.css';
import './choice-waiting.css';

// The CLI waits for a choice on a screen the reading view could not turn into a card: the terminal shows it. The card
// only sends the reader there; it never presses a key, whatever the dialog is.
export function WaitingCard({ title, terminalId, onOpenTerminal }: { title: string | null; terminalId: string; onOpenTerminal: () => void }) {
  return <div className="reading-choice reading-waiting" role="group" aria-label={t('终端里有一个需要你选择的界面')} tabIndex={-1} onFocus={() => window.agentrix.terminalFocus(terminalId, false)}>
    <div className="reading-choice-head"><strong>{t('终端里有一个需要你选择的界面')}</strong></div>
    {title && <p className="reading-waiting-heading">{title}</p>}
    <button type="button" className="result-button" onClick={onOpenTerminal}>{t('打开终端')}</button>
  </div>;
}
