async function openNativeFromShell(deps, project, s, event, adapter = deps.adapterOf(event.agent ?? deps.legacyRestoreAgent ?? 'codex')) {
  try {
    const { routingOwned } = require('../agents/agent-command.cjs');
    const { manifest: { id: agent, label }, nativePolicy } = adapter;
    const launch = adapter.terminal.launch(event.args === undefined && !event.command ? [] : event.args, routingOwned);
    const paths = project.kind === 'ssh' ? deps.path.posix : deps.path;
    if (typeof event.cwd !== 'string' || !paths.isAbsolute(event.cwd) || event.cwd.length > 4096 || event.cwd.includes('\0'))
      throw new Error(`${label} 启动目录无效，请重启终端后重试。`);
    launch.cwd = launch.cwd ? paths.resolve(event.cwd, launch.cwd) : event.cwd;
    if (launch.cwd.length > 4096) throw new Error(`${label} 启动目录无效，请重启终端后重试。`);
    if (nativePolicy.shellHome && typeof event.codexHome === 'string' && paths.isAbsolute(event.codexHome) && event.codexHome.length <= 4096 && !event.codexHome.includes('\0')) {
      launch.codexHome = event.codexHome;
    }
    if (!deps.nativeSessions) throw new Error(nativePolicy.restoreWithoutNative);
    deps.launchPlans.delete(s.terminalId); deps.restorePlans.delete(s.terminalId);
    const opened = await deps.nativeSessions.start(s.terminalId, { agent, resume: launch.resume, launch });
    if (launch.prompt) await deps.nativeSessions.send(s.terminalId, opened.runtimeSessionId, { clientMessageId: deps.randomUUID(), text: launch.prompt });
    deps.broadcast();
  } catch (error) {
    if (deps.sessions.get(s.terminalId) === s && !s.nativeStructured) {
      const data = `\r\n${error.message}\r\n`;
      s.chunks.push(data); s.bytes += data.length; s.pending += data; s.flush();
    } else if (deps.store.findTerminal(s.terminalId)) deps.startupErrors.set(s.terminalId, error.message);
    deps.broadcast();
  }
}

function onEvent(deps, event, remote) {
  const s = deps.sessions.get(event.projectId);
  if (!s) return;
  const project = deps.store.projects.find(p => p.id === s.projectId);
  if (!project) return;
  if (remote && remote !== (s.remoteConnection || s.terminal)) return;
  if (event.version === 1 && deps.acceptDispatchEvent(s, project, event, remote && (ack => remote.ackDispatch(ack)))) return;
  if (event.sessionKey !== s.sessionKey) return;
  if (deps.acceptDispatchEvent(s, project, event)) return;
  // Remove next version. Shells opened before the update still send these names.
  if (event.type === 'codex-started') event = { ...event, type: 'agent-started' };
  if (event.type === 'codex-exited') event = { ...event, type: 'agent-exited' };
  if (event.type === 'claude-seat-input') {
    if (s.cliActive && s.agent === 'claude' && !s.nativeStructured && event.sessionId === s.claudeSessionId) deps.callsOf(s, project).observeSeatInput(event);
    return;
  }
  if (event.type === 'agent-activity') { deps.claudeActivity(project, s, event); return; }
  // The claude wrapper found a proxy set since the terminal started; its command field names the variable.
  if (event.type === 'hook-channel') { deps.reportHookChannel(s, event.command, event.sequence); return; }
  if (event.type !== 'turn-complete' && !deps.acceptShellEvent(s, event)) return;
  const shellAdapter = event.type === 'agent-started' ? deps.adapterOf(event.agent) ?? deps.adapterOf('codex') : null;
  if (shellAdapter?.terminal?.redirect === 'native') { void openNativeFromShell(deps, project, s, event, shellAdapter); return; }
  if (event.type === 'agent-exited') {
    const terminal = deps.adapterOf(event.agent)?.terminal;
    if (!terminal || terminal.redirect) return;
  }
  s.approval?.context('shell-event', [event.type, event.sequence]);
  if (event.type === 'shell-ready' || event.type === 'shell-prompt') resetShellState(deps, s, project, event);
  else if (event.type === 'agent-started') { startAgent(deps, s, project, event, shellAdapter); return; }
  else if (event.type === 'agent-exited') exitAgent(deps, s, project, event);
  else if (event.type === 'turn-complete') {
    if (s.agent === 'codex' && event.threadId && event.turnId && s.cliStateMeta?.turnId === event.turnId
      && (s.cliProviderId || s.rootThreadId || s.reportedThreadId) === event.threadId) {
      // Notify is an immediate UI hint, not a newer rollout record. Preserve the
      // record watermark so this turn's earlier task_complete can still end its work.
      deps.publishCliState(s, 'idle', { at: s.cliStateMeta.at, threadId: event.threadId, turnId: event.turnId, eventId: `notify:${event.eventId}` });
    }
    // notify is inherited by child agents. It only requests a refresh; the
    // interactive parent's task lifecycle is the authority for completion.
    if (s.cliActive && (!s.rootThreadId || event.threadId === s.rootThreadId)) { s.usageAccount?.refresh(); void s.activityMonitor?.poll(); }
    return;
  } else return;
  deps.broadcast();
  if (event.type === 'shell-prompt') { void deps.resumeAfterPrompt(project, s); deps.launchAfterPrompt(project, s); }
}

