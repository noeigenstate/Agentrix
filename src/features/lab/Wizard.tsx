// The new-experiment form: sources → each source's scope and sample → approaches → size and estimate. It holds the draft; the bridge answers (sources, sample,
// estimate) are always the newest ones, and a step can only be left when what it needs is there.
import { useEffect, useState } from 'react';
import { Check } from '@phosphor-icons/react';
import type { LabBridge, LabExperimentInput, LabSourceInfo } from '../../shared/lab-types';
import type { Result } from '../../shared/types';
import { t } from '../../shared/i18n';
import { dateLabel, friendlyError } from './format';
import { BackButton } from './Marks';
import { SOURCE_ORDER } from './source-math';
import { lackText, nameScope } from './source-text';
import { AaStep, OssStep, ProjectStep, SourceSection } from './SourcePanels';
import { useResult } from './useResult';
import { useSamples } from './useSamples';
import { ArmStep, ScaleStep, SourceStep } from './WizardSteps';
import { canStart, chosenSources, clampRepeats, currentEstimate, defaultName, emptyDraft, missing, proposedBudget, toggleArm, toggleSource, toInput, toSelections, type Draft, type Step } from './wizard-math';

type Api = Pick<LabBridge, 'sample' | 'estimate'>;

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

export function Wizard({ projects, sources, api, begin, onAaKey, onClose, onStarted }: {
  projects: { id: string; name: string }[]; sources: LabSourceInfo[] | null; api: Api; begin: (input: LabExperimentInput) => Promise<Result<string>>;
  onAaKey: (key: string | null) => Promise<string | null>; onClose: () => void; onStarted: (id: string) => void;
}) {
  const [step, setStep] = useState<Step>(1), [reached, setReached] = useState<Step>(1);
  const [base, setBase] = useState<Draft>(emptyDraft), [budgetTouched, setBudgetTouched] = useState(false);
  const [starting, setStarting] = useState(false), [startError, setStartError] = useState<string | null>(null);
  const { draft, panels, loading, preferShortComplex, onPrefer, onRescope } = useSamples({ api, infos: sources, projects, base, active: reached >= 2 });
  const chosen = chosenSources(draft), selections = toSelections(draft);

  const ready = step === 4 && !missing(3, draft);
  const estimate = useResult(() => ready ? api.estimate({ selections, arms: draft.arms, repeats: draft.repeats }) : null,
    [ready, JSON.stringify(selections), draft.arms.join(), draft.repeats]);
  // An estimate counts only while it answers the draft as it is now (tasks, approaches, repeats); the moment one of them changes it stops counting, and the
  // experiment cannot start until the new one has arrived. A failed estimate does not count either: it is shown with a retry.
  const { value: estimated, error: failed } = currentEstimate(estimate);

  useEffect(() => { if (estimated && !budgetTouched) setBase(previous => ({ ...previous, budgetUsd: proposedBudget(estimated) })); }, [estimated, budgetTouched]);

  const patch = (change: Partial<Draft>) => setBase(current => ({ ...current, ...change }));
  const go = (next: Step) => { setStep(next); setReached(current => Math.max(current, next) as Step); };
  const lack = missing(step, draft), several = chosen.length > 1;
  const name = nameScope(chosen, projects.find(project => project.id === draft.history.projectId)?.name ?? '');

  async function start() {
    if (!canStart(lack, estimated, starting)) return;
    setStarting(true); setStartError(null);
    const result = await begin(toInput(draft, draft.name.trim() || defaultName(name, dateLabel(Date.now()))));
    setStarting(false);
    if (result.ok) onStarted(result.value); else setStartError(result.error);
  }

  const panelOf = {
    history: <ProjectStep projects={projects} projectId={draft.history.projectId} preferShortComplex={preferShortComplex} panel={panels.history} onPrefer={onPrefer}
      onProject={projectId => { patch({ history: { ...base.history, projectId } }); onRescope('history'); }} />,
    oss: <OssStep options={sources?.find(info => info.id === 'oss')?.options ?? []} repos={draft.oss.repos} panel={panels.oss}
      onRepos={repos => { patch({ oss: { ...base.oss, repos } }); onRescope('oss'); }} />,
    aa: <AaStep info={sources?.find(info => info.id === 'aa')} benchmark={draft.aa.benchmark} panel={panels.aa} onKey={onAaKey}
      onBenchmark={benchmark => { patch({ aa: { ...base.aa, benchmark } }); onRescope('aa'); }} />,
  };

  return <div className="wizard">
    <div className="toolbar"><BackButton onClick={onClose} /></div>
    <StepNav step={step} onGo={go} />
    <div className="step-body">
      {step === 1 && <SourceStep sources={sources} chosen={chosen} onToggle={source => patch({ sources: toggleSource(base.sources, source) })} />}
      {step === 2 && SOURCE_ORDER.filter(source => chosen.includes(source)).map(source => <SourceSection key={source} source={source} titled={several}>{panelOf[source]}</SourceSection>)}
      {step === 3 && <ArmStep arms={draft.arms} onToggle={arm => patch({ arms: toggleArm(draft.arms, arm) })} />}
      {step === 4 && <ScaleStep draft={draft} infos={sources ?? []} estimate={estimated} error={failed && friendlyError(failed)} onRetry={estimate.reload} defaultName={defaultName(name, dateLabel(Date.now()))}
        onRepeats={value => patch({ repeats: clampRepeats(value) })} onBudget={value => { setBudgetTouched(true); patch({ budgetUsd: Math.max(0, value) }); }} onName={value => patch({ name: value })} />}
    </div>
    <footer className="wizard-foot">
      <button type="button" className="button" disabled={step === 1} onClick={() => go((step - 1) as Step)}>{t('上一步')}</button>
      <span className="muted" role="status">{lack ? lackText(lack, several) : startError ? t('开始失败：{message}', { message: friendlyError(startError) }) : step < 4 ? t('第 {n} / 4 步', { n: step }) : estimated ? t('每次运行都在独立的工作树中进行') : failed ? t('估算没有成功，不能开始。') : t('正在估算…')}</span>
      {step < 4 ? <button type="button" className="button primary" disabled={!!lack || loading} onClick={() => go((step + 1) as Step)}>{t('下一步')}</button>
        : <button type="button" className="button primary" disabled={!canStart(lack, estimated, starting)} onClick={() => void start()}>{t('开始')}</button>}
    </footer>
  </div>;
}
