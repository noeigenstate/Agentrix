import { Fragment, type ReactNode } from 'react';
import type { AgentActionBrief, ConversationEntry } from '../../shared/types';
import { t } from '../../shared/i18n';
import { actionText } from '../agents/action-text';
import { StepState } from '../reading/feed-parts';

// Presentation only: full input and output stay in the model for history and delivery bookkeeping.
export type NativeStep = NonNullable<ConversationEntry['tool']> & {
  nativeState?: 'running' | 'done' | 'failed' | 'interrupted' | 'unknown'; nativeReason?: string;
};
const LABELS: Record<AgentActionBrief['kind'], string> = {
  command: '运行命令', read: '读取文件', search: '搜索代码', web: '访问网页', skill: '使用技能',
  agent: '派出子代理', mcp: '调用工具', other: '调用工具', edit: '修改文件',
};
export const nativeStepLabel = (step: AgentActionBrief) => step.kind === 'edit' ? actionText(step) : t(step.kind === 'command' && step.phrase ? step.phrase : LABELS[step.kind]);

export function NativeSteps({ entries, details }: { entries: ConversationEntry[]; details: (entries: ConversationEntry[]) => ReactNode }) {
  const rows: ReactNode[] = [];
  let edits: ConversationEntry[] = [];
  const flush = () => { if (edits.length) { rows.push(<Fragment key={edits[0].id}>{details(edits)}</Fragment>); edits = []; } };
  for (const entry of entries) {
    const step = entry.tool as NativeStep;
    if (step.kind === 'edit') { edits.push(entry); continue; }
    flush();
    const state = step.nativeState ?? (!step.done ? 'running' : step.failed ? 'failed' : 'done');
    const label = state === 'running' ? t('进行中') : state === 'interrupted' ? t('已中断') : state === 'unknown' ? t('未知') : state === 'failed' ? t('失败') : t('已完成');
    rows.push(<div key={entry.id} data-reading-entry={entry.id} className={`reading-tools native-tool-summary${state === 'running' ? ' is-running' : ''}`}>
      {state === 'unknown' ? <span aria-hidden="true">—</span> : <StepState running={state === 'running'} failed={state === 'failed' || state === 'interrupted'} />}
      <span className="native-tool-label">{nativeStepLabel(step)}</span><small>{label}</small>
      {step.nativeReason && <small>{step.nativeReason}</small>}
    </div>);
  }
  flush();
  return <>{rows}</>;
}
