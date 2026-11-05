// A native session's conversation, folded from the events the main process publishes (contract §1). Pure: the same events give the same
// model, and a replayed or repeated event changes nothing. Nothing is invented — a field the events do not carry stays null.
//
// The payload fields read here (the contract fixes the envelope and the event types, not these; native-words.ts reads the item content):
//   item.upsert  kind, status, content (content.discarded: a stream a newer message replaced)     item.delta  channel (text|output|plan; a reasoning summary is no part of the model), text
//   turn.diff    diff                              plan.updated  explanation, steps[{ step|text|title, status }]
//   request.opened  requestId, kind, blocking, title, preview, questions[{ id, header, question, options[{ label, description }], multiSelect, isSecret }]
//   session.state  state, reason     input.receipt  clientMessageId, status     path.changed  previous, selected, reason
//   turn.completed  status, error, terminalReason, message, durationMs, costUsdMicros, costEstimated, tokens (how the provider says the turn ended)
//   error  code, message, willRetry     switch.updated  a SwitchState (the whole payload)     limits.updated  providerStatus, notice { code, message, resetsAtMs }
//   context.compacting  active     context.compacted  trigger, preTokens, postTokens     item.dropped  bytes  (the last two become a line of the conversation: native-notices.ts)
// usage.updated and routing.updated are not part of the conversation: the usage panel asks the main process for the numbers (ApiUsage). Of limits.updated only
// the provider's own notice that a limit was reached is kept, to be said in the conversation.
import type { AgentEvent, LimitsPayload, SwitchState, TokenCounts } from '../../shared/agent-events';

export type Payload = Record<string, unknown>;
export type NativeItem = {
  id: string; kind: string; status: string | null; content: Payload; turnId: string | null; at: number | null;
  // Streamed pieces; a completed snapshot that carries its own text replaces them.
  deltas: { text: string; output: string; plan: string };
};
// How a turn ended, as its provider said: the reason code, the sentence main wrote for it, and the facts the result gave (each null when it gave none).
export type TurnEnd = {
  reason: string | null; message: string | null; durationMs: number | null; costUsdMicros: number | null; costEstimated: boolean | null; tokens: TokenCounts | null;
};
export type LimitNotice = NonNullable<LimitsPayload['notice']>;
export type NativeRequest = { id: string; kind: string; blocking: boolean; title: string; preview: string; questions: Payload[]; at: number };
export type NativeModel = {
  identity: { runtimeSessionId: string; epoch: string; provider: 'claude' | 'codex'; transport: string } | null;
  lastSequence: number | null; refused: string[];
  session: { state: string; reason: string | null } | null;
  turn: { running: boolean; status: string | null; error: string | null; end: TurnEnd | null };
  order: string[]; items: Record<string, NativeItem>; requests: NativeRequest[]; receipts: Record<string, string>;
  diff: string | null; plan: { explanation: string | null; steps: { text: string; status: string | null }[] } | null;
  path: { previous: string | null; selected: string; reason: string | null; at: number } | null;
  error: { code: string | null; message: string; willRetry: boolean } | null;
  // What the provider said about its allowance: whether it rejects, and the notice that a limit was reached (null while it says none).
  limits: { providerStatus: string | null; notice: LimitNotice | null } | null;
  // The run-mode change this session is going through (contract addendum): one state for both transports, replaced whole by each event.
  switchState: SwitchState | null;
  // The context is being compacted now (live events only: a replayed one is over).
  compacting: boolean;
};

export const emptyModel = (): NativeModel => ({
  identity: null, lastSequence: null, refused: [], session: null, turn: { running: false, status: null, error: null, end: null },
  order: [], items: {}, requests: [], receipts: {}, diff: null, plan: null, path: null, error: null, limits: null, switchState: null, compacting: false,
});

const SEND_STATES = new Set(['starting', 'idle', 'running', 'waiting']);
const OVER_STATES = new Set(['stopped', 'failed', 'disconnected']);
// The card a channel's first delta creates when the item itself was not announced.
const DELTA_KIND: Record<string, string> = { text: 'agent-message', output: 'command', plan: 'plan' };

const text = (value: unknown) => (typeof value === 'string' ? value : null);
const object = (value: unknown): Payload => (value && typeof value === 'object' && !Array.isArray(value) ? value as Payload : {});
const objects = (value: unknown): Payload[] => (Array.isArray(value) ? value.filter(entry => entry && typeof entry === 'object') as Payload[] : []);
const filled = (value: unknown) => typeof value === 'string' && value !== '';
const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);

