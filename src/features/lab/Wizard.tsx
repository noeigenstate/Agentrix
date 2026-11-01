// The new-experiment form: source → project and sample → approaches → size and estimate. It holds the draft; the bridge answers (sample, estimate) are
// always the newest ones, and a step can only be left when what it needs is there.
import { useEffect, useState } from 'react';
import { Check } from '@phosphor-icons/react';
import type { LabBridge, LabExperimentInput } from '../../shared/lab-types';
import type { Result } from '../../shared/types';
import { t } from '../../shared/i18n';
import { dateLabel } from './format';
import { useResult } from './useResult';
import { ArmStep, ProjectStep, ScaleStep, SourceStep, type Sampling } from './WizardSteps';
import { clampRepeats, clampSize, defaultName, emptyDraft, missing, proposedBudget, toggleArm, toInput, type Draft, type Step } from './wizard-math';

type Api = Pick<LabBridge, 'sample' | 'estimate'>;

const MISSING_TEXT = { project: () => t('先选一个项目。'), tasks: () => t('这个项目还没有可用的任务。'), arms: () => t('至少选 2 个方案做对比。'), budget: () => t('填一个大于 0 的预算。') };

function StepNav({ step, onGo }: { step: Step; onGo: (step: Step) => void }) {
  const names = [t('任务来源'), t('项目与样本'), t('方案'), t('规模与估算')];
  return <ol className="steps" aria-label={t('步骤')}>{names.map((name, index) => {
    const at = (index + 1) as Step, done = at < step;
    return <li key={name} aria-current={at === step ? 'step' : undefined} data-done={done}>
      <button type="button" disabled={!done} onClick={() => onGo(at)}>
        <span className="step-dot">{done ? <Check size={12} weight="bold" /> : at}</span>{name}
      </button>
    </li>;
  })}</ol>;
}

export function Wizard({ projects, api, begin, onClose, onStarted }: {
  projects: { id: string; name: string }[]; api: Api; begin: (input: LabExperimentInput) => Promise<Result<string>>;
  onClose: () => void; onStarted: (id: string) => void;
}) {
  const [step, setStep] = useState<Step>(1), [reached, setReached] = useState<Step>(1);
  const [base, setBase] = useState<Draft>(emptyDraft), [sampling, setSampling] = useState<Sampling>({ size: 3, preferShortComplex: false });
  const [exclude, setExclude] = useState<string[]>([]), [budgetTouched, setBudgetTouched] = useState(false);
  const [starting, setStarting] = useState(false), [startError, setStartError] = useState<string | null>(null);
  const projectId = base.projectId || projects[0]?.id || '';

  // The sample is asked for once the form has reached step 2 and kept when the owner steps back; only a change to what it depends on asks again.
  const sample = useResult(() => reached >= 2 && projectId ? api.sample({ projectId, size: sampling.size, preferShortComplex: sampling.preferShortComplex, exclude }) : null,
    [reached >= 2, projectId, sampling.size, sampling.preferShortComplex, exclude.join()]);
  const tasks = sample.value ?? [];
  const draft: Draft = { ...base, projectId, tasks };
  const ready = step === 4 && !missing(3, draft);
  const estimate = useResult(() => ready ? api.estimate({ projectId, source: 'history', tasks, arms: draft.arms, repeats: draft.repeats }) : null,
    [ready, projectId, tasks.map(task => task.id).join(), draft.arms.join(), draft.repeats]);

  useEffect(() => { if (estimate.value && !budgetTouched) setBase(current => ({ ...current, budgetUsd: proposedBudget(estimate.value!) })); }, [estimate.value, budgetTouched]);

  const patch = (change: Partial<Draft>) => setBase(current => ({ ...current, ...change }));
  const go = (next: Step) => { setStep(next); setReached(current => Math.max(current, next) as Step); };
  const resample = (change: Partial<Sampling>) => { setSampling(current => ({ ...current, ...change, size: clampSize(change.size ?? current.size) })); setExclude([]); };
  const lack = missing(step, draft), projectName = projects.find(project => project.id === projectId)?.name ?? '';
  const exhausted = exclude.length > 0 && !sample.loading && !sample.error && tasks.length === 0;

  async function start() {
    setStarting(true); setStartError(null);
    const result = await begin(toInput(draft, draft.name.trim() || defaultName(projectName, dateLabel(Date.now()))));
    setStarting(false);
    if (result.ok) onStarted(result.value); else setStartError(result.error);
  }

  return <div className="wizard">
    <button type="button" className="button small back" onClick={onClose}>{t('返回实验列表')}</button>
    <StepNav step={step} onGo={go} />
    <div className="step-body">
      {step === 1 && <SourceStep />}
      {step === 2 && <ProjectStep projects={projects} projectId={projectId} sampling={sampling} onProject={id => { patch({ projectId: id }); setExclude([]); }} onSampling={resample}
        sample={{ tasks, loading: sample.loading, error: sample.error, exhausted }} onShuffle={() => setExclude(tasks.map(task => task.id))} onRetry={() => { if (exclude.length) setExclude([]); else sample.reload(); }} />}
      {step === 3 && <ArmStep arms={draft.arms} onToggle={arm => patch({ arms: toggleArm(draft.arms, arm) })} />}
      {step === 4 && <ScaleStep draft={draft} estimate={estimate.value} error={estimate.error} defaultName={defaultName(projectName, dateLabel(Date.now()))}
        onRepeats={value => patch({ repeats: clampRepeats(value) })} onBudget={value => { setBudgetTouched(true); patch({ budgetUsd: Math.max(0, value) }); }} onName={name => patch({ name })} />}
    </div>
    <footer className="wizard-foot">
      <button type="button" className="button" disabled={step === 1} onClick={() => go((step - 1) as Step)}>{t('上一步')}</button>
      <span className="muted" role="status">{lack ? MISSING_TEXT[lack]() : startError ? t('开始失败：{message}', { message: startError }) : step < 4 ? t('第 {n} / 4 步', { n: step }) : t('每次运行都在独立的工作树中进行')}</span>
      {step < 4 ? <button type="button" className="button primary" disabled={!!lack || sample.loading} onClick={() => go((step + 1) as Step)}>{t('下一步')}</button>
        : <button type="button" className="button primary" disabled={!!lack || starting} onClick={() => void start()}>{t('开始')}</button>}
    </footer>
  </div>;
}
