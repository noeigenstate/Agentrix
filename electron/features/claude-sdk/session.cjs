const { randomUUID } = require('node:crypto');
const { createEventStream } = require('../native-session/events.cjs');
const { createNormalizer } = require('./normalize.cjs');
const { createRequests } = require('./requests.cjs');
const { createPolicy } = require('./policy.cjs');
const { billingIdentityError, startupFailure } = require('./identity.cjs');
const { inputQueue, queryOptions, readBillingIdentity } = require('./query.cjs');

async function waitWithin(task, milliseconds) {
  let timer;
  try { await Promise.race([task, new Promise(resolve => { timer = setTimeout(resolve, milliseconds); })]); }
  finally { clearTimeout(timer); }
}
function createClaudeSession(spec, emit, dependencies) {
  const { loadSdk, resolveExecutable, credentials, usage, now = Date.now, audit,
    onCost = () => {}, onFailure = () => {}, onSession = () => {} } = dependencies;
  const stream = createEventStream(spec, emit, now), secrets = new Set();
  const sent = new Map(), results = new Set();
  let active, opening, preparing, closing, sdk, executable, started = false, closed = false, stopping = false;
  let providerId = spec.providerSessionId || null, state = 'starting', turnId = null;
  let apiObservedAt = null;
  function clean(value) {
    let text = value;
    for (const key of secrets) text = text.replaceAll(key, '<secret>');
    return text;
  }
  const publish = (type, payload, extra) => stream.publish(type, JSON.parse(clean(JSON.stringify(payload))), extra);
  const setState = (next, reason = null) => { state = next; publish('session.state', { state, reason }); };
  const requests = createRequests({ publish, state: next => { if (!closed && !stopping) setState(next); } });
  const normalize = createNormalizer(publish, clean), policy = createPolicy(spec, audit);
  function receipt(id, status) {
    if (!sent.has(id) || sent.get(id) === status) return;
    sent.set(id, status); publish('input.receipt', { clientMessageId: id, status });
  }
  function begin(origin, clientMessageId) {
    turnId = randomUUID(); stream.turn(turnId);
    publish('turn.started', { origin, clientMessageId }); setState('running');
  }
  function reserve(run) {
    run.reservation ||= usage.reserve(spec.monthlyBudgetUsd ?? null, { sessionId: providerId, resume: !!providerId,
      maxBudgetUsd: run.remainingBudgetUsd });
  }
  function releaseIdle(run) {
    if (!run.reservation) return;
    usage.release(run.reservation.id); run.reservation = null;
  }
  function finishReservation(run) {
    if (!run.reservation) return;
    if (run.busy && run.initialized) usage.unverified(run.reservation.id);
    if (usage.finish) usage.finish(run.reservation.id, { started: run.initialized });
    else usage.release(run.reservation.id);
    run.reservation = null;
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
  function unavailable(message, generation) {
    const reason = { rate_limit: 'rate_limited', billing_error: 'credits_exhausted', authentication_failed: 'invalid_key' }[message.error];
    if (!reason) return;
    onFailure(reason, null, generation);
    publish('limits.updated', { scopeId: spec.scopeId || spec.runtimeSessionId, billingRoute: 'api', observedAtMs: now(),
      state: 'unavailable', limitsById: {}, resetCredits: null, ordinaryUsageAllowed: null, source: reason });
  }
  function budgetNotice() {
    const exhausted = usage.available(spec.monthlyBudgetUsd ?? null) <= 0;
    const message = exhausted ? '本月 API 预算已用完。' : '本轮 API 预算上限已用完，请发送新消息继续。';
    publish('error', { code: 'budget_exhausted', message, retryable: !exhausted, willRetry: false, stage: 'runtime' });
    if (exhausted) publish('limits.updated', { scopeId: spec.scopeId || spec.runtimeSessionId, billingRoute: 'api', observedAtMs: now(),
      state: 'unavailable', limitsById: {}, resetCredits: null, ordinaryUsageAllowed: null, source: 'budget_exhausted' });
    return message;
  }
  function observeBackground(run, message) {
    if (message.type !== 'system') return;
    if (message.subtype === 'background_tasks_changed') {
      run.backgroundKnown = true; run.background = new Map(message.tasks.map(task => [task.task_id, task.run_id]));
    } else if (['task_started', 'task_updated', 'task_notification'].includes(message.subtype)) {
      const previous = run.background.get(message.task_id);
      if (previous && (!message.run_id || message.run_id < previous)) return;
      if (message.subtype === 'task_notification' || message.patch?.is_backgrounded === false
        || ['completed', 'failed', 'stopped'].includes(message.patch?.status)) run.background.delete(message.task_id);
      else if (message.subtype === 'task_started' && message.is_backgrounded !== false || message.patch?.is_backgrounded === true) run.background.set(message.task_id, message.run_id);
    } else return;
    setState(state);
  }
  async function pump(run) {
    let idle = false;
    try {
      for await (const message of run.query) {
        if (closed || run.closing) break;
        if (message.type === 'system' && message.subtype === 'init' && !message.parent_tool_use_id) {
          if (message.apiKeySource !== 'ANTHROPIC_API_KEY') throw billingIdentityError(message.apiKeySource);
          run.initialized = true; providerId = message.session_id; stream.provider(providerId);
          apiObservedAt = now();
          usage.bind?.(run.reservation?.id, providerId); onSession(providerId);
          run.model = message.model || null;
          publish('routing.updated', {
            declared: { model: spec.model || null, effort: spec.effort || null, fast: spec.fast ?? null },
            effective: { model: run.model, effort: null, fast: null },
            observed: { model: run.model, effort: null, fast: null }, reason: null,
          });
        }
        observeBackground(run, message);
        if (!run.initialized) {
          if (['assistant', 'result'].includes(message.type)) throw billingIdentityError(null, { messageType: message.type });
          // Startup status/auth/rate-limit notices carry no execution or billing evidence.
          continue;
        }
        if (message.isReplay === true) { normalize(message); continue; }
        if (stopping && (message.type !== 'result' || message.parent_tool_use_id)) continue;
        if (message.user_message_uuid) receipt(message.user_message_uuid, 'consumed');
        for (const id of message.user_message_uuids || []) receipt(id, 'consumed');
        unavailable(message, run.generation);
        if (message.type === 'assistant' && !turnId && !message.parent_tool_use_id) {
          reserve(run); run.busy = true; begin('automatic', message.user_message_uuid || null);
        }
        normalize(message);
        if (message.type !== 'result' || message.parent_tool_use_id) continue;
        const resultId = message.uuid || message.result_index;
        if (resultId !== undefined && results.has(resultId)) continue;
        if (resultId !== undefined) results.add(resultId);
        const entry = usage.record(providerId, message, { resume: !!run.resumeId, reservationId: run.reservation?.id });
        if (entry.deltaUsdMicros > 0) run.remainingBudgetUsd = Math.max(0, Math.round(run.remainingBudgetUsd * 1e6 - entry.deltaUsdMicros) / 1e6);
        publish('usage.updated', entry.snapshot);
        if (entry.deltaUsdMicros > 0) onCost({ ...entry, spec: { ...spec, model: run.model || spec.model }, providerSessionId: providerId });
        requests.cancel();
        const budgetBlocked = message.subtype === 'error_max_budget_usd';
        // A hook of the owner's own may still pause a tool: the result then says success with nothing done, which is not a finished turn.
        const deferred = !!message.deferred_tool_use;
        const status = run.interrupted || budgetBlocked ? 'interrupted' : message.is_error || deferred ? 'failed' : 'completed';
        const error = budgetBlocked ? budgetNotice() : deferred ? '这次工具调用被钩子推迟，没有执行。' : status === 'failed' ? 'Claude 执行失败。' : null;
        publish('turn.completed', { status, error });
        run.interrupted = false;
        turnId = null; stream.turn(null);
        if (budgetBlocked) {
          run.busy = false; releaseIdle(run); run.onStoppedResult?.(); unknownInput();
          idle = !stopping; cancelQuery(run, 'budget'); break;
        }
        if (!(message.queued_turn_count > 0)) {
          run.busy = false;
          releaseIdle(run);
          run.onStoppedResult?.();
          if (spec.owner === 'dispatch' || stopping) { idle = !stopping; cancelQuery(run, stopping ? 'stop' : 'idle'); break; }
          setState('idle');
        }
      }
      if (!closed && !idle && !run.closing) { unknownInput(); requests.cancel(); setState('stopped'); }
    } catch (error) {
      // close()/idle retirement may reject iteration with AbortError. Its accounting was already settled above.
      if (!run.closing) {
        usage.unverified(run.reservation?.id);
        if (!closed) {
          if (error.code === 'budget_exhausted') {
            if (!turnId) begin('automatic', null);
            publish('turn.completed', { status: 'interrupted', error: budgetNotice() });
            turnId = null; stream.turn(null); idle = true;
            requests.cancel(); unknownInput();
          } else {
            const failure = startupFailure(error), code = failure.code === 'billing_identity_mismatch' ? failure.code : 'sdk_failed';
            onFailure(code, failure, run.generation);
            publish('error', { code, message: code === 'billing_identity_mismatch' ? failure.message : 'Claude API 会话无法继续。', retryable: false, willRetry: false, stage: 'runtime' });
            requests.cancel(); unknownInput(); setState('failed', code);
          }
        }
      }
    } finally {
      cancelQuery(run, 'ended');
      try { finishReservation(run); }
      finally { secrets.delete(run.key); if (active === run) active = null; }
      if (idle && !closed && !stopping) setState('idle');
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
      if (stopping || closed) throw new Error('会话已停止。');
      const message = error.outdated ? 'Claude Code 版本过低，请升级到 2.1.317 或更高'
        : error.code === 'native_cli_required' ? '未找到原生 Claude Code，无法通过 API 运行' : 'Claude API 会话无法启动。';
      const failure = error.code === 'native_cli_required' ? Object.assign(new Error(message), { code: error.code, beforeInput: true }) : startupFailure(error);
      publish('error', { code: error.outdated ? 'native_cli_outdated' : failure.code, message: failure.message, retryable: false, willRetry: false, stage: 'startup' });
      setState('failed', failure.code);
      throw failure;
    }
  }
  async function createQuery(prepareOnly = false) {
    if (closed) throw new Error('会话已停止。');
    const key = credentials.read();
    if (!key) throw new Error('请先保存 API 密钥。');
    const reservation = prepareOnly ? null : usage.reserve(spec.monthlyBudgetUsd ?? null, { sessionId: providerId, resume: !!providerId });
    const maxBudgetUsd = reservation?.maxBudgetUsd ?? (spec.monthlyBudgetUsd == null ? undefined : Math.min(usage.available(spec.monthlyBudgetUsd) / 1e6, 5));
    const run = { key, reservation, resumeId: providerId, abort: new AbortController(), initialized: false, closing: null,
      generation: dependencies.availabilityGeneration?.(),
      remainingBudgetUsd: maxBudgetUsd ?? Infinity, busy: false, background: new Map(), backgroundKnown: !providerId };
    secrets.add(key);
    run.queue = inputQueue(id => receipt(id, 'delivered'));
    const options = queryOptions(spec, { key, executable, abort: run.abort,
      providerSessionId: providerId, maxBudgetUsd, policy,
      canUseTool: async (name, input, context) => {
        if (closed || stopping || run.closing) return { behavior: 'deny', message: '会话已停止。' };
        if (name === 'AskUserQuestion') return requests.open(name, input, context);
        const decision = policy(name, input);
        if (decision.behavior === 'defer' || decision.behavior === 'ask') return requests.open(name, input, context);
        return decision.behavior === 'allow' ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: decision.reason };
      },
    });
    try {
      run.query = sdk.query({ prompt: run.queue, options });
      opening = run;
      // The pinned SDK initializes its control channel without consuming a user prompt.
      // Check this account snapshot before allowing input; stream init remains an independent guard.
      await readBillingIdentity(run.query, { signal: run.abort.signal, timeoutMs: dependencies.initializationTimeoutMs });
      dependencies.onIdentity?.(run.generation);
      if (closed || stopping || run.closing) throw new Error('会话已停止。');
    } catch (error) {
      cancelQuery(run, 'startup'); if (reservation) usage.release(reservation.id); secrets.delete(key);
      if (stopping || closed) throw new Error('会话已停止。');
      const failure = startupFailure(error);
      onFailure(failure.code, failure, run.generation);
      publish('error', { code: failure.code, message: failure.message, retryable: false, willRetry: false, stage: 'startup' });
      setState('failed', failure.code);
      throw failure;
    } finally { if (opening === run) opening = null; }
    active = run; run.task = pump(run);
    void run.task.catch(() => { try { if (!closed) setState('failed', 'accounting_unavailable'); } catch { } });
    return run;
  }
  async function send({ clientMessageId, text, images = [] }) {
    if (closed || stopping || !started || ['failed', 'stopped'].includes(state)) throw new Error('会话已停止。');
    if (sent.has(clientMessageId)) return { status: sent.get(clientMessageId) };
    if (sent.size >= 2000) throw new Error('会话消息过多，请启动新会话。');
    if (/^\/clear(?:\s|$)/.test(text)) throw new Error('原生会话不支持此命令。');
    const content = images.length ? [{ type: 'text', text }, ...images.map(image => {
      const [, media_type, data] = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(image) || [];
      if (!data) throw new Error('无效的图片。');
      return { type: 'image', source: { type: 'base64', media_type, data } };
    })] : text;
    if (active?.closing) await active.task;
    if (active && !active.busy && !active.background.size) {
      const availableUsd = usage.available(spec.monthlyBudgetUsd ?? null) / 1e6;
      const freshBudgetUsd = spec.monthlyBudgetUsd == null ? Infinity : Math.min(availableUsd, 5);
      if (active.remainingBudgetUsd !== freshBudgetUsd) {
        // SDK caps accumulate across turns. Renew at an explicit message boundary, preserving live background work.
        cancelQuery(active, 'budget'); await active.task;
      }
    }
    if (!active) {
      preparing ||= createQuery().finally(() => { preparing = null; });
      await preparing;
    }
    if (closed || stopping) throw new Error('会话已停止。');
    if (sent.has(clientMessageId)) return { status: sent.get(clientMessageId) };
    reserve(active);
    active.busy = true;
    sent.set(clientMessageId, 'queued');
    if (!turnId) begin('user', clientMessageId);
    publish('input.receipt', { clientMessageId, status: 'queued' });
    publish('item.upsert', { kind: 'user-message', status: 'completed', content: { text, clientMessageId } }, { itemId: clientMessageId });
    active.queue.push({ type: 'user', uuid: clientMessageId, session_id: providerId || '', parent_tool_use_id: null, message: { role: 'user', content } });
    return { status: 'queued' };
  }
  function close() {
    if (closing) return closing;
    stopping = true;
    closing = (async () => {
      if (opening) cancelQuery(opening, 'stop');
      if (preparing) await preparing.catch(() => {});
      const run = active;
      setState('stopping'); requests.cancel();
      if (run?.busy && run.initialized && !run.closing) {
        // Interrupt can return the final cumulative usage; keep consuming only that result before closing.
        const result = new Promise(resolve => { run.onStoppedResult = resolve; });
        run.interrupted = true;
        try { Promise.resolve(run.query.interrupt?.()).catch(() => {}); } catch { }
        await waitWithin(result, 750); run.onStoppedResult = null;
      }
      closed = true;
      if (run) cancelQuery(run, 'stop');
      try { if (run) finishReservation(run); } catch { }
      for (const [id, status] of sent) if (status !== 'consumed') receipt(id, status === 'queued' ? 'rejected' : 'unknown');
      setState('stopped');
      if (run) await waitWithin(run.task.catch(() => {}), 1500);
    })();
    return closing;
  }
  return { start, resume: start, send, close, answer: requests.answer, snapshot: stream.snapshot,
    checkpoint(restore) {
      const key = active?.key || credentials.read();
      return key ? (spec, emit) => restore(spec, emit, { status: () => ({ saved: true }), read: () => key }) : null;
    },
    activity: () => ({ known: active?.backgroundKnown === true || !active && !providerId, count: active?.backgroundKnown ? active.background.size : !providerId ? 0 : null }),
    async prepareResume() {
      if (!providerId || !started || closed) throw new Error('resume_unavailable');
      // Read the actual persisted chain, then initialize a real resumed CLI with an empty input queue.
      const history = await sdk.getSessionMessages?.(providerId, { dir: spec.cwd, limit: 1000 });
      if (!history?.length || history.some(message => message.session_id !== providerId)) throw new Error('resume_history_unavailable');
      preparing ||= createQuery(true).finally(() => { preparing = null; });
      await preparing;
      for (const message of history) normalize({ ...message, isReplay: true });
      return { providerSessionId: providerId };
    },
    connection: () => !active || closed || ['stopped', 'failed', 'disconnected'].includes(state)
      ? { kind: 'none', source: null, observedAt: null }
      : { kind: active.initialized ? 'api' : 'unknown', source: active.initialized ? 'claude-sdk init: ANTHROPIC_API_KEY' : null,
        observedAt: active.initialized ? apiObservedAt : null },
    async interrupt() {
      requests.cancel();
      if (active && !active.closing) { active.interrupted = true; await active.query.interrupt?.(); }
    },
  };
}
module.exports = { createClaudeSession, inputQueue };
