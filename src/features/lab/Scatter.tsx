// Figure b: quality against cost, one marker per approach, with the numbers in a small table beside it. The cost of an approach with an unpriced run is
// not drawn: a partial sum would pass for a measured one. The plot is drawn at the width it has, so its text is the app's own 12px.
import type { LabExperiment } from '../../shared/lab-types';
import { t } from '../../shared/i18n';
import { clamp, linear, niceScale, shapePath } from './chart-math';
import { armName, DASH, money, moneyTick, outOf, percent } from './format';
import { armSummary, ranArms, SHAPES } from './results-math';
import { ArmName, Legend, Panel, ScrollRegion } from './Marks';
import { useWidth } from './useWidth';

const L = 64, R = 24, T = 16, B = 56, TOP = 1.1;

export function Scatter({ experiment }: { experiment: LabExperiment }) {
  const [ref, width] = useWidth<HTMLDivElement>(560);
  const rows = ranArms(experiment).map(arm => ({ arm, ...armSummary(experiment, arm) }));
  const drawn = rows.filter(row => row.costUsd !== null && row.unpriced === 0 && row.rate !== null), hidden = rows.filter(row => !drawn.includes(row));
  const axis = niceScale(Math.max(0, ...drawn.map(row => row.costUsd!)), 4), height = Math.round(clamp(width * 0.55, 260, 380));
  // The pass rate runs to 110% so a marker at 100% is never cut at the top edge.
  const x = linear([0, axis.max], [L, width - R]), y = linear([0, TOP], [height - B, T]);
  return <Panel title={t('质量 × 成本')} hint={t('越靠左上越好：花得少，通过得多')}>
    <Legend arms={rows.map(row => row.arm)} />
    <div className="scatter">
      <div ref={ref} className="plot">
        {drawn.length > 0 && <svg className="chart" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={t('质量与成本的散点图')}>
          {[0, 0.25, 0.5, 0.75, 1].map(tick => <g key={tick}><line className="grid" x1={L} x2={width - R} y1={y(tick)} y2={y(tick)} /><text x={L - 8} y={y(tick) + 4} textAnchor="end">{tick * 100}%</text></g>)}
          {axis.ticks.map(tick => <g key={tick}><line className="grid" x1={x(tick)} x2={x(tick)} y1={T} y2={height - B} /><text x={x(tick)} y={height - B + 18} textAnchor="middle">{moneyTick(tick)}</text></g>)}
          <text x={(L + width - R) / 2} y={height - 8} textAnchor="middle">{t('成本（美元）')}</text>
          <text transform={`translate(12 ${(T + height - B) / 2}) rotate(-90)`} textAnchor="middle">{t('任务通过率')}</text>
          {drawn.map(row => <g key={row.arm} className={`arm-${row.arm}`}>
            <title>{`${armName(row.arm, true)} · ${money(row.costUsd)} · ${percent(row.rate)}`}</title>
            <path className="dot" d={shapePath(SHAPES[row.arm], x(row.costUsd!), y(row.rate!), 8)} />
          </g>)}
        </svg>}
      </div>
      <ScrollRegion label={t('各方案的成本与任务通过率')}>
        <table className="wide"><thead><tr><th>{t('方案')}</th><th className="num">{t('成本')}</th><th className="num">{t('任务通过率')}</th></tr></thead>
          <tbody>{rows.map(row => <tr key={row.arm}><td><ArmName arm={row.arm} /></td>
            <td className="num">{row.unpriced === 0 ? money(row.costUsd) : DASH}</td>
            <td className="num">{percent(row.rate)} <span className="muted">({outOf(row.tasksPassed, row.tasks)})</span></td></tr>)}</tbody></table>
      </ScrollRegion>
    </div>
    {hidden.length > 0 && <p className="note">{t('{names}：成本不完整，没有画出来。', { names: hidden.map(row => armName(row.arm)).join('、') })}</p>}
  </Panel>;
}