function resetShellState(deps, s, project, event) {
  s.cliState = s.cliStateMeta = s.cliProviderId = null;
  deps.endSkillSession(s);
  s.needsInput = null; s.agentCommand = null; deps.stopUsageAccount(s);
  s.claudeResumeId = null; s.claudeFollowRequest = (s.claudeFollowRequest || 0) + 1;
  s.activityMonitor?.stop(); s.activityMonitor = null;
  s.cliActive = false; s.codexActivity = 'unknown'; s.reportedThreadId = null; s.promptQueue.reset(); s.activitySnapshot = s.activityRawSnapshot = null;
  if (s.completionWork?.reset()) deps.store.expectCompletion(project.id, false);
  s.ready = event.type === 'shell-prompt';
  s.inputDirty = false;
  s.status = 'shell';
  // A prompt after the launch command was typed means the agent ended before it started: show the terminal.
  if (!deps.launchPlans.has(s.terminalId)) s.agentStarting = false;
  s.codexAvailable = event.codexAvailable === true;
  s.claudeAvailable = event.claudeAvailable === true;
  if (typeof event.codexHome === 'string') s.codexHome = event.codexHome;
  if (!deps.quitting && typeof event.cwd === 'string') deps.store.setRestore(s.terminalId, { cwd: event.cwd });
}

