// How the dashboard writes its numbers and names. Every number is null when the records do not support it: it reads "—",
// never 0. Pure functions, so the page and its tests agree on one wording.
import type { DashboardFindingCategory, DashboardKpis, DashboardModelRow, DashboardRange, DashboardWeight } from '../../shared/dashboard-types';
import { t } from '../../shared/i18n';

export const NONE = '—';

export const percent = (ratio: number | null) => ratio === null ? NONE : `${Math.round(ratio * 100)}%`;
export const decimal = (value: number | null, digits = 1) => value === null ? NONE : value.toFixed(digits);
export const speed = (value: number | null) => value === null ? NONE : `${Math.round(value)} tok/s`;
export const count = (value: number | null) => value === null ? NONE : String(value);

export function duration(ms: number | null) {
  if (ms === null) return NONE;
  if (ms < 60_000) return t('{count} 秒', { count: Math.max(1, Math.round(ms / 1000)) });
  if (ms < 3_600_000) return t('{count} 分', { count: Math.round(ms / 60_000) });
  return t('{count} 小时', { count: (ms / 3_600_000).toFixed(1) });
}

// The length of a quota window: 300 minutes is "5 h", 10080 is "7 days".
export function windowLength(minutes: number) {
  if (minutes >= 1440) return t('{count} 天', { count: Math.round(minutes / 1440) });
  if (minutes >= 60) return t('{count} 小时', { count: Math.round(minutes / 60) });
  return t('{count} 分钟', { count: minutes });
}

export const providerName = (provider: 'claude' | 'codex') => provider === 'claude' ? 'Claude' : 'Codex';

export function rangeName(range: DashboardRange) {
  return range === '7d' ? t('近 7 天') : range === '30d' ? t('近 30 天') : t('全部时间');
}

// The hint under a figure that has a previous period: "all" has nothing before it.
export function previousNote(range: DashboardRange, previous: number | string | null) {
  if (range === 'all') return t('全部累计');
  return t('上 {range} {value}', { range: range === '7d' ? t('7 天') : t('30 天'), value: previous ?? NONE });
}

const capital = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);
const CLAUDE = /^claude-([a-z]+)-(\d+)-(\d+)$/, GPT = /^gpt-[\d.]+-([a-z]+)$/;

// "claude-opus-5-5" is Opus, "gpt-6.1-sol" is Sol; an id in neither shape stands for itself.
export function modelShort(model: string) {
  const name = CLAUDE.exec(model)?.[1] ?? GPT.exec(model)?.[1];
  return name ? capital(name) : model;
}

export function modelLabel(model: string) {
  const claude = CLAUDE.exec(model);
  if (claude) return `${capital(claude[1])} ${claude[2]}.${claude[3]}`;
  return GPT.test(model) ? `${modelShort(model)} · ${model}` : model;
}

export function kindLabel(kind: string) {
  const known: Record<string, string> = {
    core: t('复杂代码'), frontend: t('前端'), test: t('测试'), 'ui-check': t('界面验收'), docs: t('文档'),
    small: t('小任务'), review: t('审查'), investigate: t('调查'), roundtable: t('圆桌'),
  };
  return known[kind] ?? kind;
}

export function categoryLabel(category: DashboardFindingCategory) {
  return { correctness: t('正确性'), security: t('安全'), performance: t('性能'), boundary: t('边界/规范'), ui: t('界面') }[category];
}

export function leadNote(lead: 'missed' | 'copied' | null) {
  return lead === 'missed' ? t('主编排漏检') : lead === 'copied' ? t('主编排照做') : '';
}

const pad = (value: number) => String(value).padStart(2, '0');
// yyyy-mm-dd (a local day) as mm-dd.
export const dayLabel = (day: string) => day.slice(5);
export const dateLabel = (at: number) => { const date = new Date(at); return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`; };
export const timeLabel = (at: number) => { const date = new Date(at); return `${pad(date.getHours())}:${pad(date.getMinutes())}`; };

// "测试 1.0 → 0.7 ↓ 降权": the arrow and the word say it without colour.
export function weightChange(weight: DashboardWeight) {
  const move = weight.to < weight.from ? ` ↓ ${t('降权')}` : weight.to > weight.from ? ` ↑ ${t('升权')}` : '';
  return `${kindLabel(weight.kind)} ${weight.from.toFixed(1)} → ${weight.to.toFixed(1)}${move}`;
}

// The weights the owner adopted for one model, or its default.
export const modelWeights = (weights: DashboardWeight[], model: string) => weights.filter(weight => weight.model === model);

export const costValue = (row: Pick<DashboardModelRow, 'costUsd'>) => row.costUsd === null ? NONE : `≈ $${row.costUsd >= 100 ? row.costUsd.toFixed(0) : row.costUsd.toFixed(2)}`;
export const costCoverage = (row: DashboardModelRow) => row.costedRuns === 0 ? t('没有价格') : t('{total} 次中 {priced} 次有价格', { total: row.runs, priced: row.costedRuns });

export function quotaNote(quota: DashboardKpis['quota']) {
  return quota ? t('{provider} · {window}额度窗口', { provider: providerName(quota.provider), window: windowLength(quota.minutes) }) : t('没有额度记录');
}

// A fresh profile has no records at all: the page says so instead of showing a wall of dashes.
export const hasNoRecords = (summary: { kpis: DashboardKpis; models: unknown[]; rounds: unknown[]; incidents: unknown[]; suggestions: unknown[] }) =>
  summary.kpis.runs === 0 && !summary.models.length && !summary.rounds.length && !summary.incidents.length && !summary.suggestions.length;
