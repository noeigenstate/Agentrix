import { useEffect, useRef, useState, type ReactNode } from 'react';
import { DownloadSimple, Keyboard } from '@phosphor-icons/react';
import { SHORTCUT_ACTIONS, shortcut } from '../shortcuts/shortcuts';
import { WHATS_NEW } from './guide';
import { t } from '../../shared/i18n';
import './guide.css';

type Page = { id: string; badge: ReactNode; title: string; body: ReactNode };

// The app icon (assets/icon-mac.png) drawn as vector: a dark rounded square holding a 2x2 grid, the last cell the brightest.
const LOGO_CELLS = [[138, 138], [438, 138], [138, 438], [438, 438]];
function AgentrixLogo() {
  return <svg viewBox="0 0 824 824"><rect x="1.5" y="1.5" width="821" height="821" rx="190" fill="#2d2d2d" stroke="#404040" strokeWidth="3" />
    {LOGO_CELLS.map(([x, y], cell) => <rect key={cell} x={x} y={y} width="248" height="248" fill={cell === 3 ? '#f0f0f0' : '#a3a3a3'} />)}</svg>;
}

// Reference pages: the shortcuts in use and what changed in this version. It opens after each update on
// the "what's new" page. How to use the app is taught in the window itself (GuideTour), reachable from here.
export function UsageGuide({ version, start, onClose, onTour }: { version: string; start: 'keys' | 'news'; onClose: () => void; onTour: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const pages: Page[] = [
    { id: 'keys', badge: <Keyboard size={20} weight="bold" />, title: t('常用快捷键'), body: <>
      <dl className="guide-keys">{SHORTCUT_ACTIONS.map(action => <div key={action.id}><dt>{t(action.label)}</dt><dd><kbd>{shortcut(action.id)}</kbd></dd></div>)}</dl>
      <p className="guide-note">{t('这些快捷键都可以在设置的「键盘快捷键」里修改。')}</p></> },
    { id: 'news', badge: <DownloadSimple size={20} weight="bold" />, title: t('本次更新 v{version}', { version }), body: <ul>{WHATS_NEW.map(item => <li key={item}>{t(item)}</li>)}</ul> },
  ];
  const [index, setIndex] = useState(() => Math.max(0, pages.findIndex(page => page.id === start)));
  const page = pages[index], last = index === pages.length - 1;
  // showModal() focuses the first control, so the primary button takes focus after it opens.
  useEffect(() => { dialog.current?.showModal(); dialog.current?.querySelector<HTMLElement>('.primary')?.focus(); }, []);
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (event.key === 'ArrowRight' && !last) setIndex(index + 1);
      if (event.key === 'ArrowLeft' && index) setIndex(index - 1);
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  }, [index, last]);
  return <dialog className="settings-dialog guide-dialog" ref={dialog} aria-label={t('使用指南')} onCancel={onClose}>
    <div className="dialog-content guide-content">
      <div className="guide-logo" aria-hidden="true"><AgentrixLogo /><span className="guide-badge">{page.badge}</span></div>
      <h2>{page.title}</h2>
      <div className="guide-body">{page.body}</div>
      <div className="guide-dots" aria-hidden="true">{pages.map((item, position) => <i key={item.id} className={position === index ? 'is-current' : ''} />)}</div>
      <div className="guide-footer">
        <button type="button" className="button secondary" onClick={onClose}>{t('跳过')}</button>
        <button type="button" className="button primary" onClick={() => (last ? onClose() : setIndex(index + 1))}>{last ? t('开始使用') : t('下一步')}</button>
      </div>
      <div className="guide-links">
        {index > 0 && <button type="button" className="text-button" onClick={() => setIndex(index - 1)}>{t('上一步')}</button>}
        <button type="button" className="text-button" onClick={onTour}>{t('操作教程')}</button>
      </div>
    </div>
  </dialog>;
}
