// How the lab writes numbers, dates, approaches and states. A number the runs do not support is a dash, never 0.
import type { LabArm, LabExperiment, LabPhase } from '../../shared/lab-types';
import { currentLanguage, t } from '../../shared/i18n';

export const DASH = '—';

export const money = (usd: number | null) => usd === null ? DASH : `$${usd < 10 ? usd.toFixed(2) : usd < 100 ? usd.toFixed(1) : usd.toFixed(0)}`;
export const percent = (share: number | null) => share === null ? DASH : `${Math.round(share * 100)}%`;
export const decimal = (value: number | null) => value === null ? DASH : value.toFixed(1);
export const outOf = (part: number | null, whole: number | null) => part === null || whole === null ? DASH : `${part}/${whole}`;

export function duration(ms: number | null) {
  if (ms === null) return DASH;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return t('{n} 秒', { n: seconds });
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? t('{n} 分钟', { n: minutes }) : `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

// An estimate is given in minutes.
export const minutesLabel = (minutes: number) => duration(minutes * 60000);

export const dateLabel = (at: number) => new Date(at).toLocaleDateString(currentLanguage() === 'en' ? 'en-US' : 'zh-CN', { month: 'short', day: 'numeric' });

export function armName(arm: LabArm, long = false) {
  if (arm === 'orchestrated') return long ? t('编排 · 完整路由') : t('编排');
  const name = { opus: 'Opus 5.5', sol: 'GPT-6.1-Sol', sonnet: 'Sonnet 5.5' }[arm];
  return long ? t('{name} 单独', { name }) : name.replace('GPT-6.1-', '');
}

export function kindLabel(kind: string) {
  const known: Record<string, string> = {
    core: t('复杂代码'), frontend: t('前端'), test: t('测试'), 'ui-check': t('界面验收'), docs: t('文档'),
    small: t('小任务'), review: t('审查'), investigate: t('调查'), roundtable: t('圆桌'),
  };
  return known[kind] ?? kind;
}

export function phaseLabel(name: LabPhase['name']) {
  return { plan: t('计划'), roundtable: t('圆桌'), build: t('编写'), review: t('评审'), rework: t('返工') }[name];
}

export function stateLabel(state: LabExperiment['state']) {
  return { running: t('运行中'), done: t('已完成'), stopped: t('已停止'), error: t('出错') }[state];
}

// In a sentence a single model is "<name> alone" and the orchestration is just its name.
export const sentenceName = (arm: LabArm) => armName(arm, arm !== 'orchestrated');

export const taskCount =(experiment: LabExperiment) => t('{n} 个任务 · 每项 {r} 次 · {date}', { n: experiment.tasks.length, r: experiment.repeats, date: dateLabel(experiment.createdAt) });
