// Step 2 of the form, one panel per chosen source: the history project, the open-source repositories, the benchmark (with the owner's AA key). Each panel
// is a controlled view: the form (Wizard.tsx) holds the draft, the samples and the bridge calls.
import { useState, type ReactNode } from 'react';
import type { LabSource, LabSourceInfo, LabSourceOption, LabTask } from '../../shared/lab-types';
import { t } from '../../shared/i18n';
import { Choice, Stepper } from './Controls';
import { friendlyError, kindLabel } from './format';
import { Tag } from './Marks';
import { SOURCE_NAMES } from './source-text';

export type SampleView = { tasks: LabTask[]; loading: boolean; error: string | null; exhausted: boolean };
// What every panel needs to show and change its sample.
export type PanelProps = { sample: SampleView; size: number; range: LabSourceInfo['size']; onSize: (size: number) => void; onShuffle: () => void; onRetry: () => void };

// A task is tagged with what the owner needs to judge it: the kind (history), the repository and licence (oss, attribution), the category (aa).
function TaskTags({ task }: { task: LabTask }) {
  if (task.source === 'oss') return <span className="tags"><Tag>{task.repo}</Tag><Tag>{task.license ?? t('未标明许可证')}</Tag></span>;
  if (task.source === 'aa') return task.category ? <Tag>{task.category}</Tag> : null;
  return <Tag>{kindLabel(task.kind)}</Tag>;
}

// `cap` keeps a long sample short: that many rows show, the rest behind a toggle that says how many there are.
function SamplePanel({ panel: { sample, size, range, onSize, onShuffle, onRetry }, extra, emptyText, cap }: { panel: PanelProps; extra?: ReactNode; emptyText: string; cap?: number }) {
  const [all, setAll] = useState(false), folded = cap !== undefined && !all && sample.tasks.length > cap;
  return <section className="panel sample" aria-live="polite">
    <div className="sample-controls">
      <Stepper label={t('抽取几个问题')} hint={t('默认 {n}，可选 {min}–{max}', { n: range.standard, min: range.min, max: range.max })} value={size} min={range.min} max={range.max} onChange={onSize} />
      {extra}
    </div>
    <div className="sample-head"><span className="muted">{sample.loading ? t('正在挑选…') : t('已选 {n} 个代表性问题', { n: sample.tasks.length })}</span>
      <button type="button" className="button small" disabled={sample.loading} onClick={sample.exhausted ? onRetry : onShuffle}>{sample.exhausted ? t('从头再来') : t('换一组')}</button></div>
    {sample.error && <p className="banner" role="alert">{t('挑选任务失败：{message}', { message: sample.error })} <button type="button" className="button small" onClick={onRetry}>{t('重试')}</button></p>}
    {!sample.loading && !sample.error && !sample.tasks.length && <p className="muted">{sample.exhausted ? t('没有更多可换的任务了。') : emptyText}</p>}
    <ul className="task-list">{(folded ? sample.tasks.slice(0, cap) : sample.tasks).map(task => <li key={task.id}>
      <i aria-hidden="true" />
      <div><b>{task.title}</b><p className="muted">{t(task.why)}</p></div>
      <TaskTags task={task} />
    </li>)}</ul>
    {cap !== undefined && sample.tasks.length > cap && <button type="button" className="button small sample-toggle" aria-expanded={!folded} onClick={() => setAll(!all)}>
      {folded ? t('显示全部 {n} 个', { n: sample.tasks.length }) : t('收起')}</button>}
  </section>;
}

export function ProjectStep({ projects, projectId, preferShortComplex, panel, onProject, onPrefer }: {
  projects: { id: string; name: string }[]; projectId: string; preferShortComplex: boolean; panel: PanelProps; onProject: (id: string) => void; onPrefer: (prefer: boolean) => void;
}) {
  return <div className="project-step">
    <p className="muted">{t('每个项目自动抽取代表性问题，覆盖不同模块和难度；样本会随实验保存，之后可以重跑同一批问题，对比才公平。')}</p>
    {!projects.length && <p className="empty">{t('没有可用的项目。先在 Agentrix 里添加一个项目。')}</p>}
    <div className="choices">{projects.map(project => <Choice key={project.id} chosen={project.id === projectId} onClick={() => onProject(project.id)}><b>{project.name}</b></Choice>)}</div>
    {projectId && <SamplePanel panel={panel} emptyText={t('这个项目里没有带测试的历史改动可以挑选。')}
      extra={<label className="check"><input type="checkbox" checked={preferShortComplex} onChange={event => onPrefer(event.target.checked)} />{t('偏好短而复杂的任务（改动行数少，但跨多个模块）')}</label>} />}
  </div>;
}

