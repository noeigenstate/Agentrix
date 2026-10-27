import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowCounterClockwise, ArrowsOutSimple, CheckCircle, ChatCircle, CopySimple, DotsThree, DownloadSimple, FileText, PencilSimple, TerminalWindow, XCircle } from '@phosphor-icons/react';
import type { GitChange } from '../../shared/types';
import { t } from '../../shared/i18n';
import './result-card.css';
import { showPopup } from '../files/file-popup';
import { stepTime } from './Timeline';
import { changedFiles, elapsed, FALLBACK_TITLES, resultActions, type LatestResult, type ResultAction } from './result-round';

const MENU_WIDTH = 224, MENU_GAP = 4, EDGE = 8, FILES_SHOWN = 5;

// How long the round took: "40 秒", "3 分 10 秒", "1 小时 5 分".
function took(result: LatestResult) {
  const { hours, minutes, seconds } = elapsed(result.startedAt, result.endedAt);
  if (hours) return t('{hours} 小时 {minutes} 分', { hours, minutes });
  return minutes ? t('{minutes} 分 {seconds} 秒', { minutes, seconds }) : t('{seconds} 秒', { seconds });
}

// The ··· menu: what can be copied out of this round, and the terminal for one that failed. Never a way to mark the
// round done: completion comes from the agent's own end of round.
function ResultMenu({ items }: { items: { icon: ReactNode; label: string; run: () => void }[] }) {
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const close = () => { setPlace(null); trigger.current?.focus(); };
  const toggle = () => {
    if (place) return close();
    const box = trigger.current!.getBoundingClientRect();
    setPlace({ left: Math.max(EDGE, Math.min(box.right - MENU_WIDTH, innerWidth - MENU_WIDTH - EDGE)), top: box.bottom + MENU_GAP });
  };
  useEffect(() => {
    if (!place) return;
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const outside = (event: PointerEvent) => { const target = event.target as Node; if (!menu.current?.contains(target) && !trigger.current?.contains(target)) setPlace(null); };
    const away = () => setPlace(null);
    document.addEventListener('pointerdown', outside, true); addEventListener('resize', away);
    return () => { document.removeEventListener('pointerdown', outside, true); removeEventListener('resize', away); };
  }, [place !== null]);
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape' || event.key === 'Tab') return close();
    const buttons = [...menu.current!.querySelectorAll<HTMLElement>('[role="menuitem"]')], at = buttons.indexOf(document.activeElement as HTMLElement);
    const target = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: buttons.length - 1 }[event.key as 'ArrowDown'];
    if (target === undefined) return;
    event.preventDefault(); buttons[(target + buttons.length) % buttons.length].focus();
  };
  if (!items.length) return null;
  return <>
    <button type="button" ref={trigger} className="result-more" title={t('更多')} aria-label={t('更多')} aria-haspopup="menu" aria-expanded={place !== null} onClick={toggle}><DotsThree size={20} weight="bold" /></button>
    {place && createPortal(<div ref={menu} className="dropdown result-menu" role="menu" tabIndex={-1} style={place} onKeyDown={onKeyDown}>
      {items.map(item => <button key={item.label} type="button" role="menuitem" onClick={() => { close(); item.run(); }}>{item.icon}{item.label}</button>)}
    </div>, document.body)}
  </>;
}

// Level 1, above the result: the round is done (or stopped), what it was, when it ended and how long it took.
export function ResultStatus({ result, taskTitle, onShowTerminal, onError }: { result: LatestResult; taskTitle: string | undefined; onShowTerminal: () => void; onError: (message: string) => void }) {
  const failed = result.kind === 'failed', label = failed ? result.failure ? t('失败') : t('已中断') : t('已完成'), title = taskTitle?.trim() || t(FALLBACK_TITLES[result.kind]);
  const copy = (text: string) => () => { void window.agentrix.copy(text).then(copied => { if (!copied.ok) onError(copied.error); }); };
  const item = (icon: ReactNode, text: string, run: () => void) => ({ icon, label: text, run });
  const items = {
    picture: [result.picture?.prompt && item(<CopySimple size={16} />, t('复制提示词'), copy(result.picture.prompt)), item(<FileText size={16} />, t('复制图片路径'), copy(result.picture?.path ?? ''))],
    code: [result.reply && item(<CopySimple size={16} />, t('复制回答'), copy(result.reply)), item(<FileText size={16} />, t('复制改动文件路径'), copy(result.written.join('\n')))],
    text: [item(<CopySimple size={16} />, t('复制回答'), copy(result.reply))],
    failed: [result.failure && item(<CopySimple size={16} />, t('复制错误信息'), copy(result.failure)), item(<TerminalWindow size={16} />, t('在终端中查看'), onShowTerminal)],
  }[result.kind].flatMap(entry => entry ? [entry] : []);
  const Icon = failed ? XCircle : CheckCircle;
  return <div className={`result-status${failed ? ' is-failed' : ''}`} role="status">
    <Icon size={20} weight="fill" className="result-state" aria-hidden="true" />
    <div className="result-heading">
      <h3 className="result-title" title={`${title} · ${label}`}><span>{title}</span><b>{` · ${label}`}</b></h3>
      <p className="result-sub">{failed ? (result.failure ? t('{time} 失败', { time: stepTime(result.endedAt) }) : t('{time} 中断', { time: stepTime(result.endedAt) })) : t('{time} 完成', { time: stepTime(result.endedAt) })}<span className="result-took">{` · ${t('用时 {span}', { span: took(result) })}`}</span></p>
    </div>
    <ResultMenu items={items} />
  </div>;
}

