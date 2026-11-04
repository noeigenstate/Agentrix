// Provider-neutral snapshots and live events. Unknown observations stay null.
export type AgentProvider = 'claude' | 'codex';
export type SessionState = 'starting' | 'idle' | 'running' | 'waiting' | 'stopping' | 'stopped' | 'disconnected' | 'failed';
export type SwitchPath = 'api' | 'native' | 'terminal';
export type SwitchState = {
  changeId: number; current: SwitchPath; target: SwitchPath;
  phase: 'stable' | 'waiting-turn' | 'awaiting-choice' | 'waiting-background' | 'preparing' | 'switching' | 'rolling-back';
  background: { count: number | null; known: boolean }; requestId: string | null; reason: string | null;
};
export type NativePendingInput = { clientMessageId: string; text: string; images?: string[] };
export type NativeDraft = { version: number; text: string; images: string[]; undelivered: NativePendingInput[] };
export type NativeHandoff = { changeId: number; draft: NativeDraft };
export type NativeHandoffReceipt = { changeId: number; version: number; accepted: boolean };
export type AgentItemKind = 'user-message' | 'agent-message' | 'reasoning-summary' | 'command' | 'file-change' | 'tool' | 'plan' | 'web' | 'other';
export type AgentItemStatus = 'in-progress' | 'running' | 'pending' | 'completed' | 'failed' | 'interrupted';
export type RoutingValues = { model: string | null; effort: string | null; fast: boolean | null };
export type UsagePayload = { input: number | null; cachedInput: number | null; cacheWrite: number | null; output: number | null; reasoning: number | null; contextWindow: number | null; costUsdMicros: number | null; costEstimated: boolean | null };
export type LimitsPayload = {
  scopeId: string; billingRoute: 'api' | 'subscription' | 'unknown'; observedAtMs: number | null;
  state: 'ready' | 'stale' | 'loading' | 'unavailable' | 'error';
  limitsById: Record<string, { primary?: { usedPercent: number | null; windowDurationMins: number | null; resetsAtMs: number | null } | null; secondary?: { usedPercent: number | null; windowDurationMins: number | null; resetsAtMs: number | null } | null }>;
  resetCredits: { availableCount: number | null } | null;
  ordinaryUsageAllowed: boolean | null; source: string;
};
export type RequestQuestion = { id: string; question: string; header?: string; options?: { label: string; description?: string }[]; multiSelect?: boolean; isSecret?: boolean; allowFreeText?: boolean };
export type RequestPayload = {
  requestId: string; kind: 'command' | 'file-change' | 'permissions' | 'tool' | 'question' | 'elicitation';
  blocking: boolean; title: string; preview: string | null; actions: string[];
  questions?: RequestQuestion[]; providerData: Record<string, unknown> | null;
};
export type AgentEventPayloads = {
  'switch.updated': SwitchState;
  'session.state': { state: SessionState; reason: string | null };
  'turn.started': { origin: 'user' | 'automatic' | 'resume'; clientMessageId: string | null };
  'turn.completed': { status: 'completed' | 'failed' | 'interrupted'; error: string | null };
  'item.upsert': { kind: AgentItemKind; status: AgentItemStatus; content: Record<string, unknown> };
  'item.delta': { channel: 'text' | 'output' | 'reasoning-summary' | 'plan'; text: string; index?: number };
  'turn.diff': { diff: string };
  'plan.updated': { explanation: string | null; steps: { step: string; status: 'pending' | 'in-progress' | 'completed' }[] };
  'request.opened': RequestPayload;
  'request.resolved': { requestId: string; resolution: 'allowed' | 'denied' | 'answered' | 'cancelled' | 'expired'; reason: string | null };
  'input.receipt': { clientMessageId: string; status: 'queued' | 'delivered' | 'consumed' | 'rejected' | 'unknown' };
  'usage.updated': UsagePayload;
  'limits.updated': LimitsPayload;
  'routing.updated': { declared: RoutingValues; effective: RoutingValues; observed: RoutingValues; reason: string | null };
  'path.changed': { previous: 'api' | 'terminal' | 'subscription' | null; selected: 'api' | 'terminal' | 'subscription'; reason: string | null };
  'error': { code: string; message: string; retryable: boolean; willRetry: boolean; stage: string };
};
export type AgentEventType = keyof AgentEventPayloads;
export type AgentEvent = { [K in AgentEventType]: {
  schemaVersion: 1; eventId: string; sequence: number; connectionEpoch: string;
  provider: AgentProvider; transport: 'claude-sdk' | 'codex-app-server';
  projectId: string; terminalId: string; runtimeSessionId: string; providerSessionId: string | null;
  runId: string | null; turnId: string | null; itemId: string | null;
  receivedAtMs: number; occurredAtMs: number | null; replay: boolean; type: K; payload: AgentEventPayloads[K];
} }[AgentEventType];
export type NativeSettings = { claudePath: 'api-then-terminal' | 'api-only' | 'terminal-only'; codexView: 'native' | 'terminal'; monthlyBudgetUsd: number | null };
export type NativeAnswer = { decision: 'allow' | 'deny' } | { answers: Record<string, string | string[]> }
  | { switch: { changeId: number; requestId: string; action: 'wait' | 'now' } } | { handoff: NativeHandoff };
export type NativeSnapshot = { runtimeSessionId: string; lastSequence: number; events: AgentEvent[]; state: SessionState; switchState?: SwitchState; handoff?: NativeHandoff };
export type AgentPathState = { path: 'api' | 'native' | 'terminal' | null; reason: string | null; limits: LimitsPayload | null };
export type NativeUsage = { month: string; todayUsdMicros: number | null; monthUsdMicros: number | null; estimated: true; budgetUsd: number | null; agents: Record<AgentProvider, AgentPathState>; switches: { waiting: number }; lastSwitch: { at: number; agent: AgentProvider; from: string | null; to: string; reason: string | null } | null };
