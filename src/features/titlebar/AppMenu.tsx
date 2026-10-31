import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowCircleUp, ArrowLeft, ChartBar, CornersIn, CornersOut, FolderSimplePlus, GearSix } from '@phosphor-icons/react';
import { shortcut } from '../shortcuts/shortcuts';
import { t } from '../../shared/i18n';

const MENU_GAP = 4;

// The dashboard is its own window; a failure to open it has nowhere better to go than the console.
const openDashboard = () => window.agentrix.openDashboard().then(result => { if (!result.ok) console.error(result.error); }, console.error);

function Item({ icon, label, keys, disabled, onSelect }: { icon: ReactNode; label: string; keys?: string; disabled?: boolean; onSelect: () => void }) {
  return <button type="button" role="menuitem" disabled={disabled} onClick={onSelect}>{icon}{label}{keys && <span className="menu-shortcut" aria-hidden="true">{keys}</span>}</button>;
}

// The logo and title are the app menu's button. The menu hangs under the title bar from the button's left edge, drawn on the page
// body so the bar's clipping and the explorer cannot cover it.
export function AppMenu({ fullScreen, canReturn, updateReady, onAddProject, onReturn, onFullScreen, onSettings, onInstallUpdate }: {
  fullScreen: boolean;
  // The projects grid is not showing: a project is open, or the decision page is.
  canReturn: boolean;
  // An update is downloaded: the button wears a dot and the menu offers to install it.
  updateReady: boolean;
  onAddProject: () => void; onReturn: () => void; onFullScreen: () => void; onSettings: () => void; onInstallUpdate: () => void;
}) {
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const open = place !== null;
  // Focus goes back to the button when the menu closes, before a chosen action runs.
  const close = () => { setPlace(null); trigger.current?.focus(); };
  const choose = (run: () => void) => { close(); run(); };
  const toggle = () => {
    if (open) return close();
    const button = trigger.current!;
    setPlace({ left: button.getBoundingClientRect().left, top: button.closest('.titlebar')!.getBoundingClientRect().bottom + MENU_GAP });
  };

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
    const outside = (event: PointerEvent) => { const target = event.target as Node; if (!menu.current?.contains(target) && !trigger.current?.contains(target)) setPlace(null); };
    const away = () => setPlace(null);
    document.addEventListener('pointerdown', outside, true); addEventListener('resize', away);
    return () => { document.removeEventListener('pointerdown', outside, true); removeEventListener('resize', away); };
  }, [open]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape' || event.key === 'Tab') return close();
    const items = [...menu.current!.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)')], at = items.indexOf(document.activeElement as HTMLElement);
    const moves: Record<string, number> = { ArrowDown: at + 1, ArrowUp: at < 0 ? items.length - 1 : at - 1, Home: 0, End: items.length - 1 }, target = moves[event.key];
    if (target === undefined) return;
    event.preventDefault();
    items[(target + items.length) % items.length].focus();
  };
  // Focus leaving for anything but the button (a dialog a shortcut opened, another window) closes the menu.
  const onBlur = (event: React.FocusEvent) => {
    const next = event.relatedTarget as Node | null;
    if (!menu.current?.contains(next) && next !== trigger.current) setPlace(null);
  };

  return <>
    <button type="button" ref={trigger} className={`titlebar-brand ${updateReady ? 'update-ready' : ''}`} aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
      <span className="brand-mark"><i /><i /><i /><i /></span><span>Agentrix</span>
    </button>
    {place && createPortal(<div ref={menu} className="dropdown app-menu" role="menu" aria-label={t('应用菜单')} tabIndex={-1} style={place} onKeyDown={onKeyDown} onBlur={onBlur}>
      <Item icon={<FolderSimplePlus size={16} />} label={t('新建项目')} keys={shortcut('addProject')} onSelect={() => choose(onAddProject)} />
      <Item icon={<ArrowLeft size={16} />} label={t('返回项目')} keys={shortcut('overview')} disabled={!canReturn} onSelect={() => choose(onReturn)} />
      <div className="menu-divider" role="separator" />
      <Item icon={fullScreen ? <CornersIn size={16} /> : <CornersOut size={16} />} label={fullScreen ? t('退出全屏') : t('全屏')} keys={shortcut('fullscreen')} onSelect={() => choose(onFullScreen)} />
      <Item icon={<GearSix size={16} />} label={t('设置')} keys={shortcut('settings')} onSelect={() => choose(onSettings)} />
      <Item icon={<ChartBar size={16} />} label={t('数据看板')} onSelect={() => choose(openDashboard)} />
      {updateReady && <>
        <div className="menu-divider" role="separator" />
        <Item icon={<ArrowCircleUp size={16} />} label={t('重启并安装更新')} onSelect={() => choose(onInstallUpdate)} />
      </>}
    </div>, document.body)}
  </>;
}
