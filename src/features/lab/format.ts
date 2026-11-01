// How the lab writes numbers, dates, approaches and states. A number the runs do not support is a dash, never 0.
import type { LabArm, LabExperiment, LabPhase } from '../../shared/lab-types';
import { currentLanguage, t } from '../../shared/i18n';

export const DASH = '—';

// A cost is always dollars and cents ("$12.90", "$0.00"), on a card, in a table, in a header. Only an axis tick may drop the cents of a whole dollar.
export const money = (usd: number | null) => usd === null ? DASH : `$${usd.toFixed(2)}`;
export const moneyTick = (usd: number) => Number.isInteger(usd) ? `$${usd}` : money(usd);
export const percent = (share: number | null) => share === null ? DASH : `${Math.round(share * 100)}%`;
export const decimal = (value: number | null) => value === null ? DASH : value.toFixed(1);
export const outOf = (part: number | null, whole: number | null) => part === null || whole === null ? DASH : `${part}/${whole}`;

// One way to write a time everywhere: "45 秒", "44 分", "1 小时 52 分" (and "2 小时" on the hour). Zero is "0 分" so an axis can start there.
export function duration(ms: number | null) {
  if (ms === null) return DASH;
  const seconds = Math.round(ms / 1000);
  if (seconds > 0 && seconds < 60) return t('{n} 秒', { n: seconds });
  const minutes = Math.round(seconds / 60), hours = Math.floor(minutes / 60), rest = minutes % 60;
  if (hours === 0) return t('{n} 分', { n: minutes });
  return rest === 0 ? t('{n} 小时', { n: hours }) : t('{h} 小时 {m} 分', { h: hours, m: rest });
}

// What the page says for an engine message: "this platform cannot run the lab safely" and "the project's Git would not give us a workspace" are put in plain
// words (the second with a next step); every other message is the engine's own sentence, translated.
export function friendlyError(message: string) {
  if (/unavailable on this platform/i.test(message)) return t('虚拟实验室目前只支持 macOS。');
  // Only the first line is the error itself; the lines after it (the test-log path) are kept as they are.
  const [first, ...rest] = message.split('\n');
  if (!/worktree|^Git:|工作区/i.test(first)) return t(message);
  return [t('无法创建独立工作区。请重试；仍然失败时，先检查这个项目的 Git 状态，再新建实验。'), ...rest].join('\n');
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

export const taskCount = (experiment: LabExperiment) => t('{n} 个任务 · 每项 {r} 次 · {date}', { n: experiment.tasks.length, r: experiment.repeats, date: dateLabel(experiment.createdAt) });