function startAgent(deps, s, project, event, shellAdapter) {
  const hookSession = shellAdapter?.terminal?.hookSession;
  if (hookSession) deps.startHookLaunch(s, event.sequence);
  s.cliState = s.cliStateMeta = s.cliProviderId = null;
  s.needsInput = null;
  s.agentStarting = false;
  const restored = deps.store.findTerminal(s.terminalId)?.record.restore;
  const startingAgent = shellAdapter.manifest.id;
  // A new CLI run must learn its own root before a received prompt can bind CLI state.
  if (!hookSession) s.rootThreadId = null;
  s.agentCwd = event.cwd || restored?.cwd || project.path;
  if (typeof event.codexHome === 'string') s.codexHome = event.codexHome;
  if (restored?.codex !== true || (restored.agent || 'codex') !== startingAgent) deps.readingHistory.close(s.terminalId);
  else void deps.prepareReading(s.terminalId, { ...restored, agent: startingAgent, cwd: event.cwd || restored.cwd });
  // A run of the CLI that is no conversation (codex update, claude --version: agent-command.cjs): the reading view
  // says what it does and shows its output; nothing is handed over, followed or restored for it.
  s.agentCommand = deps.agentCommand(event.agent, event.command);
  if (s.agentCommand) {
    deps.readingHistory.close(s.terminalId);
    deps.stopUsageAccount(s);
    s.ready = false; s.cliActive = true; s.status = 'codex'; s.error = null; s.codexActivity = 'unknown'; s.agentSettings = null; s.usage = null;
    s.agent = startingAgent;
    deps.startSkillSession(project, s, event.sequence, false);
    s.activityMonitor?.stop(); s.activityMonitor = null; s.actions.reset(); s.conversation.reset(); s.promptQueue.reset();
    deps.broadcast(); return;
  }
  // The work done in this folder before, brought up to date for the CLI that starts now (handoff.cjs).
  if (project.kind !== 'ssh') {
    void deps.writeHandoff(deps.handoffFile(s.terminalId), event.cwd || project.path, { memoryDir: deps.memoryDir(), codexHome: event.codexHome || s.codexHome || undefined }).catch(() => {});
    void deps.scrubProjectSkills(project).catch(() => {});
  } else void deps.sshHandoff(project, s).catch(() => {});
  const claudeResumeId = hookSession ? s.claudeResumeId : null;
  const keepClaudeHistory = claudeResumeId && s.claudeSessionId === claudeResumeId && s.claudeTranscript;
  if (!keepClaudeHistory) s.claudeSessionId = null;
  s.ready = false;
  s.cliActive = true;
  // A resumed Claude conversation whose transcript is still followed keeps what its records showed.
  if (!keepClaudeHistory) s.agentSettings = null;
  s.status = 'codex';
  s.error = null;
  s.submissions.reset();
  s.codexActivity = 'unknown'; s.activitySince = (deps.now ?? Date.now)(); s.activityInputAt = s.activityConfirmedInputAt = 0;
  s.activitySnapshot = s.activityRawSnapshot = null;
  // The kept tail has already replayed its prefix, including outstanding workers.
  if (!keepClaudeHistory) s.completionWork?.reset();
  s.activityPromptAt = 0; s.claudePromptEventId = null;
  s.activityClockOffset = Number.isFinite(event.sentAt) ? s.activitySince - event.sentAt : 0;
  if (!keepClaudeHistory) { s.actions.reset(); s.conversation.reset(); s.claudeTranscript = null; s.claudeSessionId = null; }
  s.promptQueue.reset();
  s.agent = startingAgent;
  deps.startSkillSession(project, s, event.sequence);
  if (!keepClaudeHistory) { s.activityMonitor?.stop(); s.activityMonitor = null; }
  if (!keepClaudeHistory || !s.usage) deps.startUsage(project, s, event);
  else if (project.kind === 'ssh') deps.bindRemoteClaudeAccount(s);
  // A terminal restores the agent it last ran. Switching agents drops the other one's conversation id.
  const previousAgent = deps.store.findTerminal(s.terminalId)?.record.restore?.agent || 'codex';
  const agentRestore = { agent: s.agent, ...(previousAgent !== s.agent ? { threadId: null, interrupted: false } : {}) };
  if (hookSession) {
    // Claude reports turns and its session id through hooks (claudeActivity).
    deps.store.setRestore(s.terminalId, { terminal: true, codex: true, cwd: event.cwd, ...agentRestore });
    s.claudeResumeId = null;
    if (claudeResumeId) void deps.followClaudeSession(project, s, claudeResumeId).catch(error => { s.error = String(error); deps.broadcast(); });
    deps.broadcast(); return;
  }
  deps.store.setRestore(s.terminalId, agentRestore);
  watchCodexActivity(deps, project, s, event);
  deps.store.setRestore(s.terminalId, { terminal: true, codex: true, cwd: event.cwd });
  // Unread completion is independent of session activity. It survives new turns.
  deps.broadcast();
}