// Level 2 of a round that wrote files: which files and what Git calls them (read once as the card appears, never per
// render), and the checks the round actually ran. No line counts: Git does not give them without a diff per file.
export function ResultFiles({ result, projectId }: { result: LatestResult; projectId: string }) {
  const [changes, setChanges] = useState<GitChange[] | null>(null);
  useEffect(() => {
    let live = true;
    void window.agentrix.gitStatus(projectId).then(status => { if (live && status.ok && status.value.repository) setChanges(status.value.files); }).catch(() => {});
    return () => { live = false; };
  }, [projectId, result.anchor]);
  const files = changedFiles(result.written, changes);
  return <div className="result-evidence">
    <div><p className="result-list-head">{t('改动 {count} 个文件', { count: files.length })}</p>
      <ul className="result-list">{files.slice(0, FILES_SHOWN).map(file => <li key={file.path}>
        <FileText size={16} aria-hidden="true" />
        <button type="button" className="result-file" title={file.path} onClick={() => showPopup({ kind: 'file', projectId, path: file.path })}>{file.name}</button>
        {file.state && <span className="result-state-text">{t(file.state)}</span>}
      </li>)}</ul>
      {files.length > FILES_SHOWN && <p className="result-more-files">{t('还有 {count} 个文件', { count: files.length - FILES_SHOWN })}</p>}
    </div>
    {result.checks.length > 0 && <div><p className="result-list-head">{t('验证')}</p>
      <ul className="result-list">{result.checks.map(check => <li key={check.id} className={check.failed ? 'is-failed' : 'is-passed'}>
        {check.failed ? <XCircle size={16} className="result-check" aria-hidden="true" /> : <CheckCircle size={16} className="result-check" aria-hidden="true" />}
        <span className="result-check-name">{t(check.phrase)}<small>{check.target}</small></span>
        <span className="result-state-text">{check.failed ? t('失败') : t('通过')}</span>
      </li>)}</ul>
    </div>}
  </div>;
}

const ACTIONS: Record<ResultAction, { icon: ReactNode; label: string }> = {
  enlarge: { icon: <ArrowsOutSimple size={16} />, label: '查看大图' }, save: { icon: <DownloadSimple size={16} />, label: '保存图片' },
  open: { icon: <FileText size={16} />, label: '打开文件' }, continue: { icon: <PencilSimple size={16} />, label: '继续修改' },
  ask: { icon: <ChatCircle size={16} />, label: '继续追问' }, copy: { icon: <CopySimple size={16} />, label: '复制回答' },
  retry: { icon: <ArrowCounterClockwise size={16} />, label: '重试' },
};

// Level 3, under the result: quiet secondary buttons, icon-only (with a tooltip) when the row is narrow.
export function ResultActions({ result, projectId, remote, canSend, onContinue, onRetry, onError }: {
  result: LatestResult; projectId: string; remote: boolean; canSend: boolean; onContinue: (prefill?: string) => void; onRetry: () => void; onError: (message: string) => void;
}) {
  const copied = (text: string) => void window.agentrix.copy(text).then(done => { if (!done.ok) onError(done.error); });
  const run: Record<ResultAction, () => void> = {
    enlarge: () => showPopup({ kind: 'image', path: result.picture!.path }),
    save: () => void window.agentrix.saveImageAs(result.picture!.path).then(saved => { if (!saved.ok) onError(saved.error); }),
    open: () => showPopup({ kind: 'file', projectId, path: result.written[0] }),
    continue: () => onContinue(result.kind === 'picture' ? t('在这张图的基础上：') : undefined),
    ask: () => onContinue(), copy: () => copied(result.reply), retry: onRetry,
  };
  const why = (id: ResultAction) => id === 'save' ? t('远程项目的图片留在远程电脑上，不能在这里保存') : id === 'retry' ? t('只有代理停在输入处时才能重试') : '';
  const actions = resultActions(result, { remote, canSend });
  return <div className="result-actions" data-count={actions.length}>{actions.map(({ id, disabled }) => {
    const label = t(ACTIONS[id].label);
    return <button key={id} type="button" className="result-button" disabled={disabled} title={disabled ? why(id) || label : label} aria-label={label} onClick={run[id]}>{ACTIONS[id].icon}<span>{label}</span></button>;
  })}</div>;
}
