// The dashboard window's page. It reads only through window.agentrixDashboard (electron/features/dashboard/preload.cjs) and draws
// whatever summary the main process returns; every number there may be null, and the page shows that as "—".
import { useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Minus, Square, X } from '@phosphor-icons/react';
import type { DashboardBridge, DashboardQuery, DashboardRange, DashboardSummary } from '../../shared/dashboard-types';
import { applyLanguage, t } from '../../shared/i18n';
import { IconButton } from '../../shared/IconButton';
import { Select } from '../../shared/Select';
import { applyTheme } from '../../shared/themes';
import { ChartDefs } from './Charts';
import { createDashboardStore } from './dashboard-store';
import { hasNoRecords, rangeName, timeLabel } from './format';
import { Empty } from './Panel';
import { ModelsTab, TeamTab } from './Tabs';

type Tab = 'models' | 'team';
type Actions = Pick<DashboardBridge, 'minimize' | 'maximize' | 'close'>;
export type DashboardViewProps = {
  summary: DashboardSummary | null; query: DashboardQuery; error: string | null; tab: Tab; named: boolean;
  onTab(tab: Tab): void; onQuery(patch: Partial<DashboardQuery>): void;
  decide(id: string, state: DashboardSummary['suggestions'][number]['state']): Promise<string | null>; actions: Actions;
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

export function DashboardView({ summary, query, error, tab, named, onTab, onQuery, decide, actions }: DashboardViewProps) {
  const project = summary?.projects.find(item => item.id === query.projectId);
  const projects = [{ value: '', label: t('全部项目') }, ...(summary?.projects ?? []).map(item => ({ value: item.id, label: item.name }))];
  const ranges: [DashboardRange, string][] = [['7d', t('7 天')], ['30d', t('30 天')], ['all', t('全部')]];
  const note = summary ? `${rangeName(query.range)} · ${project?.name ?? t('全部项目')} · ${t('更新于 {time}', { time: timeLabel(summary.generatedAt) })}` : '';
  return <div className="dash">
    <ChartDefs />
    <TitleBar note={note} named={named} actions={actions} />
    <main className="dash-main">
      <div className="toolbar">
        <div className="group" role="group" aria-label={t('看板')}>
          <Choice pressed={tab === 'models'} onClick={() => onTab('models')}>{t('模型评估')}</Choice>
          <Choice pressed={tab === 'team'} onClick={() => onTab('team')}>{t('协作报告')}</Choice>
        </div>
        <div className="filters">
          <div className="select-wrap"><span>{t('项目')}</span>
            <Select className="dash-select" label={t('项目')} value={query.projectId ?? ''} options={projects} onChange={value => onQuery({ projectId: value || null })} />
          </div>
          <div className="group" role="group" aria-label={t('时间范围')}>
            {ranges.map(([range, label]) => <Choice key={range} pressed={query.range === range} onClick={() => onQuery({ range })}>{label}</Choice>)}
          </div>
        </div>
      </div>
      {error && <p className="banner" role="alert">{t('读取数据失败：{message}', { message: error })}</p>}
      {!summary ? (!error && <Empty>{t('正在读取…')}</Empty>)
        : hasNoRecords(summary) ? <Empty>{t('还没有记录。派发子任务、完成一轮协作或评价一次交付后，这里会出现数据。')}</Empty>
          : tab === 'models' ? <ModelsTab summary={summary} /> : <TeamTab summary={summary} decide={decide} />}
    </main>
  </div>;
}

export function Dashboard({ bridge }: { bridge: DashboardBridge }) {
  const store = useMemo(() => createDashboardStore(bridge), [bridge]);
  const { query, summary, error, appearance } = useSyncExternalStore(store.subscribe, store.getState);
  const [tab, setTab] = useState<Tab>('models');
  useEffect(() => { store.start(); return () => store.stop(); }, [store]);
  // The language is set while rendering, before the children read it, as the main window does.
  applyLanguage(appearance?.language);
  useLayoutEffect(() => applyTheme(appearance?.theme), [appearance?.theme]);
  return <DashboardView summary={summary} query={query} error={error} tab={tab} named={appearance !== null} onTab={setTab} onQuery={store.setQuery}
    decide={store.decide} actions={{ minimize: () => bridge.minimize(), maximize: () => bridge.maximize(), close: () => bridge.close() }} />;
}
