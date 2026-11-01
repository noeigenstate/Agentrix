// The Virtual Lab window's page. It reads only through window.agentrixLab (electron/features/lab/preload.cjs) and draws whatever the main process
// sends; every number there may be null, and the page shows that as "—".
import { useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Minus, Square, X } from '@phosphor-icons/react';
import type { LabBridge, LabExperiment } from '../../shared/lab-types';
import { applyLanguage, t } from '../../shared/i18n';
import { IconButton } from '../../shared/IconButton';
import { applyTheme } from '../../shared/themes';
import { friendlyError } from './format';
import { Home } from './Home';
import { createLabStore, type LabState, type LabStore } from './lab-store';
import { BackButton } from './Marks';
import { Results } from './Results';
import { Running } from './Running';
import { Wizard } from './Wizard';

export type View = { kind: 'home' } | { kind: 'new' } | { kind: 'experiment'; id: string };
type Actions = Pick<LabBridge, 'minimize' | 'maximize' | 'close'>;
export type LabViewProps = {
  state: LabState; store: Pick<LabStore, 'begin' | 'refresh' | 'remove' | 'stopExperiment'>; bridge: Pick<LabBridge, 'sample' | 'estimate'>;
  named: boolean; actions: Actions; initial?: View;
};

function TitleBar({ title, note, named, actions }: { title: string; note: string; named: boolean; actions: Actions }) {
  return <div className="titlebar">
    <span className="lab-title">{named && title}</span>
    <span className="lab-note" role="status">{note}</span>
    <div className="titlebar-space" />
    <div className="window-actions">
      <IconButton label={t('最小化')} onClick={actions.minimize}><Minus size={16} /></IconButton>
      <IconButton label={t('最大化或还原')} onClick={actions.maximize}><Square size={12} /></IconButton>
      <IconButton label={t('关闭窗口')} className="window-close" onClick={actions.close}><X size={17} /></IconButton>
    </div>
  </div>;
}

function Experiment({ experiment, onStop, onBack }: { experiment: LabExperiment | undefined; onStop: (id: string) => Promise<string | null>; onBack: () => void }) {
  if (!experiment) return <p className="empty">{t('找不到这个实验。')}</p>;
  return <>
    <div className="toolbar">
      <BackButton onClick={onBack} />
      <h2>{experiment.name}</h2>
    </div>
    {experiment.state === 'running' ? <Running experiment={experiment} onStop={() => onStop(experiment.id)} /> : <Results experiment={experiment} />}
  </>;
}

export function LabView({ state, store, bridge, named, actions, initial = { kind: 'home' } }: LabViewProps) {
  const [view, setView] = useState<View>(initial);
  const experiment = view.kind === 'experiment' ? state.experiments?.find(item => item.id === view.id) : undefined;
  const home = () => setView({ kind: 'home' });
  const note = view.kind === 'new' ? t('新建实验') : view.kind === 'experiment' ? experiment?.projectName ?? '' : t('比较不同模型和编排方式在有标准答案的任务上的表现');
  return <div className="lab">
    <TitleBar title={t('虚拟实验室')} note={note} named={named} actions={actions} />
    <main className="lab-main">
      {state.error && <p className="banner" role="alert">{t('读取数据失败：{message}', { message: friendlyError(state.error) })} <button type="button" className="button small" onClick={() => void store.refresh()}>{t('重试')}</button></p>}
      {view.kind === 'home' && <Home experiments={state.experiments} onNew={() => setView({ kind: 'new' })} onOpen={id => setView({ kind: 'experiment', id })} onRemove={store.remove} />}
      {view.kind === 'new' && <Wizard projects={state.projects} api={bridge} begin={store.begin} onClose={home} onStarted={id => setView({ kind: 'experiment', id })} />}
      {view.kind === 'experiment' && <Experiment experiment={experiment} onStop={store.stopExperiment} onBack={home} />}
    </main>
  </div>;
}

export function Lab({ bridge }: { bridge: LabBridge }) {
  const store = useMemo(() => createLabStore(bridge), [bridge]);
  const state = useSyncExternalStore(store.subscribe, store.getState);
  useEffect(() => { store.start(); return () => store.stop(); }, [store]);
  // The language is set while rendering, before the children read it, as the main window does.
  applyLanguage(state.appearance?.language);
  const theme = state.appearance?.theme;
  useLayoutEffect(() => applyTheme(theme), [theme]);
  return <LabView state={state} store={store} bridge={bridge} named={state.appearance !== null} actions={{ minimize: () => bridge.minimize(), maximize: () => bridge.maximize(), close: () => bridge.close() }} />;
}
