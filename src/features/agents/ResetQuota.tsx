import { useEffect, useRef, useState } from 'react';
import { ArrowCounterClockwise } from '@phosphor-icons/react';
import type { AgentUsage, ProjectTerminal } from '../../shared/types';
import { t } from '../../shared/i18n';
import { readScreen, subscribeScreen } from '../terminal/terminal-screen.ts';
import { sendToAgent } from '../home/send-to-agent';
import { ResetCountdown } from './ResetCountdown';
import { codexResetCount, codexResetsSaid } from './reset-count';
import './activity-pane.css';

// What Codex last said on its screen of the resets left, per terminal.
const resetsSaid = new Map<string, number>();
function useResetsSaid(terminal: ProjectTerminal) {
  const key = `${terminal.agent}:${terminal.id}:${terminal.sessionId}:${terminal.agentStartedAt}`;
  const [said, setSaid] = useState(() => resetsSaid.get(key) ?? null);
  useEffect(() => {
    setSaid(resetsSaid.get(key) ?? null);
    const read = (rows: readonly string[]) => {
      const now = codexResetsSaid(rows);
      if (now !== null && now !== resetsSaid.get(key)) { resetsSaid.set(key, now); setSaid(now); }
    };
    const current = readScreen(terminal.id); if (current) read(current.rows);
    const unsubscribe = subscribeScreen(terminal.id, screen => read(screen.rows));
    return () => { unsubscribe(); resetsSaid.delete(key); };
  }, [key]);
  return said;
}

// Using one of the plan's limit resets is costly and never happens at once: a click starts a ten-second countdown, shown
// large over the whole window, that the reader can cancel at any moment, and only then does Codex get /usage as a typed
// command, where it asks which reset to use and to confirm. Agentrix itself never calls a reset. Closing the pane or
// switching terminals (or the agent stopping) unmounts this and so cancels the countdown.
const COUNTDOWN = 10;
// Why the number of resets is not known: a short form for the row's right-hand slot (which must leave the label whole) and the whole sentence for its hover.
function queryStatus(query: AgentUsage['resetQuery']) {
  if (!query) return { short: t('暂无状态'), full: t('当前会话还没有重置次数的查询状态；符合条件的本地账号会自动查询') };
  if (query.state === 'loading') return { short: t('查询中…'), full: t('正在查询剩余重置次数，结果出来后会显示在这里') };
  if (query.reason === 'remote') return { short: t('暂不支持'), full: t('远程账号暂不支持后台查询') };
  if (query.reason === 'provider') return { short: t('暂不支持'), full: t('当前接口不提供重置次数') };
  if (query.reason === 'version') return { short: t('暂不支持'), full: t('当前 Codex 版本不支持查询重置次数') };
  if (query.reason === 'missing') return { short: t('暂不支持'), full: t('找不到 Codex 程序，无法查询重置次数') };
  if (query.reason === 'scope') return { short: t('无法确认'), full: t('无法确认账号环境，暂不能查询') };
  if (query.state === 'error') return { short: t('查询失败'), full: t('查询失败，将自动重试') };
  // The account answered (the limits show) but gave no count: told apart from a reason nobody named.
  if (query.state === 'ready' || query.reason === 'unsupported') return { short: t('未提供次数'), full: t('这个账号没有返回重置次数，5 小时和每周额度照常显示；将定时再查') };
  return { short: t('次数未知'), full: t('无法确定重置次数，将定时再查') };
}
export function ResetQuota({ terminal }: { terminal: ProjectTerminal }) {
  const left = codexResetCount(terminal.agentUsage, useResetsSaid(terminal)), unknown = queryStatus(terminal.agentUsage?.resetQuery);
  const [count, setCount] = useState<number | null>(null), [note, setNote] = useState<string | null>(null);
  const row = useRef<HTMLButtonElement>(null), counted = useRef(false), fired = useRef(false);
  const command = '/usage';
  useEffect(() => {
    if (count === null) return;
    // Once per countdown, whatever renders again meanwhile.
    if (count === 0) { setCount(null); if (!fired.current) { fired.current = true; void run(); } return; }
    const timer = window.setTimeout(() => setCount(count - 1), 1000);
    return () => clearTimeout(timer);
  }, [count]);
  // Whatever ends the countdown, focus goes back to the row that started it.
  useEffect(() => { if (count === null && counted.current) row.current?.focus(); counted.current = count !== null; }, [count]);
  useEffect(() => { if (!note) return; const timer = window.setTimeout(() => setNote(null), 8000); return () => clearTimeout(timer); }, [note]);
  const run = async () => {
    // A reading view of this terminal takes it as its own composer would (its popup shows what the agent answers);
    // otherwise it goes into the agent's input as typed.
    const event = new CustomEvent('agentrix:command', { detail: { terminalId: terminal.id, text: command }, cancelable: true });
    const failed = window.dispatchEvent(event) && terminal.sessionId ? await sendToAgent(terminal.id, terminal.sessionId, 'codex', command) : null;
    setNote(failed ?? t('已打开 Codex 的 /usage，在那里选择要用的重置并确认。'));
  };
  // A 32px row on the task grid: the icon, the label and, in the right-hand slot, how many resets are left, or why that is not known, or that it is counting down. The countdown itself is the overlay.
  const counting = count !== null, status = counting ? t('倒计时中…') : left === 0 ? t('已用完') : left !== null ? t('剩余 {count} 次', { count: left }) : unknown.short;
  const start = () => { fired.current = false; setNote(null); setCount(COUNTDOWN); };
  // The hover says what this row does now: why the count is unknown and then the click's explanation, that nothing is left to use, or how to cancel.
  const title = counting ? t('倒计时进行中，可点击「取消」、按 Esc 或点击空白处取消') : left === 0 ? t('没有剩余重置次数，此行不可点击')
    : [left === null && unknown.full, t('点击后开始 10 秒倒计时，期间可取消；结束后打开 {agent} 的 /usage，由你选择并确认重置', { agent: 'Codex' })].filter(Boolean).join('\n');
  return <div className="activity-reset">
    <button ref={row} type="button" className="activity-reset-row activity-estop" disabled={counting || left === 0 || !terminal.codexActive} title={title} onClick={start}>
      <span className="activity-row-icon"><ArrowCounterClockwise size={14} aria-hidden="true" /></span>
      <span className="activity-reset-label">{t('重置额度')}</span>
      <small>{status}</small>
    </button>
    {note && <p className="activity-note" role="status">{note}</p>}
    {!!count && <ResetCountdown count={count} total={COUNTDOWN} onCancel={() => setCount(null)} />}
  </div>;
}
