// A table whose cells are shaded on the five-step slate ramp (more is further along it), each cell also saying its number: the
// shade is never the only way to read it. A missing record is a dash on a plain cell, not the lightest shade.
import type { ReactNode } from 'react';
import { t } from '../../shared/i18n';
import { NONE } from './format';
import { useModels } from './model-look';
import { ScrollRegion } from './ScrollRegion';

export type HeatCell = { step: number; text: string; title: string } | null;
export type HeatColumn = { key: string; head: ReactNode; model?: string };
export type HeatRow = { key: string; head: ReactNode; cells: HeatCell[]; total?: string };

export function HeatTable({ label, corner, columns, rows, totalHead, low, high }: {
  label: string; corner: string; columns: HeatColumn[]; rows: HeatRow[]; totalHead?: string; low: string; high: string;
}) {
  const { of } = useModels(), classes = (column: HeatColumn, ...names: string[]) => [...names, column.model ? of(column.model).dim : ''].filter(Boolean).join(' ');
  return <>
    <ScrollRegion label={label}>
      <table className="heat narrow">
        <thead><tr><th>{corner}</th>{columns.map(column => <th key={column.key} className={classes(column, 'num')}>{column.head}</th>)}{totalHead && <th className="num">{totalHead}</th>}</tr></thead>
        <tbody>{rows.map(row => <tr key={row.key}>
          <td>{row.head}</td>
          {row.cells.map((cell, index) => cell
            ? <td key={columns[index].key} className={classes(columns[index], 'cell', `step-${cell.step}`)} title={cell.title}>{cell.text}</td>
            : <td key={columns[index].key} className={classes(columns[index], 'cell', 'na')} title={t('没有记录')}>{NONE}</td>)}
          {totalHead && <td className="num muted">{row.total}</td>}
        </tr>)}</tbody>
      </table>
    </ScrollRegion>
    <div className="scale"><span>{low}</span><span className="ramp">{[1, 2, 3, 4, 5].map(step => <i key={step} className={`step-${step}`} />)}</span><span>{high}</span><span>· {t('无记录显示为 —')}</span></div>
  </>;
}
