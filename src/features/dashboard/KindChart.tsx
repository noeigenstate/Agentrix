// First-pass rate by task kind: grouped bars, one textured bar per model, the value above each bar.
import type { DashboardKindRate, DashboardModelRow } from '../../shared/dashboard-types';
import { t } from '../../shared/i18n';
import { barFill, DataToggle, Legend, Marker, useTip, useWidth } from './Charts';
import { chartSeries, kindGroups, modelsWithRate, shapeOf, yScale } from './chart-math';
import { kindLabel, modelShort, NONE, percent } from './format';
import { Empty } from './Panel';
import { ScrollRegion } from './ScrollRegion';

const HEIGHT = 180, LEFT = 40, RIGHT = 4, TOP = 20, BAR = 12, GAP = 4, CROWDED = 56;

export function KindChart({ kinds, models }: { kinds: DashboardKindRate[]; models: DashboardModelRow[] }) {
  const [ref, width] = useWidth<SVGSVGElement>(), tip = useTip();
  const groups = kindGroups(kinds), { series, all, hidden } = chartSeries(models, modelsWithRate(kinds));
  if (!groups.length || !series.length) return <Empty>{t('还没有按任务类型统计的一次通过率')}</Empty>;

  const slot = (BAR + GAP) * series.length - GAP, groupWidth = (width - LEFT - RIGHT) / groups.length;
  // Names that would collide lean over instead.
  const lean = groupWidth < CROWDED, bottom = lean ? 44 : 28, plotHeight = HEIGHT - TOP - bottom, y = yScale(100, TOP, plotHeight);
  const label = t('一次通过率按任务类型，数据见下方数据表');
  return <>
    <Legend series={series} kind="bar" hidden={hidden} />
    <svg ref={ref} className="chart" viewBox={`0 0 ${width} ${HEIGHT}`} role="img" aria-label={label} onPointerLeave={tip.hide}>
      {[0, 50, 100].map(value => <g key={value}><line className="grid" x1={LEFT} x2={width - RIGHT} y1={y(value)} y2={y(value)} /><text x={0} y={y(value) + 4}>{value}%</text></g>)}
      {groups.map((group, index) => {
        const center = LEFT + groupWidth * (index + 0.5);
        return <g key={group.kind}>
          {series.map(item => {
            const rate = group.rates[item.model]?.rate ?? null;
            if (rate === null) return null;
            const x = Math.round(center - slot / 2 + item.slot * (BAR + GAP)), height = Math.round(plotHeight * rate), top = TOP + plotHeight - height;
            return <g key={item.model} className={`s${item.slot}`}>
              <rect className="bar" x={x + 0.5} y={top + 0.5} width={BAR - 1} height={Math.max(0, height - 1)} fill={barFill(item.slot)} />
              <text className="value" x={x + BAR / 2} y={top - 4} textAnchor="middle">{Math.round(rate * 100)}</text>
              <rect className="hit" x={x - 2} y={TOP} width={BAR + 4} height={plotHeight} onPointerMove={event => tip.show(event, t('{kind} · {model}：{rate}（{count} 次）', { kind: kindLabel(group.kind), model: item.label, rate: percent(rate), count: group.rates[item.model].runs }))} />
            </g>;
          })}
          <text x={center} y={lean ? HEIGHT - 4 : HEIGHT - 8} textAnchor={lean ? 'end' : 'middle'} transform={lean ? `rotate(-30 ${center} ${HEIGHT - 4})` : undefined}>{kindLabel(group.kind)}</text>
        </g>;
      })}
    </svg>
    {tip.node}
    <DataToggle>
      <ScrollRegion label={t('一次通过率数据表，可横向滚动')}>
        <table className="narrow">
          <thead><tr><th>{t('任务类型')}</th>{all.map(model => <th key={model} className="num"><span className="who"><Marker shape={shapeOf(models, model)} />{modelShort(model)}</span></th>)}</tr></thead>
          <tbody>{groups.map(group => <tr key={group.kind}><td>{kindLabel(group.kind)}</td>{all.map(model => {
            const cell = group.rates[model];
            return <td key={model} className={cell?.rate == null ? 'num muted' : 'num'}>{cell?.rate == null ? NONE : `${percent(cell.rate)} · ${t('{count} 次', { count: cell.runs })}`}</td>;
          })}</tr>)}</tbody>
        </table>
      </ScrollRegion>
    </DataToggle>
  </>;
}
