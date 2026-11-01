// The home screen: the saved experiments as cards with a small chart each, or an empty state that explains the lab and starts the first one.
// The one strong action is "新建实验"; deleting an experiment is a quiet action on its card that shows on hover or focus.
import { useState } from 'react';
import { Plus, Trash } from '@phosphor-icons/react';
import type { LabExperiment } from '../../shared/lab-types';
import { t } from '../../shared/i18n';
import { IconButton } from '../../shared/IconButton';
import { ArmMark, ArmName } from './Marks';
import { friendlyError, outOf, percent, stateLabel, taskCount } from './format';
import { ALL_ARMS, armSummary, isDone, ranArms, runsFor } from './results-math';

const TONES = { running: 'running', done: 'success', stopped: 'warning', error: 'danger' } as const;

// One bar per approach: its task pass rate; a running experiment shows how far each approach has got instead, since its rates are not final.
function MiniChart({ experiment }: { experiment: LabExperiment }) {
  const running = experiment.state === 'running';
  return <div className="mini" role="img" aria-label={running ? t('各方案的运行进度') : t('各方案的任务通过率')}>
    <span className="muted">{running ? t('各方案的运行进度') : t('任务通过率')}</span>
    {ranArms(experiment).map(arm => {
      const runs = runsFor(experiment, arm), done = runs.filter(isDone).length, rate = armSummary(experiment, arm).rate;
      const share = running ? (runs.length ? done / runs.length : 0) : rate ?? 0;
      return <div key={arm} className={`bar-row arm-${arm}`}><ArmName arm={arm} /><span className="track"><i style={{ width: `${share * 100}%` }} /></span><b>{running ? outOf(done, runs.length) : percent(rate)}</b></div>;
    })}
  </div>;
}

function Card({ experiment, onOpen, onRemove }: { experiment: LabExperiment; onOpen: () => void; onRemove: () => Promise<string | null> }) {
  const [confirm, setConfirm] = useState(false), [error, setError] = useState<string | null>(null);
  const remove = async () => { setError(await onRemove()); setConfirm(false); };
  return <article className="exp-card">
    <div className="card-head">
      <h2><button type="button" className="card-open" onClick={onOpen}>{experiment.name}</button></h2>
      <span className={`status tone-${TONES[experiment.state]}`}><i />{stateLabel(experiment.state)}</span>
      <IconButton label={experiment.state === 'running' ? t('先停止实验') : t('删除')} className="card-delete" disabled={experiment.state === 'running'} onClick={() => setConfirm(true)}><Trash size={16} /></IconButton>
    </div>
    <p className="muted">{experiment.projectName} · {taskCount(experiment)}</p>
    <MiniChart experiment={experiment} />
    {error && <p className="banner" role="alert">{t('删除失败：{message}', { message: friendlyError(error) })}</p>}
    {confirm && <div className="card-confirm" role="alert">
      <span>{t('删除“{name}”？这不能撤销。', { name: experiment.name })}</span>
      <button type="button" className="button small" onClick={() => void remove()}>{t('确认删除')}</button>
      <button type="button" className="button small" onClick={() => setConfirm(false)}>{t('取消')}</button>
    </div>}
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
