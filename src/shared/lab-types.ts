import type { Result, Settings } from './types';

// The Virtual Lab (虚拟实验室): experiments that compare orchestrated work with single models on tasks whose right
// answer is known. Shared by the lab window (src/features/lab) and its main-process engine (electron/features/lab).
// The task sources are providers behind one contract (electron/features/lab/sources/contract.cjs); one experiment runs
// up to three of them side by side as lanes, each graded on its own scale.

export type LabArm = 'orchestrated' | 'opus' | 'sol' | 'sonnet';
// history: the project's own past changes; oss: curated SWE-bench Verified Python tasks; aa: Terminal-Bench, "AA 同款".
export type LabSource = 'history' | 'oss' | 'aa';
// What a source's score means: history = its hidden tests, oss = resolved (every FAIL_TO_PASS and PASS_TO_PASS test
// passes), aa = the task's own test suite.
export type LabMetric = 'hidden-tests' | 'resolved' | 'tests';

// One choice inside a source's step-2 panel: a history project, an oss repository or an aa benchmark.
export type LabSourceOption = { id: string; name: string; detail: string | null; tasks: number | null; license: string | null };
// Published reference scores (AA's API), dated and attributed; comparable only when harness and task set match ours.
export type LabPublished = {
  label: string; url: string; asOf: string; harness: string; comparable: boolean; note: string | null;
  values: Partial<Record<LabArm, number>>;
};
export type LabSourceInfo = {
  id: LabSource; available: boolean; reason: string | null; metric: LabMetric; review: boolean;
  size: { min: number; max: number; standard: number }; options: LabSourceOption[];
  manifest: { version: string; sha256: string } | null; published: LabPublished | null; downloadBytes: number | null;
  // Whether the owner's key for this source is stored (aa only; null where a source takes no key). The key never leaves main.
  keyStored: boolean | null;
};

// A task never carries its answer: gold patches, hidden test contents and test patches stay in main's cache.
type LabTaskBase = { id: string; source: LabSource; title: string; text: string; kind: string; why: string };
// A past change of the project that came with tests: the run starts from its parent and is graded by its own tests.
export type LabHistoryTask = LabTaskBase & {
  source: 'history'; commit: string; base: string; modules: string[]; linesChanged: number; hiddenTests: string[];
};
export type LabOssTask = LabTaskBase & {
  source: 'oss'; repo: string; commit: string; language: 'python'; upstream: string | null; license: string | null;
};
export type LabAaTask = LabTaskBase & { source: 'aa'; benchmark: 'terminal-bench-4'; item: string; category: string | null };
export type LabTask = LabHistoryTask | LabOssTask | LabAaTask;

export type LabSampleQuery =
  | { source: 'history'; projectId: string; size: number; preferShortComplex: boolean; exclude?: string[] }
  | { source: 'oss'; repos: string[]; size: number; exclude?: string[] }
  | { source: 'aa'; benchmark: string; size: number; exclude?: string[] };
// The page names tasks by id only; main rebuilds every task from its own data.
export type LabSelection =
  | { source: 'history'; projectId: string; tasks: { id: string }[] }
  | { source: 'oss'; repos: string[]; tasks: { id: string }[] }
  | { source: 'aa'; benchmark: string; tasks: { id: string }[] };
export type LabExperimentInput = { name?: string; selections: LabSelection[]; arms: LabArm[]; repeats: number; budgetUsd: number };
export type LabEstimateInput = Omit<LabExperimentInput, 'name' | 'budgetUsd'>;
// share: this source's fraction of the budget (the slices sum to the whole budget).
export type LabSourceEstimate = { source: LabSource; runs: number; minutes: number; costUsd: number; basis: 'history' | 'default'; share: number };
export type LabEstimate = { runs: number; minutes: number; costUsd: number; basis: 'history' | 'default'; sources: LabSourceEstimate[] };

export type LabPhase = { name: 'plan' | 'roundtable' | 'build' | 'review' | 'rework'; ms: number; count?: number };
export type LabRunState = 'queued' | 'running' | 'passed' | 'failed' | 'error' | 'stopped';
// Unknown measurements stay null: the lab never invents a number. score is 0..1 on the run's source's own scale.
export type LabRun = {
  id: string; taskId: string; source: LabSource; arm: LabArm; repeat: number; state: LabRunState;
  startedAt: number | null; endedAt: number | null; activeModel: string | null;
  testsPassed: number | null; testsTotal: number | null; score: number | null; reviewIssues: number | null;
  costUsd: number | null; outputTokens: number | null; rework: number | null;
  phases?: LabPhase[]; error?: string;
};

// One source inside an experiment: its own budget slice, state and grading scale. scope is the lane's label
// (the project, repositories or benchmark); manifest and published are snapshots taken at start.
export type LabLane = {
  source: LabSource; state: 'queued' | 'running' | 'done' | 'stopped' | 'error'; scope: string; metric: LabMetric;
  review: boolean; budgetUsd: number; spentUsd: number; error: string | null;
  manifest: { version: string; sha256: string } | null; published: LabPublished | null;
};

// projectId/projectName are set only when a history lane is present; spentUsd is the sum of the lanes' spentUsd.
export type LabExperiment = {
  id: string; name: string; createdAt: number; projectId: string | null; projectName: string | null;
  sources: LabSource[]; lanes: LabLane[];
  tasks: LabTask[]; arms: LabArm[]; repeats: number; budgetUsd: number;
  state: 'running' | 'done' | 'stopped' | 'error'; runs: LabRun[]; spentUsd: number;
};

export type LabAppearance = { theme: Settings['theme']; language: Settings['language']; uiZoom: number };

// The lab window's preload exposes only this, shaped like the dashboard's bridge.
export type LabBridge = {
  list(): Promise<Result<LabExperiment[]>>;
  projects(): Promise<Result<{ id: string; name: string }[]>>;
  sources(): Promise<Result<LabSourceInfo[]>>;
  // Stores (a string) or clears (null) the owner's AA API key with safeStorage; answers whether a key is stored now.
  aaKey(set: string | null): Promise<Result<boolean>>;
  sample(query: LabSampleQuery): Promise<Result<LabTask[]>>;
  estimate(input: LabEstimateInput): Promise<Result<LabEstimate>>;
  start(input: LabExperimentInput): Promise<Result<string>>;
  stop(id: string): Promise<Result<void>>;
  remove(id: string): Promise<Result<void>>;
  appearance(): Promise<Result<LabAppearance>>;
  onAppearance(callback: (appearance: LabAppearance) => void): () => void;
  onChange(callback: (experiments: LabExperiment[]) => void): () => void;
  close(): void; minimize(): void; maximize(): void;
};
declare global { interface Window { agentrixLab?: LabBridge; } }
