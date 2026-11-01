// Figure e: where the time went in one orchestrated run (the median one): a block per phase as wide as the time it took, its name and time inside it,
// the count under it, and an evenly spaced time axis. Drawn as plain layout, not a scaled drawing, so its text is the app's own 12px.
import type { LabExperiment } from '../../shared/lab-types';
import { t } from '../../shared/i18n';
import { timeTicks } from './chart-math';
import { DASH, duration, phaseLabel } from './format';
import { phaseTotal, representativeRun } from './results-math';
import { Panel } from './Marks';

export function Flow({ experiment }: { experiment: LabExperiment }) {
  const run = representativeRun(experiment), phases = run?.phases ?? [];
  if (!run || !phases.length) return <Panel title={t('编排协作流程')} hint={t('代表任务')}><p className="note">{t('没有记录到编排运行的阶段时间。')}</p></Panel>;
  const total = phaseTotal(phases), task = experiment.tasks.find(item => item.id === run.taskId);
  const ticks = timeTicks(total);
  const count = (phase: typeof phases[number]) => phase.count === undefined ? '' : t('数量 {n}', { n: phase.count });
  return <Panel title={t('编排协作流程')} hint={t('代表任务：{title}；块宽 = 耗时，总计 {total}', { title: task?.title ?? DASH, total: duration(total) })}>
    <div className="flow arm-orchestrated" role="img" aria-label={t('编排运行各阶段的耗时')}>
      <div className="flow-row">{phases.map(phase => <div key={phase.name} className={`phase ${phase.name === 'rework' ? 'outline' : ''}`} style={{ flexGrow: phase.ms }}
        title={[phaseLabel(phase.name), duration(phase.ms), count(phase)].filter(Boolean).join(' · ')}>
        <span>{phaseLabel(phase.name)}</span><b>{duration(phase.ms)}</b>
      </div>)}</div>
      <div className="flow-row counts">{phases.map(phase => <span key={phase.name} className="muted" style={{ flexGrow: phase.ms }}>{count(phase)}</span>)}</div>
      <div className="flow-axis">{ticks.map(tick => <span key={tick} style={{ left: `${tick / total * 100}%` }}>{duration(tick)}</span>)}</div>
    </div>
  </Panel>;
}
