const { randomUUID } = require('node:crypto');
const { validEvent } = require('./validate.cjs');
const { createEventStream } = require('./events.cjs');
const { nextPath } = require('./usage.cjs');
const { createSwitches } = require('./switches.cjs');
const { adapters, adapterOf, bindNativeAdapters, defaultNativeAgent, support, supportsNative } = require('../cli-adapters/registry.cjs');
const { retainLimits } = require('../agents/agent-usage.cjs');
const { routingOwned, routingPatch, routingText } = require('../agents/agent-command.cjs');
const remoteNative = spec => spec.kind === 'ssh' && supportsNative(spec.agent, spec.kind);
const wirePath = path => path === 'native' ? 'subscription' : path;
const turnBoundary = event => event.type === 'turn.started' || event.type === 'turn.completed';
function createRouter({
  settings, resolveSpec, terminal, emit, changed = () => {}, now = Date.now,
  saveSession = () => {}, saveModelOptions = () => {}, invalidateSession = () => {}, saveInterrupted = () => {}, readHistory = async () => null,
  readCommands = async () => [],
  terminalSessions = () => [], observeTerminal = () => ({ state: 'unknown' }), prepareTerminal, activateNative = () => {},
  prepareConversation = () => {}, retireTerminal = () => {}, switchOptions = {}, ...providers
}) {
  const nativeAdapterOf = bindNativeAdapters(providers);
  // The existing key and billing endpoints belong to the API provider.
  const { native: api } = nativeAdapterOf(defaultNativeAgent);
  const sessions = new Map(), terminalStreams = new Map(), busy = new Set(), occupied = new Set();
  const agents = Object.fromEntries(adapters().map(({ manifest: { id } }) => [id, { path: null, reason: null, limits: null }]));
  const projectLimits = new Map(), historyReads = new Map();
  let closed = false;
  const ended = new Set(['stopped', 'failed', 'disconnected']);
  const eventStream = spec => createEventStream(spec, event => { emit(event); changed(spec.terminalId, event); }, now);
  function history(id, { agent, list = false } = {}) {
    if (closed) return Promise.reject(new Error('session_closed'));
    const key = JSON.stringify([id, agent, list]);
    if (historyReads.has(key)) return historyReads.get(key).task;
    const entry = { abort: new AbortController() };
    entry.terminalId = id;
    entry.task = Promise.resolve().then(() => {
      if (entry.abort.signal.aborted) throw new Error('session_closed');
      return readHistory(id, { signal: entry.abort.signal, agent, list });
    }).finally(() => { if (historyReads.get(key) === entry) historyReads.delete(key); });
    historyReads.set(key, entry); return entry.task;
  }
  // A running session's path; a failed switch that kept the API holds it there as if API-only.
  function selection(spec, retained = false) {
    const { native, nativePolicy } = nativeAdapterOf(spec.agent);
    const { path, wire } = nativePolicy.select?.(native, spec, spec.terminalId, settings.get(), {
      retained: retained && switches.retained(spec.terminalId), running: true,
    }) ?? { path: nativePolicy.path, wire: null };
    return { path, reason: wire };
  }
  function pathChanged(agent, path, reason) {
    agents[agent] = { ...agents[agent], path, reason, ...(path === 'terminal' ? { limits: null } : {}) };
  }
  function current(id, runtimeSessionId) {
    const record = sessions.get(id);
    if (!record || record.spec.runtimeSessionId !== runtimeSessionId) throw new Error('会话已变化，请刷新后重试。');
    // Resolve again: a removed project must not leave an accessible runtime.
    resolveSpec(id, record.spec.agent, false, true);
    return record;
  }
  function requireStarted(record) {
    if (record.startupFailed) throw new Error('会话未能连接，请点击「开始新的对话」重试。');
    if (busy.has(record.spec.terminalId)) throw new Error('会话正在启动，请稍后重试。');
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
    const { native, nativePolicy } = nativeAdapterOf(spec.agent);
    const record = { spec, nativePolicy, runtime: null, lock: null, inputs: new Map(), staged, buffered: [] };
    record.stream = eventStream(spec);
    const receive = event => {
      if (record.staged) { record.buffered.push(event); return; }
      forward(record, event);
    };
    nativePolicy.configure?.(spec, () => settings.get(), () => selection(spec, true).path === nativePolicy.path);
    record.runtime = restoreFactory ? restoreFactory(spec, receive) : native.create(spec, receive);
    return record;
  }
  function rememberSession(record, providerSessionId) {
    if (!providerSessionId || record.persisted) return;
    record.persisted = true;
    saveSession(record.spec.terminalId, { agent: record.spec.agent, providerSessionId, ...(record.nativePolicy.historyList && { cwd: record.spec.cwd }) });
  }
  function forward(record, event) {
    const { spec, nativePolicy } = record, { agent, terminalId: id } = spec;
    if (sessions.get(id) !== record) return;
    if (!validEvent(event) || event.projectId !== spec.projectId || event.terminalId !== id || event.runtimeSessionId !== spec.runtimeSessionId ||
      record.epoch && event.connectionEpoch !== record.epoch || event.sequence <= (record.sequence || 0)) return;
    record.epoch = event.connectionEpoch; record.sequence = event.sequence;
    const deferHistory = remoteNative(spec) && !nativePolicy.rememberModelOptions;
    // SSH has no local rollout check. A thread/start reply alone does not establish history.
    if (deferHistory && event.type === 'turn.started' && !event.replay) rememberSession(record, event.providerSessionId);
    if (nativePolicy.canContinueInterrupted && !event.replay && turnBoundary(event)) {
      saveInterrupted(id, !record.ownerStopped && (event.type === 'turn.started' || ['interrupted', 'unknown'].includes(event.payload.status)));
    }
    if (turnBoundary(event)) record.turnRevision = (record.turnRevision || 0) + 1;
    if (!record.retiring && event.type === 'session.state' && ended.has(event.payload.state)
      && switches.failed(id, spec.runtimeSessionId)) return;
    if (nativePolicy.fallbackEnabled && (event.type === 'error' && event.payload.stage === 'startup' && nativePolicy.fallbackEnabled(settings.get())
      || record.failures?.length && event.type === 'session.state' && event.payload.state === 'failed')) {
      (record.failures ||= []).push(event); return;
    }
    if (event.providerSessionId && !record.lock && !record.releasing) {
      record.lock = `${agent}:${event.providerSessionId}`; occupied.add(record.lock);
    }
    if (!deferHistory && (!nativePolicy.rememberModelOptions || !event.replay && event.type === 'routing.updated')) rememberSession(record, event.providerSessionId);
    if (nativePolicy.rememberModelOptions && !event.replay && event.type === 'routing.updated' && record.persisted) {
      const { model, effort } = event.payload.effective;
      saveModelOptions(id, { model, effort });
    }
    if (event.type === 'limits.updated') {
      const limits = projectLimits.get(spec.projectId) || {};
      limits[agent] = retainLimits(limits[agent], event.payload); projectLimits.set(spec.projectId, limits);
      if (spec.kind !== 'ssh') agents[agent].limits = limits[agent];
    }
    if (event.type === 'limits.updated' || event.type === 'usage.updated') reconcile();
    if (event.type === 'input.receipt') record.inputs.set(event.payload.clientMessageId, event.payload.status);
    // A proved empty rejected turn continues on the terminal. It must not announce an
    // interrupted round before the same owner input has reached its destination.
    if (event.type === 'turn.completed' && nativePolicy.fallbackEnabled && spec.quotaFallback?.() && record.runtime.fallbackInput?.()?.safe) {
      record.quotaCompletion = event; return;
    }
    record.stream.provider(event.providerSessionId); record.stream.turn(event.turnId);
    record.stream.publish(event.type, event.payload, { itemId: event.itemId, replay: event.replay, occurredAtMs: event.occurredAtMs });
    switches.observe(id);
  }
  function releaseLock(record) {
    if (record.lock) occupied.delete(record.lock);
    record.lock = null;
  }
  async function closeRecord(record) {
    record.releasing = true;
    record.closing ||= Promise.resolve().then(() => record.runtime.close()).finally(() => {
      releaseLock(record); record.closeSettled = true;
    });
    return record.closing;
  }
  async function failStart(id, record, error, resume) {
    const { spec, runtime, nativePolicy, stream } = record, { agent } = spec;
    record.releasing = true;
    releaseLock(record);
    if (nativePolicy.startupMessage) {
      record.startupFailed = true;
      if (remoteNative(spec) && resume && nativePolicy.invalidateResume?.(error)) invalidateSession(id, spec.providerSessionId, agent);
      try { await runtime.close(); } catch { }
      const message = nativePolicy.startupMessage(error, spec);
      const code = typeof error.code === 'string' ? error.code : nativePolicy.startupCode;
      stream.publish('error', { code, message, retryable: true, willRetry: false, stage: 'startup' });
      stream.publish('session.state', { state: 'failed', reason: message });
      throw Object.assign(new Error(message), { code: error.code || nativePolicy.startupCode });
    }
    const target = nativePolicy.fallback?.(error, settings.get(), true);
    if (target === 'terminal') {
      const notice = error.beforeInput ? error.message : error.code || error.message;
      stream.publish('path.changed', { previous: nativePolicy.path, selected: target, reason: notice });
      terminalStreams.set(id, stream);
      try { await closeRecord(record); } catch { throw error; }
      sessions.delete(id); await terminal(spec, notice);
      terminalStreams.set(id, stream); pathChanged(agent, target, notice); changed();
      return { runtimeSessionId: spec.runtimeSessionId };
    }
    flushFailures(record);
    throw error;
  }
  async function start(id, { agent, resume = false, launch = null, sessionId }) {
    if (busy.has(id)) throw new Error('会话正在启动。');
    busy.add(id);
    try {
      const { native, nativePolicy } = nativeAdapterOf(agent);
      const config = settings.get(), resolved = resolveSpec(id, agent, resume, false, nativePolicy.launchOptions ? launch : null);
      const spec = { ...resolved, agent, runtimeSessionId: randomUUID() };
      if (sessionId && spec.providerSessionId !== sessionId) {
        const rows = await history(id, { agent, list: true });
        if (!rows.some(row => row.id === sessionId)) throw new Error(nativePolicy.missingResume);
        resolveSpec(id, agent, false, true);
        spec.providerSessionId = sessionId;
        if (nativePolicy.rememberModelOptions) Object.assign(spec, resolved.launchModelOptions);
      }
      if (resume && !spec.providerSessionId) {
        spec.providerSessionId = (await history(id, { agent }))?.[agent]?.id || null;
        resolveSpec(id, agent, false, true);
        if (!spec.providerSessionId) {
          if (nativePolicy.missingResume && (launch?.resume || nativePolicy.historyList)) throw new Error(nativePolicy.missingResume);
          resume = false;
        }
      }
      terminalStreams.delete(id);
      const previous = sessions.get(id);
      if (previous && !ended.has(previous.runtime.snapshot().state)) throw new Error('请先停止当前会话。');
      switches.forget(id);
      if (previous) {
        try { if (!previous.closeSettled) await closeRecord(previous); }
        finally { sessions.delete(id); }
      }
      if (nativePolicy.refresh) await nativePolicy.refresh(native);
      nativePolicy.claimTrial?.(native, spec, config);
      const decision = nativePolicy.select?.(native, spec, id, config, {}) ?? { path: nativePolicy.path, wire: null };
      if (!decision.path) throw new Error(decision.message || nativePolicy.unavailable);
      if (decision.path === 'terminal') {
        const stream = createEventStream(spec, emit, now);
        stream.publish('path.changed', { previous: null, selected: 'terminal', reason: decision.wire }); terminalStreams.set(id, stream);
        await terminal(spec, decision.wire); pathChanged(agent, 'terminal', decision.wire); changed();
        return { runtimeSessionId: spec.runtimeSessionId };
      }
      const lock = spec.providerSessionId ? `${agent}:${spec.providerSessionId}` : null;
      if (lock && occupied.has(lock)) throw new Error('该会话正在其他终端运行。');
      const record = makeRecord(spec); record.lock = lock;
      if (lock) occupied.add(lock);
      const runtime = record.runtime; sessions.set(id, record);
      let startup;
      try { startup = await runtime[resume ? 'resume' : 'start'](spec); }
      catch (error) { return await failStart(id, record, error, resume); }
      if (remoteNative(spec) && resume) rememberSession(record, startup?.providerSessionId);
      const reason = startup?.reason || decision.wire;
      record.stream.publish('path.changed', { previous: null, selected: wirePath(decision.path), reason });
      pathChanged(agent, decision.path, reason); changed(); return { runtimeSessionId: spec.runtimeSessionId };
    } finally { busy.delete(id); }
  }
  function localSessions() {
    return [...sessions.values()].filter(record => record.fallbackReason || switches.recovering(record.spec.terminalId) || !ended.has(record.runtime.snapshot().state))
      .map(record => ({ identity: record, record, spec: record.spec, path: record.nativePolicy.path }))
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
  function keepFallbackInput(draft, refused) {
    const returned = [refused.input, ...(refused.remaining || [])];
    if (!draft.text && !draft.images.length && !draft.undelivered.length && returned.length === 1 && !refused.input.images?.length) {
      draft.text = refused.input.text;
      return;
    }
    for (const input of returned) {
      if (!draft.undelivered.some(kept => kept.clientMessageId === input.clientMessageId)) draft.undelivered.push(input);
    }
  }
  const switches = createSwitches({
    ...switchOptions,
    list: localSessions,
    choose: session => session.record?.fallbackReason ? { path: 'terminal', reason: session.record.fallbackReason } : selection(session.spec),
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
        await closeRecord(session.record);
        session.record.stream.publish('session.state', { state: 'stopped', reason: message });
      } else retireTerminal(session, message);
      return { reason: message };
    },
    async prepare(session, target, handoff, currentChange, restoring, transition) {
      const id = session.spec.terminalId, old = session.record, previousStream = old?.stream || terminalStreams.get(id);
      if (!restoring) session.restoreFactory = old?.rollbackFactory || old?.runtime.checkpoint?.();
      session.spec.providerSessionId ||= old?.runtime.snapshot().events.findLast(event => event.providerSessionId)?.providerSessionId;
      const hasHistory = session.spec.hasHistory || [...(old?.inputs.values() || [])].some(status => ['delivered', 'consumed', 'unknown'].includes(status))
        || previousStream?.snapshot().events.some(event => event.type === 'item.upsert' && event.payload.content?.unsent !== true);
      if (!session.spec.providerSessionId && hasHistory) throw new Error('missing_resume_identity');
      const spec = { ...session.spec, runtimeSessionId: randomUUID(), allowFreshResume: !hasHistory };
      if (target === 'terminal') {
        if (!prepareTerminal) throw new Error('terminal_preparation_unavailable');
        const prepared = await prepareTerminal(spec, handoff, currentChange, transition);
        return { session: prepared.session, cancel: prepared.cancel, async commit() {
          if (transition.discardBackground) await old?.runtime.stopBackground?.();
          if (!currentChange()) throw new Error('session_changed');
          await prepared.commit();
          sessions.delete(id); if (old) releaseLock(old);
          const stream = eventStream(spec);
          stream.provider(spec.providerSessionId); terminalStreams.set(id, stream);
          carryHistory(previousStream, stream);
          let reason = old?.fallbackReason || null;
          const { native, nativePolicy } = nativeAdapterOf(spec.agent);
          const notices = nativePolicy.quotaSwitchNotices?.(native, spec, id, () => settings.get());
          if (notices) {
            reason = notices[0];
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
                keepFallbackInput(draft, refused);
                reason = notices[1];
              }
            }
          }
          stream.publish('session.state', { state: 'idle', reason: null });
          stream.publish('path.changed', { previous: wirePath(session.path), selected: 'terminal', reason });
          pathChanged(spec.agent, 'terminal', reason); changed();
          // The destination is ready. A failed retirement must not destroy it and resurrect a closed source.
          try { await old?.runtime.close(); }
          catch { return { reason: '旧会话未能完全退出，已保留新会话。' }; }
          return { reason };
        } };
      }
      const finishPreparation = restoring ? null : prepareConversation(spec);
      let record;
      const cancel = async () => {
        try { await record?.runtime.close(); }
        finally { finishPreparation?.(false); }
      };
      try {
        record = makeRecord(spec, true, restoring?.restoreFactory);
        const initialized = await record.runtime[spec.providerSessionId ? 'resume' : 'start'](spec);
        if (initialized?.providerSessionId) spec.providerSessionId = initialized.providerSessionId;
        if (record.nativePolicy.prepareResume) {
          const prepared = await record.nativePolicy.prepareResume(record.runtime, { allowFresh: !hasHistory });
          if (prepared && Object.hasOwn(prepared, 'providerSessionId')) spec.providerSessionId = prepared.providerSessionId;
        }
        if (record.runtime.snapshot().state !== 'idle') throw new Error('resume_not_idle');
      } catch (error) { await cancel().catch(() => {}); throw error; }
      record.handoff = handoff;
      return { session: { identity: record, record, spec, path: target }, cancel, async commit() {
        await activateNative(spec, handoff, transition);
        saveSession(id, { agent: spec.agent, providerSessionId: spec.providerSessionId }); record.persisted = !!spec.providerSessionId;
        sessions.set(id, record); terminalStreams.delete(id);
        finishPreparation?.(true);
        if (spec.providerSessionId) { record.lock = `${spec.agent}:${spec.providerSessionId}`; occupied.add(record.lock); }
        record.staged = false;
        carryHistory(previousStream, record.stream, record.inputs);
        for (const event of record.buffered) forward(record, event);
        record.buffered = [];
        record.stream.publish('path.changed', { previous: 'terminal', selected: wirePath(target), reason: null });
        pathChanged(spec.agent, target, null); changed();
      } };
    },
  });
  let reconcileQueued = null, retryRequested = false;
  // One pass per burst of requests. The promise is the settle point: it resolves once the pass has run and every change it
  // started has settled, so a caller awaits it instead of counting event-loop turns.
  function reconcile(retryFailed = false) {
    retryRequested ||= retryFailed;
    return reconcileQueued ||= Promise.resolve().then(() => {
      reconcileQueued = null; const retry = retryRequested; retryRequested = false;
      switches.reconcile(retry); return switches.settled();
    });
  }
  const unsubscribeAvailability = api.onAvailabilityChange?.(() => reconcile());
  return { start,
    history,
    async continueInterrupted(id, runtimeSessionId, beforeSend) {
      const record = current(id, runtimeSessionId), revision = record.turnRevision;
      if (!record.nativePolicy.canContinueInterrupted || record.continued || record.ownerInput || record.ownerStopped || !record.runtime.canContinueInterrupted) return;
      const unfinished = await record.runtime.canContinueInterrupted();
      if (current(id, runtimeSessionId) !== record || record.turnRevision !== revision || record.continued || record.ownerInput || record.ownerStopped || !unfinished) return;
      record.continued = true;
      beforeSend();
      const receipt = await record.runtime.send({ clientMessageId: randomUUID(), text: '继续', images: [] });
      if (!['queued', 'delivered', 'consumed'].includes(receipt.status)) throw new Error('恢复后的继续消息未确认投递，请查看会话状态。');
      return receipt;
    },
    async runOptions(id, runtimeSessionId, patch) {
      const record = current(id, runtimeSessionId);
      if (!record.runtime.runOptions) throw new Error('此会话不支持运行选项。');
      if (routingPatch(patch)) throw routingOwned();
      const permissions = support(adapterOf(record.spec.agent).manifest, 'permissionChoice').ok;
      if (!permissions && patch.permissions !== undefined) throw new Error('此会话不支持切换权限。');
      const result = await record.runtime.runOptions(patch);
      current(id, runtimeSessionId);
      if (permissions && result.permissions !== undefined) record.spec.permissions = result.permissions;
      return result;
    },
    async modelOptions(id, runtimeSessionId, patch) {
      const record = current(id, runtimeSessionId);
      requireStarted(record);
      if (!record.nativePolicy.liveRouting) throw new Error('此会话由模型分工设置模型和强度。');
      if (!Object.keys(patch).length) return record.runtime.modelOptions();
      const result = await record.runtime.setModelOptions(patch);
      current(id, runtimeSessionId);
      return result;
    },
    async applyRouting(id, seat) {
      const record = sessions.get(id);
      if (!record?.runtime.applyRouting || ended.has(record.runtime.snapshot().state)) return null;
      const { model = null, effort = null, fast = false } = seat;
      const update = Promise.resolve(record.routing).catch(() => {}).then(async () => {
        if (sessions.get(id) !== record || record.releasing || ended.has(record.runtime.snapshot().state)) return null;
        if (record.spec.model === model && record.spec.effort === effort && (record.spec.fast === true) === fast) return null;
        const result = await record.runtime.applyRouting({ model, effort, fast });
        Object.assign(record.spec, { model, effort, fast });
        return result;
      });
      record.routing = update;
      return update;
    },
    async shell(id, runtimeSessionId, clientMessageId, command) {
      const record = current(id, runtimeSessionId);
      if (!record.runtime.shell) throw new Error('此会话不支持运行命令。');
      if (record.nativePolicy.trackShellInput) {
        requireStarted(record);
        if (switches.state(id)?.phase && switches.state(id).phase !== 'stable') throw new Error('会话正在切换，请稍后重试。');
        record.ownerInput = true; record.ownerStopped = false; switches.input(id, runtimeSessionId);
      }
      const result = await record.runtime.shell(clientMessageId, command);
      current(id, runtimeSessionId); return result;
    },
    async newConversation(id, runtimeSessionId) {
      const previous = current(id, runtimeSessionId);
      if (busy.has(id) || !previous.startupFailed && (previous.runtime.snapshot().state !== 'idle' || previous.runtime.activity?.().count > 0)) {
        throw new Error('请等待当前任务结束后再开始新对话。');
      }
      busy.add(id);
      let next, finishPreparation;
      try {
        const spec = { ...previous.spec, runtimeSessionId: randomUUID(), providerSessionId: null, threadId: null };
        const { newConversationIdentity, path } = previous.nativePolicy;
        finishPreparation = prepareConversation(spec);
        next = makeRecord(spec, true);
        const started = await next.runtime.start();
        if (newConversationIdentity) spec.providerSessionId = newConversationIdentity(started);
        current(id, runtimeSessionId);
        await activateNative(spec, null, { newConversation: true });
        sessions.set(id, next); switches.forget(id);
        if (!remoteNative(spec) || next.nativePolicy.rememberModelOptions) {
          saveSession(id, { agent: spec.agent, providerSessionId: newConversationIdentity ? spec.providerSessionId : null });
          next.persisted = !!newConversationIdentity;
        }
        next.staged = false;
        for (const event of next.buffered) forward(next, event);
        next.runtime.bindHost?.();
        next.buffered = [];
        const selected = wirePath(path);
        next.stream.publish('path.changed', { previous: selected, selected, reason: null });
        if (previous.lock) occupied.delete(previous.lock);
        // The new binding is committed. A cleanup error must not tell the renderer
        // that its still-active old binding survived the transition.
        try { await previous.runtime.close(); } catch { }
        return { runtimeSessionId: spec.runtimeSessionId };
      } catch (error) {
        if (next && sessions.get(id) !== next) await closeRecord(next).catch(() => {});
        throw error;
      }
      finally { finishPreparation?.(!!next && sessions.get(id) === next); busy.delete(id); }
    },
    async commands(id, runtimeSessionId) {
      const record = current(id, runtimeSessionId);
      const fallback = record.nativePolicy.fileCommands ? await readCommands(record.spec) : [];
      const commands = await record.runtime.commands?.(fallback) || [];
      if (current(id, runtimeSessionId) !== record) throw new Error('会话已变化，请刷新后重试。');
      return commands;
    },
    async send(id, runtimeSessionId, message) {
      const record = current(id, runtimeSessionId), { nativePolicy } = record;
      if (record.spec.owner !== 'dispatch' && routingText(message.text)) throw routingOwned();
      requireStarted(record);
      // A read-only popup query is not the owner's message: it keeps their stop and input flags, leaves no item in the conversation and, mid-switch, says so
      // instead of leaving an unsent bubble behind.
      const observation = nativePolicy.observationCommands.includes(message.text.trim()) && record.spec.owner !== 'dispatch';
      if (!observation) record.ownerInput = true;
      if (record.inputs.has(message.clientMessageId)) return { status: record.inputs.get(message.clientMessageId) };
      if (switches.state(id)?.phase && switches.state(id).phase !== 'stable') {
        if (observation) throw new Error('会话正在切换，请稍后重试。');
        return unsent(record, message, 'switch_in_progress');
      }
      if (nativePolicy.select) {
        const selected = selection(record.spec, true);
        if (selected.path !== nativePolicy.path) {
          reconcile();
          if (observation) throw new Error(nativePolicy.observationUnavailable);
          return unsent(record, message, selected.reason || 'api_unavailable');
        }
      }
      if (!observation) { switches.input(id, runtimeSessionId); record.ownerStopped = false; }
      try {
        const receipt = await record.runtime.send(message);
        return receipt.status === 'rejected' && !record.inputs.has(message.clientMessageId) ? unsent(record, message, receipt.reason || 'input_rejected') : receipt;
      }
      catch (error) {
        if (nativePolicy.fallback?.(error, settings.get()) !== 'terminal') {
          flushFailures(record); throw error;
        }
        record.fallbackReason = error.message;
        reconcile(); return unsent(record, message, 'path_changed');
      }
    },
    interrupt(id, runtimeSessionId) {
      const record = current(id, runtimeSessionId);
      record.ownerStopped = true;
      if (record.nativePolicy.canContinueInterrupted) saveInterrupted(id, false);
      return record.runtime.interrupt();
    },
    answer(id, runtimeSessionId, requestId, answer) {
      if (answer.switch || answer.handoff) {
        resolveSpec(id, sessions.get(id)?.spec.agent || defaultNativeAgent, false, true);
        if (answer.handoff) {
          const inputs = sessions.get(id)?.inputs;
          answer = { handoff: { ...answer.handoff, draft: { ...answer.handoff.draft,
            undelivered: answer.handoff.draft.undelivered.filter(input => !['delivered', 'consumed', 'unknown'].includes(inputs?.get(input.clientMessageId))) } } };
        }
        return switches.answer(id, runtimeSessionId, answer);
      }
      return current(id, runtimeSessionId).runtime.answer(requestId, answer);
    },
    async stop(id, runtimeSessionId) { const record = current(id, runtimeSessionId); switches.forget(id); await closeRecord(record); },
    tokenRate(id, runtimeSessionId) { return current(id, runtimeSessionId).runtime.tokenRate?.() || null; },
    snapshot(id) {
      const record = sessions.get(id);
      if (!record) {
        const snapshot = terminalStreams.get(id)?.snapshot() || null;
        if (snapshot) { snapshot.switchState = switches.state(id); snapshot.handoff = switches.handoff(id); }
        if (snapshot) resolveSpec(id, snapshot.events[0]?.provider || defaultNativeAgent, false, true);
        return snapshot;
      }
      current(id, record.spec.runtimeSessionId); return { ...record.stream.snapshot(), switchState: switches.state(id), handoff: switches.handoff(id) || record.handoff };
    },
    usage({ cli = {}, limits = {} } = {}, projectId) {
      const config = settings.get(), snapshot = structuredClone(agents);
      for (const { manifest: { id: agent } } of adapters()) {
        const { native, nativePolicy } = nativeAdapterOf(agent);
        if (projectId) {
          snapshot[agent].limits = structuredClone(projectLimits.get(projectId)?.[agent] || null);
          const running = localSessions().findLast(session => session.spec.projectId === projectId && session.spec.agent === agent);
          snapshot[agent].path = running?.path || null;
          snapshot[agent].reason = running?.record?.stream.snapshot().events.findLast(event => event.type === 'path.changed')?.payload.reason || null;
        }
        snapshot[agent].next = nextPath(agent, config, nativePolicy.usageFacts?.(native, projectId), cli[agent]);
        snapshot[agent].limits ||= structuredClone(limits[agent] || null);
        if (snapshot[agent].limits?.billingRoute === limits[agent]?.billingRoute &&
          Number.isFinite(limits[agent]?.observedAtMs) && limits[agent].observedAtMs > (snapshot[agent].limits.observedAtMs ?? -Infinity)) {
          snapshot[agent].limits = structuredClone(retainLimits(snapshot[agent].limits, limits[agent]));
        }
      }
      return { ...api.usage.summary(), agents: snapshot, switches: { waiting: switches.waiting() } };
    },
    keyClear() {
      // Retain an in-memory rollback capability before deleting the saved key, even for a lazy idle query.
      for (const record of sessions.values()) if (record.nativePolicy.checkpointOnKeyClear) { try { record.rollbackFactory ||= record.runtime.checkpoint?.(); } catch {} }
      const result = api.credentials.clear();
      for (const record of sessions.values()) record.runtime.policyChanged?.();
      reconcile(true); return result;
    },
    keySave(key) { const result = api.credentials.save(key); for (const record of sessions.values()) record.rollbackFactory = null; reconcile(true); return result; },
    // The same settle point without asking for a pass: whatever was already requested has run and every change has settled.
    settled: () => Promise.resolve(reconcileQueued).then(() => switches.settled()),
    reconcile, observe: id => switches.observe(id), input: (id, runtimeSessionId) => switches.input(id, runtimeSessionId),
    failed: (id, runtimeSessionId) => switches.failed(id, runtimeSessionId),
    switchState: id => switches.state(id),
    async forget(id) {
      const reads = [];
      for (const [key, pending] of historyReads) if (pending.terminalId === id) {
        pending.abort.abort(); historyReads.delete(key); reads.push(pending.task);
      }
      switches.forget(id);
      const record = sessions.get(id); sessions.delete(id); terminalStreams.delete(id);
      try { if (record) await closeRecord(record); }
      finally { await Promise.allSettled(reads); }
    },
    async close() {
      closed = true; unsubscribeAvailability?.();
      const reads = [...historyReads.values()]; for (const entry of reads) entry.abort.abort();
      await switches.close();
      await Promise.allSettled([...sessions.values()].map(record => record.runtime.close()).concat(reads.map(entry => entry.task)));
      sessions.clear(); terminalStreams.clear(); occupied.clear();
    },
    has: id => sessions.has(id),
  };
}
module.exports = { createRouter };
