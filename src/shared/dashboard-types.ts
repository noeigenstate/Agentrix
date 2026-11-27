// The model dashboard's contract between its window (src/features/dashboard) and the main process
// (electron/features/dashboard). The dashboard shows how reliably each model's dispatched tasks come back tested.
import type { AgentProvider } from './agent-events';
import type { Result, Settings } from './types';

export type DashboardRange = '7d' | '30d' | 'all';
// projectId null: every project.
export type DashboardQuery = { projectId: string | null; range: DashboardRange };

// A group of tasks by outcome. passed: the role's own checks ran and none failed; failed: one or more checks failed;
// untested: it ended cleanly without a check that ran (also every record from before checks were kept); unfinished:
// it failed, was stopped, never started or changed files out of scope. passRate is passed / tasks (0..1). small: fewer
// tasks than the summary's minTasks, too few to rank on.
export type DashboardOutcomes = {
  tasks: number; passed: number; failed: number; untested: number; unfinished: number; passRate: number; small: boolean;
};
// One row per model, most reliable first: models with enough tasks before small samples, then by pass rate.
export type DashboardModelRow = DashboardOutcomes & { model: string; agent: AgentProvider };
// One cell per task kind and model. kind 'unreported' for tasks dispatched without one.
export type DashboardKindCell = DashboardOutcomes & { kind: string; model: string };
// A model's pass rate at one bucket: for days, over the seven days ending that day; for weeks, that week. No tasks there, no point.
export type DashboardTrendPoint = { bucket: string; model: string; tasks: number; passed: number; passRate: number };
// Buckets are local days, or weeks from Monday when the range spans more than 60 days, named by their first day (yyyy-mm-dd), oldest first.
export type DashboardTrend = { unit: 'day' | 'week'; buckets: string[]; points: DashboardTrendPoint[] };
export type DashboardSummary = {
  generatedAt: number; query: DashboardQuery;
  projects: { id: string; name: string }[];
  minTasks: number;
  models: DashboardModelRow[]; kinds: DashboardKindCell[]; trend: DashboardTrend;
};
// What the dashboard window shows before and while it reads: the main window's theme, language and zoom.
export type DashboardAppearance = Pick<Settings, 'theme' | 'language' | 'uiZoom'>;

// window.agentrixDashboard, exposed only in the dashboard window by electron/features/dashboard/preload.cjs.
export type DashboardBridge = {
  summary(query: DashboardQuery): Promise<Result<DashboardSummary>>;
  appearance(): Promise<Result<DashboardAppearance>>;
  onAppearance(callback: (appearance: DashboardAppearance) => void): () => void;
  // Records or the time changed; the page re-reads its current query.
  onChanged(callback: () => void): () => void;
  close(): void; minimize(): void; maximize(): void;
};
declare global { interface Window { agentrixDashboard?: DashboardBridge; } }
