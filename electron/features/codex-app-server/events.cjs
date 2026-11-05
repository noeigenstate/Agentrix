const { randomUUID } = require('node:crypto');
const { tokenUsage } = require('./account.cjs');
const { commandPhrase } = require('../../command-phrase.cjs');
const { isGeneratedImage } = require('../../generated-image-path.cjs');
/** @typedef {import('../../../src/shared/agent-events').AgentEvent} AgentEvent */
const KINDS = { userMessage: 'user-message', agentMessage: 'agent-message', reasoning: 'reasoning-summary', commandExecution: 'command',
  fileChange: 'file-change', mcpToolCall: 'tool', dynamicToolCall: 'tool', plan: 'plan', webSearch: 'web', imageGeneration: 'agent-message' };
const bounded = value => typeof value === 'string' ? value.slice(0, 256 * 1024) : null;
const ERRORS = {
  contextWindowExceeded: '输入超过上下文长度，本轮未能完成。', sessionBudgetExceeded: 'Codex 本轮预算已用完。',
  usageLimitExceeded: 'Codex 用量已达上限。', rateLimitExceeded: 'Codex 请求受到限流。', unauthorized: 'Codex 身份验证失败。',
  sandboxError: 'Codex 执行环境拒绝了本轮操作。', flexUnavailable: '弹性服务暂不可用。', serverOverloaded: '服务繁忙，本轮未能完成。',
  modelNotFound: '找不到请求的模型。', policyCapacityUnavailable: '当前策略下没有可用容量。', cyberPolicy: '安全策略阻止了本轮执行。',
  misalignmentPolicyViolation: '策略检查阻止了本轮执行。', tooManyDenials: '操作多次被拒绝，本轮已停止。',
  internalServerError: '服务内部出错，本轮未能完成。', badRequest: '请求无效，本轮未能完成。', threadRollbackFailed: '会话回退失败。',
  httpConnectionFailed: '无法连接服务。', responseStreamConnectionFailed: '无法连接回复流。', responseStreamDisconnected: '回复连接已断开。',
  responseTooManyFailedAttempts: '回复重试次数已用完。', activeTurnNotSteerable: '当前回合不能接收追加消息。', other: 'Codex 本轮执行失败',
};
function turnCompletion(turn, usage) {
  const status = ['completed', 'failed', 'interrupted'].includes(turn.status) ? turn.status : 'failed';
  const info = turn.error?.codexErrorInfo, code = typeof info === 'string' ? info : info && Object.keys(info)[0];
  const reason = Object.hasOwn(ERRORS, code) ? code : turn.error ? 'unknown' : status;
  const message = ERRORS[reason] || (status === 'completed' ? '本轮已完成。' : status === 'interrupted' ? '本轮已中断。' : 'Codex 本轮执行失败');
  return { status, error: status === 'failed' || turn.error ? message : null, terminalReason: reason, message,
    durationMs: Number.isSafeInteger(turn.durationMs) && turn.durationMs >= 0 ? turn.durationMs : null, apiDurationMs: null,
    costUsdMicros: null, costEstimated: null, tokens: usage?.round || null };
}

function itemPayload(item, completed, renderImage = () => null, translate = value => value) {
  const kind = KINDS[item.type] || 'other';
  let content;
  if (item.type === 'agentMessage' || item.type === 'plan') content = { text: bounded(item.text), phase: item.phase ?? null };
  else if (item.type === 'userMessage') content = { text: bounded((item.content || []).filter(x => x.type === 'text').map(x => x.text).join('\n')), clientMessageId: item.clientId ?? null };
  else if (item.type === 'reasoning') content = { text: bounded((item.summary || []).join('\n')) };
  else if (item.type === 'commandExecution') content = { command: bounded(item.command), phrase: commandPhrase(item.command).phrase, cwd: item.cwd ?? null, output: bounded(item.aggregatedOutput), exitCode: item.exitCode ?? null, durationMs: item.durationMs ?? null };
  else if (item.type === 'fileChange') content = { changes: (item.changes || []).slice(0, 100).map(x => ({ path: x.path, kind: x.kind, diff: bounded(x.diff) })) };
  else if (kind === 'tool') content = { tool: item.tool, server: item.server ?? null, output: bounded((item.result?.content || item.contentItems || []).filter(block => block.type === 'text').map(block => block.text).join('\n') || (typeof item.result === 'string' ? item.result : '')) };
  else if (item.type === 'imageGeneration' && completed && isGeneratedImage(item.savedPath)) {
    const images = renderImage(item)?.images || [];
    content = { text: images.length ? '' : translate('图片已保存，请在运行 Codex 的主机查看。'),
      generated: { path: item.savedPath, prompt: bounded(item.revisedPrompt) || '' }, images };
  }
  else content = { text: bounded(item.text), providerType: item.type };
  const status = { inProgress: 'in-progress', pending: 'pending', completed: 'completed', failed: 'failed', declined: 'failed', interrupted: 'interrupted' }[item.status]
    || (completed ? 'completed' : 'running');
  return { kind, status, content };
}

