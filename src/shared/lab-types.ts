import type { Result } from './types';

// The Virtual Lab (虚拟实验室): experiments that compare orchestrated work with single models on tasks whose right
// answer is known. Shared by the lab window (src/features/lab) and its main-process engine (electron/features/lab).

export type LabArm = 'orchestrated' | 'opus' | 'sol' | 'sonnet';
// Only 'history' runs in the first version; 'oss' (well-known GitHub projects) and 'aa' (Artificial Analysis tests) follow.
export type LabSource = 'history' | 'oss' | 'aa';

// A past change of the project that came with tests: the run starts from its parent and is graded by its own tests.
export type LabTask = {
  id: string; title: string; text: string; commit: string; base: string;
  modules: string[]; linesChanged: number; hiddenTests: string[];
  kind: string; why: string;
};

export type LabSampleRequest = { projectId: string; size: number; preferShortComplex: boolean; exclude?: string[] };
export type LabEstimate = { runs: number; minutes: number; costUsd: number; basis: 'history' | 'default' };
export type LabExperimentInput = { name?: string; projectId: string; source: 'history'; tasks: LabTask[]; arms: LabArm[]; repeats: number; budgetUsd: number };

export type LabPhase = { name: 'plan' | 'roundtable' | 'build' | 'review' | 'rework'; ms: number; count?: number };
export type LabRunState = 'queued' | 'running' | 'passed' | 'failed' | 'error' | 'stopped';
// Unknown measurements stay null: the lab never invents a number.
export type LabRun = {
  id: string; taskId: string; arm: LabArm; repeat: number; state: LabRunState;
  startedAt: number | null; endedAt: number | null; activeModel: string | null;
  testsPassed: number | null; testsTotal: number | null; reviewIssues: number | null;
  costUsd: number | null; outputTokens: number | null; rework: number | null;
  phases?: LabPhase[]; error?: string;
};

export type LabExperiment = {
  id: string; name: string; createdAt: number; projectId: string; projectName: string; source: LabSource;
  tasks: LabTask[]; arms: LabArm[]; repeats: number; budgetUsd: number;
  state: 'running' | 'done' | 'stopped' | 'error'; runs: LabRun[]; spentUsd: number;
};

export type LabAppearance = { theme: string; language: 'zh' | 'en'; uiZoom: number };

// The lab window's preload exposes only this, shaped like the dashboard's bridge.
export type LabBridge = {
  list(): Promise<Result<LabExperiment[]>>;
  projects(): Promise<Result<{ id: string; name: string }[]>>;
  sample(request: LabSampleRequest): Promise<Result<LabTask[]>>;
  estimate(input: Omit<LabExperimentInput, 'name' | 'budgetUsd'>): Promise<Result<LabEstimate>>;
  start(input: LabExperimentInput): Promise<Result<string>>;
  stop(id: string): Promise<Result<void>>;
  remove(id: string): Promise<Result<void>>;
  appearance(): Promise<Result<LabAppearance>>;
  onAppearance(callback: (appearance: LabAppearance) => void): () => void;
  onChange(callback: (experiments: LabExperiment[]) => void): () => void;
  close(): void; minimize(): void; maximize(): void;
};
declare global { interface Window { agentrixLab?: LabBridge; } }
