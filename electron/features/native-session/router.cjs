const { randomUUID } = require('node:crypto');
const { choosePath } = require('./routing.cjs');
const { validEvent } = require('./validate.cjs');
const { createEventStream } = require('./events.cjs');
const { nextPath } = require('./usage.cjs');
const { createSwitches } = require('./switches.cjs');
function createRouter({ claude, codex, settings, resolveSpec, terminal, emit, changed = () => {}, now = Date.now, saveSession = () => {}, readCommands = async () => [], terminalSessions = () => [], observeTerminal = () => ({ state: 'unknown' }), prepareTerminal, activateNative = () => {}, retireTerminal = () => {}, switchOptions = {} }) {
  const sessions = new Map(), terminalStreams = new Map(), busy = new Set(), occupied = new Set();
  const agents = { claude: { path: null, reason: null, limits: null }, codex: { path: null, reason: null, limits: null } };
  const ended = new Set(['stopped', 'failed', 'disconnected']);
  const eventStream = spec => createEventStream(spec, event => { emit(event); changed(spec.terminalId, event); }, now);
  function selection(spec, runtime, allowBudget = false, retained = false) {
    const config = { ...settings.get() };
    if (retained && switches.retained(spec.terminalId)) config.claudePath = 'api-only';
    let apiState = claude.apiState(config.monthlyBudgetUsd, spec.projectId, spec.apiTrial, spec.owner);
    if (spec.agent === 'claude' && config.claudePath === 'api-only' && apiState.status === 'credits_exhausted') return { path: 'api', reason: 'credits_exhausted' };
    if (apiState.status === 'budget_exhausted' && (allowBudget || runtime?.hasAllowance?.())) apiState = { status: 'ready' };
    return choosePath({ agent: spec.agent, ...config, apiState });
  }
  function pathChanged(agent, path, reason) {
    agents[agent] = { ...agents[agent], path, reason, ...(agent === 'claude' && path === 'terminal' ? { limits: null } : {}) };
  }
  function current(id, runtimeSessionId) {
    const record = sessions.get(id);
    if (!record || record.spec.runtimeSessionId !== runtimeSessionId) throw new Error('会话已变化，请刷新后重试。');
    // Resolve again: a removed project must not leave an accessible runtime.
    resolveSpec(id, record.spec.agent, false, true);
    return record;
  }
  function flushFailures(record) {
    for (const event of record.failures || []) record.stream.publish(event.type, event.payload);
    record.failures = [];
  }
  function unsent(record, message, reason) {
    record.inputs.set(message.clientMessageId, 'rejected');
    record.stream.publish('item.upsert', { kind: 'user-message', status: 'interrupted', content: { text: message.text, images: message.images, clientMessageId: message.clientMessageId, unsent: true } }, { itemId: message.clientMessageId });
    record.stream.publish('input.receipt', { clientMessageId: message.clientMessageId, status: 'rejected' });
    return { status: 'rejected', reason };
  }
  function makeRecord(spec, staged = false, restoreFactory) {
    const { agent } = spec;
    const record = { spec, runtime: null, lock: null, inputs: new Map(), staged, buffered: [] };
    record.stream = eventStream(spec);
    const receive = event => {
      if (record.staged) { record.buffered.push(event); return; }
      forward(record, event);
    };
    if (agent === 'claude') {
      spec.mayContinue = () => selection(spec, record.runtime, true, true).path === 'api';
      spec.quotaFallback = () => spec.owner !== 'dispatch' && settings.get().claudePath === 'api-then-terminal';
    }
    record.runtime = restoreFactory ? restoreFactory(spec, receive) : (agent === 'claude' ? claude : codex).create(spec, receive);
    return record;
  }
  function forward(record, event) {
    const { spec } = record, { agent, terminalId: id } = spec;
    if (sessions.get(id) !== record) return;
    if (!validEvent(event) || event.projectId !== spec.projectId || event.terminalId !== id || event.runtimeSessionId !== spec.runtimeSessionId ||
      record.epoch && event.connectionEpoch !== record.epoch || event.sequence <= (record.sequence || 0)) return;
    record.epoch = event.connectionEpoch; record.sequence = event.sequence;
    if (!record.retiring && event.type === 'session.state' && ended.has(event.payload.state)
      && switches.failed(id, spec.runtimeSessionId)) return;
    if (agent === 'claude' && (event.type === 'error' && event.payload.stage === 'startup' && settings.get().claudePath === 'api-then-terminal'
      || record.failures?.length && event.type === 'session.state' && event.payload.state === 'failed')) {
      (record.failures ||= []).push(event); return;
    }
    if (event.providerSessionId && !record.lock) {
      record.lock = `${agent}:${event.providerSessionId}`; occupied.add(record.lock);
    }
    if (event.providerSessionId && !record.persisted) {
      record.persisted = true;
      saveSession(id, { agent, providerSessionId: event.providerSessionId });
    }
    if (event.type === 'limits.updated') agents[agent].limits = event.payload;
    if (event.type === 'limits.updated' || event.type === 'usage.updated') reconcile();
    if (event.type === 'input.receipt') record.inputs.set(event.payload.clientMessageId, event.payload.status);
    // A proved empty rejected turn continues on the terminal. It must not announce an
    // interrupted round before the same owner input has reached its destination.
    if (event.type === 'turn.completed' && agent === 'claude' && spec.owner !== 'dispatch'
      && settings.get().claudePath === 'api-then-terminal' && record.runtime.fallbackInput?.()?.safe) { record.quotaCompletion = event; return; }
    record.stream.provider(event.providerSessionId); record.stream.turn(event.turnId);
    record.stream.publish(event.type, event.payload, { itemId: event.itemId, replay: event.replay, occurredAtMs: event.occurredAtMs });
    switches.observe(id);
  }
  async function start(id, { agent, resume = false }) {
    if (busy.has(id)) throw new Error('会话正在启动。');
    busy.add(id);
    try {
      const config = settings.get(), resolved = resolveSpec(id, agent, resume);
      const spec = { ...resolved, agent, runtimeSessionId: randomUUID(), monthlyBudgetUsd: config.monthlyBudgetUsd };
      terminalStreams.delete(id);
      const previous = sessions.get(id);
      if (previous && !ended.has(previous.runtime.snapshot().state)) throw new Error('请先停止当前会话。');
      switches.forget(id);
      if (previous) { await previous.runtime.close(); if (previous.lock) occupied.delete(previous.lock); sessions.delete(id); }
      if (agent === 'claude') await claude.refreshAvailability?.();
      if (agent === 'claude' && spec.owner !== 'dispatch' && spec.kind !== 'ssh' && config.claudePath === 'api-then-terminal') spec.apiTrial = claude.claimApiRetry?.(spec.projectId);
      const apiState = claude.apiState(config.monthlyBudgetUsd, spec.projectId, spec.apiTrial, spec.owner);
      const selection = choosePath({ agent, ...config, apiState });
      if (!selection.path) throw new Error(apiState.reason || 'Claude API 路径当前不可用。');
      if (selection.path === 'terminal') {
        const stream = createEventStream(spec, emit, now);
        stream.publish('path.changed', { previous: null, selected: 'terminal', reason: selection.reason }); terminalStreams.set(id, stream);
        await terminal(spec, selection.reason); pathChanged(agent, 'terminal', selection.reason); changed();
        return { runtimeSessionId: spec.runtimeSessionId };
      }
      const lock = spec.providerSessionId ? `${agent}:${spec.providerSessionId}` : null;
      if (lock && occupied.has(lock)) throw new Error('该会话正在其他终端运行。');
      if (lock) occupied.add(lock);
      const record = makeRecord(spec); record.lock = lock;
      const runtime = record.runtime; sessions.set(id, record);
      let startup;
      try { startup = await runtime[resume ? 'resume' : 'start'](spec); }
      catch (error) {
        if (record.lock) occupied.delete(record.lock);
        const reason = error.code || error.message;
        const codexUnavailable = agent === 'codex' && ['unsupported_codex_capabilities', 'unsupported_codex_version', 'codex_cli_required', 'rpc_timeout', 'process_failed', 'process_exited', 'disconnected', 'invalid_response', 'invalid_frame', 'invalid_json', 'frame_limit', 'ENOENT'].includes(reason);
        if (codexUnavailable || agent === 'claude' && settings.get().claudePath === 'api-then-terminal'
          && (error.code === 'native_cli_required' || error.beforeInput === true)) {
          const notice = codexUnavailable ? (reason === 'codex_cli_required' || reason === 'ENOENT'
            ? '未找到 Codex 原生运行器，已切换到终端。' : 'Codex 原生连接不可用，已切换到终端。') : error.beforeInput ? error.message : reason;
          record.stream.publish('path.changed', { previous: agent === 'claude' ? 'api' : 'subscription', selected: 'terminal', reason: notice });
          terminalStreams.set(id, record.stream);
          await runtime.close(); sessions.delete(id); await terminal(spec, notice);
          terminalStreams.set(id, record.stream); pathChanged(agent, 'terminal', notice); changed();
          return { runtimeSessionId: spec.runtimeSessionId };
        }
        flushFailures(record);
        throw error;
      }
      const reason = startup?.reason || selection.reason;
      record.stream.publish('path.changed', { previous: null, selected: selection.path === 'api' ? 'api' : 'subscription', reason });
      pathChanged(agent, selection.path, reason); changed(); return { runtimeSessionId: spec.runtimeSessionId };
    } finally { busy.delete(id); }
  }
  function localSessions() {
    return [...sessions.values()].filter(record => record.fallbackReason || switches.recovering(record.spec.terminalId) || !ended.has(record.runtime.snapshot().state))
      .map(record => ({ identity: record, record, spec: record.spec, path: record.spec.agent === 'claude' ? 'api' : 'native' }))
      .concat(terminalSessions().filter(session => !sessions.has(session.spec.terminalId)));
  }
  function carryHistory(source, target, inputs) {
    for (const event of source?.snapshot().events || []) {
      if (!['item.upsert', 'input.receipt', 'usage.updated', 'plan.updated', 'turn.diff'].includes(event.type)) continue;
      if (event.type === 'input.receipt') inputs?.set(event.payload.clientMessageId, event.payload.status);
      target.turn(event.turnId);
      target.publish(event.type, event.payload, { itemId: event.itemId, replay: true, occurredAtMs: event.occurredAtMs ?? event.receivedAtMs });
    }
    target.turn(null);
  }
  const switches = createSwitches({
    ...switchOptions,
    list: localSessions,
    choose: session => session.record?.fallbackReason ? { path: 'terminal', reason: session.record.fallbackReason } : selection(session.spec, session.record?.runtime),
    observe: session => session.record?.fallbackReason ? { state: 'idle', background: { known: true, count: 0 } } : session.record ? { state: session.record.runtime.snapshot().state,
      pending: [...session.record.inputs.values()].some(status => status === 'queued'),
      background: session.record.runtime.activity?.() || { known: true, count: 0 } } : observeTerminal(session),
    publish: (session, state) => {
      let stream = session.record?.stream || terminalStreams.get(session.spec.terminalId);
      if (!stream || stream.runtimeSessionId !== session.spec.runtimeSessionId) { stream = eventStream(session.spec); terminalStreams.set(session.spec.terminalId, stream); }
      stream.publish('switch.updated', state);
      if (state.outcome === 'failed' && session.record?.quotaCompletion) {
        const event = session.record.quotaCompletion; session.record.quotaCompletion = null;
        stream.publish(event.type, event.payload);
      }
    },
    async retire(session, reason) {
      const message = reason === '原会话恢复失败，草稿已保留，请重新启动会话。' ? reason : 'API 路径已不可用，会话已停止；未发送的内容已保留。';
      if (session.record) {
        session.record.retiring = true;
        await session.record.runtime.close();
        session.record.stream.publish('session.state', { state: 'stopped', reason: message });
        if (session.record.lock) occupied.delete(session.record.lock);
      } else retireTerminal(session, message);
      return { reason: message };
    },
    async prepare(session, target, handoff, currentChange, restoring, transition) {
      const id = session.spec.terminalId, old = session.record, previousStream = old?.stream || terminalStreams.get(id);
      if (!restoring) session.restoreFactory = old?.rollbackFactory || old?.runtime.checkpoint?.();
      if (!session.spec.providerSessionId) {
        session.spec.providerSessionId = old?.runtime.snapshot().events.findLast(event => event.providerSessionId)?.providerSessionId;
      }
      const hasHistory = session.spec.hasHistory || [...(old?.inputs.values() || [])].some(status => ['delivered', 'consumed', 'unknown'].includes(status))
        || previousStream?.snapshot().events.some(event => event.type === 'item.upsert' && event.payload.content?.unsent !== true);
      if (!session.spec.providerSessionId && hasHistory) throw new Error('missing_resume_identity');
      const spec = { ...session.spec, runtimeSessionId: randomUUID(), monthlyBudgetUsd: settings.get().monthlyBudgetUsd, allowFreshResume: !hasHistory };
      if (target === 'terminal') {
        if (!prepareTerminal) throw new Error('terminal_preparation_unavailable');
        const prepared = await prepareTerminal(spec, handoff, currentChange, transition);
        return { session: prepared.session, cancel: prepared.cancel, async commit() {
          if (transition.discardBackground) await old?.runtime.stopBackground?.();
          if (!currentChange()) throw new Error('session_changed');
          await prepared.commit();
          sessions.delete(id); if (old?.lock) occupied.delete(old.lock);
          const stream = eventStream(spec);
          stream.provider(spec.providerSessionId); terminalStreams.set(id, stream);
          carryHistory(previousStream, stream);
          let reason = old?.fallbackReason || null;
          if (spec.agent === 'claude' && settings.get().claudePath === 'api-then-terminal'
            && claude.apiState(settings.get().monthlyBudgetUsd, spec.projectId).status === 'credits_exhausted') {
            reason = 'API 额度已用完，已转到 Claude Code 终端。';
            const refused = old?.runtime.fallbackInput?.();
            if (refused && !old.fallbackTaken) {
              old.fallbackTaken = true;
              const draft = handoff.draft;
              let status = 'rejected';
              if (refused.safe && !draft.text && !draft.images.length && !draft.undelivered.length && !refused.input.images?.length) {
                try { status = (await prepared.send?.(refused.input))?.status || 'rejected'; }
                catch { status = 'unknown'; }
                if (status !== 'rejected') switches.input(id, spec.runtimeSessionId);
              }
              if (status !== 'delivered') {
                const returned = [refused.input, ...(refused.remaining || [])];
                if (!draft.text && !draft.images.length && !draft.undelivered.length && returned.length === 1 && !refused.input.images?.length) draft.text = refused.input.text;
                else for (const input of returned) {
                  if (!draft.undelivered.some(kept => kept.clientMessageId === input.clientMessageId)) draft.undelivered.push(input);
                }
                reason += ' 未自动发送的消息已保留，请检查终端输入框后继续。';
              }
            }
          }
          stream.publish('session.state', { state: 'idle', reason: null });
          stream.publish('path.changed', { previous: session.path === 'native' ? 'subscription' : session.path, selected: 'terminal', reason });
          pathChanged(spec.agent, 'terminal', reason); changed();
          // The destination is ready. A failed retirement must not destroy it and resurrect a closed source.
          try { await old?.runtime.close(); }
          catch { return { reason: '旧会话未能完全退出，已保留新会话。' }; }
          return { reason };
        } };
      }
      const record = makeRecord(spec, true, restoring?.restoreFactory);
      try {
        const initialized = await record.runtime[spec.providerSessionId ? 'resume' : 'start'](spec);
        if (initialized?.providerSessionId) spec.providerSessionId = initialized.providerSessionId;
        if (spec.agent === 'claude') {
          const prepared = await record.runtime.prepareResume({ allowFresh: !hasHistory });
          if (prepared && Object.hasOwn(prepared, 'providerSessionId')) spec.providerSessionId = prepared.providerSessionId;
        }
        if (record.runtime.snapshot().state !== 'idle') throw new Error('resume_not_idle');
      } catch (error) { await record.runtime.close(); throw error; }
      record.handoff = handoff;
      return { session: { identity: record, record, spec, path: target }, cancel: () => record.runtime.close(), async commit() {
        await activateNative(spec, handoff, transition);
        saveSession(id, { agent: spec.agent, providerSessionId: spec.providerSessionId }); record.persisted = !!spec.providerSessionId;
        sessions.set(id, record); terminalStreams.delete(id);
        if (spec.providerSessionId) { record.lock = `${spec.agent}:${spec.providerSessionId}`; occupied.add(record.lock); }
        record.staged = false;
        carryHistory(previousStream, record.stream, record.inputs);
        for (const event of record.buffered) forward(record, event);
        record.buffered = [];
        record.stream.publish('path.changed', { previous: 'terminal', selected: target === 'api' ? 'api' : 'subscription', reason: null });
        pathChanged(spec.agent, target, null); changed();
      } };
    },
  });
  let reconcileQueued = false, retryRequested = false;
  function reconcile(retryFailed = false) {
    retryRequested ||= retryFailed;
    if (reconcileQueued) return;
    reconcileQueued = true; queueMicrotask(() => { reconcileQueued = false; const retry = retryRequested; retryRequested = false; switches.reconcile(retry); });
  }
  const unsubscribeAvailability = claude.onAvailabilityChange?.(() => reconcile());
  return { start,
    async commands(id, runtimeSessionId) {
      const record = current(id, runtimeSessionId);
      const fallback = record.spec.agent === 'claude' ? await readCommands(record.spec) : [];
      const commands = await record.runtime.commands?.(fallback) || [];
      if (current(id, runtimeSessionId) !== record) throw new Error('会话已变化，请刷新后重试。');
      return commands;
    },
    async send(id, runtimeSessionId, message) {
      const record = current(id, runtimeSessionId);
      if (record.inputs.has(message.clientMessageId)) return { status: record.inputs.get(message.clientMessageId) };
      if (switches.state(id)?.phase && switches.state(id).phase !== 'stable') return unsent(record, message, 'switch_in_progress');
      if (record.spec.agent === 'claude') {
        // Settings are current, while a running query keeps its existing reservation until a safe input boundary.
        // The SDK's normal idle renewal then removes an old cap when the owner clears the monthly budget.
        if (record.spec.owner !== 'dispatch') record.spec.monthlyBudgetUsd = settings.get().monthlyBudgetUsd;
        const selected = selection(record.spec, record.runtime, false, true);
        if (selected.path !== 'api') { reconcile(); return unsent(record, message, selected.reason || 'api_unavailable'); }
      }
      switches.input(id, runtimeSessionId);
      try {
        const receipt = await record.runtime.send(message);
        return receipt.status === 'rejected' && !record.inputs.has(message.clientMessageId) ? unsent(record, message, 'input_rejected') : receipt;
      }
      catch (error) {
        if (record.spec.agent !== 'claude' || settings.get().claudePath !== 'api-then-terminal' || error.beforeInput !== true) {
          flushFailures(record); throw error;
        }
        record.fallbackReason = error.message;
        reconcile(); return unsent(record, message, 'path_changed');
      }
    },
    interrupt(id, runtimeSessionId) { return current(id, runtimeSessionId).runtime.interrupt(); },
    answer(id, runtimeSessionId, requestId, answer) {
      if (answer.switch || answer.handoff) {
        resolveSpec(id, sessions.get(id)?.spec.agent || 'claude', false, true);
        if (answer.handoff) {
          const inputs = sessions.get(id)?.inputs;
          answer = { handoff: { ...answer.handoff, draft: { ...answer.handoff.draft,
            undelivered: answer.handoff.draft.undelivered.filter(input => !['delivered', 'consumed', 'unknown'].includes(inputs?.get(input.clientMessageId))) } } };
        }
        return switches.answer(id, runtimeSessionId, answer);
      }
      return current(id, runtimeSessionId).runtime.answer(requestId, answer);
    },
    async stop(id, runtimeSessionId) { const record = current(id, runtimeSessionId); switches.forget(id); await record.runtime.close(); if (record.lock) occupied.delete(record.lock); },
    snapshot(id) {
      const record = sessions.get(id);
      if (!record) {
        const snapshot = terminalStreams.get(id)?.snapshot() || null;
        if (snapshot) { snapshot.switchState = switches.state(id); snapshot.handoff = switches.handoff(id); }
        if (snapshot) resolveSpec(id, snapshot.events[0]?.provider || 'claude', false, true);
        return snapshot;
      }
      current(id, record.spec.runtimeSessionId); return { ...record.stream.snapshot(), switchState: switches.state(id), handoff: switches.handoff(id) || record.handoff };
    },
    usage({ cli = {}, limits = {} } = {}, projectId) {
      const config = settings.get(), snapshot = structuredClone(agents);
      for (const agent of ['claude', 'codex']) {
        if (projectId) {
          const running = localSessions().findLast(session => session.spec.projectId === projectId && session.spec.agent === agent);
          snapshot[agent].path = running?.path || null;
          snapshot[agent].reason = running?.record?.stream.snapshot().events.findLast(event => event.type === 'path.changed')?.payload.reason || null;
        }
        snapshot[agent].next = nextPath(agent, config, agent === 'claude' ? claude.apiState(config.monthlyBudgetUsd, projectId) : null, cli[agent]);
        snapshot[agent].limits ||= structuredClone(limits[agent] || null);
      }
      return { ...claude.usage.summary(), budgetUsd: config.monthlyBudgetUsd, agents: snapshot, switches: { waiting: switches.waiting() } };
    },
    keyClear() {
      // Retain an in-memory rollback capability before deleting the saved key, even for a lazy idle query.
      for (const record of sessions.values()) if (record.spec.agent === 'claude') { try { record.rollbackFactory ||= record.runtime.checkpoint?.(); } catch {} }
      const result = claude.credentials.clear();
      for (const record of sessions.values()) record.runtime.policyChanged?.();
      reconcile(true); return result;
    },
    keySave(key) { const result = claude.credentials.save(key); for (const record of sessions.values()) record.rollbackFactory = null; reconcile(true); return result; },
    reconcile, observe: id => switches.observe(id), input: (id, runtimeSessionId) => switches.input(id, runtimeSessionId),
    failed: (id, runtimeSessionId) => switches.failed(id, runtimeSessionId),
    switchState: id => switches.state(id),
    async forget(id) {
      switches.forget(id);
      const record = sessions.get(id); sessions.delete(id); terminalStreams.delete(id);
      if (record) { await record.runtime.close(); if (record.lock) occupied.delete(record.lock); }
    },
    async close() { unsubscribeAvailability?.(); await switches.close(); await Promise.allSettled([...sessions.values()].map(record => record.runtime.close())); sessions.clear(); terminalStreams.clear(); occupied.clear(); },
    has: id => sessions.has(id),
  };
}
module.exports = { createRouter };
