const { randomUUID } = require('node:crypto');
const { tokenUsage } = require('./account.cjs');
/** @typedef {import('../../../src/shared/agent-events').AgentEvent} AgentEvent */
const KINDS = { userMessage: 'user-message', agentMessage: 'agent-message', reasoning: 'reasoning-summary', commandExecution: 'command',
  fileChange: 'file-change', mcpToolCall: 'tool', dynamicToolCall: 'tool', plan: 'plan', webSearch: 'web' };
const bounded = value => typeof value === 'string' ? value.slice(0, 256 * 1024) : null;

function itemPayload(item, completed) {
  const kind = KINDS[item.type] || 'other';
  let content;
  if (item.type === 'agentMessage' || item.type === 'plan') content = { text: bounded(item.text), phase: item.phase ?? null };
  else if (item.type === 'userMessage') content = { text: bounded((item.content || []).filter(x => x.type === 'text').map(x => x.text).join('\n')), clientMessageId: item.clientId ?? null };
  else if (item.type === 'reasoning') content = { text: bounded((item.summary || []).join('\n')) };
  else if (item.type === 'commandExecution') content = { command: bounded(item.command), cwd: item.cwd ?? null, output: bounded(item.aggregatedOutput), exitCode: item.exitCode ?? null, durationMs: item.durationMs ?? null };
  else if (item.type === 'fileChange') content = { changes: (item.changes || []).slice(0, 100).map(x => ({ path: x.path, kind: x.kind, diff: bounded(x.diff) })) };
  else if (kind === 'tool') content = { tool: item.tool, server: item.server ?? null, output: bounded(JSON.stringify(item.result ?? item.contentItems ?? null)) };
  else content = { text: bounded(item.text), providerType: item.type };
  const status = { inProgress: 'in-progress', pending: 'pending', completed: 'completed', failed: 'failed', declined: 'failed', interrupted: 'interrupted' }[item.status]
    || (completed ? 'completed' : 'running');
  return { kind, status, content };
}

function createEvents(spec, emit, now) {
  let sequence = 0;
  const events = [], items = new Map(), itemEvents = new Map(), completed = new Set();
  const binding = { connectionEpoch: randomUUID(), providerSessionId: null, turnId: null };
  function publish(type, payload, extra = {}) {
    const event = { schemaVersion: 1, eventId: randomUUID(), sequence: ++sequence, ...binding, provider: 'codex', transport: 'codex-app-server',
      projectId: spec.projectId, terminalId: spec.terminalId, runtimeSessionId: spec.runtimeSessionId, runId: spec.runId ?? null,
      itemId: null, receivedAtMs: now(), occurredAtMs: null, replay: false, type, payload, ...extra };
    events.push(event);
    if (type === 'item.upsert' || type === 'item.delta') itemEvents.set(event.itemId, event);
    if (events.length > 400) events.shift();
    emit(event); return event;
  }
  function notification(method, params) {
    if (method === 'item/started' || method === 'item/completed') {
      const item = params.item;
      if (!item || typeof item.id !== 'string' || completed.has(item.id)) return;
      const payload = itemPayload(item, method === 'item/completed'); items.set(item.id, payload);
      if (method === 'item/completed') completed.add(item.id);
      publish('item.upsert', payload, { itemId: item.id, turnId: params.turnId ?? binding.turnId });
    } else if (['item/agentMessage/delta', 'item/commandExecution/outputDelta', 'item/reasoning/summaryTextDelta', 'item/plan/delta'].includes(method)) {
      if (completed.has(params.itemId) || typeof params.delta !== 'string') return;
      const channel = method.includes('outputDelta') ? 'output' : method.includes('reasoning') ? 'reasoning-summary' : method.includes('plan') ? 'plan' : 'text';
      const previous = items.get(params.itemId) || { kind: channel === 'output' ? 'command' : channel === 'reasoning-summary' ? 'reasoning-summary' : channel === 'plan' ? 'plan' : 'agent-message', status: 'running', content: {} };
      const current = { ...previous, content: { ...previous.content } };
      const field = channel === 'output' ? 'output' : 'text';
      if (channel === 'reasoning-summary' && Number.isSafeInteger(params.summaryIndex)) {
        if (params.summaryIndex < 0 || params.summaryIndex > 64) return;
        const summaries = [...(current.content.summaries || [])];
        summaries[params.summaryIndex] = bounded((summaries[params.summaryIndex] || '') + params.delta);
        current.content.summaries = summaries; current.content.text = bounded(summaries.join('\n'));
      } else current.content[field] = bounded((current.content[field] || '') + params.delta);
      items.set(params.itemId, current);
      publish('item.delta', { channel, text: bounded(params.delta), ...(Number.isSafeInteger(params.summaryIndex) ? { index: params.summaryIndex } : {}) }, { itemId: params.itemId });
    } else if (method === 'turn/diff/updated') publish('turn.diff', { diff: bounded(params.diff) });
    else if (method === 'turn/plan/updated') publish('plan.updated', { explanation: bounded(params.explanation), steps: (params.plan || []).map(x => ({ step: x.step, status: x.status === 'inProgress' ? 'in-progress' : x.status })) });
    else if (method === 'thread/tokenUsage/updated') publish('usage.updated', tokenUsage(params.tokenUsage));
    else if (method === 'model/rerouted') publish('routing.updated', { declared: { model: null, effort: null, fast: null }, effective: { model: params.toModel ?? null, effort: null, fast: null }, observed: { model: null, effort: null, fast: null }, reason: params.reason ?? null });
    else if (method === 'error') publish('error', { code: 'provider_error', message: 'Codex 报告了错误', retryable: !!params.willRetry, willRetry: !!params.willRetry, stage: 'turn' });
    while (items.size > 400) { const id = items.keys().next().value; items.delete(id); completed.delete(id); itemEvents.delete(id); }
  }
  return { binding, publish, notification,
    snapshot: () => ({ runtimeSessionId: spec.runtimeSessionId, lastSequence: sequence,
      events: [...events.filter(x => x.type !== 'item.upsert' && x.type !== 'item.delta'), ...[...items].map(([itemId, payload]) => ({ ...itemEvents.get(itemId), type: 'item.upsert', payload }))]
        .sort((a, b) => a.sequence - b.sequence).map(x => ({ ...x, replay: true })),
      items: [...items].map(([itemId, payload]) => ({ itemId, ...payload })) }),
  };
}

module.exports = { createEvents, itemPayload };
