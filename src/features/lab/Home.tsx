// The home screen: the saved experiments as cards with a small result chart each, or an empty state that explains the lab and starts the first one.
import { useState } from 'react';
import { Plus, Trash } from '@phosphor-icons/react';
import type { LabExperiment } from '../../shared/lab-types';
import { t } from '../../shared/i18n';
import { ArmMark, ArmName } from './Marks';
import { percent, stateLabel, taskCount, outOf } from './format';
import { ALL_ARMS, armSummary, progress, ranArms } from './results-math';

const TONES = { running: 'running', done: 'success', stopped: 'warning', error: 'danger' } as const;

// Pass rate per approach as bars; a running experiment shows how far it is instead, since its rates are not final.
function MiniChart({ experiment }: { experiment: LabExperiment }) {
  if (experiment.state === 'running') {
    const pace = progress(experiment, Date.now());
    return <div className="mini"><span className="muted">{t('已完成 {done} 次运行', { done: outOf(pace.done, pace.count) })}</span><span className="track"><i className="neutral" style={{ width: `${pace.share * 100}%` }} /></span></div>;
  }
  return <div className="mini" role="img" aria-label={t('各方案的任务通过率')}>
    <span className="muted">{t('任务通过率')}</span>
    {ranArms(experiment).map(arm => { const rate = armSummary(experiment, arm).rate; return <div key={arm} className={`bar-row arm-${arm}`}>
      <ArmName arm={arm} /><span className="track"><i style={{ width: `${(rate ?? 0) * 100}%` }} /></span><b>{percent(rate)}</b>
    </div>; })}
  </div>;
}

function Card({ experiment, onOpen, onRemove }: { experiment: LabExperiment; onOpen: () => void; onRemove: () => Promise<string | null> }) {
  const [confirm, setConfirm] = useState(false), [error, setError] = useState<string | null>(null);
  const remove = async () => { setError(await onRemove()); setConfirm(false); };
  return <article className="exp-card">
    <div className="card-head">
      <h2><button type="button" className="card-open" onClick={onOpen}>{experiment.name}</button></h2>
      <span className={`status tone-${TONES[experiment.state]}`}><i />{stateLabel(experiment.state)}</span>
    </div>
    <p className="muted">{experiment.projectName} · {taskCount(experiment)}</p>
    <MiniChart experiment={experiment} />
    {error && <p className="banner" role="alert">{t('删除失败：{message}', { message: error })}</p>}
    <div className="card-foot">
      {experiment.arms.map(arm => <span key={arm} className={`arm-${arm}`}><ArmMark arm={arm} /></span>)}
      <span className="titlebar-space" />
      {confirm ? <>
        <button type="button" className="button small" onClick={() => void remove()}>{t('确认删除')}</button>
        <button type="button" className="button small" onClick={() => setConfirm(false)}>{t('取消')}</button>
      </> : <button type="button" className="button small" disabled={experiment.state === 'running'} title={experiment.state === 'running' ? t('先停止实验') : undefined} onClick={() => setConfirm(true)}><Trash size={12} />{t('删除')}</button>}
    </div>
  </article>;
}

export function Home({ experiments, onNew, onOpen, onRemove }: {
  experiments: LabExperiment[] | null; onNew: () => void; onOpen: (id: string) => void; onRemove: (id: string) => Promise<string | null>;
}) {
  if (!experiments) return <p className="empty">{t('正在读取…')}</p>;
  if (!experiments.length) return <section className="empty-state">
    <div className="marks" aria-hidden="true">{ALL_ARMS.map(arm => <span key={arm} className={`arm-${arm}`}><ArmMark arm={arm} size={32} /></span>)}</div>
    <h2>{t('还没有实验')}</h2>
    <p className="muted">{t('比较不同模型和编排方式在有标准答案的任务上的表现。从本项目的历史改动里挑几个带测试的问题，让每种方案各做几次，再用隐藏测试和盲审来打分。')}</p>
    <button type="button" className="button primary" onClick={onNew}><Plus size={16} />{t('新建实验')}</button>
  </section>;
  return <>
    <div className="toolbar"><h2>{t('实验')}</h2><button type="button" className="button primary" onClick={onNew}><Plus size={16} />{t('新建实验')}</button></div>
    <div className="cards">{[...experiments].sort((a, b) => b.createdAt - a.createdAt).map(experiment => <Card key={experiment.id} experiment={experiment} onOpen={() => onOpen(experiment.id)} onRemove={() => onRemove(experiment.id)} />)}</div>
  </>;
}
