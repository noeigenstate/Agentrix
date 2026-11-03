const { randomUUID } = require('node:crypto');
const { createEventStream } = require('../native-session/events.cjs');
const { apiEnvironment } = require('./credentials.cjs');
const { createNormalizer } = require('./normalize.cjs');
const { createRequests } = require('./requests.cjs');
const { createPolicy } = require('./policy.cjs');

function inputQueue(onTake) {
  const values = []; let wake, closed = false;
  return { push(value) { if (closed) throw new Error('会话已停止。'); values.push(value); wake?.(); },
    close() { closed = true; values.length = 0; wake?.(); },
    async *[Symbol.asyncIterator]() { while (!closed) { if (!values.length) await new Promise(resolve => { wake = resolve; }); wake = null; if (!closed && values.length) { const value = values.shift(); onTake(value.uuid); yield value; } } } };
}
function createClaudeSession(spec, emit, { loadSdk, resolveExecutable, credentials, usage, now = Date.now, audit, onCost = () => {}, onFailure = () => {}, onSession = () => {} }) {
  const stream = createEventStream(spec, emit, now);
  let query, task, key, executable, reservation, providerId = spec.providerSessionId || null, state = 'starting', turnId = null, closed = false, initialized = false, observedModel = null;
  const publish = (type, payload, extra) => stream.publish(type, key ? JSON.parse(JSON.stringify(payload).replaceAll(key, '<secret>')) : payload, extra);
  const sent = new Map(), results = new Set(), abortController = new AbortController();
  let budgetBoundary = false, reopening;
  const setState = (next, reason = null) => { state = next; publish('session.state', { state, reason }); };
  const requests = createRequests({ publish, state: setState });
  const makeQueue = () => inputQueue(id => { if (sent.has(id)) { sent.set(id, 'delivered'); publish('input.receipt', { clientMessageId: id, status: 'delivered' }); } });
  let queue = makeQueue();
  const normalize = createNormalizer(publish, text => key ? text.replaceAll(key, '<secret>') : text);
  const policy = createPolicy(spec, audit);
  function begin(origin, clientMessageId) {
    turnId = randomUUID(); stream.turn(turnId); publish('turn.started', { origin, clientMessageId }); setState('running');
  }
  function receipt(id, status) { if (!sent.has(id) || sent.get(id) === status) return; sent.set(id, status); publish('input.receipt', { clientMessageId: id, status }); }
  async function pump() {
    try {
      for await (const message of query) {
        if (closed) break;
        if (message.type === 'system' && message.subtype === 'init' && !message.parent_tool_use_id) {
          if (message.apiKeySource !== 'ANTHROPIC_API_KEY') throw Object.assign(new Error(), { code: 'billing_identity_mismatch' });
          initialized = true; providerId = message.session_id; stream.provider(providerId); onSession(providerId);
          observedModel = message.model || null;
          publish('routing.updated', { declared: { model: spec.model || null, effort: spec.effort || null, fast: spec.fast ?? null }, effective: { model: message.model || null, effort: null, fast: null }, observed: { model: message.model || null, effort: null, fast: null }, reason: null });
        }
        if (message.isReplay === true) { normalize(message); continue; }
        if (!initialized && message.type !== 'system') throw Object.assign(new Error(), { code: 'billing_identity_mismatch' });
        if (message.user_message_uuid) receipt(message.user_message_uuid, 'consumed');
        for (const id of message.user_message_uuids || []) receipt(id, 'consumed');
        if (message.error === 'rate_limit' || message.error === 'billing_error') {
          const reason = message.error === 'rate_limit' ? 'rate_limited' : 'credits_exhausted';
          onFailure(reason);
          publish('limits.updated', { scopeId: spec.scopeId || spec.runtimeSessionId, billingRoute: 'api', observedAtMs: now(),
            state: 'unavailable', limitsById: {}, resetCredits: null, ordinaryUsageAllowed: null, source: reason });
        }
        if (message.type === 'assistant' && !turnId && !message.parent_tool_use_id) begin('automatic', message.user_message_uuid || null);
        normalize(message);
        if (message.type !== 'result' || message.parent_tool_use_id) continue;
        const resultId = message.uuid || message.result_index;
        if (resultId !== undefined && results.has(resultId)) continue;
        if (resultId !== undefined) results.add(resultId);
        const entry = usage.record(providerId, message, { resume: !!spec.providerSessionId, reservationId: reservation?.id });
        publish('usage.updated', entry.snapshot);
        if (entry.deltaUsdMicros !== null && entry.deltaUsdMicros > 0) onCost({ ...entry, spec: { ...spec, model: observedModel || spec.model }, providerSessionId: providerId });
        requests.cancel();
        publish('turn.completed', { status: message.is_error ? 'failed' : 'completed', error: message.is_error ? 'Claude 执行失败。' : null });
        turnId = null; stream.turn(null);
        if (message.subtype === 'error_max_budget_usd') { budgetBoundary = true; onFailure('budget_exhausted'); }
        setState(message.queued_turn_count > 0 ? 'running' : 'idle');
        if (message.subtype === 'error_max_budget_usd') { queue.close(); break; }
      }
      if (!closed) { for (const [id, status] of sent) if (status !== 'consumed') receipt(id, 'unknown'); requests.cancel(); setState(budgetBoundary ? 'idle' : 'stopped', budgetBoundary ? 'query_budget_exhausted' : null); }
    } catch (error) {
      if (reservation) usage.unverified(reservation.id);
      if (!closed) {
        const code = ['billing_identity_mismatch', 'budget_exhausted'].includes(error.code) ? error.code : 'sdk_failed';
        onFailure(code); publish('error', { code, message: 'Claude API 会话无法继续。', retryable: false, willRetry: false, stage: 'runtime' });
        requests.cancel(); for (const [id, status] of sent) if (status !== 'consumed') receipt(id, 'unknown'); setState('failed', code);
      }
    } finally { queue.close(); try { query?.close(); } catch { } if (reservation) { usage.release(reservation.id); reservation = null; } key = null; if (budgetBoundary) query = null; }
  }
  async function start() {
    if (closed) throw new Error('会话已停止。');
    setState('starting');
    try {
      executable = await resolveExecutable();
      if (!executable) throw Object.assign(new Error('未找到原生 Claude Code，无法通过 API 运行'), { code: 'native_cli_required' });
      key = credentials.read(); if (!key) throw Object.assign(new Error('请先保存 API 密钥。'), { code: 'no_key' });
      const sdk = await loadSdk();
      reservation = usage.reserve(spec.monthlyBudgetUsd ?? null);
      const options = { cwd: spec.cwd, model: spec.model || undefined, effort: spec.effort || 'high', pathToClaudeCodeExecutable: executable,
        settings: { fastMode: spec.fast === true },
        env: apiEnvironment(spec.env || process.env, key), abortController, permissionMode: 'default', includePartialMessages: true,
        settingSources: spec.owner === 'dispatch' ? [] : ['user', 'project', 'local'],
        systemPrompt: { type: 'preset', preset: 'claude_code', append: spec.context || '' },
        ...(providerId ? { resume: providerId } : {}), ...(reservation.maxBudgetUsd === undefined ? {} : { maxBudgetUsd: reservation.maxBudgetUsd }),
        hooks: { PreToolUse: [{ onFailure: 'block', hooks: [async input => {
          const decision = policy(input.tool_name, input.tool_input);
          return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision.behavior, permissionDecisionReason: decision.reason } };
        }] }] },
        canUseTool: async (name, input, context) => {
          if (closed) return { behavior: 'deny', message: '会话已停止。' };
          if (name === 'AskUserQuestion') return requests.open(name, input, context);
          const decision = policy(name, input);
          return decision.behavior === 'ask' ? requests.open(name, input, context) : decision.behavior === 'allow' ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: decision.reason };
        },
      };
      queue = makeQueue(); initialized = false; budgetBoundary = false;
      query = sdk.query({ prompt: queue, options }); setState('idle'); task = pump();
      void task.catch(() => { try { if (!closed) setState('failed', 'accounting_unavailable'); } catch { } });
      return { runtimeSessionId: spec.runtimeSessionId };
    } catch (error) { if (reservation) usage.release(reservation.id); reservation = null; key = null; setState('failed', error.code || 'sdk_failed'); throw Object.assign(new Error(error.code === 'native_cli_required' ? '未找到原生 Claude Code，无法通过 API 运行' : 'Claude API 会话无法启动。'), { code: error.code || 'sdk_failed' }); }
  }
  async function close() {
    if (closed) return;
    // The original reservation is already durable; a later disk failure must never prevent cancellation.
    try { if (turnId && reservation) usage.unverified(reservation.id); } catch { }
    closed = true; setState('stopping'); requests.cancel(); queue.close(); abortController.abort();
    try { query?.close(); } catch { }
    for (const [id, status] of sent) if (status !== 'consumed') receipt(id, status === 'queued' ? 'rejected' : 'unknown');
    setState('stopped');
    // A stalled provider cannot hold app exit indefinitely. Its reservation remains conservative until pump exits.
    if (task) { let timer; await Promise.race([task, new Promise(resolve => { timer = setTimeout(resolve, 1500); })]); clearTimeout(timer); }
  }
  function send({ clientMessageId, text, images = [] }) {
      if (!closed && budgetBoundary) {
        const next = reopening ||= task.then(() => start()).finally(() => { reopening = null; });
        return next.then(() => send({ clientMessageId, text, images }));
      }
      if (closed || !query || ['failed', 'stopped'].includes(state)) throw new Error('会话已停止。');
      if (sent.has(clientMessageId)) return { status: sent.get(clientMessageId) };
      if (sent.size >= 2000) throw new Error('会话消息过多，请启动新会话。');
      if (/^\/clear(?:\s|$)/.test(text)) throw new Error('原生会话不支持此命令。');
      const content = images.length ? [{ type: 'text', text }, ...images.map(image => { const [, media_type, data] = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(image) || []; if (!data) throw new Error('无效的图片。'); return { type: 'image', source: { type: 'base64', media_type, data } }; })] : text;
      sent.set(clientMessageId, 'queued'); if (!turnId) begin('user', clientMessageId);
      publish('input.receipt', { clientMessageId, status: 'queued' });
      publish('item.upsert', { kind: 'user-message', status: 'completed', content: { text, clientMessageId } }, { itemId: clientMessageId });
      queue.push({ type: 'user', uuid: clientMessageId, session_id: providerId || '', parent_tool_use_id: null, message: { role: 'user', content } });
      return { status: 'queued' };
  }
  return { start, resume: start, send,
    async interrupt() { requests.cancel(); if (query?.interrupt) await query.interrupt(); },
    answer: requests.answer, snapshot: stream.snapshot, close,
  };
}
module.exports = { createClaudeSession, inputQueue };
