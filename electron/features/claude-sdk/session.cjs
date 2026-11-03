const { randomUUID } = require('node:crypto');
const { createEventStream } = require('../native-session/events.cjs');
const { apiEnvironment } = require('./credentials.cjs');
const { createNormalizer } = require('./normalize.cjs');
const { createRequests } = require('./requests.cjs');
const { createPolicy } = require('./policy.cjs');

function inputQueue(onTake) {
  const values = [];
  let wake, closed = false;
  return {
    push(value) {
      if (closed) throw new Error('会话已停止。');
      values.push(value); wake?.();
    },
    close() { closed = true; values.length = 0; wake?.(); },
    async *[Symbol.asyncIterator]() {
      while (!closed) {
        if (!values.length) await new Promise(resolve => { wake = resolve; });
        wake = null;
        if (!closed && values.length) {
          const value = values.shift(); onTake(value.uuid); yield value;
        }
      }
    },
  };
}
function createClaudeSession(spec, emit, dependencies) {
  const { loadSdk, resolveExecutable, credentials, usage, now = Date.now, audit,
    onCost = () => {}, onFailure = () => {}, onSession = () => {} } = dependencies;
  const stream = createEventStream(spec, emit, now), secrets = new Set();
  const sent = new Map(), results = new Set();
  let active, preparing, closing, sdk, executable, started = false, closed = false;
  let providerId = spec.providerSessionId || null, state = 'starting', turnId = null;
  function clean(value) {
    let text = value;
    for (const key of secrets) text = text.replaceAll(key, '<secret>');
    return text;
  }
  const publish = (type, payload, extra) => stream.publish(type, JSON.parse(clean(JSON.stringify(payload))), extra);
  const setState = (next, reason = null) => { state = next; publish('session.state', { state, reason }); };
  const requests = createRequests({ publish, state: next => { if (!closed && state !== 'stopping') setState(next); } });
  const normalize = createNormalizer(publish, clean), policy = createPolicy(spec, audit);
  function receipt(id, status) {
    if (!sent.has(id) || sent.get(id) === status) return;
    sent.set(id, status); publish('input.receipt', { clientMessageId: id, status });
  }
  function begin(origin, clientMessageId) {
    turnId = randomUUID(); stream.turn(turnId);
    publish('turn.started', { origin, clientMessageId }); setState('running');
  }
  function cancelQuery(run, reason) {
    if (run.closing) return;
    run.closing = reason;
    run.queue.close(); run.abort.abort();
    try { run.query.close(); } catch { }
  }
  function unknownInput() {
    for (const [id, status] of sent) if (!['consumed', 'rejected'].includes(status)) receipt(id, 'unknown');
  }
  function unavailable(message) {
    const reason = { rate_limit: 'rate_limited', billing_error: 'credits_exhausted', authentication_failed: 'invalid_key' }[message.error];
    if (!reason) return;
    onFailure(reason);
    publish('limits.updated', { scopeId: spec.scopeId || spec.runtimeSessionId, billingRoute: 'api', observedAtMs: now(),
      state: 'unavailable', limitsById: {}, resetCredits: null, ordinaryUsageAllowed: null, source: reason });
  }
  async function pump(run) {
    let idle = false;
    try {
      for await (const message of run.query) {
        if (closed || run.closing) break;
        if (message.type === 'system' && message.subtype === 'init' && !message.parent_tool_use_id) {
          if (message.apiKeySource !== 'ANTHROPIC_API_KEY') throw Object.assign(new Error(), { code: 'billing_identity_mismatch' });
          run.initialized = true; providerId = message.session_id; stream.provider(providerId);
          usage.bind?.(run.reservation.id, providerId); onSession(providerId);
          run.model = message.model || null;
          publish('routing.updated', {
            declared: { model: spec.model || null, effort: spec.effort || null, fast: spec.fast ?? null },
            effective: { model: run.model, effort: null, fast: null },
            observed: { model: run.model, effort: null, fast: null }, reason: null,
          });
        }
        if (message.isReplay === true) { normalize(message); continue; }
        if (!run.initialized && message.type !== 'system') throw Object.assign(new Error(), { code: 'billing_identity_mismatch' });
        if (message.user_message_uuid) receipt(message.user_message_uuid, 'consumed');
        for (const id of message.user_message_uuids || []) receipt(id, 'consumed');
        unavailable(message);
        if (message.type === 'assistant' && !turnId && !message.parent_tool_use_id) begin('automatic', message.user_message_uuid || null);
        normalize(message);
        if (message.type !== 'result' || message.parent_tool_use_id) continue;
        const resultId = message.uuid || message.result_index;
        if (resultId !== undefined && results.has(resultId)) continue;
        if (resultId !== undefined) results.add(resultId);
        const entry = usage.record(providerId, message, { resume: !!run.resumeId, reservationId: run.reservation.id });
        publish('usage.updated', entry.snapshot);
        if (entry.deltaUsdMicros > 0) onCost({ ...entry, spec: { ...spec, model: run.model || spec.model }, providerSessionId: providerId });
        requests.cancel();
        const status = run.interrupted ? 'interrupted' : message.is_error ? 'failed' : 'completed';
        publish('turn.completed', { status, error: status === 'failed' ? 'Claude 执行失败。' : null });
        run.interrupted = false;
        turnId = null; stream.turn(null);
        if (message.subtype === 'error_max_budget_usd') onFailure('budget_exhausted');
        if (!(message.queued_turn_count > 0)) {
          idle = true; cancelQuery(run, 'idle'); break;
        }
      }
      if (!closed && !idle) { unknownInput(); requests.cancel(); setState('stopped'); }
    } catch (error) {
      // close()/idle retirement may reject iteration with AbortError. Its accounting was already settled above.
      if (!run.closing) {
        usage.unverified(run.reservation.id);
        if (!closed) {
          const code = error.code === 'billing_identity_mismatch' ? error.code : 'sdk_failed';
          onFailure(code);
          publish('error', { code, message: 'Claude API 会话无法继续。', retryable: false, willRetry: false, stage: 'runtime' });
          requests.cancel(); unknownInput(); setState('failed', code);
        }
      }
    } finally {
      cancelQuery(run, 'ended');
      usage.release(run.reservation.id); secrets.delete(run.key);
      if (active === run) active = null;
      if (idle && !closed) setState('idle');
    }
  }
  async function start() {
    if (closed || started) throw new Error('会话已停止。');
    setState('starting');
    try {
      executable = await resolveExecutable({ env: spec.env || process.env });
      if (!executable) throw Object.assign(new Error('未找到原生 Claude Code，无法通过 API 运行'), { code: 'native_cli_required' });
      if (!credentials.status?.().saved && !credentials.read()) throw Object.assign(new Error(), { code: 'no_key' });
      sdk = await loadSdk(); started = true; setState('idle');
      return { runtimeSessionId: spec.runtimeSessionId };
    } catch (error) {
      setState('failed', error.code || 'sdk_failed');
      throw Object.assign(new Error(error.code === 'native_cli_required' ? '未找到原生 Claude Code，无法通过 API 运行' : 'Claude API 会话无法启动。'), { code: error.code || 'sdk_failed' });
    }
  }
  async function createQuery() {
    if (closed) throw new Error('会话已停止。');
    const key = credentials.read();
    if (!key) throw new Error('请先保存 API 密钥。');
    const reservation = usage.reserve(spec.monthlyBudgetUsd ?? null, { sessionId: providerId, resume: !!providerId });
    const run = { key, reservation, resumeId: providerId, abort: new AbortController(), initialized: false, closing: null };
    secrets.add(key);
    run.queue = inputQueue(id => receipt(id, 'delivered'));
    const options = {
      cwd: spec.cwd, model: spec.model || undefined, effort: spec.effort || 'high', pathToClaudeCodeExecutable: executable,
      settings: { fastMode: spec.fast === true }, env: apiEnvironment(spec.env || process.env, key),
      abortController: run.abort, permissionMode: 'default', includePartialMessages: true,
      settingSources: spec.owner === 'dispatch' ? [] : ['user', 'project', 'local'],
      systemPrompt: { type: 'preset', preset: 'claude_code', append: spec.context || '' },
      ...(providerId ? { resume: providerId } : {}),
      ...(reservation.maxBudgetUsd === undefined ? {} : { maxBudgetUsd: reservation.maxBudgetUsd }),
      hooks: { PreToolUse: [{ onFailure: 'block', hooks: [async input => {
        const decision = policy(input.tool_name, input.tool_input);
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision.behavior, permissionDecisionReason: decision.reason } };
      }] }] },
      canUseTool: async (name, input, context) => {
        if (closed || run.closing) return { behavior: 'deny', message: '会话已停止。' };
        if (name === 'AskUserQuestion') return requests.open(name, input, context);
        const decision = policy(name, input);
        if (decision.behavior === 'defer' || decision.behavior === 'ask') return requests.open(name, input, context);
        return decision.behavior === 'allow' ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: decision.reason };
      },
    };
    try { run.query = sdk.query({ prompt: run.queue, options }); }
    catch (error) { usage.release(reservation.id); secrets.delete(key); throw error; }
    active = run; run.task = pump(run);
    void run.task.catch(() => { try { if (!closed) setState('failed', 'accounting_unavailable'); } catch { } });
    return run;
  }
  async function send({ clientMessageId, text, images = [] }) {
    if (closed || !started || ['failed', 'stopped'].includes(state)) throw new Error('会话已停止。');
    if (sent.has(clientMessageId)) return { status: sent.get(clientMessageId) };
    if (sent.size >= 2000) throw new Error('会话消息过多，请启动新会话。');
    if (/^\/clear(?:\s|$)/.test(text)) throw new Error('原生会话不支持此命令。');
    const content = images.length ? [{ type: 'text', text }, ...images.map(image => {
      const [, media_type, data] = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(image) || [];
      if (!data) throw new Error('无效的图片。');
      return { type: 'image', source: { type: 'base64', media_type, data } };
    })] : text;
    if (active?.closing) await active.task;
    if (!active) {
      preparing ||= createQuery().finally(() => { preparing = null; });
      await preparing;
    }
    if (closed) throw new Error('会话已停止。');
    if (sent.has(clientMessageId)) return { status: sent.get(clientMessageId) };
    sent.set(clientMessageId, 'queued');
    if (!turnId) begin('user', clientMessageId);
    publish('input.receipt', { clientMessageId, status: 'queued' });
    publish('item.upsert', { kind: 'user-message', status: 'completed', content: { text, clientMessageId } }, { itemId: clientMessageId });
    active.queue.push({ type: 'user', uuid: clientMessageId, session_id: providerId || '', parent_tool_use_id: null, message: { role: 'user', content } });
    return { status: 'queued' };
  }
  function close() {
    if (closing) return closing;
    closed = true;
    closing = (async () => {
      if (preparing) await preparing.catch(() => {});
      const run = active;
      try { if (run && turnId) usage.unverified(run.reservation.id); } catch { }
      setState('stopping'); requests.cancel();
      if (run) cancelQuery(run, 'stop');
      for (const [id, status] of sent) if (status !== 'consumed') receipt(id, status === 'queued' ? 'rejected' : 'unknown');
      setState('stopped');
      if (run) {
        let timer;
        await Promise.race([run.task, new Promise(resolve => { timer = setTimeout(resolve, 1500); })]);
        clearTimeout(timer);
      }
    })();
    return closing;
  }
  return { start, resume: start, send, close, answer: requests.answer, snapshot: stream.snapshot,
    async interrupt() {
      requests.cancel();
      if (active && !active.closing) { active.interrupted = true; await active.query.interrupt?.(); }
    },
  };
}
module.exports = { createClaudeSession, inputQueue };
