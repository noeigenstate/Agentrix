// The pass rate over time: one line per model in its colour and mark, a point for each day (or week) the model had tasks; a bucket
// without tasks breaks the line. Each line's last value is written in a gutter right of the plot, so a label never sits on the lines.
import { useState } from 'react';
import type { DashboardTrend } from '../../shared/dashboard-types';
import { t } from '../../shared/i18n';
import { DataToggle, Legend, MarkShape, Marker, useTip, useWidth } from './Charts';
import { markerEvery, nearest, runs, spreadLabels, trendSeries, type TrendCell, yScale } from './chart-math';
import { dayLabel, modelTitle, NONE, percent } from './format';
import { useModels } from './model-look';
import { ScrollRegion } from './ScrollRegion';

const HEIGHT = 220, LEFT = 40, RIGHT = 136, TOP = 16, BOTTOM = 28, PLOT = HEIGHT - TOP - BOTTOM, LABEL_GAP = 14, MARK = 5, GUTTER = 16, NAME_MAX = 12;
const clip = (name: string) => name.length > NAME_MAX ? `${name.slice(0, NAME_MAX - 1)}…` : name;
const cellText = (cell: TrendCell) => cell ? t('{rate} · {count} 次任务', { rate: percent(cell.passRate), count: cell.tasks }) : NONE;

export function TrendChart({ trend, models }: { trend: DashboardTrend; models: string[] }) {
  const [ref, width] = useWidth<SVGSVGElement>(), tip = useTip(), [hover, setHover] = useState<number | null>(null), { of } = useModels();
  const series = trendSeries(trend, models), { buckets } = trend;
  const plot = width - LEFT - RIGHT, step = buckets.length > 1 ? plot / (buckets.length - 1) : 0;
  const xs = buckets.map((_, index) => buckets.length > 1 ? LEFT + step * index : LEFT + plot / 2);
  const y = yScale(1, TOP, PLOT), values = series.map(({ cells }) => cells.map(cell => cell?.passRate ?? null));
  const ends = values.map(list => list.reduce<number>((last, value, index) => value === null ? last : index, -1));
  const labelY = spreadLabels(ends.map((end, row) => y(values[row][end]!) + 4), LABEL_GAP, TOP + 8, TOP + PLOT + 4);
  const every = markerEvery(buckets.length), axis = [...new Set([0, Math.floor((buckets.length - 1) / 2), buckets.length - 1])];
  const say = (at: number) => `${dayLabel(buckets[at])} · ${series.map((line, row) => `${modelTitle(line.model)} ${cellText(series[row].cells[at])}`).join(' · ')}`;
  return <>
    <Legend models={series.map(line => line.model)} />
    <svg ref={ref} className="chart" viewBox={`0 0 ${width} ${HEIGHT}`} height={HEIGHT} role="img" aria-label={t('每个模型的测试通过率走势，数据见下方数据表')}
      onPointerLeave={() => { tip.hide(); setHover(null); }}>
      {[0, 0.5, 1].map(value => <g key={value}><line className="grid" x1={LEFT} x2={width - RIGHT} y1={y(value)} y2={y(value)} /><text x={0} y={y(value) + 4}>{percent(value)}</text></g>)}
      {axis.map(index => <text key={index} x={xs[index]} y={HEIGHT - 8} textAnchor={index === 0 ? 'start' : index === buckets.length - 1 ? 'end' : 'middle'}>{dayLabel(buckets[index])}</text>)}
      {series.map((line, row) => {
        const style = of(line.model), end = ends[row];
        return <g key={line.model} stroke={style.colour} fill={style.colour}>
          {runs(values[row]).map(run => run.length > 1 && <polyline key={run[0]} className="line" points={run.map(index => `${xs[index]},${y(values[row][index]!)}`).join(' ')} />)}
          {values[row].map((value, index) => value !== null && (index % every === 0 || index === end) &&
            <g key={index} className="marker"><MarkShape shape={style.look.shape} cx={xs[index]} cy={y(value)} r={MARK} /></g>)}
          <text className="end" stroke="none" x={width - RIGHT + GUTTER} y={labelY[row]}>{clip(modelTitle(line.model))} {percent(values[row][end])}</text>
        </g>;
      })}
      {hover !== null && <line className="cross" x1={xs[hover] + 0.5} x2={xs[hover] + 0.5} y1={TOP} y2={TOP + PLOT} />}
      <rect className="hit" x={LEFT - 4} y={TOP} width={Math.max(0, plot + 8)} height={PLOT}
        onPointerMove={event => { const at = nearest(xs, event.clientX - (ref.current?.getBoundingClientRect().left ?? 0)); setHover(at); tip.show(event, say(at)); }} />
    </svg>
    {tip.node}
    <DataToggle>
      <ScrollRegion tall label={t('走势数据表：每个时段每个模型的通过率和任务数，可上下滚动')}>
        <table className="narrow">
          <thead><tr><th>{trend.unit === 'week' ? t('周（新到旧）') : t('日期（新到旧）')}</th>
            {series.map(line => <th key={line.model} className="num"><span className="who"><Marker model={line.model} />{modelTitle(line.model)}</span></th>)}</tr></thead>
          <tbody>{buckets.map((bucket, at) => ({ bucket, at })).reverse().map(({ bucket, at }) => <tr key={bucket}><td>{dayLabel(bucket)}</td>
            {series.map(line => <td key={line.model} className={line.cells[at] ? 'num' : 'num muted'}>{cellText(line.cells[at])}</td>)}</tr>)}</tbody>
        </table>
      </ScrollRegion>
    </DataToggle>
  </>;
}
