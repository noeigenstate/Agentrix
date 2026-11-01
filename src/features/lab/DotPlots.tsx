// Figure a: one small plot per task kind. Each approach is a dot (the mean over the repeats) with a bar of one standard deviation, on a 0–100 axis.
import type { LabArm, LabExperiment } from '../../shared/lab-types';
import { t } from '../../shared/i18n';
import { barEnds, linear, shapePath } from './chart-math';
import { armName, DASH, kindLabel, percent } from './format';
import { kindScore, kindsOf, ranArms, SHAPES } from './results-math';
import { Legend, Panel, ScrollRegion } from './Marks';

const W = 260, ROW = 32, TOP = 32, LEFT = 72, RIGHT = 56, AXIS = 28, TICKS = [0, 0.5, 1];

function KindPlot({ experiment, kind }: { experiment: LabExperiment; kind: string }) {
  const arms = ranArms(experiment), x = linear([0, 1], [LEFT, W - RIGHT]), height = TOP + arms.length * ROW + AXIS;
  return <svg className="chart" viewBox={`0 0 ${W} ${height}`} role="img" aria-label={t('{kind}：各方案的得分', { kind: kindLabel(kind) })}>
    <text className="strong" x={0} y={14}>{kindLabel(kind)}</text>
    {TICKS.map(tick => <g key={tick}><line className="grid" x1={x(tick)} x2={x(tick)} y1={TOP - 4} y2={TOP + arms.length * ROW} /><text x={x(tick)} y={height - 8} textAnchor="middle">{tick * 100}</text></g>)}
    {arms.map((arm, index) => <Dot key={arm} arm={arm} score={kindScore(experiment, kind, arm)} x={x} y={TOP + index * ROW + ROW / 2} />)}
  </svg>;
}

function Dot({ arm, score, x, y }: { arm: LabArm; score: ReturnType<typeof kindScore>; x: (value: number) => number; y: number }) {
  const [low, high] = score ? barEnds(score.mean, score.sd) : [0, 0];
  const label = score ? `${Math.round(score.mean * 100)}${score.n === 1 ? ` · ${t('{n} 次重复', { n: 1 })}` : ''}` : DASH;
  return <g className={`arm-${arm}`}>
    <title>{score ? `${armName(arm, true)} · ${percent(score.mean)} ± ${Math.round(score.sd * 100)} (${t('{n} 次重复', { n: score.n })})` : `${armName(arm, true)} · ${DASH}`}</title>
    <text x={x(0) - 8} y={y + 4} textAnchor="end" className="row">{armName(arm)}</text>
    {score && score.n > 1 && <g className="bar"><line x1={x(low)} x2={x(high)} y1={y} y2={y} /><line x1={x(low)} x2={x(low)} y1={y - 4} y2={y + 4} /><line x1={x(high)} x2={x(high)} y1={y - 4} y2={y + 4} /></g>}
    {score && <path className="dot" d={shapePath(SHAPES[arm], x(score.mean), y, 6)} />}
    <text className="value" x={score ? x(high || score.mean) + 10 : x(0) + 8} y={y + 4}>{label}</text>
  </g>;
}

export function DotPlots({ experiment }: { experiment: LabExperiment }) {
  const arms = ranArms(experiment), kinds = kindsOf(experiment);
  return <Panel title={t('能力比较')} hint={experiment.repeats > 1 ? t('点 = 各次重复的均值，横线 = 标准差；横轴是隐藏测试的通过率（0–100）') : t('只重复了 1 次，所以只有点，没有误差线；横轴是隐藏测试的通过率（0–100）')}>
    <Legend arms={arms} />
    <div className="small-multiples">{kinds.map(kind => <KindPlot key={kind} experiment={experiment} kind={kind} />)}</div>
    <details className="data">
      <summary>{t('数据表')}</summary>
      <ScrollRegion label={t('各任务类别的得分表')}>
        <table className="wide"><thead><tr><th>{t('任务类别')}</th>{arms.map(arm => <th key={arm} className="num">{armName(arm)}</th>)}</tr></thead>
          <tbody>{kinds.map(kind => <tr key={kind}><td>{kindLabel(kind)}</td>{arms.map(arm => {
            const score = kindScore(experiment, kind, arm);
            return <td key={arm} className="num">{score ? `${Math.round(score.mean * 100)} ± ${Math.round(score.sd * 100)}` : DASH}</td>;
          })}</tr>)}</tbody></table>
      </ScrollRegion>
    </details>
  </Panel>;
}