function watchCodexActivity(deps, project, s, event) {
  const remoteSince = Number.isFinite(event.sentAt) ? event.sentAt : s.activitySince;
  s.activityMonitor?.stop();
  const readCurrent = () => deps.sessions.get(s.terminalId) === s && s.codexReadEvent === event && s.cliActive && s.agent === 'codex';
  // Its records feed the reading view and the activity pane: read here, or, over SSH, read on that computer and
  // sent back compacted with each status (integration/remote-worker.py), with the same history start and end.
  const onHistory = ready => {
    if (ready) s.conversation.endHistory();
    else {
      s.activitySnapshot = s.activityRawSnapshot = null;
      s.conversation.beginHistory(); s.actions.reset(); s.conversation.reset(); s.usage?.reset(true);
      if (s.completionWork?.reset()) deps.store.expectCompletion(project.id, false);
      s.usage?.resetScope(); s.bindUsageAccount?.();
    }
    if (s.completionWork) s.completionWork.reading = !ready;
    deps.usageHistory(s, ready);
  };
  const onRecord = record => {
    if (!readCurrent()) return;
    s.completionWork?.record(record, 'codex', project.kind === 'ssh' ? s.activityClockOffset || 0 : 0);
    if (record.workOnly) return;
    deps.codexConversation(s.conversation, record, event.cwd || project.path); deps.describeActions(s, event.cwd || project.path, deps.codexRecord(s.actions, record, event.cwd || project.path));
    deps.noteSettings(s, 'codex', record);
    if (record?.type === 'event_msg' && ['task_complete', 'turn_completed', 'turn_aborted', 'turn_interrupted'].includes(record.payload?.type)) {
      const at = Date.parse(record.timestamp) + (project.kind === 'ssh' ? s.activityClockOffset || 0 : 0);
      s.promptQueue.finish(Number.isFinite(at) ? at : (deps.now ?? Date.now)());
    }
  };
  s.codexReadEvent = event;
  const remoteStatus = value => {
    if (!value || typeof value !== 'object' || !('snapshot' in value)) return value;
    if (!readCurrent()) return null;
    if (value.reset) onHistory(false);
    for (const record of Array.isArray(value.records) ? value.records : []) { try { onRecord(record); } catch { } }
    if (value.historyDone) onHistory(true);
    if (s.completionWork) s.completionWork.reading = !value.historyDone;
    if (s.completionWork && value.completionUncertain) s.completionWork.uncertain = true;
    return value.snapshot;
  };
  const reader = project.kind === 'ssh' ? null : new deps.CodexActivityReader(event.cwd || project.path, event.codexHome || s.codexHome, s.activitySince, {
    threadId: () => s.reportedThreadId, requireBinding: () => (project.terminals?.length || 0) > 0,
    onHistory: ready => { if (readCurrent()) onHistory(ready); },
    catchUpHistory: true, isCurrent: readCurrent,
    onReset: partial => { if (readCurrent() && s.usage?.rates) s.usage.rates.partial = partial; }, onRecord, onWorkRecord: record => onRecord({ ...record, workOnly: true }) });
  s.activityMonitor = deps.monitorActivity(
    async () => {
      let snapshot = await (reader ? reader.read() : project.terminals?.length && !s.reportedThreadId ? null :
        s.terminal.request('codex-status', { since: remoteSince, threadId: s.reportedThreadId }).then(remoteStatus));
      if (!readCurrent()) return null;
      // Fresh SSH snapshots use the remote clock; cached snapshots already use this clock.
      if (snapshot && !reader) snapshot = { ...snapshot, updatedAt: snapshot.updatedAt + s.activitySince - remoteSince };
      if (reader?.filename && snapshot?.threadId) void deps.prepareReading(s.terminalId,
        { agent: 'codex', threadId: snapshot.threadId, cwd: event.cwd || project.path }, reader.filename);
      if (s.completionWork && reader) {
        s.completionWork.reading = reader.historyPending || reader.offset < reader.fileSize || reader.buffer.length > 0;
        s.completionWork.uncertain ||= reader.workHistory?.uncertain;
      }
      const latest = snapshot || s.activityRawSnapshot;
      return latest && { ...latest, workVersion: s.completionWork?.version, reading: !!s.completionWork?.reading };
    },
    snapshot => {
      // Codex can record the received prompt after task_started for the same open turn.
      if (snapshot.state === 'working' && s.activityPromptAt > snapshot.updatedAt) snapshot = { ...snapshot, updatedAt: s.activityPromptAt };
      deps.applyActivity(project, s, snapshot);
    },
    // A rollout here is read as it is written; over SSH the server is asked more often while the agent works.
    { interval: () => deps.readEvery(s), watch: () => reader?.filename || null },
  );
}

