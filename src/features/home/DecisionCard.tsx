import { useEffect, useState } from 'react';
import { CaretDown } from '@phosphor-icons/react';
import type { Decision, DecisionKind } from './decisions';
import { snooze } from './decisions';
import { t } from '../../shared/i18n';
import { ReviewCard } from './ReviewCard';

const KINDS: Record<DecisionKind, string> = { approval: '需要审批', question: '需要回答', choice: '需要选择', signin: '需要登录', attention: '需要你处理', review: '交付审查' };
export const kindLabel = (kind: DecisionKind) => t(KINDS[kind]);
const AGENTS = { claude: 'Claude Code', codex: 'Codex' };

// How long a decision has waited, in the words of a clock on the wall.
export function waited(since: number, now: number) {
  const minutes = Math.floor((now - since) / 60000);
  return minutes < 1 ? t('刚刚') : minutes < 60 ? t('等了 {count} 分钟', { count: minutes }) : t('等了 {count} 小时', { count: Math.floor(minutes / 60) });
}
// A permission is named by what it would do: Claude heads it with the kind of step ("Bash command", "Edit file") and
// the command or file under it; Codex shows the command after "$ ". The CLI's own question ("Do you want to proceed?")
// says nothing about that.
const STEPS: Record<string, string> = { 'Bash command': '运行命令', 'Edit file': '修改文件', 'Create file': '新建文件', 'Write file': '写入文件', 'Read file': '读取文件', 'Fetch': '访问网页' };
function approvalTitle(decision: Decision) {
  const lines = decision.context.map(line => line.trim()), at = lines.findIndex(line => STEPS[line]);
  const command = lines.find(line => /^\$\s/.test(line))?.slice(2);
  if (at >= 0 && lines[at + 1]) return t('{step}：{target}', { step: t(STEPS[lines[at]]), target: lines[at + 1] });
  return command ? t('{step}：{target}', { step: t('运行命令'), target: command }) : decision.title;
}
export function decisionTitle(decision: Decision) {
  if (decision.kind === 'approval') return approvalTitle(decision);
  if (decision.kind === 'review') return decision.title ? t('交付：{task}', { task: decision.title }) : t('{project} 交付了这一轮的工作', { project: decision.projectName });
  if (decision.kind === 'signin') return t('登录 {agent}', { agent: AGENTS[decision.agent] });
  if (decision.kind === 'attention') return decision.message || t('{agent} 在等你', { agent: AGENTS[decision.agent] });
  if (trustsFolder(decision)) return t('要信任这个文件夹吗？');
  return decision.title;
}
// The CLI asking whether to trust the folder it starts in (Claude Code's "Accessing workspace:", Codex's "Do you trust
// the files in this folder?"): named for what it asks, the folder under it.
export function trustsFolder(decision: Decision) {
  return decision.kind === 'choice' && [decision.title, ...(decision.choice?.options ?? []).map(option => option.label)].some(text => /trust (this|the files in this) folder/i.test(text));
}
export function trustedFolder(decision: Decision) {
  return decision.context.map(line => line.trim()).find(line => /^([A-Za-z]:[\\/]|\/|~)/.test(line));
}

// Every live CLI decision opens its own terminal; the dashboard never answers for it.
export function DecisionCard({ decision, now, onOpen, onDone, onError }: {
  decision: Decision; now: number; onOpen: (decision: Decision) => void; onDone: (message: string) => void; onError: (message: string) => void;
}) {
  const [later, setLater] = useState(false);
  useEffect(() => setLater(false), [decision.id]);
  const title = decisionTitle(decision);
  const kind = <span className="decision-kind">{kindLabel(decision.kind)}</span>;
  const source = `${decision.projectName}${decision.multipleTerminals ? ` · ${decision.terminalTitle}` : ''} · ${AGENTS[decision.agent]} · ${waited(decision.since, now)}`;
  if (decision.kind === 'review') return <ReviewCard decision={decision} now={now} kind={kind} onOpen={onOpen} onDone={onDone} onError={onError} />;
  const putOff = (minutes: number) => { snooze(decision.id, Date.now() + minutes * 60000); setLater(false); onDone(t('已暂缓，{time} 后再提醒；执行仍在等你。', { time: minutes < 60 ? t('{count} 分钟', { count: minutes }) : t('{count} 小时', { count: minutes / 60 }) })); };
  return <article className={`decision-card is-${decision.kind}`} data-approval-mode="terminal-only" aria-label={title}>
    <header className="decision-card-head">
      {kind}<span className="decision-mode">{t('终端模式')}</span>
      <span className="decision-source">{source}</span>
    </header>
    <h2 className="decision-title">{title}</h2>
    <div className="decision-body">
      {decision.kind !== 'signin' && decision.kind !== 'attention' && <p className="decision-why" role="status">{t('在终端中处理所有确认和问题')}</p>}
      {decision.context.length > 0 && decision.kind !== 'question' && <pre className="decision-evidence">{decision.context.join('\n')}</pre>}
      {decision.kind === 'signin' && <p className="decision-why">{t('请在终端中完成登录。')}</p>}
      {decision.kind === 'attention' && <p className="decision-why">{t('这件事在它的终端里处理：打开来源，看它在问什么。')}</p>}
    </div>
    <footer className="decision-actions">
      <button type="button" className="button primary" data-approval-open-terminal onClick={() => onOpen(decision)}>{t('打开终端')}</button>
      <span className="decision-later">
        <button type="button" className="button secondary" aria-expanded={later} onClick={() => setLater(!later)}>{t('稍后处理')}<CaretDown size={16} /></button>
        {later && <span className="decision-later-menu" role="menu">
          {[10, 60, 180].map(minutes => <button type="button" role="menuitem" key={minutes} onClick={() => putOff(minutes)}>{minutes < 60 ? t('{count} 分钟后', { count: minutes }) : t('{count} 小时后', { count: minutes / 60 })}</button>)}
        </span>}
      </span>
    </footer>
  </article>;
}
