// Output speed per local day: one line per model (its own dash and mark), the last value written at the line's end.
import { useState } from 'react';
import type { DashboardModelRow, DashboardSpeedPoint } from '../../shared/dashboard-types';
import { t } from '../../shared/i18n';
import { DataToggle, Legend, MarkShape, Marker, useTip, useWidth } from './Charts';
import { chartSeries, DASHES, dayNumber, markerEvery, modelsWithSpeed, nearest, niceMax, runs, shapeOf, speedByDay, spreadLabels, yScale } from './chart-math';
import { dayLabel, modelShort, NONE } from './format';
import { Empty } from './Panel';
import { ScrollRegion } from './ScrollRegion';

const HEIGHT = 180, LEFT = 40, RIGHT = 96, TOP = 20, BOTTOM = 28, PLOT = HEIGHT - TOP - BOTTOM, LABEL_GAP = 14;

export function SpeedChart({ speed, models }: { speed: DashboardSpeedPoint[]; models: DashboardModelRow[] }) {
  const [ref, width] = useWidth<SVGSVGElement>(), tip = useTip(), [hover, setHover] = useState<number | null>(null);
  const days = speedByDay(speed), { series, all, hidden } = chartSeries(models, modelsWithSpeed(speed));
  if (!days.length || !series.length) return <Empty>{t('还没有带计时的回复，算不出输出速度')}</Empty>;

  const plot = width - LEFT - RIGHT, first = dayNumber(days[0].day), span = dayNumber(days[days.length - 1].day) - first;
  const xs = days.map(({ day }) => span ? LEFT + plot * (dayNumber(day) - first) / span : LEFT + plot / 2);
  const max = niceMax(Math.max(...speed.map(point => point.tokensPerSecond ?? 0))), y = yScale(max, TOP, PLOT);
  const values = series.map(item => days.map(({ values: day }) => day[item.model] ?? null));
  const ends = values.map(list => list.map((value, index) => ({ value, index })).filter(point => point.value !== null).at(-1)!);
  const labelY = spreadLabels(ends.map(end => y(end.value!) + 4), LABEL_GAP, TOP + 8, TOP + PLOT + 4);
  const every = markerEvery(days.length);
  const axisDays = [...new Set([0, Math.floor((days.length - 1) / 2), days.length - 1])];
  const label = t('每天输出速度，数据见下方数据表');
  return <>
    <Legend series={series} kind="line" hidden={hidden} />
    <svg ref={ref} className="chart" viewBox={`0 0 ${width} ${HEIGHT}`} role="img" aria-label={label} onPointerLeave={() => { tip.hide(); setHover(null); }}>
      {[0, max / 2, max].map(value => <g key={value}><line className="grid" x1={LEFT} x2={width - RIGHT} y1={y(value)} y2={y(value)} /><text x={0} y={y(value) + 4}>{Math.round(value)}</text></g>)}
      {axisDays.map(index => <text key={index} x={xs[index]} y={HEIGHT - 8} textAnchor={index === 0 ? 'start' : index === days.length - 1 ? 'end' : 'middle'}>{dayLabel(days[index].day)}</text>)}
      {series.map((item, row) => <g key={item.model} className={`s${item.slot}`}>
        {runs(values[row]).map(run => run.length > 1 && <polyline key={run[0]} className="line" strokeDasharray={DASHES[item.slot]} points={run.map(index => `${xs[index]},${y(values[row][index]!)}`).join(' ')} />)}
        {values[row].map((value, index) => value !== null && (index % every === 0 || index === ends[row].index) &&
          <g key={index} className="marker"><MarkShape shape={item.shape} cx={xs[index]} cy={y(value)} r={5} /></g>)}
        <text className="end" x={xs[ends[row].index] + 12} y={labelY[row]}>{item.label} {Math.round(ends[row].value!)}</text>
      </g>)}
      {hover !== null && xs[hover] !== undefined && <line className="cross" x1={xs[hover] + 0.5} x2={xs[hover] + 0.5} y1={TOP} y2={TOP + PLOT} />}
      <rect className="hit" x={LEFT - 4} y={TOP} width={plot + 8} height={PLOT}
        onPointerMove={event => { const at = nearest(xs, event.clientX - (ref.current?.getBoundingClientRect().left ?? 0)); setHover(at); tip.show(event, `${dayLabel(days[at].day)} · ${series.map((item, row) => `${item.label} ${values[row][at] === null ? NONE : Math.round(values[row][at]!)}`).join(' · ')}`); }} />
    </svg>
    {tip.node}
    <DataToggle>
      <ScrollRegion tall label={t('输出速度数据表：每天每个模型的值，可上下滚动')}>
        <table className="narrow">
          <thead><tr><th>{t('日期（新到旧）')}</th>{all.map(model => <th key={model} className="num"><span className="who"><Marker shape={shapeOf(models, model)} />{modelShort(model)}</span></th>)}</tr></thead>
          <tbody>{[...days].reverse().map(({ day, values: row }) => <tr key={day}><td>{dayLabel(day)}</td>{all.map(model => <td key={model} className={row[model] == null ? 'num muted' : 'num'}>{row[model] == null ? NONE : Math.round(row[model]!)}</td>)}</tr>)}</tbody>
        </table>
      </ScrollRegion>
    </DataToggle>
  </>;
}