// A turn's counts as it gave them; a count it did not give is null, and a turn that gave none has no tokens.
function tokensOf(value: unknown): TokenCounts | null {
  const found = object(value), tokens = { input: count(found.input), cachedInput: count(found.cachedInput), cacheWrite: count(found.cacheWrite), output: count(found.output), reasoning: count(found.reasoning) };
  return Object.values(tokens).some(entry => entry !== null) ? tokens : null;
}
const endOf = (payload: Payload): TurnEnd => ({
  reason: text(payload.terminalReason), message: text(payload.message), durationMs: count(payload.durationMs), costUsdMicros: count(payload.costUsdMicros),
  costEstimated: typeof payload.costEstimated === 'boolean' ? payload.costEstimated : null, tokens: tokensOf(payload.tokens),
});

function touch(draft: NativeModel, event: AgentEvent, kind: string): NativeItem | null {
  const id = event.itemId;
  if (!id) return null;
  const known = draft.items[id];
  if (!known) draft.order.push(id);
  return known ?? { id, kind, status: null, content: {}, turnId: event.turnId, at: event.occurredAtMs ?? event.receivedAtMs, deltas: { text: '', output: '', plan: '' } };
}

function upsert(draft: NativeModel, event: AgentEvent, payload: Payload) {
  const base = touch(draft, event, text(payload.kind) ?? 'other');
  if (!base) return;
  const content = object(payload.content), deltas = { ...base.deltas };
  // A stream a newer message replaced is dropped whole, with the pieces already heard; a completed snapshot that carries its text replaces them.
  if (content.discarded === true || filled(content.text)) Object.assign(deltas, { text: '', plan: '' });
  if (content.discarded === true || filled(content.output)) deltas.output = '';
  // The time the record itself gives (a replayed item's own) is the item's; an item first heard as a delta had only the time it was heard.
  const merged = { ...base.content, ...content };
  if (filled(content.text) && content.discarded !== true) delete merged.discarded;
  draft.items[base.id] = { ...base, kind: text(payload.kind) ?? base.kind, status: text(payload.status) ?? base.status, at: event.occurredAtMs ?? base.at, content: merged, deltas };
}

function delta(draft: NativeModel, event: AgentEvent, payload: Payload) {
  const channel = text(payload.channel) ?? 'text', piece = text(payload.text) ?? '';
  if (channel === 'reasoning-summary') return;
  const base = touch(draft, event, DELTA_KIND[channel] ?? 'other');
  if (!base || base.content.discarded === true) return;
  if (channel === 'output' || channel === 'plan' || channel === 'text') draft.items[base.id] = { ...base, deltas: { ...base.deltas, [channel]: base.deltas[channel] + piece } };
}

// A line of the conversation that is no item of the provider's: it stands where the event came, named by its sequence so a replay makes the same line.
function note(draft: NativeModel, event: AgentEvent, kind: string, content: Payload) {
  const id = `notice:${event.sequence}`;
  draft.order.push(id);
  draft.items[id] = { id, kind, status: 'completed', content, turnId: event.turnId, at: event.occurredAtMs ?? event.receivedAtMs, deltas: { text: '', output: '', plan: '' } };
}

