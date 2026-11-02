// Each model's share of the runs in the range: a ring of arcs and, beside it, the same numbers in words.
import type { DashboardModelRow } from '../../shared/dashboard-types';
import { t } from '../../shared/i18n';
import { Marker } from './Charts';
import { modelLabel, modelShort, percent } from './format';
import { useModels } from './model-look';
import { Empty } from './Panel';

const SIZE = 144, MID = SIZE / 2, RADIUS = 56, WIDTH = 24, ROUND = 2 * Math.PI * RADIUS;

export function ShareDonut({ models }: { models: DashboardModelRow[] }) {
  const { of } = useModels(), rows = models.filter(row => row.runs > 0).sort((a, b) => b.runs - a.runs), total = rows.reduce((sum, row) => sum + row.runs, 0);
  if (!total) return <Empty>{t('这段时间没有子任务')}</Empty>;
  let offset = 0;
  return <div className="donut">
    <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label={t('各模型子任务占比')}>
      {rows.map(row => {
        const length = row.runs / total * ROUND, style = of(row.model), start = offset;
        offset += length;
        // A 2px gap between arcs, none for a ring of one.
        return <circle key={row.model} className={style.dim} cx={MID} cy={MID} r={RADIUS} fill="none" stroke={style.colour} strokeWidth={WIDTH} transform={`rotate(-90 ${MID} ${MID})`}
          strokeDasharray={`${length - (rows.length > 1 ? 2 : 0)} ${ROUND - length + (rows.length > 1 ? 2 : 0)}`} strokeDashoffset={-start}>
          <title>{`${modelLabel(row.model)} · ${t('{count} 次', { count: row.runs })} · ${percent(row.runs / total)}`}</title>
        </circle>;
      })}
      <text className="centre" x={MID} y={MID + 2} textAnchor="middle">{total}</text>
      <text x={MID} y={MID + 18} textAnchor="middle">{t('子任务')}</text>
    </svg>
    <ul className="share-list">{rows.map(row => <li key={row.model} className={of(row.model).dim}>
      <span className="who"><Marker model={row.model} />{modelShort(row.model)}</span><span className="muted">{row.runs} · {percent(row.runs / total)}</span>
    </li>)}</ul>
  </div>;
}
