// The model comparison: one row per model, the model column kept in view while the numbers scroll.
import { useRef, useState } from 'react';
import { CaretRight } from '@phosphor-icons/react';
import type { DashboardModelRow, DashboardSummary } from '../../shared/dashboard-types';
import { t } from '../../shared/i18n';
import { Marker } from './Charts';
import { shapeOf } from './chart-math';
import { costCoverage, costValue, count, decimal, duration, modelLabel, modelWeights, NONE, percent, speed, weightChange } from './format';
import { ScrollRegion } from './ScrollRegion';
import { ModelTasks } from './ModelTasks';

const quota = (row: DashboardModelRow) => row.quotaPercent === null ? NONE : `${Math.round(row.quotaPercent)}%`;

export function ModelTable({ summary }: { summary: DashboardSummary }) {
  const { models, weights, prices, modelRuns } = summary;
  const [opened, setOpened] = useState<string | null>(null), opener = useRef<HTMLButtonElement | null>(null);
  const expanded = models.find(row => row.model === opened)?.model ?? null;
  function close() { setOpened(null); opener.current?.focus(); }
  const columns = [t('模型'), t('任务'), t('一次通过'), t('平均用时'), t('输出速度'), t('审查问题/次'), t('你退回'), t('越界'), t('事故'), t('额度'), t('成本'), t('路由权重')];
  return <>
    <ScrollRegion label={t('模型对比表，可横向滚动；模型列固定')}>
      <table className="sticky wide">
        <thead><tr>{columns.map((name, index) => <th key={name} className={index > 0 && index < columns.length - 1 ? 'num' : undefined}>{name}</th>)}</tr></thead>
        <tbody>
          {models.length === 0 && <tr><td colSpan={columns.length} className="muted">{t('这段时间没有模型的记录')}</td></tr>}
          {models.map(row => {
            const own = modelWeights(weights, row.model);
            return <tr key={row.model} data-expanded={expanded === row.model}>
              <td><button type="button" className="button who model-toggle" title={modelLabel(row.model)} aria-expanded={expanded === row.model}
                aria-controls={expanded === row.model ? 'dashboard-model-tasks' : undefined}
                onClick={event => { opener.current = event.currentTarget; setOpened(expanded === row.model ? null : row.model); }}>
                <CaretRight className="model-caret" size={12} aria-hidden="true" />
                <Marker shape={shapeOf(models, row.model)} /><span className="model-name">{modelLabel(row.model)}</span>
              </button></td>
              <td className="num">{row.runs}</td>
              <td className="num">{percent(row.firstPassRate)}</td>
              <td className="num">{duration(row.avgActiveMs)}</td>
              <td className="num">{speed(row.tokensPerSecond)}</td>
              <td className="num">{decimal(row.findingsPerRun)}</td>
              <td className="num">{count(row.sentBack)}</td>
              <td className="num">{count(row.outOfScope)}</td>
              <td className="num">{count(row.incidents)}</td>
              <td className="num">{quota(row)}</td>
              <td className="num"><span>{costValue(row)}</span><small className="cost-note">{costCoverage(row)}</small></td>
              <td>{own.length ? own.map(weight => <span key={weight.kind} className="weight">{weightChange(weight)}</span>) : <span className="muted">{t('默认 1.0')}</span>}</td>
            </tr>;
          })}
        </tbody>
      </table>
    </ScrollRegion>
    <p className="note">
      {t('成本是按公开 API 价格估算的等价费用，价格更新于 {date}。', { date: prices.updated })}
      {prices.unpriced.length > 0 && ` ${t('没有价格的模型：{names}；它们不计入成本。', { names: prices.unpriced.map(modelLabel).join('、') })}`}
    </p>
    {expanded !== null && <ModelTasks model={expanded} runs={modelRuns.filter(run => run.model === expanded)} onClose={close} />}
  </>;
}
