import type { DashboardModelRun } from '../../shared/dashboard-types';
import { t } from '../../shared/i18n';
import { costValue, count, dateLabel, duration, kindLabel, modelLabel, NONE, timeLabel } from './format';
import { ScrollRegion } from './ScrollRegion';

export function ModelTasks({ model, runs, onClose }: { model: string; runs: DashboardModelRun[]; onClose(): void }) {
  const columns = [t('任务'), t('时间'), t('项目'), t('任务类型'), t('用时'), t('输出 token'), t('成本'), t('结果')];
  return <section id="dashboard-model-tasks" className="model-tasks" aria-labelledby="dashboard-model-tasks-title">
    <div className="model-tasks-head">
      <h3 id="dashboard-model-tasks-title">{t('{model} 的任务', { model: modelLabel(model) })}</h3>
      <button type="button" className="button" onClick={onClose}>{t('收起任务列表')}</button>
    </div>
    <p className="note">{t('按当前筛选，最多显示最近 50 条任务')}</p>
    <ScrollRegion tall label={t('模型任务表，可横向滚动；任务列固定')}>
      <table className="sticky wide task-table">
        <thead><tr>{columns.map((name, index) => <th key={name} className={index >= 4 && index <= 6 ? 'num' : undefined}>{name}</th>)}</tr></thead>
        <tbody>
          {runs.length === 0 && <tr><td colSpan={columns.length} className="muted">{t('没有任务')}</td></tr>}
          {runs.map((run, index) => <tr key={index}>
            <td className="task-title">{run.title || NONE}</td>
            <td><time dateTime={new Date(run.at).toISOString()}>{new Date(run.at).getFullYear()}-{dateLabel(run.at)} {timeLabel(run.at)}</time></td>
            <td className="task-project">{run.project || NONE}</td>
            <td>{run.kind === null ? NONE : kindLabel(run.kind)}</td>
            <td className="num">{duration(run.activeMs)}</td>
            <td className="num">{count(run.outputTokens)}</td>
            <td className="num">{costValue(run)}</td>
            <td>{run.firstPass === null ? NONE : run.firstPass ? t('一次通过') : t('返工或退回')}</td>
          </tr>)}
        </tbody>
      </table>
    </ScrollRegion>
  </section>;
}
