const { randomUUID } = require('node:crypto');
const { choosePath } = require('./routing.cjs');
const { validEvent } = require('./validate.cjs');
const { createEventStream } = require('./events.cjs');
const { nextPath } = require('./usage.cjs');
function createRouter({ claude, codex, settings, resolveSpec, terminal, emit, changed = () => {}, now = Date.now, saveSession = () => {} }) {
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
      const apiState = claude.apiState(config.monthlyBudgetUsd);
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
      const record = { spec, runtime: null, lock, inputs: new Map() };
      record.stream = createEventStream(spec, event => { emit(event); changed(id, event); }, now);
      const runtime = (agent === 'claude' ? claude : codex).create(spec, event => {
        if (sessions.get(id) !== record) return;
        if (!validEvent(event) || event.projectId !== spec.projectId || event.terminalId !== id || event.runtimeSessionId !== spec.runtimeSessionId ||
          record.epoch && event.connectionEpoch !== record.epoch || event.sequence <= (record.sequence || 0)) return;
        record.epoch = event.connectionEpoch; record.sequence = event.sequence;
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
      });
      record.runtime = runtime; sessions.set(id, record);
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
  return { start,
    async send(id, runtimeSessionId, message) {
      const record = current(id, runtimeSessionId), config = settings.get();
      if (record.inputs.has(message.clientMessageId)) return { status: record.inputs.get(message.clientMessageId) };
      if (record.spec.agent === 'claude' && record.runtime.snapshot().state === 'idle') {
        const apiState = claude.apiState(config.monthlyBudgetUsd);
        const selection = choosePath({ agent: 'claude', ...config, apiState });
        if (selection.path === 'terminal') {
          return rejectAndSwitch(id, record, message, selection.reason);
        }
        if (!selection.path) throw new Error(apiState.reason || 'Claude API 路径当前不可用。');
      }
      try { return await record.runtime.send(message); }
      catch (error) {
        if (record.spec.agent !== 'claude' || settings.get().claudePath !== 'api-then-terminal' || error.beforeInput !== true) {
          flushFailures(record); throw error;
        }
        return rejectAndSwitch(id, record, message, error.message);
      }
    },
    interrupt(id, runtimeSessionId) { return current(id, runtimeSessionId).runtime.interrupt(); },
    answer(id, runtimeSessionId, requestId, answer) { return current(id, runtimeSessionId).runtime.answer(requestId, answer); },
    async stop(id, runtimeSessionId) { const record = current(id, runtimeSessionId); await record.runtime.close(); if (record.lock) occupied.delete(record.lock); },
    snapshot(id) {
      const record = sessions.get(id);
      if (!record) {
        const snapshot = terminalStreams.get(id)?.snapshot() || null;
        if (snapshot) resolveSpec(id, snapshot.events[0]?.provider || 'claude', false, true);
        return snapshot;
      }
      current(id, record.spec.runtimeSessionId); return record.stream.snapshot();
    },
    usage({ cli = {}, limits = {} } = {}) {
      const config = settings.get(), snapshot = structuredClone(agents);
      for (const agent of ['claude', 'codex']) {
        snapshot[agent].next = nextPath(agent, config, agent === 'claude' ? claude.apiState(config.monthlyBudgetUsd) : null, cli[agent]);
        snapshot[agent].limits ||= structuredClone(limits[agent] || null);
      }
      return { ...claude.usage.summary(), budgetUsd: config.monthlyBudgetUsd, agents: snapshot, lastSwitch };
    },
    async keyClear() { await Promise.allSettled([...sessions.values()].filter(record => record.spec.agent === 'claude').map(record => record.runtime.close())); await claude.close?.(); return claude.credentials.clear(); },
    async forget(id) {
      const record = sessions.get(id); sessions.delete(id); terminalStreams.delete(id);
      if (record) { await record.runtime.close(); if (record.lock) occupied.delete(record.lock); }
    },
    async close() { await Promise.allSettled([...sessions.values()].map(record => record.runtime.close())); sessions.clear(); terminalStreams.clear(); occupied.clear(); },
    has: id => sessions.has(id),
  };
}
module.exports = { createRouter };
