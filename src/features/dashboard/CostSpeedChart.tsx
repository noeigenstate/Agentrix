// Cost against speed, one bubble per model, its area the number of runs: toward the top left is fast and cheap. A model whose
// records give no price or no speed has no place on the plot; it is named under the chart instead of drawn at zero.
import type { DashboardModelRow } from '../../shared/dashboard-types';
import { t } from '../../shared/i18n';
import { MarkShape, useTip, useWidth } from './Charts';
import { niceMax, spreadNearby } from './chart-math';
import { costValue, modelLabel, modelShort, percent, speed } from './format';
import { useModels } from './model-look';
import { Empty } from './Panel';

const HEIGHT = 260, LEFT = 48, RIGHT = 24, TOP = 16, BOTTOM = 40;
const perRun = (row: DashboardModelRow) => row.costUsd !== null && row.costedRuns > 0 ? row.costUsd / row.costedRuns : null;
// A label is about this wide, and a line of text this tall: points closer than the width have labels that meet and are spread apart.
const LABEL_REACH = 88, LABEL_GAP = 16;
const money = (value: number) => `$${value.toFixed(value >= 10 ? 0 : 2)}`;

export function CostSpeedChart({ models }: { models: DashboardModelRow[] }) {
  const [ref, width] = useWidth<SVGSVGElement>(), tip = useTip(), { of } = useModels();
  const drawn = models.filter(row => perRun(row) !== null && row.tokensPerSecond !== null), left = models.filter(row => !drawn.includes(row));
  if (!drawn.length) return <Empty>{t('还没有同时有价格和速度的模型')}</Empty>;

  const xMax = niceMax(Math.max(...drawn.map(row => perRun(row)!))), yMax = niceMax(Math.max(...drawn.map(row => row.tokensPerSecond!)));
  const x = (value: number) => LEFT + (width - LEFT - RIGHT) * value / xMax, y = (value: number) => TOP + (HEIGHT - TOP - BOTTOM) * (1 - value / yMax);
  const points = drawn.map(row => ({ row, cx: x(perRun(row)!), cy: y(row.tokensPerSecond!) }));
  const labelYs = spreadNearby(points.map(point => ({ x: point.cx, y: point.cy + 4 })), LABEL_REACH, LABEL_GAP, TOP + 8, HEIGHT - BOTTOM - 4);
  return <>
    <svg ref={ref} className="chart" viewBox={`0 0 ${width} ${HEIGHT}`} height={HEIGHT} role="img" aria-label={t('成本与速度散点图，数据见模型对比表')} onPointerLeave={tip.hide}>
      {[0, yMax / 2, yMax].map(value => <g key={value}><line className="grid" x1={LEFT} x2={width - RIGHT} y1={y(value)} y2={y(value)} /><text x={0} y={y(value) + 4}>{Math.round(value)}</text></g>)}
      {[0, xMax / 2, xMax].map(value => <text key={value} x={x(value)} y={HEIGHT - 20} textAnchor={value === 0 ? 'start' : value === xMax ? 'end' : 'middle'}>{money(value)}</text>)}
      <text x={(LEFT + width - RIGHT) / 2} y={HEIGHT - 2} textAnchor="middle">{t('每次成本（按公开价格估算）→ 越靠左越便宜')}</text>
      <text x={0} y={8}>tok/s ↑</text>
      {points.map(({ row, cx, cy }, index) => {
        const style = of(row.model), r = 5 + Math.sqrt(row.runs) * 0.7, right = cx + r + 72 < width - RIGHT, labelX = right ? cx + r + 8 : cx - r - 8, labelY = labelYs[index];
        return <g key={row.model} className={style.dim}>
          <g className="bubble" fill={style.colour}><MarkShape shape={style.look.shape} cx={cx} cy={cy} r={r} /></g>
          {/* A label pushed off its point is tied back to it by a thin line. */}
          {Math.abs(labelY - 4 - cy) > 2 && <line className="leader" x1={cx + (right ? r : -r)} y1={cy} x2={labelX + (right ? -2 : 2)} y2={labelY - 4} />}
          <text className="end" x={labelX} y={labelY} textAnchor={right ? 'start' : 'end'}>{modelShort(row.model)}</text>
          <rect className="hit" x={cx - 16} y={cy - 16} width={32} height={32}
            onPointerMove={event => tip.show(event, `${modelLabel(row.model)} · ${costValue({ costUsd: perRun(row) })} ·${speed(row.tokensPerSecond)} · ${t('{count} 次', { count: row.runs })} · ${percent(row.firstPassRate)}`)} />
        </g>;
      })}
    </svg>
    {tip.node}
    {left.length > 0 && <p className="note">{t('没有价格或速度的模型不画：{names}', { names: left.map(row => modelShort(row.model)).join('、') })}</p>}
  </>;
}
