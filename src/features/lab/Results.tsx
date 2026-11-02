// The results of an experiment: the one-line conclusion, a ring card per approach, then the figures (dots per task kind, quality against cost,
// the task × approach matrix and the orchestration flow). With several sources each gets its own section and a combined view comes first; an AA lane
// adds its accuracy and the published scores.
import type { LabExperiment } from '../../shared/lab-types';
import { t } from '../../shared/i18n';
import { AaSection } from './AaSection';
import { Combined } from './Combined';
import { DotPlots } from './DotPlots';
import { Flow } from './Flow';
import { armName, DASH, decimal, duration, friendlyError, money, outOf, percent, sentenceName } from './format';
import { Lanes } from './LaneSection';
import { Matrix } from './Matrix';
import { ArmMark, Ring } from './Marks';
import { armSummary, conclude, ranArms, type Conclusion } from './results-math';
import { Scatter } from './Scatter';

export function conclusionText(conclusion: Conclusion) {
  if (conclusion.kind === 'none') return t('还没有足够的结果可以比较。');
  if (conclusion.kind === 'tie') return t('{a}与 {b}在 {tasks} 个任务中都通过了 {passed} 个。', { a: sentenceName(conclusion.arms[0]), b: sentenceName(conclusion.arms[1]), tasks: conclusion.tasks, passed: conclusion.passed });
  const values = { leader: sentenceName(conclusion.leader), other: sentenceName(conclusion.other), tasks: conclusion.tasks, leaderPassed: conclusion.leaderPassed, otherPassed: conclusion.otherPassed };
  // The cost is said against a named approach: "its cost" alone would not say whose.
  return conclusion.costRatio === null ? t('{leader}在 {tasks} 个任务中通过 {leaderPassed} 个，{other}通过 {otherPassed} 个。', values)
    : t('{leader}在 {tasks} 个任务中通过 {leaderPassed} 个，{other}通过 {otherPassed} 个；成本为 {base} 的 {ratio} 倍。', { ...values, base: armName(conclusion.other), ratio: conclusion.costRatio.toFixed(1) });
}

function ArmCard({ experiment, arm }: { experiment: LabExperiment; arm: LabExperiment['arms'][number] }) {
  const s = armSummary(experiment, arm);
  return <section className={`arm-card arm-${arm}`} aria-label={armName(arm, true)}>
    <h3><ArmMark arm={arm} />{armName(arm, true)}</h3>
    <Ring share={s.rate} size={128} stroke={12}><b className="figure">{outOf(s.tasksPassed, s.tasks)}</b></Ring>
    <p className="muted ring-caption">{t('任务通过 {rate}', { rate: percent(s.rate) })}</p>
    <dl className="kpis">
      <div><dt>{t('评审问题')}</dt><dd>{decimal(s.reviewIssues)}</dd></div>
      <div><dt>{t('总耗时')}</dt><dd>{duration(s.ms)}</dd></div>
      <div><dt>{t('成本')}</dt><dd>{money(s.costUsd)}</dd>{s.unpriced > 0 && <small>{t('{n} 次运行未计价', { n: s.unpriced })}</small>}</div>
      <div><dt>{t('返工')}</dt><dd>{s.rework ?? DASH}</dd></div>
    </dl>
  </section>;
}

// The banner of an unfinished experiment, or of one source's part of it when several ran.
const BANNERS = {
  experiment: { error: (message: string) => t('实验出错：{message}', { message }), stopped: () => t('实验没有跑完：缺少的运行按未通过计算，成本只含已完成的运行。') },
  lane: { error: (message: string) => t('这个来源出错：{message}', { message }), stopped: () => t('这个来源没有跑完：缺少的运行按未通过计算，成本只含已完成的运行。') },
};

// The figures of one experiment, or of one source's slice of it. A single source draws exactly this; several draw one per source (LaneSection.tsx).
export function SourceResults({ experiment, lane = false }: { experiment: LabExperiment; lane?: boolean }) {
  const banners = lane ? BANNERS.lane : BANNERS.experiment, failed = experiment.lanes[0]?.error ?? experiment.runs.find(run => run.error)?.error;
  return <>
    {experiment.state !== 'done' && <p className="banner" role="status">{experiment.state === 'error' ? banners.error(failed ? friendlyError(failed) : DASH) : banners.stopped()}</p>}
    <p className="conclusion" role="status">{conclusionText(conclude(experiment))}</p>
    <div className="arm-cards">{ranArms(experiment).map(arm => <ArmCard key={arm} experiment={experiment} arm={arm} />)}</div>
    {experiment.lanes[0]?.source === 'aa' && <AaSection experiment={experiment} />}
    <DotPlots experiment={experiment} />
    <Scatter experiment={experiment} />
    <Matrix experiment={experiment} />
    <Flow experiment={experiment} />
  </>;
}

export function Results({ experiment }: { experiment: LabExperiment }) {
  if (experiment.lanes.length < 2) return <div className="content"><SourceResults experiment={experiment} /></div>;
  return <div className="content">
    <Combined experiment={experiment} />
    <Lanes experiment={experiment}>{slice => <SourceResults experiment={slice} lane />}</Lanes>
  </div>;
}