function createEvents(spec, emit, now, renderImage, translate) {
  let sequence = 0, dropped = false;
  const events = [], items = new Map(), itemEvents = new Map(), completed = new Set(), children = new Set();
  const binding = { connectionEpoch: randomUUID(), providerSessionId: null, turnId: null };
  let cumulative = spec.providerSessionId ? null : { input: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0 }, baseline = cumulative;
  function publish(type, payload, extra = {}) {
    if (type === 'item.dropped') dropped = true;
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
      if (item.type === 'contextCompaction') {
        const done = method === 'item/completed';
        publish('context.compacting', { active: !done });
        if (done) {
          completed.add(item.id);
          publish('context.compacted', { trigger: item.trigger === 'manual' ? 'manual' : 'auto',
            preTokens: Number.isSafeInteger(item.preTokens) && item.preTokens >= 0 ? item.preTokens : null,
            postTokens: Number.isSafeInteger(item.postTokens) && item.postTokens >= 0 ? item.postTokens : null });
        }
        return;
      }
      if (item.type === 'collabAgentToolCall') for (const id of item.receiverThreadIds || []) {
        const status = item.agentsStates?.[id]?.status;
        if (item.tool === 'closeAgent' || ['completed', 'failed', 'shutdown', 'notFound'].includes(status)) children.delete(id);
        else if (['spawnAgent', 'sendInput', 'resumeAgent'].includes(item.tool)) children.add(id);
      }
      const payload = itemPayload(item, method === 'item/completed', renderImage, translate); items.set(item.id, payload);
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
    else if (method === 'thread/tokenUsage/updated') { const usage = tokenUsage(params.tokenUsage, baseline); cumulative = usage; publish('usage.updated', usage); }
    else if (method === 'model/rerouted') publish('routing.updated', { declared: { model: null, effort: null, fast: null }, effective: { model: params.toModel ?? null, effort: null, fast: null }, observed: { model: null, effort: null, fast: null }, reason: params.reason ?? null });
    else if (method === 'error') { publish('context.compacting', { active: false }); publish('error', { code: 'provider_error', message: 'Codex 报告了错误', retryable: !!params.willRetry, willRetry: !!params.willRetry, stage: 'turn' }); }
    while (items.size > 400) { const id = items.keys().next().value; items.delete(id); completed.delete(id); itemEvents.delete(id); }
  }
  return { binding, publish, notification,
    finishTurn(status = 'interrupted') {
      publish('context.compacting', { active: false });
      for (const [itemId, payload] of items) if (['command', 'tool', 'file-change'].includes(payload.kind) && ['running', 'in-progress', 'pending'].includes(payload.status)
        && itemEvents.get(itemId)?.turnId === binding.turnId) {
        // The drained frame has no trustworthy nested item identity. Missing tool results
        // stay unknown even if the turn failed elsewhere; actual interruption retains its meaning.
        const final = { ...payload, status: dropped && status !== 'interrupted' ? 'unknown' : 'interrupted' };
        items.set(itemId, final); completed.add(itemId); publish('item.upsert', final, { itemId });
      }
    },
    beginTurn() { dropped = false; baseline = cumulative; for (let i = events.length - 1; i >= 0; i--) if (['plan.updated', 'turn.diff'].includes(events[i].type)) events.splice(i, 1); },
    activity: () => ({ known: true, count: children.size + [...items.values()].filter(item => ['command', 'tool'].includes(item.kind) && ['running', 'in-progress', 'pending'].includes(item.status)).length }),
    snapshot: () => ({ runtimeSessionId: spec.runtimeSessionId, lastSequence: sequence,
      events: [...events.filter(x => x.type !== 'item.upsert' && x.type !== 'item.delta'), ...[...items].map(([itemId, payload]) => ({ ...itemEvents.get(itemId), type: 'item.upsert', payload }))]
        .sort((a, b) => a.sequence - b.sequence).map(x => ({ ...x, replay: true })),
      items: [...items].map(([itemId, payload]) => ({ itemId, ...payload })) }),
  };
}

module.exports = { createEvents, itemPayload, turnCompletion };
