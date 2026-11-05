// The renderer's one view of the main process's native sessions: window.agentrix.nativeSession (contract-addendum 4). The bridge itself
// and its preload wiring belong to the main side; this file is the consumer-side shape of it, so the rest of the module never reaches
// into window. Every call returns a Result; a build or a test without the bridge reads as "no native sessions" (null).
import type { AgentCommand, ConnectionTest, Result } from '../../shared/types';
import type { AgentEvent, LimitsPayload as SharedLimits, NativeAnswer, NativeSnapshot } from '../../shared/agent-events';
export type { NativeAnswer, NativeSnapshot, NativeDraft, NativeHandoff, NativeHandoffReceipt, NativePendingInput, SwitchState } from '../../shared/agent-events';

export type NativeAgent = 'claude' | 'codex';
export type ClaudePath = 'api-then-terminal' | 'api-only' | 'terminal-only';
export type CodexView = 'native' | 'terminal';
export type NativeSettings = { claudePath: ClaudePath; codexView: CodexView; monthlyBudgetUsd: number | null; codexAutoReset: boolean };

// One quota window (Codex's 5 hours or week, an API rate limit); a value the provider did not give is null, never 0.
export type LimitWindow = { usedPercent: number | null; windowDurationMins: number | null; resetsAtMs: number | null };
export type LimitsPayload = {
  state?: string | null; observedAtMs?: number | null; ordinaryUsageAllowed?: boolean | null;
  limitsById?: Record<string, { limitName?: string | null; primary?: LimitWindow | null; secondary?: LimitWindow | null } | null> | null;
  resetCredits?: { availableCount?: number | null } | null;
  // What the provider itself says about the allowance: whether it rejects, and the notice that a limit was reached (with when it recovers, when it says).
  providerStatus?: SharedLimits['providerStatus'] | null; notice?: SharedLimits['notice'];
};
// What an agent is connected through right now (contract addendum 2): the API key, the subscription login, nothing running, or not known.
export type ConnectionKind = 'api' | 'subscription' | 'none' | 'unknown';
export type AgentConnection = { kind: ConnectionKind; source: string | null; observedAt: number | null; active?: boolean };
export type NextPath = { path: 'api' | 'native' | 'terminal' | null; reason: string | null };
export type AgentPathState = { path: 'api' | 'native' | 'terminal' | null; reason: string | null; next: NextPath; limits: LimitsPayload | null; connection?: AgentConnection | null };

// The answer to the owner's click on 测试连接 (contract addendum 2); it never carries the key.
export type KeyCheck = ConnectionTest['key']['status'];
export type { ConnectionTest };
export type NativeUsage = {
  month: string; apiRecords: boolean; todayUsdMicros: number | null; monthUsdMicros: number | null; estimated: true; budgetUsd: number | null;
  agents: Record<NativeAgent, AgentPathState>;
  // Owner sessions still on their way to a changed run mode, counted by main; absent from an older main.
  switches?: { waiting: number } | null;
};

export interface NativeBridge {
  start(terminalId: string, options: { agent: NativeAgent; resume?: boolean }): Promise<Result<{ runtimeSessionId: string }>>;
  send(terminalId: string, runtimeSessionId: string, clientMessageId: string, text: string, images?: string[]): Promise<Result<unknown>>;
  interrupt(terminalId: string, runtimeSessionId: string): Promise<Result<unknown>>;
  // The commands the session runs without a terminal (contract addendum, native composer); an older main has none, and that reads as an empty list.
  commands?(terminalId: string, runtimeSessionId: string): Promise<Result<AgentCommand[]>>;
  stop(terminalId: string, runtimeSessionId: string): Promise<Result<unknown>>;
  answer(terminalId: string, runtimeSessionId: string, requestId: string, answer: NativeAnswer): Promise<Result<unknown>>;
  snapshot(terminalId: string): Promise<Result<NativeSnapshot | null>>;
  onEvent(listener: (event: AgentEvent) => void): () => void;
  getSettings(): Promise<Result<NativeSettings>>;
  setSettings(patch: Partial<NativeSettings>): Promise<Result<unknown>>;
  keySave(key: string): Promise<Result<unknown>>;
  keyClear(): Promise<Result<unknown>>;
  keyStatus(): Promise<Result<{ saved: boolean }>>;
  // Both read the project's scope (a project-local token never decides another project's path).
  usage(projectId?: string): Promise<Result<NativeUsage>>;
  // Runs only when the owner clicks the button; never on a timer.
  testConnection(projectId?: string): Promise<Result<ConnectionTest>>;
}

// How a new agent session starts, from the settings and whether an API key is saved: the native view, today's terminal (with the reason when
// a missing key is why), or not at all (the API only, and no key). Settings not read yet or a window without the bridge mean the terminal.
export type Launch = { how: 'native' } | { how: 'terminal'; reason: 'no_key' | null } | { how: 'blocked'; reason: 'no_key' };
export function launchRoute(agent: NativeAgent, settings: NativeSettings | null, keySaved: boolean | null): Launch {
  if (!settings) return { how: 'terminal', reason: null };
  if (agent === 'codex') return settings.codexView === 'native' ? { how: 'native' } : { how: 'terminal', reason: null };
  if (settings.claudePath === 'terminal-only') return { how: 'terminal', reason: null };
  if (keySaved !== false) return { how: 'native' };
  return settings.claudePath === 'api-only' ? { how: 'blocked', reason: 'no_key' } : { how: 'terminal', reason: 'no_key' };
}

// The one place that reads the bridge off window (Bridge's own type is the main side's).
export const nativeBridge = (): NativeBridge | null => (typeof window === 'undefined' ? null : (window.agentrix as unknown as { nativeSession?: NativeBridge } | undefined)?.nativeSession ?? null);

// Opens a page through the project, the way every link is opened (the caller only passes an address it trusts).
export const openProjectLink = (projectId: string, url: string) => window.agentrix.openLink(projectId, url);

// Copying recovered input never submits it to either runtime.
export const copyNativeText = (text: string) => window.agentrix.copy(text);
