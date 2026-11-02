// What several sources add up to. Each source is graded on its own scale, so nothing here adds or averages a score across sources: the combined view
// only counts which approach leads in how many sources, and sums cost and time. Pure functions over the contract's data.
import type { LabExperiment, LabLane, LabMetric, LabSource } from '../../shared/lab-types';
import { armSummary, conclude, ranArms } from './results-math';

export const SOURCE_ORDER: LabSource[] = ['history', 'oss', 'aa'];

// A lane has no queued state of its own in the figures: a queued or running lane is a running experiment.
const SLICE_STATE = { queued: 'running', running: 'running', done: 'done', stopped: 'stopped', error: 'error' } as const;

// One source's share of an experiment, in the shape the single-source screens already draw: its tasks, its runs, and its own budget, spend and state.
export function sliceExperiment(experiment: LabExperiment, source: LabSource): LabExperiment {
  const lane: LabLane | undefined = experiment.lanes.find(item => item.source === source);
  return {
    ...experiment, sources: [source], lanes: lane ? [lane] : [],
    tasks: experiment.tasks.filter(task => task.source === source), runs: experiment.runs.filter(run => run.source === source),
    budgetUsd: lane?.budgetUsd ?? experiment.budgetUsd, spentUsd: lane?.spentUsd ?? experiment.spentUsd, state: lane ? SLICE_STATE[lane.state] : experiment.state,
  };
}

// A single-source experiment has one metric; an experiment without lanes is an old history one.
export const metricOf = (experiment: LabExperiment): LabMetric => experiment.lanes[0]?.metric ?? 'hidden-tests';

// What the experiment is about, for a title or a card: the project when only history ran, otherwise every lane's own scope.
export const scopeLabel = (experiment: LabExperiment) =>
  experiment.lanes.length === 1 && experiment.projectName ? experiment.projectName : experiment.lanes.map(lane => lane.scope).join(' · ') || experiment.projectName || '';

// The 95% Wilson score interval of a success rate: it stays inside 0..1 and is honest about few tasks, unlike mean ± sd.
export function wilson(successes: number, total: number) {
  if (total <= 0) return null;
  const z = 1.96, p = successes / total, denominator = 1 + z * z / total;
  const centre = (p + z * z / (2 * total)) / denominator, half = z * Math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / denominator;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

// The combined view: per approach, in how many sources it leads (by that source's own conclusion, a tie leads nowhere), plus cost and time summed over every run.
export function combine(experiment: LabExperiment) {
  const conclusions = experiment.lanes.map(lane => conclude(sliceExperiment(experiment, lane.source)));
  const rows = ranArms(experiment).map(arm => {
    const { costUsd, unpriced, ms } = armSummary(experiment, arm);
    return { arm, leads: conclusions.filter(conclusion => conclusion.kind === 'lead' && conclusion.leader === arm).length, costUsd, unpriced, ms };
  });
  return { sources: conclusions.length, rows };
}
