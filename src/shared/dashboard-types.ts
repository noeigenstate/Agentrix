// The model dashboard's contract between its window (src/features/dashboard) and the main process
// (electron/features/dashboard). Numbers are null when the records do not support a value: unknown, never 0.
import type { Result, Settings } from './types';

export type DashboardRange = '7d' | '30d' | 'all';
// projectId null: every project.
export type DashboardQuery = { projectId: string | null; range: DashboardRange };
export type DashboardFindingCategory = 'correctness' | 'security' | 'performance' | 'boundary' | 'ui';

// First pass: for a worker, an execution run that ended cleanly in scope, with no review finding against its author in
// that round and no rework after it; for the lead's model, a delivery the owner passed at its first submission.
// Ratios are 0..1. A model row's weight is the lowest of its adopted per-kind weights (1 when none).
export type DashboardModelRow = {
  model: string; agent: 'codex' | 'claude'; runs: number; firstPassRate: number | null;
  avgActiveMs: number | null; tokensPerSecond: number | null; findingsPerRun: number | null;
  sentBack: number; outOfScope: number; incidents: number;
  // The latest quota reading of this model's provider in the range (the larger window's percent).
  quotaPercent: number | null;
  // Public-price equivalent of the runs that have one; costedRuns says how many did.
  costUsd: number | null; costedRuns: number;
  // 1 unless the owner adopted a weight suggestion for this model; the per-kind values are in weights.
  weight: number;
};
export type DashboardKindRate = { kind: string; model: string; runs: number; firstPassRate: number | null };
// day is the local calendar day, yyyy-mm-dd. Rate from timed replies only (outputTokens / activeMs).
export type DashboardSpeedPoint = { day: string; model: string; tokensPerSecond: number | null };
export type DashboardWeight = { model: string; kind: string; from: number; to: number };
export type DashboardIncident = {
  at: number; project: string; meeting: string | null; model: string; kind: string; cause: string; fix: string;
  lead: 'missed' | 'copied' | null; weight: DashboardWeight | null;
};
// durationMs is the journal timestamp span; phases are summed active time; a phase with no runs is null, and so is
// questions for a round recorded before issues were journaled.
export type DashboardRound = {
  project: string; meeting: string; at: number; tasks: number; questions: number | null; findings: number;
  rework: number; outOfScope: number; incidents: number; durationMs: number | null; firstConfirmed: boolean;
  phases: { roundtable: number | null; build: number | null; review: number | null; rework: number | null };
};
export type DashboardFindingCell = { author: string; category: DashboardFindingCategory; count: number };
// One run in a model's task list (a model row opens it): newest first, at most 50 per model, in the query's range and
// project. firstPass is null when the run had no observable outcome.
export type DashboardModelRun = {
  model: string; at: number; project: string; title: string; kind: string | null; role: string | null; meeting: string | null;
  firstPass: boolean | null; reason: string | null; activeMs: number | null; outputTokens: number | null; costUsd: number | null;
};
// Generated from the records by fixed rules; id is stable for the same evidence so an adoption survives a refresh.
export type DashboardSuggestion = {
  id: string; kind: 'weight' | 'mechanism'; title: string; text: string; weight: DashboardWeight | null;
  state: 'open' | 'adopted' | 'dismissed';
};
export type DashboardKpis = {
  firstPassRate: number | null; runs: number; runsPrevious: number | null; incidents: number;
  quota: { provider: 'claude' | 'codex'; percent: number; minutes: number } | null;
  reworkPerRound: number | null; reworkPerRoundPrevious: number | null; rounds: number;
  roundtableFirstConfirm: number | null; findingsPerRound: number | null; findingFixRate: number | null;
};
export type DashboardSummary = {
  generatedAt: number; query: DashboardQuery;
  projects: { id: string; name: string }[];
  kpis: DashboardKpis;
  models: DashboardModelRow[]; kinds: DashboardKindRate[]; speed: DashboardSpeedPoint[];
  incidents: DashboardIncident[]; rounds: DashboardRound[]; findings: DashboardFindingCell[];
  suggestions: DashboardSuggestion[]; weights: DashboardWeight[]; modelRuns: DashboardModelRun[];
  // prices.json's date; models seen in runs without a price row are listed so the page can say so.
  prices: { updated: string; unpriced: string[] };
};
// What the dashboard window shows before and while it reads: the main window's theme, language and zoom.
export type DashboardAppearance = Pick<Settings, 'theme' | 'language' | 'uiZoom'>;

// window.agentrixDashboard, exposed only in the dashboard window by electron/features/dashboard/preload.cjs.
export type DashboardBridge = {
  summary(query: DashboardQuery): Promise<Result<DashboardSummary>>;
  // adopt / dismiss / reopen a suggestion; returns the summary for the same query after the change.
  decide(id: string, state: DashboardSuggestion['state'], query: DashboardQuery): Promise<Result<DashboardSummary>>;
  appearance(): Promise<Result<DashboardAppearance>>;
  onAppearance(callback: (appearance: DashboardAppearance) => void): () => void;
  // New records arrived (a run ended, a grade, a consolidation); the page re-reads its current query.
  onChanged(callback: () => void): () => void;
  close(): void; minimize(): void; maximize(): void;
};
declare global { interface Window { agentrixDashboard?: DashboardBridge; } }
