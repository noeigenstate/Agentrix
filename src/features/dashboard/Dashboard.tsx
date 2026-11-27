// The dashboard window's page. It reads only through window.agentrixDashboard (electron/features/dashboard/preload.cjs) and answers one
// question: how reliably each model's tasks come back tested. Three charts, top to bottom, and two filters: project and time range.
import { useEffect, useLayoutEffect, useMemo, useSyncExternalStore } from 'react';
import { Minus, Square, X } from '@phosphor-icons/react';
import type { DashboardBridge, DashboardQuery, DashboardRange, DashboardSummary } from '../../shared/dashboard-types';
import { applyLanguage, t } from '../../shared/i18n';
import { IconButton } from '../../shared/IconButton';
import { Select } from '../../shared/Select';
import { applyTheme } from '../../shared/themes';
import { modelLooks } from './chart-math';
import { createDashboardStore } from './dashboard-store';
import { rangeName } from './format';
import { KindTable } from './KindTable';
import { ModelLooksProvider } from './model-look';
import { Empty, Panel } from './Panel';
import { Reliability } from './Reliability';
import { TrendChart } from './TrendChart';

type Actions = Pick<DashboardBridge, 'minimize' | 'maximize' | 'close'>;
export type DashboardViewProps = {
  summary: DashboardSummary | null; query: DashboardQuery; error: string | null; loading?: boolean; named: boolean;
  onQuery(patch: Partial<DashboardQuery>): void; actions: Actions;
};

const Choice = ({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: string }) =>
  <button type="button" className="button" aria-pressed={pressed} onClick={onClick}>{children}</button>;

function TitleBar({ note, named, actions }: { note: string; named: boolean; actions: Actions }) {
  return <div className="titlebar">
    <span className="dash-title">{named && t('数据看板')}</span>
    <span className="dash-note" role="status">{note}</span>
    <div className="titlebar-space" />
    <div className="window-actions">
      <IconButton label={t('最小化')} onClick={actions.minimize}><Minus size={16} /></IconButton>
      <IconButton label={t('最大化或还原')} onClick={actions.maximize}><Square size={12} /></IconButton>
      <IconButton label={t('关闭窗口')} className="window-close" onClick={actions.close}><X size={17} /></IconButton>
    </div>
  </div>;
}

function Charts({ summary }: { summary: DashboardSummary }) {
  const { models, minTasks, trend, kinds } = summary, ids = models.map(row => row.model), empty = !models.length;
  return <div className="content">
    <Panel title={t('可靠性总览')} hint={t('通过率 = 测试通过的任务 ÷ 全部任务')}>
      {empty ? <Empty>{t('这段时间没有派发给角色的任务。')}</Empty> : <>
        <Reliability models={models} minTasks={minTasks} />
        <p className="note">{t('「测试通过」来自角色交回时自己报告的检查（自测）；记录里还没有能对应到具体任务的独立测试结论。')}</p>
      </>}
    </Panel>
    <Panel title={t('可靠性走势')} hint={trend.unit === 'week' ? t('每周的测试通过率') : t('每天的测试通过率，按截至当天的 7 天计算')}>
      {empty ? <Empty>{t('这段时间没有任务，画不出走势。')}</Empty> : <TrendChart trend={trend} models={ids} />}
    </Panel>
    <Panel title={t('模型 × 任务类型')} hint={t('测试通过率和任务数；样本少的格子较淡')}>
      {empty ? <Empty>{t('这段时间没有任务，无法按类型比较。')}</Empty> : <KindTable kinds={kinds} models={ids} />}
    </Panel>
  </div>;
}

export function DashboardView({ summary, query, error, loading = false, named, onQuery, actions }: DashboardViewProps) {
  const looks = useMemo(() => modelLooks(summary ? summary.models.map(row => row.model) : []), [summary]);
  const project = summary?.projects.find(item => item.id === query.projectId);
  const projects = [{ value: '', label: t('全部项目') }, ...(summary?.projects ?? []).map(item => ({ value: item.id, label: item.name }))];
  const ranges: [DashboardRange, string][] = [['7d', t('7 天')], ['30d', t('30 天')], ['all', t('全部')]];
  const note = summary ? `${rangeName(query.range)} · ${project?.name ?? t('全部项目')}` : '';
  return <ModelLooksProvider value={looks}><div className="dash">
    <TitleBar note={note} named={named} actions={actions} />
    <main className={loading && summary ? 'dash-main is-refetch' : 'dash-main'}>
      <div className="toolbar">
        <div className="select-wrap"><span>{t('项目')}</span>
          <Select className="dash-select" label={t('项目')} value={query.projectId ?? ''} options={projects} onChange={value => onQuery({ projectId: value || null })} />
        </div>
        <div className="group" role="group" aria-label={t('时间范围')}>
          {ranges.map(([range, label]) => <Choice key={range} pressed={query.range === range} onClick={() => onQuery({ range })}>{label}</Choice>)}
        </div>
      </div>
      {error && <p className="banner" role="alert">{t('读取数据失败：{message}', { message: error })}</p>}
      {summary ? <Charts summary={summary} /> : !error && <Empty>{t('正在读取…')}</Empty>}
    </main>
  </div></ModelLooksProvider>;
}

export function Dashboard({ bridge }: { bridge: DashboardBridge }) {
  const store = useMemo(() => createDashboardStore(bridge), [bridge]);
  const { query, summary, error, appearance, loading } = useSyncExternalStore(store.subscribe, store.getState);
  useEffect(() => { store.start(); return () => store.stop(); }, [store]);
  // The language is set while rendering, before the children read it, as the main window does.
  applyLanguage(appearance?.language);
  useLayoutEffect(() => applyTheme(appearance?.theme), [appearance?.theme]);
  return <DashboardView summary={summary} query={query} error={error} loading={loading} named={appearance !== null} onQuery={store.setQuery}
    actions={{ minimize: () => bridge.minimize(), maximize: () => bridge.maximize(), close: () => bridge.close() }} />;
}
