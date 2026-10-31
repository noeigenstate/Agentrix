// The two pages of the dashboard. Each has one hero figure (48px) and three plain ones.
import type { DashboardSummary } from '../../shared/dashboard-types';
import { t } from '../../shared/i18n';
import { FindingsTable } from './FindingsTable';
import { decimal, NONE, percent, previousNote, quotaNote, rangeName } from './format';
import { IncidentTable } from './IncidentTable';
import { KindChart } from './KindChart';
import { ModelTable } from './ModelTable';
import { Panel } from './Panel';
import { RoundTable } from './RoundTable';
import { SpeedChart } from './SpeedChart';
import { Suggestions } from './Suggestions';

type Decide = Parameters<typeof Suggestions>[0]['decide'];

function Kpi({ label, value, note, hero = false }: { label: string; value: string | number; note: string; hero?: boolean }) {
  return <div className={hero ? 'kpi hero' : 'kpi'}><div className="label">{label}</div><div className="value">{value}</div><div className="delta">{note}</div></div>;
}

export function ModelsTab({ summary }: { summary: DashboardSummary }) {
  const { kpis, query, models } = summary, range = rangeName(query.range);
  return <div className="content">
    <div className="kpis">
      <Kpi hero label={t('一次通过率')} value={percent(kpis.firstPassRate)} note={t('审查和你都没退回')} />
      <Kpi label={t('子任务')} value={kpis.runs} note={previousNote(query.range, kpis.runsPrevious)} />
      <Kpi label={t('事故')} value={kpis.incidents} note={range} />
      <Kpi label={t('额度消耗')} value={kpis.quota ? `${Math.round(kpis.quota.percent)}%` : NONE} note={quotaNote(kpis.quota)} />
    </div>
    <Panel title={t('模型对比')} hint={t('按 {range}', { range })}><ModelTable summary={summary} /></Panel>
    <div className="two">
      <Panel title={t('一次通过率 · 按任务类型')} hint="%"><KindChart kinds={summary.kinds} models={models} /></Panel>
      <Panel title={t('输出速度 · 每天')} hint={t('tok/s，按活跃时间算')}><SpeedChart speed={summary.speed} models={models} /></Panel>
    </div>
    <Panel title={t('事故记录')} hint={t('CI 或发布失败、越界、返工；每条写清负主要责任的模型和改进')}><IncidentTable incidents={summary.incidents} models={models} /></Panel>
  </div>;
}

export function TeamTab({ summary, decide }: { summary: DashboardSummary; decide: Decide }) {
  const { kpis, query, models } = summary;
  return <div className="content">
    <div className="kpis">
      <Kpi hero label={t('返工 / 轮')} value={decimal(kpis.reworkPerRound)} note={previousNote(query.range, kpis.reworkPerRoundPrevious === null ? null : decimal(kpis.reworkPerRoundPrevious))} />
      <Kpi label={t('轮次')} value={kpis.rounds} note={rangeName(query.range)} />
      <Kpi label={t('圆桌一次确认')} value={percent(kpis.roundtableFirstConfirm)} note={t('其余轮次的圆桌需要再确认')} />
      <Kpi label={t('审查发现 / 轮')} value={decimal(kpis.findingsPerRound)} note={t('修复率 {rate}', { rate: percent(kpis.findingFixRate) })} />
    </div>
    <Panel title={t('每轮经过')} hint={t('各阶段用时的占比；返工用不同的灰度，旁边写明返工占比')}><RoundTable rounds={summary.rounds} showProject={query.projectId === null} /></Panel>
    <div className="two">
      <Panel title={t('审查发现 · 按作者和类别')}><FindingsTable findings={summary.findings} models={models} /></Panel>
      <Panel title={t('改进建议')} hint={t('由数据生成，你采纳后才生效')}><Suggestions suggestions={summary.suggestions} decide={decide} /></Panel>
    </div>
  </div>;
}
