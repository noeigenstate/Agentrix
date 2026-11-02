// Review findings by the author they were against and by category, shaded by how many.
import type { DashboardFindingCategory, DashboardFindingCell, DashboardModelRow } from '../../shared/dashboard-types';
import { t } from '../../shared/i18n';
import { Marker } from './Charts';
import { countStep } from './chart-math';
import { categoryLabel, modelShort } from './format';
import { HeatTable } from './HeatTable';
import { Empty } from './Panel';

const CATEGORIES: DashboardFindingCategory[] = ['correctness', 'security', 'performance', 'boundary', 'ui'];

export function FindingsTable({ findings, models }: { findings: DashboardFindingCell[]; models: DashboardModelRow[] }) {
  const totals = new Map<string, number>();
  for (const cell of findings) totals.set(cell.author, (totals.get(cell.author) ?? 0) + cell.count);
  if (!totals.size) return <Empty>{t('这段时间没有审查发现')}</Empty>;
  const authors = [...totals.keys()].sort((a, b) => totals.get(b)! - totals.get(a)! || (a < b ? -1 : 1));
  const cell = (author: string, category: DashboardFindingCategory) => findings.filter(item => item.author === author && item.category === category).reduce((sum, item) => sum + item.count, 0);
  const max = Math.max(...authors.flatMap(author => CATEGORIES.map(category => cell(author, category))));
  // An author is a model when its short name matches one: it then wears that model's mark.
  const markOf = (author: string) => models.find(row => modelShort(row.model) === modelShort(author));
  return <HeatTable label={t('审查发现热力图，可横向滚动')} corner={t('作者')} totalHead={t('合计')} low="0" high={String(max)}
    columns={CATEGORIES.map(category => ({ key: category, head: categoryLabel(category) }))}
    rows={authors.map(author => {
      const model = markOf(author);
      return { key: author, head: <span className="who">{model && <Marker model={model.model} />}{modelShort(author)}</span>, total: t('{count} 条', { count: totals.get(author)! }),
        cells: CATEGORIES.map(category => { const count = cell(author, category); return { step: countStep(count, max), text: String(count), title: `${modelShort(author)} · ${categoryLabel(category)}：${t('{count} 条', { count })}` }; }) };
    })} />;
}
