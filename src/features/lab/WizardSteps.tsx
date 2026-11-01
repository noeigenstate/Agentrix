// The four steps of the new-experiment form. Each is a controlled view: the form (Wizard.tsx) holds the state and the bridge calls.
import type { ReactNode } from 'react';
import { ChartLineUp, Check, GitCommit, GithubLogo, Minus, Plus } from '@phosphor-icons/react';
import type { LabArm, LabEstimate, LabTask } from '../../shared/lab-types';
import { t } from '../../shared/i18n';
import { armName, DASH, kindLabel, minutesLabel, money, percent } from './format';
import { ArmMark, Ring, Tag } from './Marks';
import { ALL_ARMS } from './results-math';
import { MIN_ARMS, REPEATS, SIZE, type Draft } from './wizard-math';

const Tick = () => <span className="tick" aria-hidden="true"><Check size={12} weight="bold" /></span>;

// A choice card: a native toggle button, and only the chosen one carries the tick.
function Choice({ chosen, disabled = false, onClick, className = '', children }: { chosen: boolean; disabled?: boolean; onClick: () => void; className?: string; children: ReactNode }) {
  return <button type="button" className={`choice ${className}`} aria-pressed={chosen} disabled={disabled} onClick={onClick}>{chosen && <Tick />}{children}</button>;
}

export function SourceStep() {
  const sources = [
    { id: 'history', Icon: GitCommit, title: t('本项目的历史改动'), text: t('从项目自己的提交历史里挑带测试的改动，用当时的测试来评分。'), open: true },
    { id: 'oss', Icon: GithubLogo, title: t('知名开源项目'), text: t('从著名的 GitHub 项目里各摘取几个代表性问题。'), open: false },
    { id: 'aa', Icon: ChartLineUp, title: t('AA 测试'), text: t('Artificial Analysis 的公开基准，可以和他们公布的分数对照。'), open: false },
  ];
  return <div className="choices three">{sources.map(({ id, Icon, title, text, open }) => <Choice key={id} chosen={open} disabled={!open} onClick={() => undefined}>
    <Icon size={32} aria-hidden="true" /><b>{title}</b><span className="muted">{text}</span>{!open && <Tag>{t('下一轮')}</Tag>}
  </Choice>)}</div>;
}

export function Stepper({ label, hint, value, min, max, onChange }: { label: string; hint: string; value: number; min: number; max: number; onChange: (value: number) => void }) {
  return <div className="field"><div><b>{label}</b><p className="muted">{hint}</p></div>
    <div className="control"><div className="stepper" role="group" aria-label={label}>
      <button type="button" className="icon-button" aria-label={t('减少')} disabled={value <= min} onClick={() => onChange(value - 1)}><Minus size={16} /></button>
      <output aria-live="polite">{value}</output>
      <button type="button" className="icon-button" aria-label={t('增加')} disabled={value >= max} onClick={() => onChange(value + 1)}><Plus size={16} /></button>
    </div></div></div>;
}

export type Sampling = { size: number; preferShortComplex: boolean };
export type SampleView = { tasks: LabTask[]; loading: boolean; error: string | null; exhausted: boolean };

export function ProjectStep({ projects, projectId, sampling, sample, onProject, onSampling, onShuffle, onRetry }: {
  projects: { id: string; name: string }[]; projectId: string; sampling: Sampling; sample: SampleView;
  onProject: (id: string) => void; onSampling: (patch: Partial<Sampling>) => void; onShuffle: () => void; onRetry: () => void;
}) {
  return <div className="project-step">
    <p className="muted">{t('每个项目自动抽取代表性问题，覆盖不同模块和难度；样本会随实验保存，之后可以重跑同一批问题，对比才公平。')}</p>
    {!projects.length && <p className="empty">{t('没有可用的项目。先在 Agentrix 里添加一个项目。')}</p>}
    <div className="choices">{projects.map(project => <Choice key={project.id} chosen={project.id === projectId} onClick={() => onProject(project.id)}><b>{project.name}</b></Choice>)}</div>
    {projectId && <section className="panel sample" aria-live="polite">
      <div className="sample-controls">
        <Stepper label={t('抽取几个问题')} hint={t('默认 {n}，可选 {min}–{max}', { n: SIZE.standard, min: SIZE.min, max: SIZE.max })} value={sampling.size} min={SIZE.min} max={SIZE.max} onChange={size => onSampling({ size })} />
        <label className="check"><input type="checkbox" checked={sampling.preferShortComplex} onChange={event => onSampling({ preferShortComplex: event.target.checked })} />{t('偏好短而复杂的任务（改动行数少，但跨多个模块）')}</label>
      </div>
      <div className="sample-head"><span className="muted">{sample.loading ? t('正在挑选…') : t('已选 {n} 个代表性问题', { n: sample.tasks.length })}</span>
        <button type="button" className="button small" disabled={sample.loading} onClick={sample.exhausted ? onRetry : onShuffle}>{sample.exhausted ? t('从头再来') : t('换一组')}</button></div>
      {sample.error && <p className="banner" role="alert">{t('挑选任务失败：{message}', { message: sample.error })} <button type="button" className="button small" onClick={onRetry}>{t('重试')}</button></p>}
      {!sample.loading && !sample.error && !sample.tasks.length && <p className="muted">{sample.exhausted ? t('没有更多可换的任务了。') : t('这个项目里没有带测试的历史改动可以挑选。')}</p>}
      <ul className="task-list">{sample.tasks.map(task => <li key={task.id}>
        <i aria-hidden="true" />
        <div><b>{task.title}</b><p className="muted">{t(task.why)}</p></div>
        <Tag>{kindLabel(task.kind)}</Tag>
      </li>)}</ul>
    </section>}
  </div>;
}

