// The running screen: an overall ring, a card per approach with the model working now, and a tile per run that fills in as it finishes.
import { useState } from 'react';
import { Check, Minus, Stop, Warning, X } from '@phosphor-icons/react';
import type { LabExperiment, LabRun } from '../../shared/lab-types';
import { t } from '../../shared/i18n';
import { useNow } from '../../shared/useNow';
import { duration, money, outOf, stateLabel } from './format';
import { ArmName, Panel, Ring, ScrollRegion, Tag } from './Marks';
import { isDone, progress, ranArms, runsFor } from './results-math';

// A finished run carries a mark as well as a colour: passed, failed, errored and stopped never differ by colour alone.
const TILE_ICONS = { passed: Check, failed: X, error: Warning, stopped: Minus } as const;
const TILE_NAMES: Record<LabRun['state'], () => string> = {
  queued: () => t('排队'), running: () => t('运行中'), passed: () => t('通过'), failed: () => t('未通过'), error: () => t('出错'), stopped: () => t('已停止'),
};
const KEY_RUN: LabRun = { id: '', taskId: '', arm: 'opus', repeat: 1, state: 'queued', startedAt: null, endedAt: null, activeModel: null, testsPassed: null, testsTotal: null, reviewIssues: null, costUsd: null, outputTokens: null, rework: null };

export function Tile({ run }: { run: LabRun }) {
  const Icon = run.state in TILE_ICONS ? TILE_ICONS[run.state as keyof typeof TILE_ICONS] : null, label = TILE_NAMES[run.state]();
  return <span className={`tile ${run.state}`} role="img" aria-label={label} title={run.error ? `${label}: ${run.error}` : label}>{Icon && <Icon size={12} weight="bold" />}</span>;
}

function ArmCard({ experiment, arm }: { experiment: LabExperiment; arm: LabExperiment['arms'][number] }) {
  const runs = runsFor(experiment, arm), done = runs.filter(isDone).length;
  const models = [...new Set(runs.filter(run => run.state === 'running').map(run => run.activeModel).filter((model): model is string => model !== null))];
  return <section className={`arm-card running-card arm-${arm}`} data-active={models.length > 0}>
    <div className="card-head"><ArmName arm={arm} long />{models.length > 0 && <span className="live"><i />{t('运行中')}</span>}</div>
    <Ring share={runs.length ? done / runs.length : 0} size={96} stroke={8}><b className="small-figure">{outOf(done, runs.length)}</b></Ring>
    <div className="models">{models.length ? models.map(model => <Tag key={model}>{model}</Tag>) : <span className="muted">{done === runs.length && runs.length ? t('已完成') : t('等待中')}</span>}</div>
  </section>;
}

export function Running({ experiment, onStop }: { experiment: LabExperiment; onStop: () => Promise<string | null> }) {
  const now = useNow(() => Date.now()), [stopping, setStopping] = useState(false), [error, setError] = useState<string | null>(null);
  const pace = progress(experiment, now), arms = ranArms(experiment);
  const stop = async () => { setStopping(true); setError(await onStop()); setStopping(false); };
  return <div className="content">
    <section className="panel overall">
      <Ring share={pace.share} size={144} stroke={12}><b className="figure">{Math.round(pace.share * 100)}%</b><span className="muted">{outOf(pace.done, pace.count)}</span></Ring>
      <div className="overall-text">
        <h2>{stateLabel(experiment.state)}</h2>
        <p>{t('已用 {elapsed} · 预计还需 {left} · 已花 {spent}', { elapsed: duration(pace.elapsedMs), left: duration(pace.remainingMs), spent: money(experiment.spentUsd) })}</p>
        <p className="muted">{t('预算 {budget}：只阻止新的运行开始，不会中断已经开始的运行。', { budget: money(experiment.budgetUsd) })}</p>
        {error && <p className="banner" role="alert">{t('停止失败：{message}', { message: error })}</p>}
      </div>
      <button type="button" className="button" disabled={stopping || experiment.state !== 'running'} onClick={() => void stop()}><Stop size={16} weight="fill" />{t('停止')}</button>
    </section>
    <div className="arm-cards">{arms.map(arm => <ArmCard key={arm} experiment={experiment} arm={arm} />)}</div>
    <Panel title={t('运行网格')} hint={t('每个方块是一次运行，完成后填色')}>
      <ScrollRegion label={t('每个任务在每种方案下的运行状态')}>
        <table className="tiles">
          <thead><tr><th>{t('任务')}</th>{arms.map(arm => <th key={arm}><ArmName arm={arm} /></th>)}</tr></thead>
          <tbody>{experiment.tasks.map(task => <tr key={task.id}>
            <th scope="row" className="task-title">{task.title}</th>
            {arms.map(arm => <td key={arm}><span className="tile-row">{[...runsFor(experiment, arm, task.id)].sort((a, b) => a.repeat - b.repeat).map(run => <Tile key={run.id} run={run} />)}</span></td>)}
          </tr>)}</tbody>
        </table>
      </ScrollRegion>
      <p className="note tile-key">{(['queued', 'running', 'passed', 'failed', 'error'] as const).map(state => <span key={state}><Tile run={{ ...KEY_RUN, state }} />{TILE_NAMES[state]()}</span>)}<span>{t('通过 = 隐藏测试全部通过')}</span></p>
    </Panel>
  </div>;
}
