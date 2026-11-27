// How the dashboard writes its numbers and names. Pure functions, so the page and its tests agree on one wording.
import type { DashboardRange } from '../../shared/dashboard-types';
import { t } from '../../shared/i18n';
import { callModelName } from '../../shared/call-model-name';
import { modelName } from '../../shared/model-name';

export const NONE = '—';

export const percent = (ratio: number | null) => ratio === null ? NONE : `${Math.round(ratio * 100)}%`;

export function rangeName(range: DashboardRange) {
  return range === '7d' ? t('近 7 天') : range === '30d' ? t('近 30 天') : t('全部时间');
}

const capital = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);
const CLAUDE = /^claude-([a-z]+)-(\d+)-(\d+)$/, GPT = /^gpt-[\d.]+-([a-z]+)$/;
// The names Claude Code accepts for a model it resolves itself ("sonnet"): the same model as its full id.
export const ALIAS = /^(opus|sonnet|haiku|fable)$/i;

// A model's family word ("claude-opus-5-5" and "opus" are Opus, "gpt-6.1-sol" is Sol), which keeps its colour slot.
export function modelShort(model: string) {
  const name = CLAUDE.exec(model)?.[1] ?? GPT.exec(model)?.[1] ?? ALIAS.exec(model)?.[1];
  return name ? capital(name.toLowerCase()) : modelName(model);
}

// A model in words, the way the rest of Agentrix names it; a model the records do not name reads 模型未确认.
export function modelTitle(model: string) {
  const prefix = /^([a-z][\w-]*):unreported$/.exec(model)?.[1];
  return prefix ? `${prefix} · ${callModelName({ model: null })}` : callModelName({ model });
}

export function kindLabel(kind: string) {
  const known: Record<string, string> = {
    core: t('复杂代码'), frontend: t('前端'), test: t('测试'), 'ui-check': t('界面验收'), docs: t('文档'),
    small: t('小任务'), review: t('审查'), investigate: t('调查'), roundtable: t('圆桌'), unreported: t('未分类'),
  };
  return known[kind] ?? kind;
}

// A trend bucket (yyyy-mm-dd, its first local day) as mm-dd.
export const dayLabel = (day: string) => day.slice(5);
