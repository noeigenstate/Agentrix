import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Copy, FileText, Quotes } from '@phosphor-icons/react';
import { t } from '../../shared/i18n';
import { NativeToast } from '../native-session/NativeToast';
import { keepsOwnMenu, linkPath, menuPlace, menuText, opensMenu, selectedWithin } from './message-menu';
import { isGeneratedPicture, isPicture } from './reply-links.ts';

// link: the full path of the file a reply link right-clicked opens, copied by 复制路径 (复制图片路径 for a picture).
type Place = { x: number; y: number; selected: string; link?: string };
export type MessageQuoteAction = { disabled: string | null; pick: (who: string, text: string) => void };

// The two actions of a message, 引用 and 复制, in the app's standard dropdown, and 复制路径 when it opened on a reply's file
// link. 引用 can be unavailable (the composer cannot take a message now); its reason is the title. Escape and a press
// outside close it, and focus returns to where it was.
export function MessageMenu({ place, text, who, quote, onCopy, onClose }: {
  place: Place; text: string; who: string; quote: MessageQuoteAction; onCopy: (text: string, path?: boolean) => void; onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const words = menuText(text, place.selected);
  // The listeners are set once per opening; they close through the latest onClose.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onClose = () => close.current();
    const previous = document.activeElement as HTMLElement | null;
    menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
    const away = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) onClose(); };
    // Capture phase: Escape closes the menu and nothing else (the composer's Escape would stop the agent).
    const keys = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return; }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      const items = [...menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []];
      if (!items.length) return;
      event.preventDefault(); event.stopPropagation();
      const at = items.indexOf(document.activeElement as HTMLButtonElement);
      items[(at + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
    };
    const scrolled = () => onClose();
    document.addEventListener('pointerdown', away); document.addEventListener('keydown', keys, true); document.addEventListener('scroll', scrolled, true);
    return () => {
      document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', keys, true); document.removeEventListener('scroll', scrolled, true);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  const run = (action: () => void) => { onClose(); action(); };
  return createPortal(<div ref={menu} className="dropdown reading-message-menu" role="menu" aria-label={t('消息操作')} style={{ left: place.x, top: place.y }} onContextMenu={event => event.preventDefault()}>
    <button type="button" role="menuitem" disabled={quote.disabled !== null} title={quote.disabled ?? undefined} onClick={() => run(() => quote.pick(who, words))}><Quotes size={16} />{t('引用')}</button>
    <button type="button" role="menuitem" onClick={() => run(() => onCopy(words))}><Copy size={16} />{t('复制')}</button>
    {place.link && <button type="button" role="menuitem" onClick={() => run(() => onCopy(place.link!, true))}><FileText size={16} />
      {t(isPicture(place.link) || isGeneratedPicture(place.link) ? '复制图片路径' : '复制路径')}</button>}
  </div>, document.body);
}

// A message card whose right click (or menu key, Shift+F10) opens MessageMenu. A reply's file link opens it too, with
// 复制路径 when pathOf finds the file the link opens (none for a link the click refuses); other links, pictures, code
// blocks and controls inside keep their own right click. A copied path is told by the session's light note for two
// seconds. Without a quote action, or a message with no words of its own, the card is plain.
export function MessageCard({ id, className, text, who, quote, pathOf, onError, children }: {
  id: string; className: string; text: string | undefined; who: string; quote: MessageQuoteAction | undefined;
  pathOf?: (target: string) => Promise<string | null>; onError: (message: string) => void; children: ReactNode;
}) {
  const [place, setPlace] = useState<Place | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const [told, setTold] = useState('');
  useEffect(() => { if (!told) return; const timer = setTimeout(() => setTold(''), 2000); return () => clearTimeout(timer); }, [told]);
  const open = (x: number, y: number, link?: string) => {
    const at = menuPlace(x, y, { width: window.innerWidth, height: window.innerHeight }, link ? 3 : 2);
    setPlace({ ...at, selected: card.current ? selectedWithin(card.current, window.getSelection()) : '', ...(link ? { link } : {}) });
  };
  const copy = (words: string, path = false) => {
    void window.agentrix.copy(words).then(result => { if (!result.ok) onError(result.error); else if (path) setTold(t('已复制')); });
  };
  if (!quote || !text) return <div data-reading-entry={id} className={className}>{children}</div>;
  // The note sits where the session view shows its own, at the foot of the conversation.
  const noteArea = told ? card.current?.closest?.('.reading-scroll-area') : null;
  const onContextMenu = (event: MouseEvent) => {
    const link = pathOf && linkPath(event.target);
    if (link) {
      event.preventDefault();
      const { clientX, clientY } = event;
      void pathOf(link).catch(() => null).then(found => open(clientX, clientY, found ?? undefined));
      return;
    }
    if (keepsOwnMenu(event.target)) return;
    event.preventDefault(); open(event.clientX, event.clientY);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.target !== event.currentTarget || !opensMenu(event)) return;
    event.preventDefault();
    const box = event.currentTarget.getBoundingClientRect();
    open(box.left + 16, box.top + 16);
  };
  return <div ref={card} data-reading-entry={id} className={className} tabIndex={0} aria-haspopup="menu" onContextMenu={onContextMenu} onKeyDown={onKeyDown}>
    {children}
    {place && <MessageMenu place={place} text={text} who={who} quote={quote} onCopy={copy} onClose={() => setPlace(null)} />}
    {noteArea && createPortal(<NativeToast text={told} />, noteArea)}
  </div>;
}
