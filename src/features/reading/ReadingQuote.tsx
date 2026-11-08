import { Quotes, X } from '@phosphor-icons/react';
import { t } from '../../shared/i18n';
import { plainExcerpt, type MessageQuote } from './message-quote';
import './reading-quote.css';

// The quoted message waiting above the composer, until the next message takes it or it is removed.
export function QuoteChip({ quote, onRemove }: { quote: MessageQuote; onRemove: () => void }) {
  const line = plainExcerpt(quote.excerpt);
  return <div className="reading-quote" role="group" aria-label={t('引用的消息')}>
    <Quotes size={14} aria-hidden="true" />
    <b>{quote.who}</b>
    <span title={line}>{line}</span>
    <button type="button" className="icon-button" title={t('移除引用')} aria-label={t('移除引用')} onClick={onRemove}><X size={12} weight="bold" /></button>
  </div>;
}
