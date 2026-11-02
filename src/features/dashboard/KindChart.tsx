// First-pass rate by task kind and model as a shaded table: a row per kind, a column per model, the rate in each cell.
import type { DashboardKindRate, DashboardModelRow } from '../../shared/dashboard-types';
import { t } from '../../shared/i18n';
import { Marker } from './Charts';
import { kindGroups, rateLegendLow, rateStep } from './chart-math';
import { kindLabel, modelShort, percent } from './format';
import { HeatTable } from './HeatTable';
import { Empty } from './Panel';

export function KindChart({ kinds, models }: { kinds: DashboardKindRate[]; models: DashboardModelRow[] }) {
  const groups = kindGroups(kinds), present = new Set(kinds.map(row => row.model));
  const columns = [...new Set([...models.map(row => row.model), ...present])].filter(model => present.has(model));
  if (!groups.length || !columns.length) return <Empty>{t('还没有按任务类型统计的一次通过率')}</Empty>;
  return <HeatTable label={t('一次通过率热力图，可横向滚动')} corner={t('任务类型')} totalHead={t('样本')} low={rateLegendLow(kinds.flatMap(row => row.firstPassRate ?? []))} high="100%"
    columns={columns.map(model => ({ key: model, model, head: <span className="who"><Marker model={model} />{modelShort(model)}</span> }))}
    rows={groups.map(group => ({
      key: group.kind, head: kindLabel(group.kind), total: t('{count} 次', { count: Object.values(group.rates).reduce((sum, cell) => sum + cell.runs, 0) }),
      cells: columns.map(model => {
        const cell = group.rates[model];
        return cell?.rate == null ? null : { step: rateStep(cell.rate), text: String(Math.round(cell.rate * 100)),
          title: t('{kind} · {model}：{rate}（{count} 次）', { kind: kindLabel(group.kind), model: modelShort(model), rate: percent(cell.rate), count: cell.runs }) };
      }),
    }))} />;
}
