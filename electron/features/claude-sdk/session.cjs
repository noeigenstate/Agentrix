const { randomUUID } = require('node:crypto');
const { createEventStream } = require('../native-session/events.cjs');
const { createNormalizer } = require('./normalize.cjs');
const { TokenRates } = require('../agents/token-rate.cjs');
const { createRequests } = require('./requests.cjs');
const { createPolicy } = require('./policy.cjs');
const { billingIdentityError, startupFailure } = require('./identity.cjs');
const { inputQueue, queryOptions, readBillingIdentity } = require('./query.cjs');
const { turnResult, tokensOf, hasModelReply } = require('./result.cjs');
const { rateLimits } = require('./limits.cjs');
const { claudeCommands } = require('./commands.cjs');
const { runShell } = require('./shell.cjs');
const { sessionHistory } = require('./history.cjs');
const { panelCommand, answer: panelAnswer, createTally, initFacts } = require('./panel.cjs');

async function waitWithin(task, milliseconds) {
  let timer;
  try { await Promise.race([task, new Promise(resolve => { timer = setTimeout(resolve, milliseconds); })]); }
  finally { clearTimeout(timer); }
}
function createClaudeSession(spec, emit, dependencies) {
  spec.fast = false;
  const { loadSdk, resolveExecutable, credentials, usage, now = Date.now, audit,
    onCost = () => {}, onFailure = () => {}, onSession = () => {} } = dependencies;
  const stream = createEventStream(spec, emit, now), secrets = new Set();
  const sent = new Map(), results = new Set();
  let active, opening, preparing, closing, sdk, executable, started = false, closed = false, stopping = false;
  let providerId = spec.providerSessionId || null, state = 'starting', turnId = null;
  let apiObservedAt = null, limits = null, fallbackInput = null, resultCost = 0, observedModel = null;
  let changingOptions = null;
  let shellAbort = null, defaultModelReset = false;
  const shellControllers = new Set();
  async function stopShells(foregroundOnly = false) {
    const jobs = [...shellControllers].filter(job => !foregroundOnly || !job.returned);
    for (const job of jobs) job.abort.abort();
    await Promise.allSettled(jobs.map(async job => { try { await job.task; } finally { await job.closed; } }));
    for (const job of jobs) shellControllers.delete(job);
  }
  const shells = new Map();
  function clean(value) {
    let text = value;
    for (const key of secrets) text = text.replaceAll(key, '<secret>');
    return text;
  }
  const rates = new TokenRates('claude'), tally = createTally();
  let rateUsage = { input: null, cachedInput: null, cacheWrite: null, output: null, reasoning: null, contextWindow: null, costUsdMicros: null, costEstimated: null };
  const publish = (type, payload, extra) => {
    if (type === 'usage.updated') rateUsage = payload;
    return stream.publish(type, JSON.parse(clean(JSON.stringify(payload))), extra);
  };
  const setState = (next, reason = null) => { state = next; publish('session.state', { state, reason }); };
  const requests = createRequests({ publish, state: next => { if (!closed && !stopping) setState(next); } });
  const normalize = createNormalizer(publish, clean), policy = createPolicy(spec, audit);
  function receipt(id, status) {
    if (!sent.has(id) || sent.get(id) === status) return;
    sent.set(id, status); publish('input.receipt', { clientMessageId: id, status });
  }
  function begin(origin, clientMessageId) {
    turnId = randomUUID(); stream.turn(turnId);
    rates.nativeBegin(now());
    rateUsage = { ...rateUsage, round: null };
    publish('turn.started', { origin, clientMessageId }); setState('running');
  }
  const canContinue = () => dependencies.canContinue?.() !== false;
  function reserve(run) {
    if (run.reservation && usage.currentReservation?.(run.reservation.id) === false) {
      usage.finish(run.reservation.id, { started: run.initialized }); run.reservation = null;
    }
    run.reservation ||= usage.reserve(spec.monthlyBudgetUsd ?? null, { sessionId: providerId, resume: !!providerId,
      maxBudgetUsd: run.remainingBudgetUsd });
  }
  function releaseIdle(run) {
    if (!run.reservation) return;
    // A resumed history anchor may still have unknown spend. Keep ownership of its
    // held allowance so the same capped query can obtain the later accounting evidence.
    if (usage.release(run.reservation.id) !== false) run.reservation = null;
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
  function unavailable(message, run) {
    const observed = rateLimits(message, limits, spec.scopeId || spec.runtimeSessionId, now());
    const quota = ['credits_required', 'spend_limit'].includes(observed?.notice?.code);
    if (quota && spec.quotaFallback?.()) observed.notice = { code: observed.notice.code, resetsAtMs: observed.notice.resetsAtMs,
      message: 'API 额度已用完，本轮结束后将转到 Claude Code 终端。' };
    if (observed) { limits = observed; publish('limits.updated', limits); }
    if (quota) run.quotaRejected = true;
    const reason = observed?.notice ? quota && !(spec.owner === 'dispatch' && observed.notice.code === 'spend_limit') ? 'credits_exhausted' : 'rate_limited'
      : message.error === 'authentication_failed' ? 'invalid_key' : null;
    if (!reason) return;
    // Owner fallback follows quota evidence only. Workers retain their previous routing.
    if (spec.owner === 'dispatch' ? reason !== 'credits_exhausted' : reason !== 'rate_limited') onFailure(reason, null, run.generation);
    if (observed) publish('error', { code: observed.notice.code, message: observed.notice.message, retryable: false, willRetry: false, stage: 'turn' });
    else publish('limits.updated', { scopeId: spec.scopeId || spec.runtimeSessionId, billingRoute: 'api', observedAtMs: now(),
      state: 'unavailable', limitsById: {}, resetCredits: null, ordinaryUsageAllowed: null, source: reason });
  }
  function budgetNotice() {
    const exhausted = usage.available(spec.monthlyBudgetUsd ?? null, active?.reservation?.id) <= 0;
    const message = exhausted ? '本月 API 预算已用完。' : active?.background.size
      ? 'API 预算上限已用完。后台任务结束后才能继续，或先停止它们。' : 'API 预算上限已用完，请发送新消息继续。';
    publish('error', { code: 'budget_exhausted', message, retryable: !exhausted, willRetry: false, stage: 'runtime' });
    if (exhausted) publish('limits.updated', { scopeId: spec.scopeId || spec.runtimeSessionId, billingRoute: 'api', observedAtMs: now(),
      state: 'unavailable', limitsById: {}, resetCredits: null, ordinaryUsageAllowed: null, source: 'budget_exhausted' });
    return message;
  }
  function observeBackground(run, message) {
    if (message.type !== 'system') return;
    if (message.subtype === 'background_tasks_changed') {
      run.background = new Map(message.tasks.map(task => [task.task_id, task.run_id]));
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
        if (message.type === 'system' && !message.parent_tool_use_id) {
          if (message.subtype === 'init') {
            run.slashCommands = Array.isArray(message.slash_commands) ? message.slash_commands : null;
            run.terminalCommands = Array.isArray(message.terminal_slash_commands) ? message.terminal_slash_commands : null;
          } else if (message.subtype === 'commands_changed' && Array.isArray(message.commands)) run.commands = message.commands;
        }
        if (message.type === 'system' && message.subtype === 'init' && !message.parent_tool_use_id) {
          if (message.apiKeySource !== 'ANTHROPIC_API_KEY') throw billingIdentityError(message.apiKeySource);
          run.initialized = true; run.init = initFacts(message); providerId = message.session_id; stream.provider(providerId);
          apiObservedAt = now();
          usage.bind?.(run.reservation?.id, providerId); onSession(providerId);
          run.model = run.resetModel || message.model || null;
          observedModel = run.model;
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
        if (message.isReplay === true) { normalize(message, { live: true }); continue; }
        if (stopping && (message.type !== 'result' || message.parent_tool_use_id)) continue;
        if (!message.parent_tool_use_id && !message.isSidechain) {
          if (message.type === 'system' && message.subtype === 'status' && message.status === 'compacting') run.compactionStarted = true;
          // The CLI's failed automatic compact is a synthetic error reply. The
          // ordinary transcript filter omits those; retain its reason only for
          // an explicitly observed compact followed by a failed final result.
          if (run.compactionStarted && message.type === 'assistant' && message.error && message.message?.model === '<synthetic>') {
            run.compactFailure = (Array.isArray(message.message.content) ? message.message.content : [])
              .filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n').slice(0, 2000);
          }
        }
        if (message.user_message_uuid) receipt(message.user_message_uuid, 'consumed');
        for (const id of message.user_message_uuids || []) receipt(id, 'consumed');
        unavailable(message, run);
        if (message.type === 'assistant' && message.message?.model !== '<synthetic>'
          || message.type === 'stream_event' || message.type === 'user' && Array.isArray(message.message?.content) && message.message.content.some(block => block.type === 'tool_result')) run.executed = true;
        if (message.type === 'assistant' && !message.parent_tool_use_id && message.message?.model === '<synthetic>') run.synthetic = true;
        if (message.error === 'billing_error' && message.message?.model === '<synthetic>') run.billingRejected = true;
        if (hasModelReply(message)) run.modelReplied = true;
        if (message.type === 'assistant' && !message.parent_tool_use_id && message.message?.usage) {
          run.lastUsage = tokensOf(message.message.usage); run.lastModel = message.message.model;
        }
        if (message.type === 'assistant' && !turnId && !message.parent_tool_use_id) {
          if (!canContinue()) {
            if (!run.background.size) { cancelQuery(run, 'path_changed'); break; }
            run.busy = true; run.interrupted = true; begin('automatic', message.user_message_uuid || null);
            try { Promise.resolve(run.query.interrupt()).catch(() => {}); } catch { }
            continue;
          }
          reserve(run); run.busy = true; begin('automatic', message.user_message_uuid || null);
        }
        if (rates.nativeClaude(message, now())) publish('usage.updated', rateUsage);
        const context = normalize(message, { live: true });
        if (message.type !== 'result' || message.parent_tool_use_id) continue;
        const resultId = message.uuid || message.result_index;
        if (resultId !== undefined && results.has(resultId)) continue;
        if (resultId !== undefined) results.add(resultId);
        const refusal = spec.owner === 'dispatch' ? run.billingRejected && message.total_cost_usd === 0
          : run.quotaRejected && run.synthetic && !run.executed && message.total_cost_usd === resultCost;
        const rejected = refusal && message.is_error === true && message.usage
          && Object.values(tokensOf(message.usage)).every(value => value === null || value === 0);
        if (run.quotaRejected && spec.owner !== 'dispatch') {
          // Shell context is already recorded by the CLI. Never turn it back into
          // an executable !command in the fallback composer or automatic replay.
          const inputs = (run.turnInputs || []).filter(input => !run.shellInputs?.has(input.clientMessageId));
          // A CLI consumption receipt proves stdin delivery, not model execution. Only the final
          // synthetic refusal plus explicit zero usage can override that receipt for this one input.
          fallbackInput = inputs.length ? { input: inputs[0], ...(inputs.length > 1 ? { remaining: inputs.slice(1) } : {}),
            safe: !!(inputs.length === 1 && rejected && sent.get(inputs[0].clientMessageId) === 'consumed'
            && message.usage?.input_tokens === 0 && message.usage?.output_tokens === 0 && !run.interrupted) } : null;
        }
        if (spec.owner !== 'dispatch' && !message.is_error && !run.quotaRejected && Object.values(tokensOf(message.usage) || {}).some(value => value > 0)) dependencies.onSuccess?.(run.generation);
        const entry = usage.record(providerId, message, { resume: !!run.resumeId, reservationId: run.reservation?.id, rejected });
        resultCost = message.total_cost_usd;
        tally.result(message);
        run.billingRejected = false;
        if (entry.deltaUsdMicros > 0) run.remainingBudgetUsd = Math.max(0, Math.round(run.remainingBudgetUsd * 1e6 - entry.deltaUsdMicros) / 1e6);
        const lastUsage = run.lastUsage;
        const contextTokens = lastUsage && [lastUsage.input, lastUsage.cachedInput, lastUsage.cacheWrite, lastUsage.output].every(value => value !== null)
          ? lastUsage.input + lastUsage.cachedInput + lastUsage.cacheWrite + lastUsage.output : null;
        const modelWindow = message.modelUsage?.[run.lastModel]?.contextWindow;
        publish('usage.updated', { ...entry.snapshot, ...(Number.isSafeInteger(modelWindow) && modelWindow > 0 ? { contextWindow: modelWindow } : {}), contextTokens, round: tokensOf(message.usage) });
        if (entry.deltaUsdMicros > 0) onCost({ ...entry, spec: { ...spec, model: run.model || spec.model }, providerSessionId: providerId });
        requests.cancel();
        const budgetBlocked = message.terminal_reason === 'budget_exhausted' || message.subtype === 'error_max_budget_usd';
        const interrupted = run.interrupted;
        const outcome = turnResult(message, { interrupted, costUsdMicros: entry.deltaUsdMicros, compacted: context?.compacted });
        if (run.compactionStarted && !context?.compacted && outcome.status === 'failed' && message.local_command !== 'compact') {
          outcome.error = outcome.message = run.compactFailure || '上下文压缩失败。' + outcome.message;
          publish('error', { code: 'context_compaction_failed', message: outcome.message, retryable: false, willRetry: false, stage: 'turn' });
        }
        // Raw SDK input can change the CLI model too. Carry only a successful,
        // identified local /model command into the next query. Its new init may
        // arrive on the next input; a reply's model is not a configuration choice.
        const modelInput = run.turnInputs?.find(input => input.clientMessageId === message.user_message_uuid);
        const modelChoice = message.local_command === 'model' && message.subtype === 'success' && message.is_error === false && outcome.status === 'completed'
          && /^\/model\s+(\S+)\s*$/.exec(modelInput?.text?.trim() || '');
        if (modelChoice) { defaultModelReset = modelChoice[1] === 'default'; spec.model = defaultModelReset ? null : modelChoice[1]; }
        if (budgetBlocked) outcome.error = outcome.message = budgetNotice();
        if (!run.interrupted && !run.modelReplied && (message.is_error === true || outcome.status === 'failed')) {
          for (const id of run.shellInputs || []) shells.get(id)?.reject(null, { completedTurn: true,
            switching: spec.quotaFallback?.() && (run.quotaRejected || budgetBlocked) });
        }
        for (const id of run.shellInputs || []) delete shells.get(id)?.reject;
        publish('turn.completed', outcome);
        run.turnInputs = []; run.shellInputs = null; run.modelReplied = false; run.executed = false; run.synthetic = false; run.quotaRejected = false;
        run.interrupted = false;
        run.compactionStarted = false; run.compactFailure = null;
        rates.nativeEnd(); turnId = null; stream.turn(null);
        if (interrupted) unknownInput();
        if (budgetBlocked) {
          run.busy = false; releaseIdle(run); run.onStoppedResult?.(); unknownInput();
          if (run.background.size) { setState('idle'); continue; }
          idle = !stopping; cancelQuery(run, 'budget'); break;
        }
        if (!canContinue()) {
          run.busy = false; releaseIdle(run); unknownInput();
          if (run.background.size) { setState('idle'); continue; }
          idle = true; cancelQuery(run, 'path_changed'); break;
        }
        // queued_turn_count can predate a late stdin write. A worker must answer
        // every accepted input before its otherwise-idle query is retired.
        const unread = spec.owner === 'dispatch' && [...sent.values()].some(status => ['queued', 'delivered'].includes(status));
        if (!(message.queued_turn_count > 0) && !unread) {
          run.busy = false;
          releaseIdle(run);
          run.onStoppedResult?.();
          if (spec.owner === 'dispatch' || stopping && !run.background.size) { idle = !stopping; cancelQuery(run, stopping ? 'stop' : 'idle'); break; }
          setState('idle');
        }
      }
      if (!closed && !idle && !run.closing) { unknownInput(); requests.cancel(); setState('stopped'); }
    } catch (error) {
      // close()/idle retirement may reject iteration with AbortError. Its accounting was already settled above.
      if (!run.closing) {
        usage.unverified(run.reservation?.id);
        if (!closed) {
          if (run.interrupted || error.code === 'budget_exhausted') {
            if (!turnId) begin('automatic', null);
            const outcome = turnResult({ terminal_reason: 'budget_exhausted' }, { interrupted: !!run.interrupted });
            if (!run.interrupted) outcome.error = outcome.message = budgetNotice();
            publish('turn.completed', outcome);
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
      for (const id of run.shellInputs || []) delete shells.get(id)?.reject;
      publish('context.compacting', { active: false });
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
    const maxBudgetUsd = spec.monthlyBudgetUsd == null ? undefined : usage.available(spec.monthlyBudgetUsd) / 1e6;
    const run = { key, reservation: null, resumeId: providerId, abort: new AbortController(), initialized: false, closing: null,
      generation: dependencies.availabilityGeneration?.(), keyVersion: dependencies.credentialVersion?.(),
      remainingBudgetUsd: maxBudgetUsd ?? Infinity, busy: false, background: new Map() };
    secrets.add(key);
    run.queue = inputQueue(id => receipt(id, 'delivered'));
    try {
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
      if (!prepareOnly) {
        run.reservation = usage.reserve(spec.monthlyBudgetUsd ?? null, { sessionId: providerId, resume: !!providerId });
        options.maxBudgetUsd = run.reservation.maxBudgetUsd;
        run.remainingBudgetUsd = options.maxBudgetUsd ?? Infinity;
      }
      run.query = sdk.query({ prompt: run.queue, options });
      opening = run;
      // The pinned SDK initializes its control channel without consuming a user prompt.
      // Check this account snapshot before allowing input; stream init remains an independent guard.
      await readBillingIdentity(run.query, { signal: run.abort.signal, timeoutMs: dependencies.initializationTimeoutMs });
      // A resumed transcript retains its last explicit model. Reapply an
      // acknowledged default reset before the renewed query accepts any input.
      if (defaultModelReset && providerId && run.query.setModel) {
        await run.query.setModel(undefined);
        const context = await run.query.getContextUsage();
        run.resetModel = typeof context.model === 'string' ? context.model : null;
      }
      dependencies.onIdentity?.(run.generation);
      if (closed || stopping || run.closing) throw new Error('会话已停止。');
      if (!prepareOnly && !canContinue()) {
        cancelQuery(run, 'path_changed'); if (run.reservation) usage.release(run.reservation.id); secrets.delete(key); return null;
      }
    } catch (error) {
      cancelQuery(run, 'startup'); if (run.reservation) usage.release(run.reservation.id); secrets.delete(key);
      if (stopping || closed) throw new Error('会话已停止。');
      if (error.code === 'budget_exhausted') throw error;
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
  const connection = () => !active || closed || ['stopped', 'failed', 'disconnected'].includes(state)
    ? { kind: 'none', source: null, observedAt: null }
    : { kind: active.initialized ? 'api' : 'unknown', source: active.initialized ? 'claude-sdk init: ANTHROPIC_API_KEY' : null,
      observedAt: active.initialized ? apiObservedAt : null };
  // /context, /cost, /status and /usage are read-only questions for the owner's window: they are no input of the model, leave no receipt or item and take no turn.
  async function panel(command, images, clientMessageId) {
    if (images.length) throw new Error('命令不能附带图片。');
    if (closed || stopping || !started || ['failed', 'stopped'].includes(state)) throw new Error('会话已停止。');
    if (changingOptions) { try { await changingOptions; } catch { } }
    const read = command === 'context' || command === 'status' ? async () => {
      const context = await (await optionsQuery()).query.getContextUsage();
      if (typeof context?.model === 'string') observedModel = context.model;
      return context;
    } : null;
    const local = await panelAnswer(command, { read, tally, summary: usage.summary?.() ?? {}, budgetUsd: spec.monthlyBudgetUsd, limits, connection: connection(), init: active?.init,
      session: () => ({ model: observedModel, effort: spec.effort || null, cwd: spec.cwd || null, sessionId: providerId }) });
    if (closed || stopping) throw new Error('会话已停止。');
    return { clientMessageId, status: 'consumed', local: JSON.parse(clean(JSON.stringify(local))) };
  }
  async function send({ clientMessageId, text, images = [] }, shellContent) {
    const command = !shellContent && spec.owner !== 'dispatch' && typeof text === 'string' ? panelCommand(text) : null;
    if (command) return panel(command, images, clientMessageId);
    if (shellAbort && !shellContent) throw new Error('命令仍在运行，请等待结束。');
    if (changingOptions) await changingOptions;
    if (typeof text !== 'string' || !text.trim() && !images.length) throw new Error('无效的消息。');
    if (closed || stopping || !started || ['failed', 'stopped'].includes(state)) throw new Error('会话已停止。');
    if (sent.has(clientMessageId)) return { status: sent.get(clientMessageId) };
    if (!canContinue()) return { status: 'rejected' };
    if (sent.size >= 2000) throw new Error('会话消息过多，请启动新会话。');
    if (/^\/(?:clear|reset|new)(?:\s|$)/.test(text)) throw new Error('原生会话不支持此命令。');
    let content = images.length ? [...(text.trim() ? [{ type: 'text', text }] : []), ...images.map(image => {
      const [, media_type, data] = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(image) || [];
      if (!data) throw new Error('无效的图片。');
      return { type: 'image', source: { type: 'base64', media_type, data } };
    })] : text;
    if (active?.closing) await active.task;
    if (active && active.keyVersion !== dependencies.credentialVersion?.()) {
      if (active.busy) return { status: 'rejected' };
      await stopBackground(); cancelQuery(active, 'credentials_changed'); await active.task;
    }
    if (active && !active.busy && !active.background.size) {
      const availableUsd = usage.available(spec.monthlyBudgetUsd ?? null, active.reservation?.id) / 1e6;
      const freshBudgetUsd = spec.monthlyBudgetUsd == null ? Infinity : availableUsd;
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
    if (!canContinue()) return { status: 'rejected' };
    // No input has been queued yet; a key replaced during initialization must initialize again before delivery.
    if (active.keyVersion !== dependencies.credentialVersion?.()) { await stopBackground(); cancelQuery(active, 'credentials_changed'); await active.task; return send({ clientMessageId, text, images }, shellContent); }
    if (sent.has(clientMessageId)) return { status: sent.get(clientMessageId) };
    try { reserve(active); }
    catch (error) {
      if (error.code === 'budget_exhausted' && active.background.size) error.message = budgetNotice();
      throw error;
    }
    // Settings invalidate failures while owner queries stay open at idle. An explicit
    // new turn observes the new generation without letting an old in-flight failure rearm it.
    if (!active.busy) active.generation = dependencies.availabilityGeneration?.();
    active.busy = true;
    (active.turnInputs ||= []).push({ clientMessageId, text, images });
    fallbackInput = null;
    if (shellContent) { active.executed = true; (active.shellInputs ||= new Set()).add(clientMessageId); }
    sent.set(clientMessageId, 'queued');
    if (!turnId) begin('user', clientMessageId);
    publish('input.receipt', { clientMessageId, status: 'queued' });
    if (!shellContent) publish('item.upsert', { kind: 'user-message', status: 'completed', content: { text, clientMessageId, ...(images.length ? { images } : {}) } }, { itemId: clientMessageId });
    if (shellContent) content = shellContent;
    active.queue.push({ type: 'user', uuid: clientMessageId, session_id: providerId || '', parent_tool_use_id: null, message: { role: 'user', content } });
    return { status: 'queued' };
  }
  function close() {
    if (closing) return closing;
    stopping = true;
    closing = (async () => {
      await stopShells();
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
      // Full retirement owns cleanup; ordinary Stop still preserves live background work.
      try { await stopBackground(); } catch { }
      closed = true;
      if (run) cancelQuery(run, 'stop');
      try { if (run) finishReservation(run); } catch { }
      for (const [id, status] of sent) if (status !== 'consumed') receipt(id, status === 'queued' ? 'rejected' : 'unknown');
      setState('stopped');
      if (run) await waitWithin(run.task.catch(() => {}), 1500);
    })();
    return closing;
  }
  async function stopBackground() {
    const run = active;
    if (!run?.background.size) return;
    // A process exit alone does not stop Bash jobs on Windows. Ask the process which owns these task ids
    // to stop them and wait for its receipts before retiring that process. A helper launched by a background Bash is part of that task.
    let timer;
    try {
      await Promise.race([Promise.all([...run.background.keys()].map(id => run.query.stopTask(id))), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('background_stop_unconfirmed')), 3000);
      })]);
      const deadline = Date.now() + 3000;
      while (run.background.size && active === run && !run.closing && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
      if (run.background.size) throw new Error('background_stop_unconfirmed');
    } finally { clearTimeout(timer); }
  }
  const optionsSnapshot = () => ({ model: observedModel, effort: spec.effort || 'high', fast: spec.fast === true });
  async function optionsQuery() {
    if (closed || stopping || !started) throw new Error('会话已停止。');
    if (active?.closing) await active.task;
    if (!active) { preparing ||= createQuery(true).finally(() => { preparing = null; }); await preparing; }
    return active;
  }
  async function models() {
    const run = await optionsQuery();
    try {
      const rows = (await run.query.supportedModels()).map(row => ({ value: clean(String(row.resolvedModel || row.value)), displayName: clean(String(row.displayName)),
        description: clean(String(row.description || '')), efforts: row.supportedEffortLevels || [] }));
      if (observedModel && !rows.some(row => row.value === observedModel)) rows.push({ value: observedModel, displayName: observedModel, description: '', efforts: [] });
      return [...new Map(rows.map(row => [row.value, row])).values()];
    } catch (error) { error.message = clean(error.message); throw error; }
  }
  async function runOptions(patch) {
    if (patch.fast === true) throw new Error('Claude Agent SDK 目前不支持快速模式');
    if (!Object.keys(patch).length) {
      if (changingOptions) { try { await changingOptions; } catch {} }
      return optionsSnapshot();
    }
    const previous = changingOptions;
    const update = (async () => {
      if (previous) { try { await previous; } catch {} }
      const run = await optionsQuery();
      // Keep acknowledged changes on spec so budget renewal resumes with the same choices.
      if (Object.hasOwn(patch, 'model')) { await run.query.setModel(patch.model || undefined); spec.model = patch.model; defaultModelReset = patch.model === null; }
      const flags = {};
      if (Object.hasOwn(patch, 'effort')) flags.effortLevel = patch.effort;
      if (Object.hasOwn(patch, 'fast')) flags.fastMode = patch.fast;
      if (Object.keys(flags).length) {
        await run.query.applyFlagSettings(flags);
        if (Object.hasOwn(patch, 'effort')) spec.effort = patch.effort;
        if (Object.hasOwn(patch, 'fast')) spec.fast = patch.fast;
      }
      const context = await run.query.getContextUsage();
      if (typeof context.model === 'string') observedModel = context.model;
      return optionsSnapshot();
    })();
    changingOptions = update;
    try { return await update; }
    catch (error) { error.message = clean(error.message); throw error; }
    finally { if (changingOptions === update) changingOptions = null; }
  }
  function shell(clientMessageId, command) {
    if (shells.has(clientMessageId)) {
      const previous = shells.get(clientMessageId);
      if (previous.command !== command) throw new Error('消息标识已用于其他命令。');
      return previous.task;
    }
    if (state !== 'idle' || shellAbort || closed || changingOptions || preparing) throw new Error('当前正在工作，请等待空闲后再运行命令。');
    if (shells.size >= 2000) throw new Error('会话消息过多，请启动新会话。');
    shellAbort = new AbortController();
    const job = { abort: shellAbort }; shellControllers.add(job);
    const itemId = `shell:${clientMessageId}`, abort = shellAbort;
    let savedOutput = '', savedExitCode = null, notified = false;
    const card = (status, output = savedOutput, exitCode = savedExitCode, extra = {}) => {
      savedOutput = output; savedExitCode = exitCode;
      publish('item.upsert', { kind: 'command', status, content: { command, cwd: spec.cwd, output, exitCode, ...extra } }, { itemId });
    };
    const notSent = '命令已执行，但输出未发送给模型。请检查 API 和预算后重试。';
    const rejected = (error, { completedTurn = false, switching = false } = {}) => {
      if (!notified) {
        notified = true;
        delete shells.get(clientMessageId)?.reject;
        card(savedExitCode === 0 ? 'completed' : savedExitCode === null ? 'interrupted' : 'failed', savedOutput, savedExitCode, { modelDelivery: 'rejected' });
        const retained = switching ? '命令输出保留在本次会话历史中，切换到终端后会随下一条消息发送给模型，无需重新执行命令。' : '';
        publish('error', { code: 'shell_context_rejected', message: notSent + (retained ? '\n' + retained : ''), retryable: false, willRetry: false, stage: completedTurn ? 'turn' : 'input' });
      }
      const detail = typeof error?.message === 'string' ? clean(error.message) : '';
      return new Error(notSent + (detail && detail !== notSent ? '\n' + detail : ''));
    };
    card('running'); setState('running');
    const task = runShell({ cwd: spec.cwd, env: spec.env || process.env, command, signal: abort.signal,
      output: ({ stdout, stderr, combined }) => card('running', combined ?? stdout + stderr) }).then(async result => {
      job.closed = result.closed;
      job.returned = true;
      void result.closed.then(() => shellControllers.delete(job));
      card(result.exitCode === 0 ? 'completed' : result.exitCode === null ? 'interrupted' : 'failed', result.combined ?? result.stdout + result.stderr, result.exitCode);
      if (!abort.signal.aborted && result.exitCode !== null) {
        // Terminal success rows omit initial empty lines and trailing whitespace,
        // while preserving leading spaces; raw streams and card output stay intact.
        const merged = result.exitCode === 0 && typeof result.combined === 'string';
        const stdout = merged ? result.combined.replace(/^[\r\n]+/, '').trimEnd() : result.stdout, stderr = merged ? '' : result.stderr;
        const delivery = await send({ clientMessageId, text: '!' + command }, [
        { type: 'text', text: `<bash-input>${command}</bash-input>\n` },
        { type: 'text', text: `<bash-stdout>${stdout || (!stderr ? '(Bash completed with no output)' : '')}</bash-stdout><bash-stderr>${stderr}</bash-stderr>` },
        ]);
        if (delivery.status === 'rejected') throw new Error(notSent);
      }
      return { exitCode: result.exitCode };
    }).catch(error => { if (job.returned) throw rejected(error); card('failed'); throw error; }).finally(() => {
      if (!sent.has(clientMessageId)) delete shells.get(clientMessageId)?.reject;
      if (shellAbort === abort) shellAbort = null;
      if (!closed && !stopping && !active?.busy) setState('idle');
    });
    job.task = task;
    shells.set(clientMessageId, { command, task, reject: rejected }); return task;
  }
  return { start, resume: start, send, close, stopBackground, answer: requests.answer, snapshot: stream.snapshot,
    tokenRate: () => ({ ...rates.snapshot(), model: rates.model }),
    runOptions, models, shell,
    fallbackInput: () => fallbackInput && structuredClone(fallbackInput),
    async commands(fallback = []) {
      if (closed) return [];
      const run = active;
      if (!run || run.closing) return claudeCommands(null, fallback);
      let rows;
      try { rows = await run.query.supportedCommands?.(); } catch { }
      if (active !== run || run.closing) return claudeCommands(null, fallback);
      let current = run.commands ?? rows ?? run.slashCommands?.map(name => ({ name }));
      if (!run.commands && Array.isArray(current) && run.slashCommands) {
        const names = new Set(run.slashCommands.map(name => String(name).replace(/^\//, '')));
        current = current.filter(row => row && names.has(String(row.name).replace(/^\//, '')));
      }
      return claudeCommands(Array.isArray(current) ? current : null, fallback, run.terminalCommands)
        .map(row => ({ ...row, description: clean(row.description) }));
    },
    hasAllowance: () => !!active?.reservation && usage.currentReservation?.(active.reservation.id) !== false && active.remainingBudgetUsd > 0,
    checkpoint(restore) {
      let key; try { key = active?.key || credentials.read(); } catch { return null; }
      return key ? (spec, emit) => restore(spec, emit, { status: credentials.status,
        read: () => credentials.status().saved ? credentials.read() : key }) : null;
    },
    policyChanged() { if (!canContinue() && active && !active.busy && !active.background.size) cancelQuery(active, 'path_changed'); },
    activity: () => ({ known: true, count: active?.background.size || 0 }),
    async prepareResume({ allowFresh = false } = {}) {
      if (!started || closed || !providerId && !allowFresh) throw new Error('resume_unavailable');
      // Read the actual persisted chain, then initialize a real resumed CLI with an empty input queue.
      const history = providerId ? await sessionHistory(sdk, spec, providerId) : [];
      if (!history || !history.length && !allowFresh || history.some(message => message.session_id !== providerId)) throw new Error('resume_history_unavailable');
      if (!history.length) { providerId = null; stream.provider(null); }
      preparing ||= createQuery(true).finally(() => { preparing = null; });
      await preparing;
      for (const message of history.slice(-1000)) normalize({ ...message, isReplay: true });
      return { providerSessionId: providerId };
    },
    connection,
    async interrupt() {
      await stopShells(true);
      requests.cancel();
      if (active && !active.closing) { active.interrupted = true; await active.query.interrupt?.(); }
    },
  };
}
module.exports = { createClaudeSession, inputQueue };
