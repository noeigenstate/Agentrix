import { useEffect, useRef, useState } from 'react';
import { CaretDown, CircleNotch } from '@phosphor-icons/react';
import type { Decision, DecisionKind } from './decisions';
import { snooze } from './decisions';
import { parseAgentScreen } from '../agents/agent-screen';
import { readScreen } from '../terminal/terminal-screen';
import { choiceIdentity, selectedChoiceIndex, writeChoiceKeys } from '../reading/choice-keys';
import { NativeApprovalCard } from '../reading/NativeApprovalCard';
import { terminalApprovalCopy } from '../reading/approval-action';
import { ReadingQuestion } from '../reading/ReadingQuestion';
import { currentLanguage, t } from '../../shared/i18n';
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
  const params = decision.native?.params, input = params?.input && typeof params.input === 'object' ? params.input as Record<string, unknown> : undefined, nativeCommand = params?.command ?? input?.command;
  if (typeof nativeCommand === 'string') return t('{step}：{target}', { step: t('运行命令'), target: nativeCommand });
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

// Permission cards display the CLI's request and open its terminal. Other choices retain their confirm action.
export function DecisionCard({ decision, now, onOpen, onDone, onError }: {
  decision: Decision; now: number; onOpen: (decision: Decision) => void; onDone: (message: string) => void; onError: (message: string) => void;
}) {
  const [picked, setPicked] = useState<number | null>(null), [state, setState] = useState<'idle' | 'sending' | 'expired'>('idle'), [later, setLater] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { setPicked(null); setState('idle'); setLater(false); }, [decision.id, decision.choice?.approval?.stamp?.sessionId, decision.choice?.approval?.stamp?.revision]);
  const kind = <span className="decision-kind">{kindLabel(decision.kind)}</span>;
  const source = `${decision.projectName}${decision.multipleTerminals ? ` · ${decision.terminalTitle}` : ''} · ${AGENTS[decision.agent]} · ${waited(decision.since, now)}`;
  if (decision.native) return <article className="decision-card is-approval" data-approval-mode="native" aria-label={decisionTitle(decision)}>
    <header className="decision-card-head">{kind}<span className="decision-mode">{decision.native.provider === 'claude' ? 'Claude SDK' : 'Codex'}</span><span className="decision-source">{source}</span></header>
    <h2 className="decision-title">{decisionTitle(decision)}</h2>
    <div className="decision-body"><NativeApprovalCard key={decision.native.token} request={decision.native} onOpen={() => onOpen(decision)} onError={onError} /></div>
  </article>;
  if (decision.kind === 'review') return <ReviewCard decision={decision} now={now} kind={kind} onOpen={onOpen} onDone={onDone} onError={onError} />;
  const options = decision.choice?.options ?? [];
  const terminalOnly = decision.kind === 'approval' || decision.choice?.kind === 'permission', copy = terminalApprovalCopy(currentLanguage());
  const send = async () => {
    if (terminalOnly) return;
    if (picked === null || state === 'sending') return;
    // The answer goes only to the choice it was picked for: read the screen again first.
    const rows = readScreen(decision.terminalId)?.rows;
    const current = rows ? parseAgentScreen(decision.agent, rows).choice : null;
    if (!current || current.kind === 'permission' || choiceIdentity(current) !== decision.identity) { setState('expired'); return; }
    setState('sending');
    try {
      await writeChoiceKeys(selectedChoiceIndex(current), picked, key => window.agentrix.writeTerminal(decision.terminalId, key), () => alive.current);
      onDone(t('已回答「{project}」：{answer}', { project: decision.projectName, answer: options[picked]?.label ?? '' }));
    } catch (error) { if (alive.current) { setState('idle'); onError(error instanceof Error ? t(error.message) : String(error)); } }
  };
  const putOff = (minutes: number) => { snooze(decision.id, Date.now() + minutes * 60000); setLater(false); onDone(t('已暂缓，{time} 后再提醒；执行仍在等你。', { time: minutes < 60 ? t('{count} 分钟', { count: minutes }) : t('{count} 小时', { count: minutes / 60 }) })); };
  return <article className={`decision-card is-${decision.kind}`} data-approval-mode={terminalOnly ? 'terminal-only' : undefined} aria-label={decisionTitle(decision)}>
    <header className="decision-card-head">
      {kind}{terminalOnly && <span className="decision-mode">{t('终端模式')}</span>}
      <span className="decision-source">{source}</span>
    </header>
    <h2 className="decision-title">{decisionTitle(decision)}</h2>
    <div className="decision-body">
      {terminalOnly && <p className="decision-why" role="status">{copy.message}</p>}
      {decision.context.length > 0 && decision.kind !== 'question' && <pre className="decision-evidence">{decision.context.join('\n')}</pre>}
      {decision.kind === 'question' && decision.choice
        ? <div className="decision-question"><ReadingQuestion key={decision.id} choice={decision.choice} terminalId={decision.terminalId} onError={onError} /></div>
        : options.length > 0 && (terminalOnly
          ? <ol className="decision-options-readonly" aria-label={decisionTitle(decision)}>
            {options.map(option => <li key={option.number}>{option.label}{option.detail && <small>{option.detail}</small>}</li>)}
          </ol>
          : <div className="decision-options" role="radiogroup" aria-label={decisionTitle(decision)}>
            {options.map((option, index) => <label key={option.number} className={`decision-option ${picked === index ? 'is-picked' : ''}`}>
              <input type="radio" name={`decision-${decision.id}`} checked={picked === index} disabled={state === 'sending'} onChange={() => setPicked(index)} />
              <span><b>{option.label}</b>{option.detail && <small>{option.detail}</small>}</span>
            </label>)}
          </div>)}
      {decision.kind === 'signin' && <p className="decision-why">{t('打开它的阅读视图，在登录窗口里打开登录页或粘贴授权码。')}</p>}
      {decision.kind === 'attention' && <p className="decision-why">{t('这件事在它的终端里处理：打开来源，看它在问什么。')}</p>}
      {state === 'expired' && <p className="decision-state is-expired" role="status">{t('这个问题已经变了，没有发送。请看更新后的内容再决定。')}</p>}
    </div>
    <footer className="decision-actions">
      {options.length > 0 && decision.kind !== 'question' && !terminalOnly && <button type="button" className="button primary" disabled={picked === null || state !== 'idle'} onClick={() => void send()}>
        {state === 'sending' && <CircleNotch size={16}className="loading-spinner" />}{picked === null ? t('先选一个答案') : t('确认：{answer}', { answer: options[picked].label })}</button>}
      <button type="button" className={`button ${terminalOnly ? 'primary' : 'secondary'}`} data-approval-open-terminal={terminalOnly || undefined} onClick={() => onOpen(decision)}>{terminalOnly ? copy.open : t('打开来源')}</button>
      <span className="decision-later">
        <button type="button" className="button secondary" aria-expanded={later} onClick={() => setLater(!later)}>{t('稍后处理')}<CaretDown size={16} /></button>
        {later && <span className="decision-later-menu" role="menu">
          {[10, 60, 180].map(minutes => <button type="button" role="menuitem" key={minutes} onClick={() => putOff(minutes)}>{minutes < 60 ? t('{count} 分钟后', { count: minutes }) : t('{count} 小时后', { count: minutes / 60 })}</button>)}
        </span>}
      </span>
    </footer>
  </article>;
}
