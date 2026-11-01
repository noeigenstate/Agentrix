// Figure b: quality against cost, one marker per approach. The cost of an approach with an unpriced run is not drawn: a partial sum would pass for a measured one.
import type { LabExperiment } from '../../shared/lab-types';
import { t } from '../../shared/i18n';
import { linear, niceScale, shapePath } from './chart-math';
import { armName, money, percent } from './format';
import { armSummary, ranArms, SHAPES } from './results-math';
import { Legend, Panel } from './Marks';

const W = 560, H = 320, L = 56, R = 24, T = 16, B = 48, LABEL_GAP = 16;

export function Scatter({ experiment }: { experiment: LabExperiment }) {
  const rows = ranArms(experiment).map(arm => ({ arm, ...armSummary(experiment, arm) }));
  const drawn = rows.filter(row => row.costUsd !== null && row.unpriced === 0 && row.rate !== null), hidden = rows.filter(row => !drawn.includes(row));
  const axis = niceScale(Math.max(0, ...drawn.map(row => row.costUsd!)), 4);
  const x = linear([0, axis.max], [L, W - R]), y = linear([0, 1], [H - B, T]);
  // Labels sit above their marker; one that would cover an earlier label moves down a line.
  const placed: { x: number; y: number }[] = [];
  const labels = drawn.map(row => {
    const px = x(row.costUsd!), at = { x: px, y: y(row.rate!) - 14 };
    while (placed.some(other => Math.abs(other.x - at.x) < 150 && Math.abs(other.y - at.y) < LABEL_GAP)) at.y += LABEL_GAP;
    placed.push(at);
    return { row, px, ...at, end: px > W - 180 };
  });
  return <Panel title={t('质量 × 成本')} hint={t('越靠左上越好：花得少，通过得多')}>
    <Legend arms={rows.map(row => row.arm)} />
    {drawn.length > 0 && <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t('质量与成本的散点图')}>
      {[0, 0.25, 0.5, 0.75, 1].map(tick => <g key={tick}><line className="grid" x1={L} x2={W - R} y1={y(tick)} y2={y(tick)} /><text x={L - 8} y={y(tick) + 4} textAnchor="end">{tick * 100}%</text></g>)}
      {axis.ticks.map(tick => <g key={tick}><line className="grid" x1={x(tick)} x2={x(tick)} y1={T} y2={H - B} /><text x={x(tick)} y={H - B + 18} textAnchor="middle">{money(tick)}</text></g>)}
      <text x={(L + W - R) / 2} y={H - 8} textAnchor="middle">{t('成本（美元）')}</text>
      <text transform={`translate(14 ${(T + H - B) / 2}) rotate(-90)`} textAnchor="middle">{t('任务通过率')}</text>
      {labels.map(({ row, px, y: ly, end }) => <g key={row.arm} className={`arm-${row.arm}`}>
        <title>{`${armName(row.arm, true)} · ${money(row.costUsd)} · ${percent(row.rate)}`}</title>
        <path className="dot" d={shapePath(SHAPES[row.arm], px, y(row.rate!), 8)} />
        <text className="end" x={end ? px - 4 : px + 4} y={ly} textAnchor={end ? 'end' : 'start'}>{`${armName(row.arm)} (${money(row.costUsd)}, ${percent(row.rate)})`}</text>
      </g>)}
    </svg>}
    {hidden.length > 0 && <p className="note">{t('{names}：成本不完整，没有画出来。', { names: hidden.map(row => armName(row.arm)).join('、') })}</p>}
  </Panel>;
}
