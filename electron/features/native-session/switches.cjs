const { randomUUID } = require('node:crypto');

// Owns change identity and ordering only. Transport preparation must leave the old input surface alive.
function createSwitches({ list, choose, observe, prepare, publish, retire = async () => {}, retryMs = 1000, maxRetries = 4, handoffTimeoutMs = 15000 }) {
  const entries = new Map();
  let changeId = 0, closed = false;
  function clearTimers(entry) { clearTimeout(entry.retry); clearTimeout(entry.handoffTimer); entry.handoffTimer = null; }
  function remove(entry) {
    if (entries.get(entry.session.spec.terminalId) === entry) entries.delete(entry.session.spec.terminalId);
    entry.cancelled = true; clearTimers(entry);
  }
  function update(entry, patch) {
    if (entry.cancelled) return;
    entry.state = { ...entry.state, ...patch };
    publish(entry.session, structuredClone(entry.state));
  }
  async function handoffExpired(entry, version) {
    entry.handoffTimer = null;
    if (closed || entry.cancelled || entry.state.changeId !== version || entry.handoff?.changeId === version) return;
    entry.failed = version;
    let reason = '未能接收输入草稿，已保留原输入界面，请重试切换。';
    if (entry.recovery) {
      reason = '原会话恢复失败，草稿已保留，请重新启动会话。';
      await retire(entry.session, reason); entry.recovery = null;
    }
    if (entry.state.changeId === version) update(entry, { phase: 'stable', requestId: null, reason });
  }
  function kick(entry) {
    if (entry.cancelled) return;
    if (closed || entry.task) { entry.again = true; return; }
    entry.task = Promise.resolve().then(() => advance(entry)).catch(() => {
      update(entry, { phase: 'stable', requestId: null, reason: '运行方式切换失败，已保留原会话。' });
    }).finally(() => {
      entry.task = null;
      if (entry.again && !closed) { entry.again = false; kick(entry); }
    });
  }
  async function advance(entry) {
    const state = entry.state, version = state.changeId;
    const activity = entry.recovery ? { state: 'idle', background: { known: true, count: 0 } } : observe(entry.session);
    if (['stopped', 'failed', 'disconnected'].includes(activity.state)) {
      update(entry, { phase: 'stable', requestId: null }); remove(entry); return;
    }
    if (entry.unavailable && entry.session.record) {
      if (activity.state !== 'idle') { update(entry, { phase: 'waiting-turn', requestId: null, reason: 'API 路径已不可用，本轮结束后停止会话。' }); return; }
      const result = await retire(entry.session, entry.unavailable); clearTimers(entry);
      update(entry, { phase: 'stable', requestId: null, reason: result?.reason || 'API 路径已不可用，会话已停止。' }); remove(entry); return;
    }
    if (state.current === state.target) {
      if (state.phase !== 'stable') update(entry, { phase: 'stable', requestId: null, reason: null });
      return;
    }
    if (entry.failed === version) return;
    const background = activity.background?.known === true && Number.isSafeInteger(activity.background.count) && activity.background.count >= 0
      ? { known: true, count: activity.background.count } : { known: false, count: null };
    if (activity.draftBlocked) {
      update(entry, { phase: 'waiting-turn', background, requestId: entry.choice === 'wait' ? state.requestId : null, reason: '输入框里有未发送的文字' }); return;
    }
    if (activity.state !== 'idle' || activity.pending) {
      update(entry, { phase: 'waiting-turn', background, requestId: entry.choice === 'wait' ? state.requestId : null, reason: null }); return;
    }
    if ((!background.known || background.count > 0) && entry.choice !== 'now') {
      if (entry.choice === 'wait') update(entry, { phase: 'waiting-background', background, requestId: state.requestId || randomUUID() });
      else if (state.phase !== 'awaiting-choice') update(entry, { phase: 'awaiting-choice', background, requestId: randomUUID(), reason: null });
      else if (JSON.stringify(state.background) !== JSON.stringify(background)) update(entry, { background });
      return;
    }
    if (entry.handoff?.changeId !== version) {
      if (state.phase !== 'preparing') update(entry, { phase: 'preparing', background, requestId: null, reason: null });
      if (!entry.handoffTimer) {
        entry.handoffTimer = setTimeout(() => {
          void handoffExpired(entry, version).catch(() => update(entry, { phase: 'stable', requestId: null, reason: '原会话恢复失败，草稿已保留，请重新启动会话。' }));
        }, handoffTimeoutMs); entry.handoffTimer.unref?.();
      }
      return;
    }
    clearTimeout(entry.handoffTimer); entry.handoffTimer = null;
    update(entry, { phase: 'preparing', background, requestId: null, reason: null });
    let prepared;
    try {
      const source = entry.session;
      prepared = await prepare(source, state.target, entry.handoff, () => !closed && !entry.cancelled && entry.state.changeId === version, entry.recovery,
        { discardBackground: entry.choice === 'now', recovering: !!entry.recovery });
      // Give queued IPC answers a turn before sealing the latest acknowledged draft.
      await new Promise(resolve => setImmediate(resolve));
      const latest = entry.recovery ? { state: 'idle' } : observe(entry.session);
      if (closed || entry.cancelled || entry.state.changeId !== version || latest.state !== 'idle' || latest.pending || latest.draftBlocked) {
        await prepared.cancel(); entry.again = true; return;
      }
      entry.inputStarted = false; entry.pendingFailure = false; entry.pendingSession = prepared.session;
      update(entry, { phase: 'switching' });
      const result = await prepared.commit();
      entry.session = prepared.session;
      entry.pendingSession = null;
      const recovered = !!entry.recovery;
      entry.previous = recovered || entry.inputStarted ? null : source;
      entry.recovery = null;
      update(entry, { current: state.target, phase: 'stable', reason: recovered ? '新运行方式连接失败，已恢复原会话。' : result?.reason || null, requestId: null });
      if (entry.pendingFailure && !entry.inputStarted) { entry.pendingFailure = false; recover(entry); }
    } catch {
      if (prepared) await prepared.cancel();
      entry.pendingSession = null;
      if (closed || entry.cancelled) return;
      if (entry.state.changeId !== version) { entry.again = true; return; }
      if (entry.recovery && !closed && !entry.cancelled) {
        entry.retries = (entry.retries || 0) + 1;
        if (entry.retries >= maxRetries) {
          await retire(entry.session, '原会话恢复失败，草稿已保留，请重新启动会话。');
          entry.failed = version; entry.recovery = null;
          update(entry, { phase: 'stable', requestId: null, reason: '原会话恢复失败，草稿已保留，请重新启动会话。' }); return;
        }
        update(entry, { phase: 'rolling-back', requestId: null, reason: '正在重试恢复原会话，草稿已保留。' });
        clearTimeout(entry.retry); entry.retry = setTimeout(() => kick(entry), retryMs * 2 ** (entry.retries - 1)); entry.retry.unref?.(); return;
      }
      entry.failed = version;
      update(entry, { phase: 'stable', requestId: null, reason: '运行方式切换失败，已保留原会话。' });
    }
  }
  function recover(entry) {
    entry.recovery = entry.previous;
    entry.previous = null; entry.choice = 'now'; entry.handoff = null; entry.retries = 0;
    update(entry, { changeId: ++changeId, target: entry.recovery.path, phase: 'preparing', requestId: null, reason: '新运行方式连接失败，正在恢复原会话。' });
    kick(entry);
  }
  function reconcile() {
    if (closed) return;
    const live = new Set();
    for (const session of list()) {
      if (session.spec.owner === 'dispatch' || session.spec.kind === 'ssh' || !['claude', 'codex'].includes(session.spec.agent)) continue;
      const id = session.spec.terminalId; live.add(id);
      let entry = entries.get(id);
      if (entry && entry.session.identity !== session.identity && !entry.task) { clearTimers(entry); entries.delete(id); entry = null; }
      const target = entry?.recovery ? { path: entry.recovery.path } : choose(session);
      if (!entry) {
        entry = { session, unavailable: target.path ? null : target.reason, state: { changeId: ++changeId, current: session.path, target: target.path || session.path, phase: 'stable',
          background: { known: false, count: null }, requestId: null, reason: target.path ? null : target.reason } };
        entries.set(id, entry);
      } else {
        const retryFailed = entry.failed === entry.state.changeId && entry.state.phase === 'stable' && entry.state.current !== entry.state.target;
        if (!retryFailed && entry.state.target === (target.path || session.path) && entry.unavailable === (target.path ? null : target.reason)) { entry.session = session; kick(entry); continue; }
        clearTimers(entry); entry.unavailable = target.path ? null : target.reason;
        entry.choice = entry.recovery ? 'now' : null; entry.handoff = null; entry.session = session;
        entry.state = { ...entry.state, changeId: ++changeId, target: target.path || entry.state.current, requestId: null, reason: target.path ? null : target.reason };
      }
      kick(entry);
    }
    for (const [id, entry] of entries) if (!live.has(id) && !entry.task) { update(entry, { phase: 'stable', requestId: null }); remove(entry); }
  }
  return {
    reconcile,
    observe(id) { const entry = entries.get(id); if (entry && entry.state.phase !== 'stable') kick(entry); },
    state: id => entries.get(id)?.state || null,
    handoff: id => entries.get(id)?.handoff || null,
    recovering: id => !!entries.get(id)?.recovery,
    frozen: id => ['preparing', 'switching', 'rolling-back'].includes(entries.get(id)?.state.phase),
    waiting: () => [...entries.values()].filter(entry => entry.state.phase !== 'stable').length,
    input(id, runtimeSessionId) {
      const entry = entries.get(id);
      if (!entry || ![entry.session.spec.runtimeSessionId, entry.pendingSession?.spec.runtimeSessionId].includes(runtimeSessionId)) return;
      entry.inputStarted = true; entry.previous = null;
    },
    failed(id, runtimeSessionId) {
      const entry = entries.get(id);
      if (!entry || entry.inputStarted || entry.recovery) return false;
      if (entry.pendingSession?.spec.runtimeSessionId === runtimeSessionId) { entry.pendingFailure = true; return true; }
      if (entry.session.spec.runtimeSessionId !== runtimeSessionId || !entry.previous) return false;
      recover(entry); return true;
    },
    answer(id, runtimeSessionId, answer) {
      const entry = entries.get(id);
      if (!entry || entry.session.spec.runtimeSessionId !== runtimeSessionId && !(entry.session.path === 'terminal' && runtimeSessionId === id)) return { accepted: false };
      if (answer.switch) {
        const value = answer.switch;
        if (!['awaiting-choice', 'waiting-background'].includes(entry.state.phase) || value.changeId !== entry.state.changeId || value.requestId !== entry.state.requestId) return { accepted: false };
        entry.choice = value.action; update(entry, { requestId: value.action === 'wait' ? entry.state.requestId : null, phase: value.action === 'wait' ? 'waiting-background' : 'preparing' });
        kick(entry); return { accepted: true };
      }
      const value = answer.handoff;
      if (!value || value.changeId !== entry.state.changeId || entry.state.phase !== 'preparing'
        || entry.handoff && value.draft.version < entry.handoff.draft.version) return { accepted: false };
      if (entry.handoff?.draft.version === value.draft.version) return { changeId: value.changeId, version: value.draft.version,
        accepted: JSON.stringify(entry.handoff.draft) === JSON.stringify(value.draft) };
      if (entry.handoff) Object.assign(entry.handoff, structuredClone(value));
      else entry.handoff = structuredClone(value);
      kick(entry);
      return { changeId: value.changeId, version: value.draft.version, accepted: true };
    },
    forget(id) { const entry = entries.get(id); if (entry) { update(entry, { phase: 'stable', requestId: null }); remove(entry); } },
    async close() { closed = true; for (const entry of entries.values()) clearTimers(entry); await Promise.allSettled([...entries.values()].map(entry => entry.task)); entries.clear(); },
  };
}
module.exports = { createSwitches };