// The options of an oss or aa panel as choice cards; `chosen` says which are on.
function Options({ options, chosen, onPick }: { options: LabSourceOption[]; chosen: (id: string) => boolean; onPick: (id: string) => void }) {
  if (!options.length) return <p className="empty">{t('这个来源还没有可选的内容。')}</p>;
  return <div className="choices">{options.map(option => <Choice key={option.id} chosen={chosen(option.id)} onClick={() => onPick(option.id)}>
    <b>{option.name}</b>{option.detail && <span className="muted">{option.detail}</span>}
    <span className="tags">{option.tasks !== null && <Tag>{t('{n} 个任务', { n: option.tasks })}</Tag>}{option.license && <Tag>{option.license}</Tag>}</span>
  </Choice>)}</div>;
}

export function OssStep({ options, repos, panel, onRepos }: { options: LabSourceOption[]; repos: string[]; panel: PanelProps; onRepos: (repos: string[]) => void }) {
  const pick = (id: string) => onRepos(repos.includes(id) ? repos.filter(item => item !== id) : [...repos, id]);
  return <div className="project-step">
    <p className="muted">{t('这些问题来自公开的 SWE-bench Verified，可以选一个或几个仓库；模型训练时可能见过它们，结果只作参考。')}</p>
    <Options options={options} chosen={id => repos.includes(id)} onPick={pick} />
    {repos.length > 0 && <SamplePanel panel={panel} emptyText={t('所选仓库里没有可以挑选的任务。')} />}
  </div>;
}

// The key is typed into a password field and handed to `onSave` once; the field is cleared at once, and the key is never shown, in an error or in a label.
// All the field says is whether main has one stored.
function AaKeyField({ stored, onSave }: { stored: boolean | null; onSave: (key: string | null) => Promise<string | null> }) {
  const [value, setValue] = useState(''), [busy, setBusy] = useState(false), [failure, setFailure] = useState<string | null>(null);
  async function save(key: string | null) {
    setValue(''); setBusy(true);
    setFailure(await onSave(key)); setBusy(false);
  }
  return <section className="panel fields">
    <div className="field">
      <div><b>{t('AA 密钥')}</b><p className="muted">{t('用来取得 AA 公布的各模型分数，只加密保存在本机，不会显示，也不会发到别处。没有密钥时只显示本地得分。')}</p></div>
      <div className="control"><Tag tone={stored ? 'success' : undefined}>{stored ? t('已保存') : t('未保存')}</Tag></div>
    </div>
    <div className="key-row">
      <input className="input" type="password" autoComplete="off" spellCheck={false} aria-label={t('AA 密钥')} value={value} onChange={event => setValue(event.target.value)} />
      <button type="button" className="button" disabled={busy || !value} onClick={() => void save(value)}>{t('保存')}</button>
      <button type="button" className="button" disabled={busy || !stored} onClick={() => void save(null)}>{t('清除')}</button>
    </div>
    {failure && <p className="banner" role="alert">{t('保存密钥失败：{message}', { message: friendlyError(failure) })}</p>}
  </section>;
}

// The benchmark's sample is long and only informs; the key, which switches on the real scores, comes before it and the list shows this many rows first.
const AA_ROWS = 5;

export function AaStep({ info, benchmark, panel, onBenchmark, onKey }: {
  info: LabSourceInfo | undefined; benchmark: string; panel: PanelProps; onBenchmark: (id: string) => void; onKey: (key: string | null) => Promise<string | null>;
}) {
  return <div className="project-step">
    <p className="muted">{t('Terminal-Bench 是公开的终端任务基准，每个任务在容器里完成，由任务自带的测试评分。这里只抽取其中一部分任务，分数不等于 AA 公布的成绩。')}</p>
    <Options options={info?.options ?? []} chosen={id => id === benchmark} onPick={onBenchmark} />
    <AaKeyField stored={info?.keyStored ?? null} onSave={onKey} />
    {benchmark && <SamplePanel panel={panel} emptyText={t('这个基准里没有可以挑选的任务。')} cap={AA_ROWS} />}
  </div>;
}

// With several sources chosen each panel gets its source's name above it.
export const SourceSection = ({ source, titled, children }: { source: LabSource; titled: boolean; children: ReactNode }) =>
  titled ? <section className="source-section"><h2>{SOURCE_NAMES[source]()}</h2>{children}</section> : <>{children}</>;
