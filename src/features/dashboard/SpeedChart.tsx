// Output speed per local day: one line per model in its colour and mark. The last value of each is written in a gutter right of the plot, tied to its line's end by a thin tail,
// so a label never sits among the marks and lines (every mark ends within MARK of the plot's right edge, every label starts GUTTER past it).
import { useState } from 'react';
import type { DashboardSpeedPoint } from '../../shared/dashboard-types';
import { t } from '../../shared/i18n';
import { DataToggle, Legend, MarkShape, Marker, useTip, useWidth } from './Charts';
import { dayNumber, markerEvery, modelsWithSpeed, nearest, niceMax, runs, speedByDay, spreadLabels, yScale } from './chart-math';
import { dayLabel, modelShort, NONE } from './format';
import { useModels } from './model-look';
import { Empty } from './Panel';
import { ScrollRegion } from './ScrollRegion';

const HEIGHT = 240, LEFT = 40, RIGHT = 120, TOP = 20, BOTTOM = 28, PLOT = HEIGHT - TOP - BOTTOM, LABEL_GAP = 14, MARK = 5, GUTTER = 24, NAME_MAX = 12;
const clip = (name: string) => name.length > NAME_MAX ? `${name.slice(0, NAME_MAX - 1)}…` : name;

export function SpeedChart({ speed, models }: { speed: DashboardSpeedPoint[]; models: string[] }) {
  const [ref, width] = useWidth<SVGSVGElement>(), tip = useTip(), [hover, setHover] = useState<number | null>(null), { of } = useModels();
  const days = speedByDay(speed), withSpeed = modelsWithSpeed(speed), drawn = models.filter(model => withSpeed.has(model));
  if (!days.length || !drawn.length) return <Empty>{t('还没有带计时的回复，算不出输出速度')}</Empty>;

  const plot = width - LEFT - RIGHT, first = dayNumber(days[0].day), span = dayNumber(days[days.length - 1].day) - first;
  const xs = days.map(({ day }) => span ? LEFT + plot * (dayNumber(day) - first) / span : LEFT + plot / 2);
  const max = niceMax(Math.max(...speed.map(point => point.tokensPerSecond ?? 0))), y = yScale(max, TOP, PLOT);
  const values = drawn.map(model => days.map(({ values: day }) => day[model] ?? null));
  const ends = values.map(list => list.map((value, index) => ({ value, index })).filter(point => point.value !== null).at(-1)!);
  const labelY = spreadLabels(ends.map(end => y(end.value!) + 4), LABEL_GAP, TOP + 8, TOP + PLOT + 4);
  // From just past the end mark, level to the gutter's edge, then to the label's middle.
  const tail = (row: number) => { const end = ends[row], edge = width - RIGHT + GUTTER; return [[xs[end.index] + MARK + 2, y(end.value!)], [edge - 10, y(end.value!)], [edge - 4, labelY[row] - 4]].map(point => point.join(',')).join(' '); };
  const every = markerEvery(days.length);
  const axisDays = [...new Set([0, Math.floor((days.length - 1) / 2), days.length - 1])];
  return <>
    <Legend models={drawn} />
    <svg ref={ref} className="chart" viewBox={`0 0 ${width} ${HEIGHT}`} height={HEIGHT} role="img" aria-label={t('每天输出速度，数据见下方数据表')} onPointerLeave={() => { tip.hide(); setHover(null); }}>
      {[0, max / 2, max].map(value => <g key={value}><line className="grid" x1={LEFT} x2={width - RIGHT} y1={y(value)} y2={y(value)} /><text x={0} y={y(value) + 4}>{Math.round(value)}</text></g>)}
      {axisDays.map(index => <text key={index} x={xs[index]} y={HEIGHT - 8} textAnchor={index === 0 ? 'start' : index === days.length - 1 ? 'end' : 'middle'}>{dayLabel(days[index].day)}</text>)}
      {drawn.map((model, row) => {
        const style = of(model);
        return <g key={model} className={style.dim} stroke={style.colour} fill={style.colour}>
          {runs(values[row]).map(run => run.length > 1 && <polyline key={run[0]} className="line" points={run.map(index => `${xs[index]},${y(values[row][index]!)}`).join(' ')} />)}
          {values[row].map((value, index) => value !== null && (index % every === 0 || index === ends[row].index) &&
            <g key={index} className="marker"><MarkShape shape={style.look.shape} cx={xs[index]} cy={y(value)} r={MARK} /></g>)}
          <polyline className="tail" points={tail(row)} />
          <text className="end" stroke="none" x={width - RIGHT + GUTTER} y={labelY[row]}>{clip(modelShort(model))} {Math.round(ends[row].value!)}</text>
        </g>;
      })}
      {hover !== null && xs[hover] !== undefined && <line className="cross" x1={xs[hover] + 0.5} x2={xs[hover] + 0.5} y1={TOP} y2={TOP + PLOT} />}
      <rect className="hit" x={LEFT - 4} y={TOP} width={plot + 8} height={PLOT}
        onPointerMove={event => { const at = nearest(xs, event.clientX - (ref.current?.getBoundingClientRect().left ?? 0)); setHover(at); tip.show(event, `${dayLabel(days[at].day)} · ${drawn.map((model, row) => `${modelShort(model)} ${values[row][at] === null ? NONE : Math.round(values[row][at]!)}`).join(' · ')}`); }} />
    </svg>
    {tip.node}
    <DataToggle>
      <ScrollRegion tall label={t('输出速度数据表：每天每个模型的值，可上下滚动')}>
        <table className="narrow">
          <thead><tr><th>{t('日期（新到旧）')}</th>{drawn.map(model => <th key={model} className="num"><span className="who"><Marker model={model} />{modelShort(model)}</span></th>)}</tr></thead>
          <tbody>{[...days].reverse().map(({ day, values: row }) => <tr key={day}><td>{dayLabel(day)}</td>{drawn.map(model => <td key={model} className={row[model] == null ? 'num muted' : 'num'}>{row[model] == null ? NONE : Math.round(row[model]!)}</td>)}</tr>)}</tbody>
        </table>
      </ScrollRegion>
    </DataToggle>
  </>;
}