function exitAgent(deps, s, project, event) {
  s.calls?.endSession();
  s.cliState = s.cliStateMeta = s.cliProviderId = null;
  deps.readingHistory.close(s.terminalId);
  deps.endSkillSession(s);
  s.needsInput = null; s.agentCommand = null; deps.stopUsageAccount(s);
  s.claudeResumeId = null; s.claudeFollowRequest = (s.claudeFollowRequest || 0) + 1;
  s.activityMonitor?.stop(); s.activityMonitor = null; s.codexActivity = 'unknown';
  if (s.completionWork?.reset()) deps.store.expectCompletion(project.id, false);
  s.activitySnapshot = s.activityRawSnapshot = null;
  s.ready = false;
  s.cliActive = false;
  s.status = 'shell';
  s.reportedThreadId = null;
  if (!deps.quitting) deps.store.setRestore(s.terminalId, { codex: false });
  const code = Number(event.exitCode);
  if (code && code !== 130 && code !== -1073741510) s.error = deps.t('{agent} 已退出（代码 {code}），请查看终端输出。', { agent: deps.adapterOf(s.agent)?.manifest.label ?? 'Codex', code });
}

const MAX_NATIVE_MESSAGES = 512;

function trackNativeInput(s, event) {
  const { type, payload, receivedAtMs, itemId } = event;
  if (type === 'item.upsert' && payload.kind === 'user-message' && payload.content.unsent !== true && payload.content.text) {
    const id = payload.content.clientMessageId || itemId;
    s.nativeMessages.set(id, payload.content.text);
    s.promptQueue.enqueue(payload.content.text, receivedAtMs, id);
    if (s.nativeMessages.size > MAX_NATIVE_MESSAGES) {
      const oldest = s.nativeMessages.keys().next().value;
      s.promptQueue.cancel(s.nativeMessages.get(oldest), receivedAtMs, oldest);
      s.nativeMessages.delete(oldest);
    }
  }
  if (type !== 'input.receipt' || !['consumed', 'rejected', 'unknown'].includes(payload.status)) return;
  const id = payload.clientMessageId, text = s.nativeMessages.get(id);
  if (!s.nativeMessages.delete(id)) return;
  if (payload.status === 'consumed') s.promptQueue.start(text, receivedAtMs, id);
  else s.promptQueue.cancel(text, receivedAtMs, id);
}

