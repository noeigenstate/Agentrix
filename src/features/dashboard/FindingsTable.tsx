// Review findings by the author they were against and by category.
import type { DashboardFindingCategory, DashboardFindingCell, DashboardModelRow } from '../../shared/dashboard-types';
import { t } from '../../shared/i18n';
import { Marker } from './Charts';
import { shapeOf } from './chart-math';
import { categoryLabel, modelShort } from './format';
import { ScrollRegion } from './ScrollRegion';

const CATEGORIES: DashboardFindingCategory[] = ['correctness', 'security', 'performance', 'boundary', 'ui'];

export function FindingsTable({ findings, models }: { findings: DashboardFindingCell[]; models: DashboardModelRow[] }) {
  const totals = new Map<string, number>();
  for (const cell of findings) totals.set(cell.author, (totals.get(cell.author) ?? 0) + cell.count);
  const authors = [...totals.keys()].sort((a, b) => totals.get(b)! - totals.get(a)! || (a < b ? -1 : 1));
  const cell = (author: string, category: DashboardFindingCategory) => findings.filter(item => item.author === author && item.category === category).reduce((sum, item) => sum + item.count, 0);
  // An author is a model when its short name matches one: it then wears that model's mark.
  const markOf = (author: string) => models.find(row => modelShort(row.model) === modelShort(author));
  return <ScrollRegion label={t('审查发现表，可横向滚动')}>
    <table className="narrow">
      <thead><tr><th>{t('作者')}</th>{CATEGORIES.map(category => <th key={category} className="num">{categoryLabel(category)}</th>)}</tr></thead>
      <tbody>
        {authors.length === 0 && <tr><td colSpan={CATEGORIES.length + 1} className="muted">{t('这段时间没有审查发现')}</td></tr>}
        {authors.map(author => {
          const model = markOf(author);
          return <tr key={author}><td><span className="who">{model && <Marker shape={shapeOf(models, model.model)} />}{modelShort(author)}</span></td>
            {CATEGORIES.map(category => <td key={category} className="num">{cell(author, category)}</td>)}</tr>;
        })}
      </tbody>
    </table>
  </ScrollRegion>;
}