function handle(draft: NativeModel, event: AgentEvent) {
  const payload = object(event.payload);
  switch (event.type) {
    case 'session.state': {
      const state = text(payload.state) ?? 'unknown';
      draft.session = { state, reason: text(payload.reason) };
      if (OVER_STATES.has(state)) { draft.requests = []; draft.compacting = false; }
      break;
    }
    // A new turn starts with no plan and no diff: the last turn's are not this one's.
    case 'turn.started': draft.turn = { running: true, status: null, error: null, end: null }; draft.error = null; draft.plan = null; draft.diff = null; break;
    case 'turn.completed': draft.turn = { running: false, status: text(payload.status), error: text(payload.error), end: endOf(payload) }; draft.compacting = false; break;
    case 'item.upsert': upsert(draft, event, payload); break;
    case 'item.delta': delta(draft, event, payload); break;
    case 'turn.diff': draft.diff = text(payload.diff) ?? text(payload.text); break;
    case 'plan.updated': draft.plan = {
      explanation: text(payload.explanation),
      steps: objects(payload.steps).map(step => ({ text: text(step.step) ?? text(step.text) ?? text(step.title) ?? '', status: text(step.status) })),
    }; break;
    case 'request.opened': {
      const id = text(payload.requestId);
      if (id && !draft.requests.some(request => request.id === id)) draft.requests.push({
        id, kind: text(payload.kind) ?? 'tool', blocking: payload.blocking !== false, title: text(payload.title) ?? '', preview: text(payload.preview) ?? '',
        questions: objects(payload.questions), at: event.occurredAtMs ?? event.receivedAtMs,
      });
      break;
    }
    case 'request.resolved': draft.requests = draft.requests.filter(request => request.id !== text(payload.requestId)); break;
    case 'input.receipt': { const id = text(payload.clientMessageId), status = text(payload.status); if (id && status) draft.receipts[id] = status; break; }
    case 'path.changed': draft.path = { previous: text(payload.previous), selected: text(payload.selected) ?? 'unknown', reason: text(payload.reason), at: event.occurredAtMs ?? event.receivedAtMs }; break;
    case 'switch.updated': draft.switchState = event.payload; break;
    case 'limits.updated': {
      const notice = object(payload.notice), code = text(notice.code), message = text(notice.message), url = text(notice.url);
      // The console action and its address are kept as given; the view opens only the one fixed address (native-words.ts consoleCheck).
      draft.limits = { providerStatus: text(payload.providerStatus), notice: code && message ? { code: code as LimitNotice['code'], message, resetsAtMs: count(notice.resetsAtMs),
        ...(notice.action === 'check-console' ? { action: 'check-console' as const } : {}), ...(url ? { url } : {}) } : null };
      break;
    }
    case 'context.compacting': draft.compacting = payload.active === true && !event.replay; break;
    case 'context.compacted':
      draft.compacting = false;
      note(draft, event, 'context-compacted', { trigger: text(payload.trigger), preTokens: count(payload.preTokens), postTokens: count(payload.postTokens) });
      break;
    case 'item.dropped': note(draft, event, 'item-dropped', { bytes: count(payload.bytes) }); break;
    case 'error': draft.error = { code: text(payload.code), message: text(payload.message) ?? '', willRetry: payload.willRetry === true }; break;
  }
}

// Folds events into the model. One session and one connection epoch only: an event of another is dropped (and asks for one new snapshot
// per such identity), a sequence at or below the last is a repeat, and a gap stops the fold and asks for a snapshot, which covers the
// rest. `strict: false` is the snapshot's own events, which may be compacted.
export function applyEvents(model: NativeModel, events: AgentEvent[], strict = true): { model: NativeModel; resync: boolean } {
  const draft: NativeModel = { ...model, items: { ...model.items }, order: [...model.order], requests: [...model.requests], receipts: { ...model.receipts }, refused: [...model.refused] };
  let resync = false;
  for (const event of events) {
    const identity = `${event.runtimeSessionId}/${event.connectionEpoch}`;
    if (!draft.identity) draft.identity = { runtimeSessionId: event.runtimeSessionId, epoch: event.connectionEpoch, provider: event.provider, transport: event.transport };
    else if (draft.identity.runtimeSessionId !== event.runtimeSessionId || draft.identity.epoch !== event.connectionEpoch) {
      if (!draft.refused.includes(identity)) { draft.refused.push(identity); resync = true; }
      continue;
    }
    if (draft.lastSequence !== null && event.sequence <= draft.lastSequence) continue;
    if (strict && draft.lastSequence !== null && event.sequence > draft.lastSequence + 1) { resync = true; break; }
    draft.lastSequence = event.sequence;
    handle(draft, event);
  }
  return { model: draft, resync };
}

export function fromSnapshot(snapshot: { lastSequence: number; events: AgentEvent[]; switchState?: SwitchState }): NativeModel {
  const { model } = applyEvents(emptyModel(), snapshot.events, false);
  return { ...model, switchState: snapshot.switchState ?? model.switchState, lastSequence: Math.max(model.lastSequence ?? snapshot.lastSequence, snapshot.lastSequence) };
}

export const canSend = (model: NativeModel) => !!model.session && SEND_STATES.has(model.session.state);
export const isOver = (model: NativeModel) => !!model.session && OVER_STATES.has(model.session.state);
export const isWorking = (model: NativeModel) => model.turn.running || model.session?.state === 'running' || model.session?.state === 'stopping';