function structuredEvent(deps, id, event) {
  if (event.replay || deps.quitting) return;
  if (event.type === 'switch.updated') {
    const host = deps.sessions.get(id), s = host?.switchPreviousHost || host;
    if (s && (!s.nativeRuntimeSessionId || s.nativeRuntimeSessionId === event.runtimeSessionId)) { s.switchState = event.payload; s.nativePathReason = event.payload.reason; }
    deps.scheduleState(); return;
  }
  const spec = deps.nativeSpecs.get(id), project = deps.store.findTerminal(id)?.project;
  if (!spec || !project) return;
  let s = deps.sessions.get(id);
  if (!s || !s.nativeStructured || s.nativeRuntimeSessionId !== event.runtimeSessionId) {
    if (event.type !== 'session.state' || event.payload.state !== 'starting') return;
    s = { nativeStructured: true, nativeSpec: spec, terminalId: id, projectId: project.id, sessionId: spec.sessionId, skillSessionId: spec.skillSessionId,
      sessionKey: spec.sessionKey, controlCapability: spec.controlCapability, bootstrapFile: spec.bootstrapFile,
      status: 'codex', ready: false, cliActive: true, agent: spec.agent, nativeMode: event.transport,
      activitySince: (deps.now ?? Date.now)(), codexActivity: 'unknown', error: null, nativeMessages: new Map(), usageEnv: spec.env,
      recordRun: (call, value) => deps.dashboard.run(project, call, value),
      terminal: { kill: () => { void deps.nativeSessions.stop(id, event.runtimeSessionId).catch(deps.report); }, resize() {} },
      gate: { dispose() {} },
      promptQueue: new deps.PromptQueue(() => deps.scheduleState()), completionWork: new deps.CompletionWork(),
      actions: new deps.ActionLog(() => {}), conversation: new deps.ConversationLog(() => {}) };
    if (spec.switchHost) { deps.retainAgentState(s, spec.switchHost); delete spec.switchHost; }
    deps.sessions.set(id, s);
    deps.bindDispatchInbox(s, project);
  }
  s.nativeRuntimeSessionId = event.runtimeSessionId;
  s.nativeUsage ||= deps.createNativeUsage(spec.agent);
  s.nativeUsage.apply(event, event.type === 'usage.updated' ? deps.nativeSessions.tokenRate(id, event.runtimeSessionId) : null);
  if (event.type === 'error' && event.payload.code === 'native_cli_outdated') deps.store.warning = deps.t(event.payload.message);
  if (event.providerSessionId) {
    if (spec.agent === 'claude') s.claudeSessionId = event.providerSessionId;
    else s.reportedThreadId = event.providerSessionId;
  }
  if (event.type === 'routing.updated') {
    const { observed, effective } = event.payload;
    if (typeof observed?.model === 'string') s.nativeObservedModel = observed.model;
    s.agentSettings = Object.fromEntries(['model', 'effort', 'fast', 'ultracode'].map(key => [key, observed?.[key] ?? effective?.[key] ?? s.agentSettings?.[key] ?? null]));
  }
  trackNativeInput(s, event);
  if (event.type === 'turn.started') {
    if (event.payload.origin === 'user') { s.completionWork.begin(event.receivedAtMs); deps.store.expectCompletion(project.id); }
    s.activityInputAt = event.receivedAtMs;
    deps.applyActivity(project, s, { threadId: event.providerSessionId || event.runtimeSessionId, turnId: event.turnId, state: 'working', updatedAt: event.receivedAtMs });
  }
  if (event.type === 'turn.completed') {
    deps.applyActivity(project, s, { threadId: event.providerSessionId || event.runtimeSessionId, turnId: event.turnId,
      state: event.payload.status === 'completed' ? 'complete' : event.payload.status === 'unknown' ? 'unknown' : 'interrupted', ended: true, updatedAt: event.receivedAtMs });
  }
  if (event.type === 'session.state') {
    s.nativeState = event.payload.state;
    if (['stopped', 'failed', 'disconnected'].includes(event.payload.state)) {
      for (const [clientId, text] of s.nativeMessages) s.promptQueue.cancel(text, event.receivedAtMs, clientId);
      s.nativeMessages.clear();
      s.calls?.endSession();
      s.status = 'exited'; s.cliActive = false;
      deps.store.setRestore(id, { terminal: false, codex: false });
    }
    if (event.payload.state === 'failed') s.error = event.payload.reason;
  }
  deps.scheduleState();
}

function createShellEvents(deps) {
  return {
    onEvent: onEvent.bind(null, deps),
    structuredEvent: structuredEvent.bind(null, deps),
    openCodexFromShell: openNativeFromShell.bind(null, deps),
    watchCodexActivity: watchCodexActivity.bind(null, deps),
  };
}

module.exports = { createShellEvents };
