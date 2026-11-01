// Figure e: where the time went in one orchestrated run (the median one): a block per phase, as wide as the time it took, on a minutes axis.
import type { LabExperiment } from '../../shared/lab-types';
import { t } from '../../shared/i18n';
import { linear, niceScale } from './chart-math';
import { DASH, duration, phaseLabel } from './format';
import { phaseTotal, representativeRun } from './results-math';
import { Panel } from './Marks';

const W = 900, L = 16, R = 16, BAR_Y = 32, BAR_H = 32, MIN_LABEL = 72;

export function Flow({ experiment }: { experiment: LabExperiment }) {
  const run = representativeRun(experiment), phases = run?.phases ?? [];
  if (!run || !phases.length) return <Panel title={t('编排协作流程')} hint={t('代表任务')}><p className="note">{t('没有记录到编排运行的阶段时间。')}</p></Panel>;
  const total = phaseTotal(phases), task = experiment.tasks.find(item => item.id === run.taskId);
  const axis = niceScale(total / 60000, 5), x = linear([0, total], [L, W - R]);
  let at = 0;
  const blocks = phases.map(phase => { const start = at; at += phase.ms; return { phase, start, width: x(at) - x(start) }; });
  return <Panel title={t('编排协作流程')} hint={t('代表任务：{title}；块宽 = 耗时，总计 {total}', { title: task?.title ?? DASH, total: duration(total) })}>
    <svg className="chart flow arm-orchestrated" viewBox={`0 0 ${W} 100`} role="img" aria-label={t('编排运行各阶段的耗时')}>
      {blocks.map(({ phase, start, width }) => {
        const inside = width >= MIN_LABEL, outline = phase.name === 'rework';
        return <g key={phase.name + start}>
          <title>{`${phaseLabel(phase.name)} · ${duration(phase.ms)}${phase.count === undefined ? '' : ` · ${t('数量 {n}', { n: phase.count })}`}`}</title>
          <rect className={outline ? 'phase outline' : 'phase'} x={x(start) + 1} y={BAR_Y} width={Math.max(2, width - 2)} height={BAR_H} />
          <text className={outline ? 'phase-text out' : inside ? 'phase-text' : 'phase-text out'} x={x(start) + width / 2} y={inside ? BAR_Y + 21 : BAR_Y - 8} textAnchor="middle">{phaseLabel(phase.name)}</text>
        </g>;
      })}
      <line className="axis" x1={x(0)} x2={x(total)} y1={BAR_Y + BAR_H + 12} y2={BAR_Y + BAR_H + 12} />
      {axis.ticks.filter(tick => tick * 60000 <= total).map(tick => <g key={tick}><line className="axis" x1={x(tick * 60000)} x2={x(tick * 60000)} y1={BAR_Y + BAR_H + 12} y2={BAR_Y + BAR_H + 18} /><text x={x(tick * 60000)} y={BAR_Y + BAR_H + 34} textAnchor="middle">{duration(tick * 60000)}</text></g>)}
    </svg>
    <ul className="phase-list">{phases.map(phase => <li key={phase.name}><b>{phaseLabel(phase.name)}</b> {duration(phase.ms)}{phase.count !== undefined && <span className="muted"> · {t('数量 {n}', { n: phase.count })}</span>}</li>)}</ul>
  </Panel>;
}
