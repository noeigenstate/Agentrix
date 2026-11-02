// Runs per day, stacked by model: one column per local day of the selected range, a 2px gap between the segments of a column.
import type { DashboardDailyPoint } from '../../shared/dashboard-types';
import { t } from '../../shared/i18n';
import { DataToggle, Legend, Marker, useTip, useWidth } from './Charts';
import { niceMax, nearest, runsByDay, yScale } from './chart-math';
import { dayLabel, modelShort } from './format';
import { useModels } from './model-look';
import { Empty } from './Panel';
import { ScrollRegion } from './ScrollRegion';

const HEIGHT = 260, LEFT = 32, RIGHT = 4, TOP = 8, BOTTOM = 28, PLOT = HEIGHT - TOP - BOTTOM;

export function DailyBars({ daily, models }: { daily: DashboardDailyPoint[]; models: string[] }) {
  const [ref, width] = useWidth<SVGSVGElement>(), tip = useTip(), { of } = useModels();
  const days = runsByDay(daily), drawn = models.filter(model => days.some(day => day.runs[model]));
  if (!days.some(day => day.total)) return <Empty>{t('这段时间没有子任务')}</Empty>;

  const max = niceMax(Math.max(...days.map(day => day.total))), y = yScale(max, TOP, PLOT), slot = (width - LEFT - RIGHT) / days.length, bar = Math.max(1, Math.floor(slot - 4));
  const centres = days.map((_, index) => LEFT + slot * (index + 0.5)), every = Math.max(1, Math.ceil(days.length / 6));
  return <>
    <Legend models={drawn} />
    <svg ref={ref} className="chart" viewBox={`0 0 ${width} ${HEIGHT}`} height={HEIGHT} role="img" aria-label={t('每天子任务，数据见下方数据表')} onPointerLeave={tip.hide}
      onPointerMove={event => {
        const day = days[nearest(centres, event.clientX - (ref.current?.getBoundingClientRect().left ?? 0))];
        tip.show(event, `${dayLabel(day.day)} · ${t('合计')} ${t('{count} 次', { count: day.total })} · ${drawn.filter(model => day.runs[model]).map(model => `${modelShort(model)} ${day.runs[model]}`).join(' · ')}`);
      }}>
      {[0, max / 2, max].map(value => <g key={value}><line className="grid" x1={LEFT} x2={width - RIGHT} y1={y(value)} y2={y(value)} /><text x={0} y={y(value) + 4}>{Math.round(value)}</text></g>)}
      {days.map((day, index) => {
        let base = 0;
        return <g key={day.day}>
          {drawn.map(model => {
            const value = day.runs[model];
            if (!value) return null;
            const top = y(base + value), bottom = y(base), style = of(model);
            base += value;
            return <rect key={model} className={`seg ${style.dim}`} x={Math.round(centres[index] - bar / 2)} y={top} width={bar} height={Math.max(1, bottom - top - 2)} rx="2" fill={style.colour} />;
          })}
          {index % every === 0 && <text x={centres[index]} y={HEIGHT - 8} textAnchor={index === 0 ? 'start' : 'middle'}>{dayLabel(day.day)}</text>}
        </g>;
      })}
    </svg>
    {tip.node}
    <DataToggle>
      <ScrollRegion tall label={t('每天子任务数据表：每天每个模型的次数，可上下滚动')}>
        <table className="narrow">
          <thead><tr><th>{t('日期（新到旧）')}</th>{drawn.map(model => <th key={model} className="num"><span className="who"><Marker model={model} />{modelShort(model)}</span></th>)}</tr></thead>
          <tbody>{[...days].reverse().map(day => <tr key={day.day}><td>{dayLabel(day.day)}</td>{drawn.map(model => <td key={model} className={day.runs[model] ? 'num' : 'num muted'}>{day.runs[model] ?? 0}</td>)}</tr>)}</tbody>
        </table>
      </ScrollRegion>
    </DataToggle>
  </>;
}
