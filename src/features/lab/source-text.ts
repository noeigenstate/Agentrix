// What the page calls each source, lane state and metric. Pure words: the numbers themselves come from the contract and the math modules.
import type { LabLane, LabMetric, LabSource } from '../../shared/lab-types';
import { t } from '../../shared/i18n';
import type { Missing } from './wizard-math';

export const SOURCE_NAMES: Record<LabSource, () => string> = { history: () => t('本项目的历史改动'), oss: () => t('知名开源项目'), aa: () => t('AA 同款') };
export const SOURCE_BLURBS: Record<LabSource, () => string> = {
  history: () => t('从项目自己的提交历史里挑带测试的改动，用当时的测试来评分。'),
  oss: () => t('从著名的 GitHub 项目里各摘取几个代表性问题。'),
  aa: () => t('Artificial Analysis 的公开基准，可以和他们公布的分数对照。'),
};
export const LANE_STATES: Record<LabLane['state'], () => string> = { queued: () => t('排队'), running: () => t('运行中'), done: () => t('已完成'), stopped: () => t('已停止'), error: () => t('出错') };

// Each metric says what a pass and a cell mean; the two scored metrics read alike in the figures. The first set is exactly the wording the history lane has always had.
const SCORED = {
  cells: () => t('得分；打勾 = 多数次重复通过'), cellsLabel: () => t('每个任务在每种方案下的得分'),
  axis: () => t('点 = 各次重复的均值，横线 = 标准差；没有横线的点，各次结果相同或只重复了 1 次。横轴是得分（0–100）'),
};
export const METRIC_WORDS: Record<LabMetric, { rule: () => string; cells: () => string; cellsLabel: () => string; axis: () => string }> = {
  'hidden-tests': {
    rule: () => t('通过 = 隐藏测试全部通过'), cells: () => t('隐藏测试通过数；打勾 = 多数次重复全部通过'), cellsLabel: () => t('每个任务在每种方案下的隐藏测试结果'),
    axis: () => t('点 = 各次重复的均值，横线 = 标准差；没有横线的点，各次结果相同或只重复了 1 次。横轴是隐藏测试的通过率（0–100）'),
  },
  resolved: { rule: () => t('通过 = 已解决：指定的失败测试转为通过，原有测试也都不坏'), ...SCORED },
  tests: { rule: () => t('通过 = 任务自带的测试全部通过'), ...SCORED },
};

// A name for an experiment started without one: the project when only history runs, otherwise the sources.
export const nameScope = (sources: LabSource[], projectName: string) => sources.length === 1 && sources[0] === 'history' ? projectName : sources.map(source => SOURCE_NAMES[source]()).join(' + ');

// What the form still needs, said for the source that lacks it (named when several are chosen, so the owner knows which panel).
const LACKS = {
  scope: { history: () => t('先选一个项目。'), oss: () => t('先选至少一个开源仓库。'), aa: () => t('先选一个基准。') },
  tasks: { history: () => t('这个项目还没有可用的任务。'), oss: () => t('所选仓库还没有可用的任务。'), aa: () => t('这个基准还没有可用的任务。') },
};
export function lackText(lack: NonNullable<Missing>, several: boolean) {
  const { need, source } = lack;
  if (need === 'sources') return t('先选至少一个任务来源。');
  if (need === 'arms') return t('至少选 2 个方案做对比。');
  if (need === 'budget') return t('填一个大于 0 的预算。');
  const text = LACKS[need][source!]();
  return several ? t('{source}：{message}', { source: SOURCE_NAMES[source!](), message: text }) : text;
}
