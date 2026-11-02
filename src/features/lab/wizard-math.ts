// What the new-experiment form allows: the limits of each step, what is missing before the next one, and the defaults it proposes. The form holds one
// draft per source (its scope and its sampled tasks); a source takes part only while it is chosen.
import type { LabArm, LabEstimate, LabExperimentInput, LabSampleQuery, LabSelection, LabSource, LabSourceInfo, LabTask } from '../../shared/lab-types';
import { clamp } from './chart-math';
import { SOURCE_ORDER } from './source-math';

export const SIZE = { min: 1, max: 10, standard: 3 };
export const REPEATS = { min: 1, max: 5, standard: 3 };
export const MIN_ARMS = 2;

export type Draft = {
  sources: LabSource[];
  history: { projectId: string; tasks: LabTask[] };
  oss: { repos: string[]; tasks: LabTask[] };
  aa: { benchmark: string; tasks: LabTask[] };
  arms: LabArm[]; repeats: number; budgetUsd: number; name: string;
};
export const emptyDraft = (): Draft => ({
  sources: ['history'], history: { projectId: '', tasks: [] }, oss: { repos: [], tasks: [] }, aa: { benchmark: '', tasks: [] },
  arms: ['orchestrated', 'opus'], repeats: REPEATS.standard, budgetUsd: 0, name: '',
});

export const clampSize = (size: number, range = SIZE) => clamp(Number.isFinite(size) ? Math.round(size) : range.standard, range.min, range.max);
export const clampRepeats = (repeats: number) => clamp(Number.isFinite(repeats) ? Math.round(repeats) : REPEATS.standard, REPEATS.min, REPEATS.max);

export type Step = 1 | 2 | 3 | 4;
export type Missing = { need: 'sources' | 'scope' | 'tasks' | 'arms' | 'budget'; source?: LabSource } | null;

const hasScope = (draft: Draft, source: LabSource) => source === 'history' ? !!draft.history.projectId : source === 'oss' ? draft.oss.repos.length > 0 : !!draft.aa.benchmark;
// The chosen sources in the fixed order history, oss, aa, whatever order they were ticked in.
export const chosenSources = (draft: Draft) => SOURCE_ORDER.filter(source => draft.sources.includes(source));
export const taskTotal = (draft: Draft) => chosenSources(draft).reduce((sum, source) => sum + draft[source].tasks.length, 0);

// What stops the form leaving a step (or starting), naming the source that lacks something: step 1 needs a source, step 2 a scope and a task for each.
export function missing(step: Step, draft: Draft): Missing {
  if (!draft.sources.length) return { need: 'sources' };
  if (step >= 2) for (const source of chosenSources(draft)) {
    if (!hasScope(draft, source)) return { need: 'scope', source };
    if (!draft[source].tasks.length) return { need: 'tasks', source };
  }
  if (step >= 3 && draft.arms.length < MIN_ARMS) return { need: 'arms' };
  if (step >= 4 && !(draft.budgetUsd > 0)) return { need: 'budget' };
  return null;
}

export const toggleArm = (arms: LabArm[], arm: LabArm) => arms.includes(arm) ? arms.filter(item => item !== arm) : [...arms, arm];
// Flips one source in or out, keeping the fixed order.
export const toggleSource = (sources: LabSource[], source: LabSource) => SOURCE_ORDER.filter(item => (item === source) !== sources.includes(item));

// The sources the owner can choose now: those the bridge reports available.
export const availableSources = (infos: LabSourceInfo[] | null) => (infos ?? []).filter(info => info.available).map(info => info.id);

export const withTasks = (draft: Draft, tasks: Record<LabSource, LabTask[]>): Draft => ({
  ...draft, history: { ...draft.history, tasks: tasks.history }, oss: { ...draft.oss, tasks: tasks.oss }, aa: { ...draft.aa, tasks: tasks.aa },
});

// The sample asked of one source, from its scope; null while it has no scope. The size range and the short-and-complex preference belong to their source.
export function sampleQuery(draft: Draft, source: LabSource, size: number, exclude: string[], preferShortComplex: boolean): LabSampleQuery | null {
  if (!hasScope(draft, source)) return null;
  if (source === 'history') return { source, projectId: draft.history.projectId, size, preferShortComplex, exclude };
  return source === 'oss' ? { source, repos: draft.oss.repos, size, exclude } : { source, benchmark: draft.aa.benchmark, size, exclude };
}

export function toSelections(draft: Draft): LabSelection[] {
  return chosenSources(draft).map((source): LabSelection => {
    const tasks = draft[source].tasks.map(({ id }) => ({ id }));
    if (source === 'history') return { source, projectId: draft.history.projectId, tasks };
    return source === 'oss' ? { source, repos: draft.oss.repos, tasks } : { source, benchmark: draft.aa.benchmark, tasks };
  });
}

// The budget the form proposes: the estimate with half again for the unlucky runs, rounded up to a round dollar amount.
export const proposedBudget = (estimate: LabEstimate) => Math.max(5, Math.ceil(estimate.costUsd * 1.5 / 5) * 5);

export const defaultName = (scope: string, date: string) => `${scope} · ${date}`;

export const toInput = (draft: Draft, name: string): LabExperimentInput => ({ name, selections: toSelections(draft), arms: draft.arms, repeats: draft.repeats, budgetUsd: draft.budgetUsd });

// What the form may use of an estimate: only an answer to the draft as it is now that has finished. An answer to an earlier draft, one still on its way
// and a failure all count as no estimate; a failure is shown with a retry.
export function currentEstimate<T>(result: { fresh: boolean; loading: boolean; value: T | null; error: string | null }) {
  const settled = result.fresh && !result.loading;
  return { value: settled ? result.value : null, error: settled ? result.error : null };
}

// The experiment starts only with everything filled in and a current estimate in hand.
export const canStart = (lack: Missing, estimate: LabEstimate | null, starting: boolean) => lack === null && estimate !== null && !starting;

// How many tasks a source can be sampled for, as it says; the history range until it has said.
export const sizeRange = (infos: LabSourceInfo[] | null, source: LabSource) => infos?.find(info => info.id === source)?.size ?? SIZE;
