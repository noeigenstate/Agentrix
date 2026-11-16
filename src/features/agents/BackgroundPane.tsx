// The view of one background task beside a conversation: the command, how long it has run and the end of its output, read-only (no word is sent and nothing is stopped from here).
import { useEffect, useRef } from 'react';
import { Terminal, X } from '@phosphor-icons/react';
import type { ProjectTerminal } from '../../shared/types';
import { t } from '../../shared/i18n';
import { elapsedClock } from '../../shared/elapsed-clock.ts';
import { backgroundEnd, backgroundTaskOf, useClock } from './subagent-splits.ts';
import './activity-pane.css';

export function BackgroundPane({ terminal, callId, onClose }: { terminal: ProjectTerminal | undefined; callId: string; onClose(): void }) {
  const task = backgroundTaskOf(terminal, callId), now = useClock(task?.state === 'running'), body = useRef<HTMLPreElement>(null);
  const tail = task?.tail ?? [];
  // The newest output stays in view.
  useEffect(() => { const node = body.current; if (node) node.scrollTop = node.scrollHeight; }, [tail.length, tail.at(-1)]);
  if (!task) return <section className="subagent-split" aria-label={t('后台任务的输出，只读')} onKeyDown={event => { if (event.key === 'Escape') onClose(); }}>
    <header className="subagent-head"><div className="subagent-head-row"><Terminal size={16} /><span className="subagent-title">{t('后台任务')}</span><span className="subagent-tag">{t('不可用')}</span>
      <button type="button" className="icon-button" title={t('关闭分屏（Esc）')} aria-label={t('关闭后台任务的分屏')} onClick={onClose}><X size={13} /></button></div></header>
    <div className="subagent-body"><p className="subagent-empty">{t('这个后台任务已经不在记录里。')}</p></div>
  </section>;
  const running = task.state === 'running', took = elapsedClock((running ? now : backgroundEnd(task)) - task.startedAt);
  const age = task.lastOutputAt == null ? t('还没有输出') : t('最后输出 {count} 秒前', { count: Math.max(0, Math.floor((now - task.lastOutputAt) / 1000)) });
  const state = running ? t('运行中') : task.exitCode ? t('已结束，退出码 {code}', { code: task.exitCode }) : t('已完成');
  return <section className="subagent-split" aria-label={t('{command} 的输出，只读', { command: task.command })} onKeyDown={event => { if (event.key === 'Escape') onClose(); }}>
    <header className="subagent-head">
      <div className="subagent-head-row">
        <Terminal size={16} /><span className="subagent-title" title={task.command}>{task.command}</span>
        <span className={`subagent-tag subagent-state is-${running ? 'running' : 'done'}`}>{state}</span>
        <span className="subagent-elapsed" title={t(running ? '已运行' : '用时')}>{took}</span>
        <button type="button" className="icon-button" title={t('关闭分屏（Esc）')} aria-label={t('关闭 {command} 的分屏', { command: task.command })} onClick={onClose}><X size={13} /></button>
      </div>
      <div className="subagent-meta">{[t('后台任务'), running ? age : null].filter(Boolean).join(' · ')}</div>
    </header>
    <pre ref={body} className="subagent-background-tail" tabIndex={0} role="log" aria-live="off" aria-label={t('后台任务的输出，只读')}>{tail.length ? tail.join('\n') : t('还没有输出。')}</pre>
    <div className="subagent-input"><p className="subagent-input-note">{t('后台任务的输出只读，这里不能向它发消息或停止它。')}</p></div>
  </section>;
}
