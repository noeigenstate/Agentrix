import { Quotes, X } from '@phosphor-icons/react';
import { t } from '../../shared/i18n';
import type { MessageQuote } from './message-quote';
import './reading-quote.css';

// The 引用 action on a message: a button in its corner, shown on hover and on keyboard focus. It is disabled, with the
// reason in its title, while the composer cannot take a message.
export function QuoteAction({ who, text, disabled, onQuote }: { who: string; text: string; disabled: string | null; onQuote: (who: string, text: string) => void }) {
  const label = disabled ?? t('引用这条消息');
  return <button type="button" className="icon-button reading-quote-action" title={label} aria-label={t('引用这条消息')} disabled={disabled !== null} onClick={() => onQuote(who, text)}><Quotes size={14} /></button>;
}

// The quoted message waiting above the composer, until the next message takes it or it is removed.
export function QuoteChip({ quote, onRemove }: { quote: MessageQuote; onRemove: () => void }) {
  return <div className="reading-quote" role="group" aria-label={t('引用的消息')}>
    <Quotes size={14} aria-hidden="true" />
    <b>{quote.who}</b>
    <span title={quote.excerpt}>{quote.excerpt.replace(/\s*\n\s*/g, ' ')}</span>
    <button type="button" className="icon-button" title={t('移除引用')} aria-label={t('移除引用')} onClick={onRemove}><X size={12} weight="bold" /></button>
  </div>;
}
