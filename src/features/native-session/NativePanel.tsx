import { Fragment, useEffect, useRef, useState } from 'react';
import { ArrowClockwise, Check, Copy, WarningCircle, X } from '@phosphor-icons/react';
import { t } from '../../shared/i18n';
import { AgentMark } from '../reading/feed-parts';
import { panelText, panelTitle, readTime, type Panel, type PanelGroup, type PanelState, type Quota } from './native-panel.ts';
import { escapeFrom, showPanel } from './panel-keys.ts';
import './native-panel.css';

function Meter({ percent, label, className = '' }: { percent: number; label: string; className?: string }) {
  return <span className={`native-panel-meter ${className}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)} aria-label={label}><i style={{ width: `${percent}%` }} /></span>;
}

function QuotaBar({ quota }: { quota: Quota }) {
  return <div className={`native-panel-quota${quota.full ? ' is-out' : ''}`}>
    <div className="native-panel-quota-top">
      <span>{quota.name}</span><span className="native-panel-spacer" />
      {quota.full && <span className="native-panel-state"><WarningCircle size={12} />{t('已用完')}</span>}
      <b className="num">{quota.used}</b>
    </div>
    {quota.percent !== null && <Meter percent={quota.percent} label={quota.name} />}
    {quota.when && <div className="native-panel-when">{quota.when}</div>}
  </div>;
}

function Group({ group, onPick }: { group: PanelGroup; onPick?: (command: string) => void }) {
  return <section className="native-panel-group">
    {group.title && <h3 className="native-panel-group-title">{group.title}</h3>}
    {group.kind === 'rows' && <dl className="native-panel-rows">{group.rows.map(row => <Fragment key={row.label}>
      <dt title={row.label}>{row.label}</dt><dd className="num" title={row.note ? `${row.value} ${row.note}` : row.value}>{row.value}{row.note && <span className="native-panel-note">{row.note}</span>}</dd>
    </Fragment>)}</dl>}
    {group.kind === 'chips' && <div className="native-panel-chips">{group.chips.map(chip => <span key={chip.text} className={`native-panel-chip${chip.warn ? ' is-warn' : ''}`}>{chip.warn && <i />}{chip.text}</span>)}</div>}
    {group.kind === 'quota' && <div className="native-panel-quotas">{group.quotas.map(quota => <QuotaBar key={quota.name} quota={quota} />)}</div>}
    {group.kind === 'composition' && <>
      <span className="native-panel-meter is-stack" role="img" aria-label={group.title}>{group.segments.map((segment, at) => <i key={segment.label} className={`is-seg-${at + 1}`} style={{ width: `${segment.share}%` }} />)}</span>
      <ul className="native-panel-legend">{group.segments.map((segment, at) => <li key={segment.label}><i className={`is-seg-${at + 1}`} /><span title={segment.label}>{segment.label}</span><b className="num">{segment.value}</b></li>)}</ul>
    </>}
    {group.kind === 'suggest' && <div className="native-panel-suggest">{group.items.map(item => <button key={item.command} type="button" onClick={() => onPick?.(item.command)}><code>{item.command}</code><span>{item.description}</span></button>)}</div>}
  </section>;
}

// Three bars of different length stand where the groups will be: asking is not a blank window and not a half-filled one.
function Skeleton() {
  return <div role="status" aria-label={t('正在读取…')}>
    <div className="native-panel-hero"><div className="native-panel-skeleton"><i className="is-big" /></div></div>
    {[70, 52, 64].map(width => <section className="native-panel-group" key={width}><div className="native-panel-skeleton"><i style={{ width: `${width}%` }} /><i style={{ width: `${width - 14}%` }} /></div></section>)}
  </div>;
}

function Body({ panel, onPick }: { panel: Panel; onPick?: (command: string) => void }) {
  const { alert, hero } = panel;
  return <>
    {alert && <div className="native-panel-alert" role="alert"><WarningCircle size={16} /><span><b>{alert.strong}</b>{alert.text}</span></div>}
    {hero && <>
      <div className="native-panel-hero"><div className="native-panel-big num" title={hero.value}>{hero.value}{hero.unit && <small>{hero.unit}</small>}</div>{hero.caption && <div className="native-panel-cap">{hero.caption}</div>}</div>
      {hero.percent !== null && <div className={`native-panel-hero-bar${hero.percent >= 100 ? ' is-out' : ''}`}><Meter percent={hero.percent} label={hero.caption ?? hero.value} /></div>}
    </>}
    {panel.groups.map((group, at) => <Group key={`${group.kind}:${group.title ?? at}`} group={group} onPick={onPick} />)}
  </>;
}

// The window an information command opens over the conversation, centred above the message box. A press on the backdrop, the close button and Esc all
// close it. Esc is its own only when pressed in its session view (the window, the message box or the conversation): there it is caught on `window`
// before the message box sees it (which would stop a running agent); an Esc aimed at another project, a terminal or anything else passes untouched.
// With nothing focused (a press on the window's text leaves the page itself as the key's target) Esc closes the newest window nothing lies over, and
// only that one (`panel-keys.ts`). `onClose` is told whether the close came from inside the view (its own Esc, the button, the backdrop): only then does
// the cursor go back to the message box. A window closed from the page, or with its hidden project, moves the focus nowhere, so the next Esc is not a
// message box's (where it would stop a running agent).
// A hidden project keeps its views mounted, so the window goes with its view instead of waiting behind it. Tab stays among its buttons and Ctrl+C
// copies the whole panel unless some text is selected. Nothing in it is part of the conversation.
export function NativePanel({ state, onClose, onRefresh, onPick }: { state: PanelState; onClose: (refocus: boolean) => void; onRefresh: () => void; onPick?: (command: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null), close = useRef(onClose), copyAll = useRef(() => {});
  const [copied, setCopied] = useState(false), ready = state.state === 'ready' ? state.panel : null, title = ready?.title ?? panelTitle(state.agent, state.command);
  close.current = onClose;
  copyAll.current = () => { if (ready) void navigator.clipboard?.writeText(panelText(ready)).then(() => setCopied(true), () => {}); };
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  useEffect(() => {
    dialog.current?.focus({ preventScroll: true });
    const keys = (event: KeyboardEvent) => {
      const target = event.target as Node | null;
      if (event.key === 'Escape') {
        const from = escapeFrom(dialog, target);
        if (from) { event.preventDefault(); event.stopPropagation(); close.current(from === 'view'); }
        return;
      }
      if (!dialog.current?.contains(target)) return;
      if (event.key === 'Tab') {
        const buttons = [...dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled)')], at = buttons.indexOf(document.activeElement as HTMLElement);
        event.preventDefault();
        buttons[event.shiftKey ? (at <= 0 ? buttons.length - 1 : at - 1) : (at + 1) % buttons.length]?.focus();
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c' && !window.getSelection()?.toString()) { event.preventDefault(); copyAll.current(); }
    };
    window.addEventListener('keydown', keys, true);
    const forget = showPanel(dialog);
    // A view that is not drawn (its project slot is hidden) has no box.
    const hidden = new ResizeObserver(() => { if (!dialog.current?.getClientRects().length) close.current(false); });
    if (dialog.current) hidden.observe(dialog.current);
    return () => { window.removeEventListener('keydown', keys, true); hidden.disconnect(); forget(); };
  }, []);
  return <div className="native-panel-scrim" onMouseDown={event => {
    // The press would otherwise focus what lies under the backdrop once it is gone.
    if (event.button === 0 && event.target === event.currentTarget) { event.preventDefault(); onClose(true); }
  }}>
    <dialog open ref={dialog} tabIndex={-1} className="native-panel" aria-modal="true" aria-label={title} onCancel={event => event.preventDefault()}>
      <header className="native-panel-head">
        <span className="native-panel-mark"><AgentMark agent={state.agent} /></span>
        <strong className="native-panel-title">{title}</strong>
        <code className="native-panel-cmd">{ready?.command ?? `/${state.command}`}</code>
        <span className="native-panel-spacer" />
        <button type="button" className="icon-button" title={t('重新读取')} aria-label={t('重新读取')} disabled={state.state === 'loading'} onClick={onRefresh}><ArrowClockwise size={16} /></button>
        <button type="button" className="icon-button" title={copied ? t('已复制') : t('复制全部')} aria-label={t('复制全部')} disabled={!ready} onClick={() => copyAll.current()}>{copied ? <Check size={16} /> : <Copy size={16} />}</button>
        <button type="button" className="icon-button" title={t('关闭（Esc）')} aria-label={t('关闭')} onClick={() => onClose(true)}><X size={16} /></button>
      </header>
      <div className="native-panel-body">
        {state.state === 'loading' && <Skeleton />}
        {state.state === 'failed' && <div className="native-panel-alert" role="alert"><WarningCircle size={16} /><span><b>{t('读取失败')}</b>（{state.error}）</span></div>}
        {ready && <Body panel={ready} onPick={onPick} />}
      </div>
      <footer className="native-panel-foot">
        <span>{ready ? readTime(ready.readAt) : state.state === 'loading' ? t('正在读取…') : ''}</span><span className="native-panel-spacer" />
        <span><kbd>Esc</kbd> {t('关闭')}</span>{ready && <span><kbd>Ctrl</kbd> <kbd>C</kbd> {t('复制')}</span>}
      </footer>
    </dialog>
  </div>;
}
