// What the new-experiment form allows: the limits of each step, what is missing before the next one, and the defaults it proposes.
import type { LabArm, LabEstimate, LabExperimentInput, LabTask } from '../../shared/lab-types';
import { clamp } from './chart-math';

export const SIZE = { min: 1, max: 10, standard: 3 };
export const REPEATS = { min: 1, max: 5, standard: 3 };
export const MIN_ARMS = 2;
// The largest experiment the form allows: the gauges show a plan's size against it.
export const MAX_RUNS = SIZE.max * 4 * REPEATS.max;

export type Draft = { projectId: string; tasks: LabTask[]; arms: LabArm[]; repeats: number; budgetUsd: number; name: string };
export const emptyDraft = (): Draft => ({ projectId: '', tasks: [], arms: ['orchestrated', 'opus'], repeats: REPEATS.standard, budgetUsd: 0, name: '' });

export const clampSize = (size: number) => clamp(Number.isFinite(size) ? Math.round(size) : SIZE.standard, SIZE.min, SIZE.max);
export const clampRepeats = (repeats: number) => clamp(Number.isFinite(repeats) ? Math.round(repeats) : REPEATS.standard, REPEATS.min, REPEATS.max);

export type Step = 1 | 2 | 3 | 4;
export type Missing = 'project' | 'tasks' | 'arms' | 'budget' | null;

// What stops the form leaving a step (or starting): step 1 only chooses a source, which is always valid.
export function missing(step: Step, draft: Draft): Missing {
  if (step >= 2 && !draft.projectId) return 'project';
  if (step >= 2 && !draft.tasks.length) return 'tasks';
  if (step >= 3 && draft.arms.length < MIN_ARMS) return 'arms';
  if (step >= 4 && !(draft.budgetUsd > 0)) return 'budget';
  return null;
}

export const toggleArm = (arms: LabArm[], arm: LabArm) => arms.includes(arm) ? arms.filter(item => item !== arm) : [...arms, arm];

// The budget the form proposes: the estimate with half again for the unlucky runs, rounded up to a round dollar amount.
export const proposedBudget = (estimate: LabEstimate) => Math.max(5, Math.ceil(estimate.costUsd * 1.5 / 5) * 5);

export const defaultName = (projectName: string, date: string) => `${projectName} · ${date}`;

export function toInput(draft: Draft, name: string): LabExperimentInput {
  return { name, projectId: draft.projectId, source: 'history', tasks: draft.tasks, arms: draft.arms, repeats: draft.repeats, budgetUsd: draft.budgetUsd };
}
