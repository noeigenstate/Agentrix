const { randomUUID } = require('node:crypto');
const { choosePath } = require('./routing.cjs');
const { validEvent } = require('./validate.cjs');
const { createEventStream } = require('./events.cjs');
const { nextPath } = require('./usage.cjs');
const { createSwitches } = require('./switches.cjs');
function createRouter({ claude, codex, settings, resolveSpec, terminal, emit, changed = () => {}, now = Date.now, saveSession = () => {}, terminalSessions = () => [], observeTerminal = () => ({ state: 'unknown' }), prepareTerminal, activateNative = () => {} }) {
  const sessions = new Map(), terminalStreams = new Map(), busy = new Set(), occupied = new Set();
  const agents = { claude: { path: null, reason: null, limits: null }, codex: { path: null, reason: null, limits: null } };
  let lastSwitch = null;
  function pathChanged(agent, path, reason) {
    const previous = agents[agent].path;
    agents[agent] = { ...agents[agent], path, reason };
    if (previous !== path) lastSwitch = { at: now(), agent, from: previous, to: path, reason };
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
  async function rejectAndSwitch(id, record, message, reason) {
    record.inputs.set(message.clientMessageId, 'rejected');
    record.stream.publish('item.upsert', { kind: 'user-message', status: 'interrupted', content: { text: message.text, clientMessageId: message.clientMessageId, unsent: true } }, { itemId: message.clientMessageId });
    record.stream.publish('input.receipt', { clientMessageId: message.clientMessageId, status: 'rejected' });
    record.switching ||= (async () => {
      const providerSessionId = record.runtime.snapshot().events.findLast(event => event.providerSessionId)?.providerSessionId || record.spec.providerSessionId;
      record.stream.publish('path.changed', { previous: 'api', selected: 'terminal', reason });
      terminalStreams.set(id, record.stream);
      // Only positively identified history is resumed; the rejected input is never automatically replayed.
      await record.runtime.close(); sessions.delete(id); if (record.lock) occupied.delete(record.lock);
      await terminal({ ...record.spec, providerSessionId }, reason);
      terminalStreams.set(id, record.stream); pathChanged('claude', 'terminal', reason); changed();
    })();
    await record.switching;
    return { status: 'rejected', reason: 'path_changed' };
  }
  function makeRecord(spec, staged = false, restoreFactory) {
    const { agent, terminalId: id } = spec;
    const record = { spec, runtime: null, lock: null, inputs: new Map(), staged, buffered: [] };
    record.stream = createEventStream(spec, event => { emit(event); changed(id, event); }, now);
    const receive = event => {
      if (record.staged) { record.buffered.push(event); return; }
      forward(record, event);
    };
    record.runtime = restoreFactory ? restoreFactory(spec, receive) : (agent === 'claude' ? claude : codex).create(spec, receive);
    return record;
  }
  function forward(record, event) {
    const { spec } = record, { agent, terminalId: id } = spec;
    if (sessions.get(id) !== record) return;
    if (!validEvent(event) || event.projectId !== spec.projectId || event.terminalId !== id || event.runtimeSessionId !== spec.runtimeSessionId ||
      record.epoch && event.connectionEpoch !== record.epoch || event.sequence <= (record.sequence || 0)) return;
    record.epoch = event.connectionEpoch; record.sequence = event.sequence;
    if (event.type === 'session.state' && ['failed', 'disconnected', 'stopped'].includes(event.payload.state)
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
    if (event.type === 'input.receipt') record.inputs.set(event.payload.clientMessageId, event.payload.status);
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
      if (previous && !['stopped', 'failed', 'disconnected'].includes(previous.runtime.snapshot().state)) throw new Error('请先停止当前会话。');
      if (previous) { await previous.runtime.close(); if (previous.lock) occupied.delete(previous.lock); sessions.delete(id); }
      if (agent === 'claude') await claude.refreshAvailability?.();
      const apiState = claude.apiState(config.monthlyBudgetUsd, spec.projectId);
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
        const codexUnavailable = agent === 'codex' && ['unsupported_codex_capabilities', 'unsupported_codex_version', 'codex_cli_required', 'rpc_timeout', 'process_failed', 'process_exited', 'disconnected', 'invalid_response', 'invalid_frame', 'invalid_json', 'ENOENT'].includes(reason);
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
    return [...sessions.values()].filter(record => switches.recovering(record.spec.terminalId) || !['stopped', 'failed', 'disconnected'].includes(record.runtime.snapshot().state))
      .map(record => ({ identity: record, record, spec: record.spec, path: record.spec.agent === 'claude' ? 'api' : 'native' }))
      .concat(terminalSessions().filter(session => !sessions.has(session.spec.terminalId)));
  }
  function carryHistory(source, target, inputs) {
    for (const event of source?.snapshot().events || []) {
      if (!['item.upsert', 'input.receipt', 'usage.updated'].includes(event.type)) continue;
      if (event.type === 'input.receipt') inputs?.set(event.payload.clientMessageId, event.payload.status);
      target.turn(event.turnId);
      target.publish(event.type, event.payload, { itemId: event.itemId, replay: true, occurredAtMs: event.occurredAtMs });
    }
    target.turn(null);
  }
  const switches = createSwitches({
    list: localSessions,
    choose: session => { const config = settings.get(); return choosePath({ agent: session.spec.agent, ...config,
      apiState: claude.apiState(config.monthlyBudgetUsd, session.spec.projectId) }); },
    observe: session => session.record ? { state: session.record.runtime.snapshot().state,
      pending: [...session.record.inputs.values()].some(status => status === 'queued'),
      background: session.record.runtime.activity?.() || { known: false, count: null } } : observeTerminal(session),
    publish: (session, state) => {
      let stream = session.record?.stream || terminalStreams.get(session.spec.terminalId);
      if (!stream) { stream = createEventStream(session.spec, event => { emit(event); changed(session.spec.terminalId, event); }, now); terminalStreams.set(session.spec.terminalId, stream); }
      stream.publish('switch.updated', state);
    },
    async prepare(session, target, handoff, currentChange, restoring) {
      const id = session.spec.terminalId, old = session.record, previousStream = old?.stream || terminalStreams.get(id);
      if (!restoring) session.restoreFactory = old?.rollbackFactory || old?.runtime.checkpoint?.();
      if (!session.spec.providerSessionId) {
        session.spec.providerSessionId = old?.runtime.snapshot().events.findLast(event => event.providerSessionId)?.providerSessionId;
      }
      if (!session.spec.providerSessionId && (target !== 'terminal' || !old || old.inputs.size
        || old.stream.snapshot().events.some(event => event.type === 'item.upsert'))) throw new Error('missing_resume_identity');
      const spec = { ...session.spec, runtimeSessionId: randomUUID(), monthlyBudgetUsd: settings.get().monthlyBudgetUsd };
      if (target === 'terminal') {
        if (!prepareTerminal) throw new Error('terminal_preparation_unavailable');
        const prepared = await prepareTerminal(spec, handoff, currentChange);
        return { session: prepared.session, cancel: prepared.cancel, async commit() {
          await prepared.commit();
          sessions.delete(id); if (old?.lock) occupied.delete(old.lock);
          const stream = createEventStream(spec, event => { emit(event); changed(id, event); }, now);
          stream.provider(spec.providerSessionId); terminalStreams.set(id, stream);
          carryHistory(previousStream, stream);
          stream.publish('session.state', { state: 'idle', reason: null });
          stream.publish('path.changed', { previous: session.path === 'native' ? 'subscription' : session.path, selected: 'terminal', reason: null });
          pathChanged(spec.agent, 'terminal', null); changed();
          // The destination is ready. A failed retirement must not destroy it and resurrect a closed source.
          try { await old?.runtime.close(); }
          catch { return { reason: '旧会话未能完全退出，已保留新会话。' }; }
        } };
      }
      const record = makeRecord(spec, true, restoring?.restoreFactory);
      try {
        await record.runtime.resume(spec);
        if (spec.agent === 'claude') await record.runtime.prepareResume();
        if (record.runtime.snapshot().state !== 'idle') throw new Error('resume_not_idle');
      } catch (error) { await record.runtime.close(); throw error; }
      record.handoff = handoff;
      return { session: { identity: record, record, spec, path: target }, cancel: () => record.runtime.close(), async commit() {
        saveSession(id, { agent: spec.agent, providerSessionId: spec.providerSessionId }); record.persisted = true;
        await activateNative(spec, handoff);
        sessions.set(id, record); terminalStreams.delete(id);
        record.lock = `${spec.agent}:${spec.providerSessionId}`; occupied.add(record.lock);
        record.staged = false;
        carryHistory(previousStream, record.stream, record.inputs);
        for (const event of record.buffered) forward(record, event);
        record.buffered = [];
        record.stream.publish('path.changed', { previous: 'terminal', selected: target === 'api' ? 'api' : 'subscription', reason: null });
        pathChanged(spec.agent, target, null); changed();
      } };
    },
  });
  let reconcileQueued = false;
  function reconcile() {
    if (reconcileQueued) return;
    reconcileQueued = true; queueMicrotask(() => { reconcileQueued = false; switches.reconcile(); });
  }
  const unsubscribeAvailability = claude.onAvailabilityChange?.(reconcile);
  return { start,
    async send(id, runtimeSessionId, message) {
      const record = current(id, runtimeSessionId), config = settings.get();
      if (record.inputs.has(message.clientMessageId)) return { status: record.inputs.get(message.clientMessageId) };
      if (switches.frozen(id)) {
        record.inputs.set(message.clientMessageId, 'rejected');
        record.stream.publish('item.upsert', { kind: 'user-message', status: 'interrupted', content: { text: message.text, images: message.images, clientMessageId: message.clientMessageId, unsent: true } }, { itemId: message.clientMessageId });
        return { status: 'rejected', reason: 'switch_in_progress' };
      }
      if (record.spec.agent === 'claude' && record.runtime.snapshot().state === 'idle') {
        const apiState = claude.apiState(config.monthlyBudgetUsd, record.spec.projectId);
        const selection = choosePath({ agent: 'claude', ...config, apiState });
        if (selection.path === 'terminal') {
          return rejectAndSwitch(id, record, message, selection.reason);
        }
        if (!selection.path) throw new Error(apiState.reason || 'Claude API 路径当前不可用。');
      }
      switches.input(id, runtimeSessionId);
      try { return await record.runtime.send(message); }
      catch (error) {
        if (record.spec.agent !== 'claude' || settings.get().claudePath !== 'api-then-terminal' || error.beforeInput !== true) {
          flushFailures(record); throw error;
        }
        return rejectAndSwitch(id, record, message, error.message);
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
      return { ...claude.usage.summary(), budgetUsd: config.monthlyBudgetUsd, agents: snapshot, switches: { waiting: switches.waiting() }, lastSwitch };
    },
    keyClear() {
      // Retain an in-memory rollback capability before deleting the saved key, even for a lazy idle query.
      for (const record of sessions.values()) if (record.spec.agent === 'claude') record.rollbackFactory ||= record.runtime.checkpoint?.();
      const result = claude.credentials.clear(); reconcile(); return result;
    },
    keySave(key) { const result = claude.credentials.save(key); reconcile(); return result; },
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