// The orchestrated approach as it is tested: a lead plans, Sol and Sonnet build, Opus reviews, and review findings go back to the lead.
function Orchestration() {
  const box = (x: number, y: number, label: string) => <g><rect x={x} y={y} width="188" height="44" rx="12" /><text x={x + 94} y={y + 27} textAnchor="middle">{label}</text></g>;
  return <svg className="diagram" viewBox="0 0 800 200" role="img" aria-label={t('编排方案的分工：主管计划，Sol 和 Sonnet 分工编写，Opus 评审，意见回到主管')}>
    <defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" /></marker></defs>
    <g className="links" markerEnd="url(#arrow)"><path d="M200 94L306 54" /><path d="M200 94L306 134" /><path d="M494 54L600 94" /><path d="M494 134L600 94" /></g>
    {box(12, 72, t('主管 · 计划'))}{box(306, 20, t('Sol · 复杂代码'))}{box(306, 112, t('Sonnet · 常规与界面'))}{box(600, 72, t('Opus · 评审'))}
    <path className="loop" d="M694 116V176H106V120" markerEnd="url(#arrow)" />
    <text className="note" x="400" y="194" textAnchor="middle">{t('评审意见回到主管，返工后再评审')}</text>
  </svg>;
}

const ARM_TEXT: Record<LabArm, () => string> = {
  orchestrated: () => t('计划、圆桌、Sol + Sonnet 分工、Opus 评审'),
  opus: () => t('一个模型独自完成，不分工'), sol: () => t('一个模型独自完成，不分工'), sonnet: () => t('一个模型独自完成，不分工'),
};

export function ArmStep({ arms, onToggle }: { arms: LabArm[]; onToggle: (arm: LabArm) => void }) {
  return <div className="arm-step">
    <div className="choices four">{ALL_ARMS.map(arm => <Choice key={arm} chosen={arms.includes(arm)} className={`arm-${arm}`} onClick={() => onToggle(arm)}>
      <ArmMark arm={arm} size={24} /><b>{armName(arm, true)}</b><span className="muted">{ARM_TEXT[arm]()}</span>
    </Choice>)}</div>
    <section className="panel"><h2>{t('编排方案怎么分工')}<span className="hint">{arms.includes('orchestrated') ? t('已选中：这条流程是被测的“编排”') : t('未选中')}</span></h2><Orchestration /></section>
    {arms.length < MIN_ARMS && <p className="note" role="status">{t('至少选 {n} 个方案做对比。', { n: MIN_ARMS })}</p>}
  </div>;
}

// The estimate as three large numbers; the one ring says how much of the budget the estimated cost is.
const Stat = ({ value, label }: { value: string; label: string }) => <div className="stat"><b className="figure">{value}</b><span className="muted">{label}</span></div>;

export function ScaleStep({ draft, estimate, error, onRetry, onRepeats, onBudget, onName, defaultName }: {
  draft: Draft; estimate: LabEstimate | null; error: string | null; defaultName: string; onRetry: () => void;
  onRepeats: (value: number) => void; onBudget: (value: number) => void; onName: (value: string) => void;
}) {
  const share = estimate && draft.budgetUsd > 0 ? estimate.costUsd / draft.budgetUsd : null, over = share !== null && share > 1;
  return <>
    <section className="panel">
      <h2>{t('预估')}<span className="hint">{estimate ? (estimate.basis === 'history' ? t('按你自己的运行记录估算') : t('还没有运行记录，按默认值估算')) : t('估算值')}</span></h2>
      {error && <p className="banner" role="alert">{t('估算失败：{message}', { message: error })} <button type="button" className="button small" onClick={onRetry}>{t('重试')}</button></p>}
      <div className="estimate">
        <Stat value={estimate ? String(estimate.runs) : DASH} label={t('次运行')} />
        <Stat value={estimate ? minutesLabel(estimate.minutes) : DASH} label={t('用时')} />
        <Stat value={estimate ? money(estimate.costUsd) : DASH} label={t('费用')} />
        <div className={`gauge ${over ? 'over' : ''}`}>
          <Ring share={share === null ? 0 : Math.min(1, share)} size={112} stroke={10}><b className="small-figure">{percent(share)}</b></Ring>
          <span className="muted">{over ? t('超出预算') : t('占预算的比例')}</span>
        </div>
      </div>
    </section>
    <section className="panel fields">
      <Stepper label={t('每个问题重复几次')} hint={t('结果有随机性，{min}–{max} 次', { min: REPEATS.min, max: REPEATS.max })} value={draft.repeats} min={REPEATS.min} max={REPEATS.max} onChange={onRepeats} />
      <label className="field"><div><b>{t('预算（美元）')}</b><p className="muted">{t('花到这个数就不再开始新的运行；已经开始的运行不会被中断。')}</p></div>
        <div className="control"><input className="input" type="number" min={1} step={1} inputMode="decimal" aria-label={t('预算（美元）')} value={draft.budgetUsd || ''} onChange={event => onBudget(Number(event.target.value))} /></div></label>
      <label className="field"><div><b>{t('实验名称')}</b><p className="muted">{t('留空则用默认名称')}</p></div>
        <div className="control"><input className="input" type="text" placeholder={defaultName} aria-label={t('实验名称')} value={draft.name} onChange={event => onName(event.target.value)} /></div></label>
      <p className="note">{t('{tasks} 个问题 × {arms} 种方案 × {repeats} 次', { tasks: draft.tasks.length, arms: draft.arms.length, repeats: draft.repeats })}</p>
    </section>
  </>;
}
