// Model × task kind: a row per kind, a column per model in reliability order. Each cell says its pass rate and task count over a thin
// success bar; a small sample reads weaker, and a pair with no tasks is a plain dash.
import type { DashboardKindCell } from '../../shared/dashboard-types';
import { t } from '../../shared/i18n';
import { Marker } from './Charts';
import { kindRows } from './chart-math';
import { kindLabel, modelTitle, NONE, percent } from './format';
import { ScrollRegion } from './ScrollRegion';

function Cell({ cell }: { cell: DashboardKindCell | undefined }) {
  if (!cell) return <td className="num muted" title={t('没有任务')}>{NONE}</td>;
  return <td className={cell.small ? 'num kind-cell is-small' : 'num kind-cell'} title={cell.small ? t('样本少') : undefined}>
    <span className="kind-value"><b>{percent(cell.passRate)}</b><small>{t('{count} 次任务', { count: cell.tasks })}</small></span>
    <i className="kind-bar" aria-hidden="true"><b style={{ width: `${cell.passRate * 100}%` }} /></i>
  </td>;
}

export function KindTable({ kinds, models }: { kinds: DashboardKindCell[]; models: string[] }) {
  return <ScrollRegion label={t('模型与任务类型的通过率表，可横向滚动；任务类型列固定')}>
    <table className="sticky kinds">
      <thead><tr><th>{t('任务类型')}</th>{models.map(model => <th key={model} className="num"><span className="who"><Marker model={model} />{modelTitle(model)}</span></th>)}</tr></thead>
      <tbody>{kindRows(kinds).map(row => <tr key={row.kind}><td>{kindLabel(row.kind)}</td>{models.map(model => <Cell key={model} cell={row.cells[model]} />)}</tr>)}</tbody>
    </table>
  </ScrollRegion>;
}
