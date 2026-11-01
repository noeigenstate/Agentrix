// What an experiment's runs add up to: the pass rule, per-approach totals, scores per task kind, the matrix cells, the conclusion and the
// run the orchestration flow shows. Pure functions over the contract's data; an unknown number stays null and is never counted as 0.
import type { LabArm, LabExperiment, LabPhase, LabRun, LabRunState } from '../../shared/lab-types';

export const ALL_ARMS: LabArm[] = ['orchestrated', 'opus', 'sol', 'sonnet'];
// One shape per approach, used with its colour in every chart so the colour is never the only cue.
export const SHAPES = { orchestrated: 'circle', opus: 'square', sol: 'diamond', sonnet: 'triangle' } as const;

const DONE: LabRunState[] = ['passed', 'failed', 'error', 'stopped'];
const MEASURED: LabRunState[] = ['passed', 'failed', 'error'];
export const isDone = (run: LabRun) => DONE.includes(run.state);

const total = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) : null;
const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const known = (values: (number | null)[]) => values.filter((value): value is number => value !== null);

export const runsFor = (experiment: LabExperiment, arm: LabArm, taskId?: string) =>
  experiment.runs.filter(run => run.arm === arm && (taskId === undefined || run.taskId === taskId));

// A task passes for an approach when all its hidden tests pass in most of its repeats; a run that never finished counts against it.
export const taskPasses = (experiment: LabExperiment, arm: LabArm, taskId: string) =>
  runsFor(experiment, arm, taskId).filter(run => run.state === 'passed').length * 2 > experiment.repeats;

export function armSummary(experiment: LabExperiment, arm: LabArm) {
  const runs = runsFor(experiment, arm), done = runs.filter(isDone), measured = runs.filter(run => MEASURED.includes(run.state));
  const costs = known(measured.map(run => run.costUsd));
  const tasksPassed = experiment.tasks.filter(task => taskPasses(experiment, arm, task.id)).length;
  return {
    tasks: experiment.tasks.length, tasksPassed, rate: experiment.tasks.length ? tasksPassed / experiment.tasks.length : null,
    runs: runs.length, done: done.length,
    reviewIssues: average(known(measured.map(run => run.reviewIssues))),
    ms: total(done.flatMap(run => run.startedAt !== null && run.endedAt !== null ? [run.endedAt - run.startedAt] : [])),
    costUsd: total(costs), unpriced: measured.length - costs.length,
    rework: total(known(measured.map(run => run.rework))),
  };
}
export type ArmSummary = ReturnType<typeof armSummary>;

// A run's score is the share of its hidden tests that pass; when the counts are unknown a pass is 1 and a failure 0, and anything else is unmeasured.
export function runScore(run: LabRun): number | null {
  if (run.testsTotal && run.testsPassed !== null) return run.testsPassed / run.testsTotal;
  return run.state === 'passed' ? 1 : run.state === 'failed' ? 0 : null;
}

export function spread(values: number[]) {
  const mean = average(values);
  if (mean === null) return null;
  const sd = values.length > 1 ? Math.sqrt(total(values.map(value => (value - mean) ** 2))! / (values.length - 1)) : 0;
  return { mean, sd, n: values.length };
}

export const kindsOf = (experiment: LabExperiment) => [...new Set(experiment.tasks.map(task => task.kind))];

// The score of one approach on one task kind: the mean of the repeats (each repeat averages the tasks of that kind), with the standard deviation over the repeats.
export function kindScore(experiment: LabExperiment, kind: string, arm: LabArm) {
  const ids = new Set(experiment.tasks.filter(task => task.kind === kind).map(task => task.id));
  const byRepeat = new Map<number, number[]>();
  for (const run of runsFor(experiment, arm)) {
    const score = ids.has(run.taskId) ? runScore(run) : null;
    if (score !== null) byRepeat.set(run.repeat, [...(byRepeat.get(run.repeat) ?? []), score]);
  }
  return spread(known([...byRepeat.values()].map(average)));
}

export function matrixCell(experiment: LabExperiment, arm: LabArm, taskId: string) {
  const runs = runsFor(experiment, arm, taskId), counted = runs.filter(run => run.testsTotal && run.testsPassed !== null);
  const testsTotal = total(counted.map(run => run.testsTotal!)), testsPassed = total(counted.map(run => run.testsPassed!));
  return { testsPassed, testsTotal, share: testsTotal ? testsPassed! / testsTotal : null, passes: taskPasses(experiment, arm, taskId), settled: runs.length > 0 && runs.every(isDone) };
}

export type Conclusion =
  | { kind: 'none' }
  | { kind: 'tie'; arms: [LabArm, LabArm]; passed: number; tasks: number }
  | { kind: 'lead'; leader: LabArm; other: LabArm; leaderPassed: number; otherPassed: number; tasks: number; costRatio: number | null };

// The leader passes the most tasks (the cheaper one on a tie in passes); it is compared with the runner-up, and the cost ratio is given only when both costs are fully known.
export function conclude(experiment: LabExperiment): Conclusion {
  const rows = experiment.arms.map(arm => ({ arm, ...armSummary(experiment, arm) })).filter(row => row.done > 0);
  if (rows.length < 2) return { kind: 'none' };
  const cost = (row: typeof rows[number]) => row.costUsd !== null && row.unpriced === 0 ? row.costUsd : Infinity;
  const [leader, other] = [...rows].sort((a, b) => b.tasksPassed - a.tasksPassed || cost(a) - cost(b));
  if (leader.tasksPassed === other.tasksPassed && cost(leader) === cost(other)) return { kind: 'tie', arms: [leader.arm, other.arm], passed: leader.tasksPassed, tasks: leader.tasks };
  const ratio = cost(leader) !== Infinity && cost(other) !== Infinity && cost(other) > 0 ? cost(leader) / cost(other) : null;
  return { kind: 'lead', leader: leader.arm, other: other.arm, leaderPassed: leader.tasksPassed, otherPassed: other.tasksPassed, tasks: leader.tasks, costRatio: ratio };
}

export const phaseTotal = (phases: LabPhase[]) => phases.reduce((sum, phase) => sum + phase.ms, 0);

// The orchestrated run whose total time is the median (the lower one of an even count): neither the luckiest nor the worst.
export function representativeRun(experiment: LabExperiment) {
  const runs = runsFor(experiment, 'orchestrated').filter(run => isDone(run) && run.phases?.length).sort((a, b) => phaseTotal(a.phases!) - phaseTotal(b.phases!));
  return runs[Math.floor((runs.length - 1) / 2)] ?? null;
}

export function progress(experiment: LabExperiment, now: number) {
  const planned = experiment.tasks.length * experiment.arms.length * experiment.repeats, count = Math.max(planned, experiment.runs.length);
  const done = experiment.runs.filter(isDone), starts = known(experiment.runs.map(run => run.startedAt));
  const spans = done.flatMap(run => run.startedAt !== null && run.endedAt !== null ? [run.endedAt - run.startedAt] : []);
  const mean = average(spans);
  return {
    count, done: done.length, share: count ? done.length / count : 0,
    elapsedMs: starts.length ? now - Math.min(...starts) : null,
    // What is left is the number of runs not finished times the mean finished run: unknown until one has finished.
    remainingMs: mean === null ? null : mean * (count - done.length),
  };
}

export const ranArms = (experiment: LabExperiment) => ALL_ARMS.filter(arm => experiment.arms.includes(arm));
