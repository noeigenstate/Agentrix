// The steps of the new-experiment form after the source panels (SourcePanels.tsx): the sources, the approaches, the size and the estimate. Each is a controlled
// view: the form (Wizard.tsx) holds the state and the bridge calls.
import { ChartLineUp, GitCommit, GithubLogo } from '@phosphor-icons/react';
import type { LabArm, LabEstimate, LabSource, LabSourceInfo } from '../../shared/lab-types';
import { t } from '../../shared/i18n';
import { Choice, Stepper } from './Controls';
import { armName, bytesLabel, DASH, minutesLabel, money, percent } from './format';
import { ArmMark, Ring, ScrollRegion } from './Marks';
import { ALL_ARMS } from './results-math';
import { SOURCE_ORDER } from './source-math';
import { SOURCE_BLURBS, SOURCE_NAMES } from './source-text';
import { MIN_ARMS, REPEATS, taskTotal, type Draft } from './wizard-math';

const ICONS = { history: GitCommit, oss: GithubLogo, aa: ChartLineUp };

// Every source the bridge reports, to be chosen together; one that cannot run is disabled and says why. Only a chosen source carries a tick.
export function SourceStep({ sources, chosen, onToggle }: { sources: LabSourceInfo[] | null; chosen: LabSource[]; onToggle: (source: LabSource) => void }) {
  if (!sources) return <p className="empty">{t('正在读取…')}</p>;
  return <div className="choices three">{[...sources].sort((a, b) => SOURCE_ORDER.indexOf(a.id) - SOURCE_ORDER.indexOf(b.id)).map(info => {
    const Icon = ICONS[info.id];
    return <Choice key={info.id} chosen={info.available && chosen.includes(info.id)} disabled={!info.available} onClick={() => onToggle(info.id)}>
      <Icon size={32} aria-hidden="true" /><b>{SOURCE_NAMES[info.id]()}</b><span className="muted">{SOURCE_BLURBS[info.id]()}</span>
      {!info.available && <span className="muted reason">{info.reason ?? t('暂不可用')}</span>}
    </Choice>;
  })}</div>;
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

// Where the estimate comes from, per source, when more than one is chosen or the one is not history: its runs, time and cost, its share of the budget (main's
// own split: the page only shows it) and what it will download at the start.
function SourceRows({ estimate, infos }: { estimate: LabEstimate; infos: LabSourceInfo[] }) {
  return <ScrollRegion label={t('各来源的估算')}>
    <table className="wide">
      <thead><tr><th>{t('来源')}</th><th className="num">{t('次运行')}</th><th className="num">{t('用时')}</th><th className="num">{t('费用')}</th><th className="num">{t('预算占比')}</th><th className="num">{t('下载')}</th></tr></thead>
      <tbody>{estimate.sources.map(row => {
        const download = infos.find(info => info.id === row.source)?.downloadBytes ?? null;
        return <tr key={row.source}>
          <td>{SOURCE_NAMES[row.source]()}</td><td className="num">{row.runs}</td><td className="num">{minutesLabel(row.minutes)}</td>
          <td className="num">{money(row.costUsd)}</td><td className="num">{percent(row.share)}</td><td className="num">{download === null ? DASH : bytesLabel(download)}</td>
        </tr>;
      })}</tbody>
    </table>
  </ScrollRegion>;
}

export function ScaleStep({ draft, infos, estimate, error, onRetry, onRepeats, onBudget, onName, defaultName }: {
  draft: Draft; infos: LabSourceInfo[]; estimate: LabEstimate | null; error: string | null; defaultName: string; onRetry: () => void;
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
      {estimate && (estimate.sources.length > 1 || estimate.sources[0]?.source !== 'history') && <SourceRows estimate={estimate} infos={infos} />}
    </section>
    <section className="panel fields">
      <Stepper label={t('每个问题重复几次')} hint={t('结果有随机性，{min}–{max} 次', { min: REPEATS.min, max: REPEATS.max })} value={draft.repeats} min={REPEATS.min} max={REPEATS.max} onChange={onRepeats} />
      <label className="field"><div><b>{t('预算（美元）')}</b><p className="muted">{t('花到这个数就停止：不再开始新的运行，正在进行的运行也会在超出时停下。')}</p></div>
        <div className="control"><input className="input" type="number" min={1} step={1} inputMode="decimal" aria-label={t('预算（美元）')} value={draft.budgetUsd || ''} onChange={event => onBudget(Number(event.target.value))} /></div></label>
      <label className="field"><div><b>{t('实验名称')}</b><p className="muted">{t('留空则用默认名称')}</p></div>
        <div className="control"><input className="input" type="text" placeholder={defaultName} aria-label={t('实验名称')} value={draft.name} onChange={event => onName(event.target.value)} /></div></label>
      <p className="note">{t('{tasks} 个问题 × {arms} 种方案 × {repeats} 次', { tasks: taskTotal(draft), arms: draft.arms.length, repeats: draft.repeats })}</p>
    </section>
  </>;
}
