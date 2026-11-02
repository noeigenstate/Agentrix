// The two pages of the dashboard. Each has one hero figure (48px) and plain ones; the model page opens with the key and the live strip.
import type { ReactNode } from 'react';
import type { DashboardSummary } from '../../shared/dashboard-types';
import { t } from '../../shared/i18n';
import { Marker } from './Charts';
import { CostSpeedChart } from './CostSpeedChart';
import { DailyBars } from './DailyBars';
import { FindingsTable } from './FindingsTable';
import { changeNote, decimal, modelShort, NONE, percent, previousNote, quotaNote, rangeName } from './format';
import { IncidentTable } from './IncidentTable';
import { KindChart } from './KindChart';
import { LiveStrip } from './LiveStrip';
import { ModelKey } from './ModelKey';
import { ModelTable } from './ModelTable';
import { useModels } from './model-look';
import { Panel } from './Panel';
import { RoundTable } from './RoundTable';
import { ShareDonut } from './ShareDonut';
import { SpeedChart } from './SpeedChart';
import { localDay, recentDays, runsByDay, summaryModels } from './chart-math';
import { SparkBars } from './Spark';
import { Suggestions } from './Suggestions';

type Decide = Parameters<typeof Suggestions>[0]['decide'];

function Kpi({ label, value, note, hero = false, children }: { label: string; value: string | number; note: string; hero?: boolean; children?: ReactNode }) {
  return <div className={hero ? 'kpi hero' : 'kpi'}><div className="label">{label}</div><div className="value">{value}</div><div className="delta">{note}</div>{children}</div>;
}

// The first-pass rate of each model, best first; a model without a measured rate has no bar and a dash.
function RateBars({ models }: { models: DashboardSummary['models'] }) {
  const { of } = useModels(), ordered = [...models].sort((a, b) => (b.firstPassRate ?? -1) - (a.firstPassRate ?? -1));
  return <div className="mini-bars" role="list" aria-label={t('各模型一次通过率')}>{ordered.map(row => <div key={row.model} role="listitem" className={of(row.model).dim}>
    <span className="who"><Marker model={row.model} />{modelShort(row.model)}</span>
    <i><b style={{ width: `${(row.firstPassRate ?? 0) * 100}%`, background: of(row.model).colour }} /></i>
    <span>{row.firstPassRate === null ? NONE : Math.round(row.firstPassRate * 100)}</span>
  </div>)}</div>;
}

export function ModelsTab({ summary, now, onFocus }: { summary: DashboardSummary; now: number; onFocus(model: string | null): void }) {
  const { kpis, query, models } = summary, range = rangeName(query.range), ids = [...new Set(summaryModels(summary))];
  const days = recentDays(summary.generatedAt, 14), incidentDays = days.map(day => summary.incidents.filter(incident => localDay(incident.at) === day).length);
  return <div className="content">
    <ModelKey models={models} onFocus={onFocus} />
    <LiveStrip live={summary.live} projectId={query.projectId} now={now} />
    <div className="kpis">
      <div className="kpi hero"><div className="label">{t('一次通过率')}</div>
        <div className="hero-split">
          <div><div className="value">{percent(kpis.firstPassRate)}</div><div className="delta">{t('审查和你都没退回')}</div>
            <SparkBars label={t('每天一次通过的子任务数')} layers={[{ model: null, values: runsByDay(summary.daily).map(day => day.passes) }]} /></div>
          <RateBars models={models} />
        </div>
      </div>
      <Kpi label={t('子任务')} value={kpis.runs} note={changeNote(query.range, kpis.runs, kpis.runsPrevious)}>
        <SparkBars label={t('近 14 天每天子任务')} layers={models.map(row => ({ model: row.model, values: row.trend }))} />
      </Kpi>
      <Kpi label={t('事故')} value={kpis.incidents} note={range}><SparkBars label={t('近 14 天每天事故')} layers={[{ model: null, values: incidentDays }]} /></Kpi>
      <Kpi label={t('额度消耗')} value={kpis.quota ? `${Math.round(kpis.quota.percent)}%` : NONE} note={quotaNote(kpis.quota)}>
        {kpis.quota && <div className="meter" role="img" aria-label={t('额度已用 {percent}%', { percent: Math.round(kpis.quota.percent) })}><b style={{ width: `${Math.min(100, kpis.quota.percent)}%` }} /></div>}
      </Kpi>
    </div>
    <div className="two">
      <Panel title={t('成本与速度')} hint={t('每个点一个模型，面积表示子任务数')}><CostSpeedChart models={models} /></Panel>
      <Panel title={t('每天子任务')} hint={t('按模型叠加')}><DailyBars daily={summary.daily} models={ids} /></Panel>
    </div>
    <div className="two">
      <Panel title={t('一次通过率 · 任务类型 × 模型')} hint={t('%，颜色越深越高')}><KindChart kinds={summary.kinds} models={models} /></Panel>
      <Panel title={t('子任务份额')} hint={t('{range}内每个模型占多少', { range })}><ShareDonut models={models} /></Panel>
    </div>
    <Panel title={t('输出速度 · 每天')} hint={t('tok/s，按活跃时间算')}><SpeedChart speed={summary.speed} models={ids} /></Panel>
    <Panel title={t('模型对比')} hint={t('按 {range}', { range })}><ModelTable summary={summary} /></Panel>
    <Panel title={t('事故记录')} hint={t('CI 或发布失败、越界、返工；每条写清负主要责任的模型和改进')}><IncidentTable incidents={summary.incidents} /></Panel>
  </div>;
}

export function TeamTab({ summary, decide }: { summary: DashboardSummary; decide: Decide }) {
  const { kpis, query, models } = summary;
  return <div className="content">
    <div className="kpis">
      <Kpi hero label={t('返工 / 轮')} value={decimal(kpis.reworkPerRound)} note={previousNote(query.range, kpis.reworkPerRoundPrevious === null ? null : decimal(kpis.reworkPerRoundPrevious))}>
        <SparkBars label={t('每轮返工次数')} layers={[{ model: null, values: [...summary.rounds].reverse().map(round => round.rework) }]} />
      </Kpi>
      <Kpi label={t('轮次')} value={kpis.rounds} note={rangeName(query.range)} />
      <Kpi label={t('圆桌一次确认')} value={percent(kpis.roundtableFirstConfirm)} note={t('其余轮次的圆桌需要再确认')} />
      <Kpi label={t('审查发现 / 轮')} value={decimal(kpis.findingsPerRound)} note={t('修复率 {rate}', { rate: percent(kpis.findingFixRate) })} />
    </div>
    <Panel title={t('每轮经过')} hint={t('各阶段用时的占比；返工是红色斜纹，旁边写明返工占比')}><RoundTable rounds={summary.rounds} showProject={query.projectId === null} /></Panel>
    <div className="two">
      <Panel title={t('审查发现 · 作者 × 类别')} hint={t('次数，颜色越深越多')}><FindingsTable findings={summary.findings} models={models} /></Panel>
      <Panel title={t('改进建议')} hint={t('由数据生成，你采纳后才生效')}><Suggestions suggestions={summary.suggestions} decide={decide} /></Panel>
    </div>
  </div>;
}
