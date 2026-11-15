const path = require('node:path');

// The hook events the pipe's claude-hook.ps1 kinds stood for (C-2), by the state claudeActivity takes.
const HOOK_STATES = { UserPromptSubmit: 'working', Stop: 'complete', Notification: 'attention', PermissionRequest: 'attention',
  Elicitation: 'attention', PreToolUse: 'progress', PostToolUse: 'progress', PostToolUseFailure: 'progress', PermissionDenied: 'progress',
  ElicitationResult: 'progress' };
// The notifications that mean Claude waits for an answer; an idle one must not turn a finished round back into a waiting one.
const ATTENTION_NOTICES = ['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog'];

// A terminal's Claude Code and Codex activity: hook events, the transcript Claude writes and the turn snapshots
// readers produce become the CLI state, the lights and the completion alert. `deps` is the app shell (main.cjs),
// read on every call so its late values are current; these functions are among its members and reach each other
// through it too, so a later round can replace one of them without editing the rest. A closure a call leaves behind
// (the transcript tail's and monitor's callbacks) keeps the members that call read.
function createClaudeActivity(deps) {
  // Claude Code writes each tool call to its transcript; follow it while the session lasts.
  function followClaude(project, s, event) {
    const { sessions, store, claudeConfigDir, prepareReading, callsOf, TranscriptTail, monitorActivity, readEvery, usageHistory,
      claudeConversation, describeActions, claudeRecord, noteSettings, applyActivity } = deps;
    const remote = project.kind === 'ssh', paths = remote ? path.posix : path;
    const file = typeof event.transcriptPath === 'string' && (!remote || paths.isAbsolute(event.transcriptPath)) ? paths.resolve(event.transcriptPath) : '';
    if (!file || paths.basename(file) !== `${event.sessionId}.jsonl`) return;
    // The worker checks remote paths against its own Claude projects folder before reading them.
    if (!remote && !file.toLowerCase().startsWith(claudeConfigDir().toLowerCase() + path.sep)) return;
    if (!remote) void prepareReading(s.terminalId, { agent: 'claude', threadId: event.sessionId }, file);
    s.claudeFollowRequest = (s.claudeFollowRequest || 0) + 1;
    s.claudeSessionId = event.sessionId;
    s.approval?.context('claude-session', event.sessionId);
    // The terminal's own calls, not the agent's meter: a hook can bind the transcript before startUsage builds the meter,
    // and the meter it builds keeps these calls and their folder.
    callsOf(s, project).setFolder(remote ? null : path.join(path.dirname(file), event.sessionId, 'subagents'));
    if (s.claudeTranscript?.filename !== file) {
      let tail;
      const readCurrent = () => sessions.get(s.terminalId) === s && (!tail || s.claudeTranscript === tail)
        && (s.codexActive && s.agent === 'claude' || s.claudeResumeId === event.sessionId);
      const onHistory = ready => {
        if (ready) s.conversation.endHistory();
        else { s.conversation.beginHistory(); s.actions.reset(); s.conversation.reset(); s.usage?.reset(true); }
        if (!ready && s.completionWork?.reset()) store.expectCompletion(project.id, false);
        if (s.completionWork) s.completionWork.reading = !ready;
        usageHistory(s, ready);
      };
      s.activitySnapshot = s.activityRawSnapshot = null;
      tail = s.claudeTranscript = remote ? { filename: file } : new TranscriptTail(file, { onHistory: ready => { if (readCurrent()) onHistory(ready); }, catchUpHistory: true,
        isCurrent: readCurrent,
        onReset: partial => { if (readCurrent() && s.usage?.rates) s.usage.rates.partial = partial; }, onWorkRecord: record => onRecord({ ...record, workOnly: true }) });
      s.activityMonitor?.stop();
      const onRecord = record => {
        if (!readCurrent()) return;
        s.completionWork?.record(record, 'claude', remote ? s.activityClockOffset || 0 : 0);
        // Finish this user round even if later background records replace the poll's final snapshot.
        const endedAt = s.completionWork?.endedAt;
        if (endedAt && endedAt >= (s.activitySince || 0) && endedAt > s.promptQueue.finishedAt) s.promptQueue.finish(endedAt);
        if (record.workOnly) {
          if (['queue-operation', 'user', 'attachment'].includes(record.type)) claudeConversation(s.conversation, record, project.path, { queueOnly: true });
          return;
        }
        const turn = s.completionWork?.turn;
        if (turn && turn.updatedAt >= Math.max(s.activitySince || 0, s.activityRawSnapshot?.updatedAt || 0)) {
          s.activityRawSnapshot = { ...turn, threadId: s.claudeSessionId };
        }
        claudeConversation(s.conversation, record, project.path); describeActions(s, project.path, claudeRecord(s.actions, record, project.path));
        noteSettings(s, 'claude', record);
      };
      const since = Number.isFinite(event.sentAt) ? event.sentAt : s.activitySince || Date.now();
      const remoteStatus = value => {
        if (!value || !readCurrent() || !s.activityMonitor) return null;
        // The host reads the sub-agents after this transcript: their records go first, so a completion below ends a call
        // whose replies are already counted. A reset answer carries none.
        callsOf(s, project).remoteRecords(value.subagents);
        if (value.reset) onHistory(false);
        for (const record of Array.isArray(value.records) ? value.records : []) { try { onRecord(record); } catch { } }
        if (value.historyDone) onHistory(true);
        if (s.completionWork) s.completionWork.reading = !value.historyDone;
        if (s.completionWork && value.completionUncertain) s.completionWork.uncertain = true;
        return s.activityRawSnapshot && { ...s.activityRawSnapshot, workVersion: s.completionWork?.version, reading: !!s.completionWork?.reading, transcriptRead: true };
      };
      s.activityMonitor = monitorActivity(async () => {
        if (remote) {
          const subagents = callsOf(s, project).remoteSubagents();
          return s.terminal.request('claude-status', { path: file, since, ...(subagents.length ? { subagents } : {}) }).then(remoteStatus);
        }
        await tail.read(onRecord);
        if (!readCurrent()) return null;
        if (s.completionWork) {
          s.completionWork.reading = tail.historyPending || tail.offset < tail.fileSize || tail.buffer.length > 0;
          s.completionWork.uncertain ||= tail.workHistory?.uncertain;
        }
        return s.activityRawSnapshot && { ...s.activityRawSnapshot, workVersion: s.completionWork?.version, reading: !!s.completionWork?.reading, transcriptRead: true };
      }, snapshot => applyActivity(project, s, snapshot), { interval: () => readEvery(s), watch: () => remote ? null : tail.filename });
    } else void s.activityMonitor?.poll();
  }

  // Restores know the id before Claude emits its next prompt hook.
  async function followClaudeSession(project, s, id) {
    const { sessions, store, findClaudeSession, followClaude } = deps;
    if (project.kind === 'ssh') return false;
    const request = s.claudeFollowRequest = (s.claudeFollowRequest || 0) + 1;
    const cwd = store.findTerminal(s.terminalId)?.record.restore?.cwd || project.path;
    const file = await findClaudeSession(cwd, id);
    if (!file || sessions.get(s.terminalId) !== s || (!s.codexActive && s.claudeResumeId !== id) || (s.codexActive && s.agent !== 'claude')) return false;
    if (s.claudeFollowRequest !== request) return s.claudeSessionId === id && s.claudeTranscript?.filename === file;
    followClaude(project, s, { sessionId: id, transcriptPath: file });
    store.setRestore(s.terminalId, { threadId: id });
    await s.activityMonitor?.poll();
    return true;
  }


  // CLI interaction is independent of project completion: progress never arms another completion notification.
  function publishCliState(s, state, { at = Date.now(), threadId, turnId, requestId, eventId, message: detail, bind = false, progress = false, expectedRevision, newTurn = false } = {}) {
    const { sessions, broadcast } = deps;
    if (!s.sessionId || s.nativeStructured || !s.codexActive || sessions.get(s.terminalId) !== s || !Number.isFinite(at)) return false;
    if (!s.cliStateMeta || s.cliState?.sessionId !== s.sessionId) s.cliStateMeta = { at: 0, events: new Set(), closed: new Set(), turnId: null, requestId: null };
    const meta = s.cliStateMeta, before = s.cliState;
    if (expectedRevision != null && expectedRevision !== before?.revision) return false;
    const bound = s.cliProviderId || (s.agent === 'claude' ? s.claudeSessionId || s.claudeResumeId : s.reportedThreadId || s.rootThreadId);
    if (!bind && threadId && bound && threadId !== bound && !(s.agent === 'codex' && bound.length >= 8 && threadId.toLowerCase().startsWith(bound.toLowerCase()))) return false;
    if (at < Math.max(s.activitySince || 0, s.activityInputAt || 0, meta.at)) return false;
    if (eventId && meta.events.has(eventId)) return false;
    if (!bind && turnId && (meta.closed.has(turnId) || state !== 'working' && meta.turnId && turnId !== meta.turnId)) return false;
    // PermissionRequest/Elicitation have no tool_use_id in Claude 2.1.317. A sibling's
    // asynchronous progress cannot prove that such a dialog has been answered. A tool
    // observation only releases a matching wait; it cannot advance a working turn's watermark.
    if (progress && (before?.state !== 'waiting' || !meta.requestId || requestId !== meta.requestId)) return false;
    if (bind && threadId !== bound) { meta.closed.clear(); meta.turnId = null; }
    if (newTurn) { if (meta.turnId) meta.closed.add(meta.turnId); meta.turnId = null; }
    if (threadId) s.cliProviderId = threadId;
    if (turnId && turnId !== meta.turnId) { if (meta.turnId) meta.closed.add(meta.turnId); meta.turnId = turnId; }
    if (eventId) { meta.events.add(eventId); if (meta.events.size > 256) meta.events.delete(meta.events.values().next().value); }
    meta.at = at;
    if (state === 'idle' && turnId) meta.closed.add(turnId);
    const message = state === 'waiting' ? String(detail ?? '').slice(0, 300) : undefined;
    meta.requestId = state === 'waiting' ? requestId || null : null;
    s.needsInput = state === 'waiting' ? { message, since: Date.now() } : null;
    s.cliStateRevision = (s.cliStateRevision || 0) + 1;
    s.cliState = { sessionId: s.sessionId, revision: s.cliStateRevision,
      updatedAt: Date.now(), state, ...(message ? { message } : {}) };
    s.observeNativeSwitch?.();
    broadcast();
    return true;
  }

  // One place turns an agent's turn state into lights and completion alerts, for Codex and Claude alike.
  function applyActivity(project, s, snapshot) {
    const { sessions, store, scheduleState, publishCliState, summarizeTask, refreshClaudeAccounts, notifyCompletion, memoryFolder, memoryDir,
      remember, roundsOf, scrubProjectSkills, broadcast } = deps;
    if (sessions.get(s.terminalId) !== s || !s.codexActive) return;
    if (snapshot.updatedAt < (s.activitySince || 0)) return;
    const bound = s.cliProviderId || (s.agent === 'claude' ? s.claudeSessionId : s.reportedThreadId);
    if (bound && snapshot.threadId && bound !== snapshot.threadId && !(s.agent === 'codex' && bound.length >= 8 && snapshot.threadId.toLowerCase().startsWith(bound.toLowerCase()))) return;
    if (s.agent === 'codex' && snapshot.turnId && s.cliStateMeta?.closed.has(snapshot.turnId)
      && (snapshot.state === 'working' || snapshot.turnId !== s.cliStateMeta.turnId)) return;
    // Readers deduplicate snapshots. Retain even a completion hidden by provisional
    // input so that expiring that submission can replay it without another record.
    if (snapshot.updatedAt >= (s.activityRawSnapshot?.updatedAt || 0)) s.activityRawSnapshot = snapshot;
    // Neither a polled result from before new input nor a result from before newer attention can end this interaction.
    if (snapshot.updatedAt < Math.max(s.activityInputAt || 0, s.cliStateMeta?.at || 0)) return;
    if (snapshot.ended || ['working', 'complete', 'interrupted'].includes(snapshot.state)) publishCliState(s, snapshot.state === 'working' ? 'working' : 'idle',
      { at: snapshot.updatedAt, threadId: snapshot.threadId, turnId: s.agent === 'codex' ? snapshot.turnId : undefined,
        eventId: `record:${snapshot.threadId}:${snapshot.turnId}:${snapshot.state}:${snapshot.updatedAt}` });
    if (s.completionWork?.reading) { s.codexActivity = 'working'; scheduleState(); return; }
    if (snapshot.ended || ['complete', 'interrupted'].includes(snapshot.state)) {
      s.completionWork?.end(snapshot.updatedAt);
      s.promptQueue.finish?.(snapshot.updatedAt);
    }
    s.activitySnapshot = snapshot;
    const queued = s.promptQueue.list?.().some(item => item.state === 'queued') || !!s.conversation?.queue?.length;
    const state = s.completionWork?.state(snapshot, { queued })
      || (queued && snapshot.state === 'complete' ? 'working' : snapshot.state);
    if (snapshot.ended && snapshot.state === 'unknown' || snapshot.state === 'interrupted' || state === 'interrupted') store.expectCompletion(project.id, false);
    snapshot = { ...snapshot, state };
    s.rootThreadId = snapshot.threadId;
    s.approval?.context('activity', [snapshot.threadId, snapshot.turnId, snapshot.state]);
    // Keep the last prompt that named work; bare continuations and background callbacks cannot replace it.
    const task = summarizeTask(snapshot.prompt, { spoken: true });
    if (task) { s.lastTask = task; s.lastTaskSummary = summarizeTask(snapshot.prompt); s.lastTaskTitle = snapshot.prompt; }
    if (s.agent === 'codex') store.setRestore(s.terminalId, { threadId: snapshot.threadId });
    s.codexActivity = snapshot.state;
    if (s.agent === 'claude') {
      s.claudeActivitySnapshot = snapshot;
      if (snapshot.state === 'complete' && project.kind !== 'ssh') void refreshClaudeAccounts();
      if (['complete', 'interrupted'].includes(snapshot.state)) {
        // The last poll may still add tool calls. Settle both views afterward, unless another round has started.
        const settle = () => {
          if (sessions.get(s.terminalId) === s && s.codexActive && s.agent === 'claude' && s.claudeActivitySnapshot === snapshot && s.codexActivity !== 'working' && !(s.activityInputAt > snapshot.updatedAt)) {
            s.actions.settle(); s.conversation.settle();
          }
        };
        if (snapshot.transcriptRead || !s.activityMonitor) settle();
        else void Promise.resolve(s.activityMonitor.poll()).then(settle);
      }
    }
    if (snapshot.state === 'complete' && snapshot.turnId) {
      s.lastCompletedAt = snapshot.updatedAt;
      const allComplete = [...sessions.values()].filter(item => item.projectId === project.id || item.terminalId === project.id)
        .every(item => !item.codexActive || item.codexActivity === 'complete');
      if (allComplete && store.complete(project.id, `${snapshot.threadId}:${snapshot.turnId}`, snapshot.updatedAt)) notifyCompletion(project);
    }
    // The round that ended joins the folder's permanent memory (project-memory.cjs), here or over SSH alike. Claude's
    // transcript is read a moment later, when its last reply has arrived.
    if (['complete', 'interrupted'].includes(snapshot.state) && snapshot.threadId) {
      const agent = s.agent === 'claude' ? 'claude' : 'codex', folder = memoryFolder(project, s);
      setTimeout(() => { void remember(memoryDir(), folder, roundsOf(s.conversation.list, agent, snapshot.threadId)).catch(() => {}); }, 1500).unref?.();
      if (project.kind !== 'ssh') void scrubProjectSkills(project).catch(() => {});
    }
    broadcast();
  }

  // Claude Code hooks (HTTP through claudeHook, commands through claude-hook.ps1 and agent-event.cjs): UserPromptSubmit ->
  // working, Stop -> complete. SessionStart, always a command -> the conversation Claude writes from now on: after /clear
  // or /resume the reading view follows the new file at once.
  // Notification -> attention while Claude waits for a permission answer in its own screen; that only
  // sets the waiting indicator and never changes the round's lifecycle.
  function claudeActivity(project, s, event) {
    const { store, publishCliState, followClaude, applyActivity, refreshClaudeAccounts, promptText, isLocalAgentCommand } = deps;
    if (!s.codexActive || s.agent !== 'claude' || !['working', 'complete', 'attention', 'session', 'progress'].includes(event.state)) return;
    if (typeof event.sessionId !== 'string' || !/^[\w-]{1,100}$/.test(event.sessionId) || typeof event.eventId !== 'string' || event.eventId.length > 200) return;
    const at = Number.isFinite(event.sentAt) ? event.sentAt + (project.kind === 'ssh' ? s.activityClockOffset || 0 : 0) : Date.now();
    const bound = s.cliProviderId || s.claudeSessionId || s.claudeResumeId;
    if (at < Math.max(s.activitySince || 0, s.cliStateMeta?.at || 0) || s.cliStateMeta?.events.has(event.eventId) || event.state !== 'session' && bound && bound !== event.sessionId) return;
    // Every hook names the prompt whose turn it belongs to. Async command hooks (a proxied Windows terminal) can arrive out
    // of order, and their send times follow PowerShell's start-up: a Stop for a prompt older than the newest one seen
    // ended a turn that is already over. A dequeued prompt is new without a UserPromptSubmit, so first sight counts.
    const prompts = s.claudePrompts ||= [];
    if (typeof event.promptId === 'string' && !prompts.includes(event.promptId)) {
      prompts.push(event.promptId);
      if (prompts.length > 32) prompts.shift();
    }
    if (event.state === 'complete' && prompts.includes(event.promptId) && prompts.at(-1) !== event.promptId) return;
    const evidence = { at, threadId: event.sessionId, turnId: event.turnId, requestId: event.requestId, eventId: event.eventId };
    // Hook eventId is an event identity, not a native approval request ID. A different observed event invalidates
    // actions conservatively, even if its message is identical. Duplicate events leave the epoch alone.
    s.approval?.context('claude-event', [event.sessionId, event.eventId, event.state]);
    if (event.state === 'attention') { publishCliState(s, 'waiting', { ...evidence, message: event.message }); return; }
    if (event.state === 'progress') { publishCliState(s, 'working', { ...evidence, progress: true }); return; }
    if (event.state === 'session') {
      if (publishCliState(s, event.sessionSource === 'compact' && s.cliState?.state === 'working' ? 'working' : 'idle', { ...evidence, bind: true })) {
        s.claudeSessionSource = event.sessionSource; followClaude(project, s, event);
      }
      return;
    }
    if (s.usage && project.kind !== 'ssh') void refreshClaudeAccounts();
    // Claude Code runs its prompt hooks for some local slash commands (/context, /doctor, /compact) too. They open a screen
    // or print a line and no round follows, so they neither start a round nor end one; the card would stay "working".
    if (event.state === 'working') {
      if (typeof event.prompt === 'string' && promptText(event.prompt, event) === null) return;
      const local = typeof event.prompt === 'string' && isLocalAgentCommand('claude', event.prompt);
      if (local) { if (publishCliState(s, 'working', evidence)) s.claudeLocalCommand = true; return; }
      if (!publishCliState(s, 'working', evidence)) return;
      s.claudeLocalCommand = false;
      // UserPromptSubmit is actual input, unlike a polled working snapshot or a Stop callback.
      if (s.claudePromptEventId !== event.eventId) {
        s.claudePromptEventId = event.eventId;
        if (promptText(event.prompt, event) !== null) {
          s.activityConfirmedInputAt = Math.max(s.activityConfirmedInputAt || 0, at);
          s.activityInputAt = Math.max(s.activityInputAt || 0, s.activityConfirmedInputAt);
          s.completionWork?.begin(); store.expectCompletion(project.id);
        }
      }
    } else if (event.state === 'complete' && s.claudeLocalCommand) { if (publishCliState(s, 'idle', evidence)) s.claudeLocalCommand = false; return; }
    if (event.state === 'complete' && !publishCliState(s, 'idle', evidence)) return;
    const revision = s.cliState.revision;
    const turnId = event.eventId.slice(event.sessionId.length + 1);
    // Remember the conversation and whether its turn is still open, so a restart can resume it and continue.
    store.setRestore(s.terminalId, { threadId: event.sessionId, interrupted: event.state === 'working' });
    followClaude(project, s, event);
    const snapshot = { threadId: event.sessionId, turnId: event.state === 'complete' ? turnId : null, state: event.state, updatedAt: at, prompt: typeof event.prompt === 'string' ? event.prompt.slice(0, 2000) : undefined };
    // Stop can beat the last tool-result write. Read it before granting a completion,
    // and let a newer turn/input win if it started while the read was in flight.
    if (event.state === 'complete' && s.activityMonitor) {
      const promptEvent = s.claudePromptEventId;
      void Promise.resolve(s.activityMonitor.poll()).then(() => {
        if (s.agent !== 'claude' || s.cliState?.revision !== revision || s.claudeSessionId && s.claudeSessionId !== event.sessionId || s.claudePromptEventId !== promptEvent || s.activityRawSnapshot?.updatedAt > snapshot.updatedAt) return;
        applyActivity(project, s, { ...snapshot, state: s.completionWork?.turn?.state === 'interrupted' ? 'interrupted' : snapshot.state, transcriptRead: true });
      }).catch(() => {});
    } else applyActivity(project, s, snapshot);
  }

  // An HTTP hook event (hook-ingest.cjs) as the event claude-hook.ps1 sends over the pipe, until the session machine (T2)
  // reads hook events itself. An event that lost its payload to the size limit belongs to the session the terminal follows.
  function claudeHook(hookEvent) {
    const { sessions, store, claudeActivity } = deps;
    const s = sessions.get(hookEvent.terminalId), project = s && store.projects.find(item => item.id === s.projectId);
    const state = HOOK_STATES[hookEvent.event], { payload } = hookEvent;
    if (!project || !state || hookEvent.event === 'Notification' && !ATTENTION_NOTICES.includes(payload.notification_type)) return;
    const sessionId = hookEvent.sessionId || s.claudeSessionId || '';
    claudeActivity(project, s, { state, sessionId, eventId: `${sessionId}:${hookEvent.at}-${hookEvent.seq}`, sentAt: hookEvent.at,
      hookEvent: hookEvent.event, transcriptPath: hookEvent.transcriptPath, promptId: hookEvent.promptId,
      message: state === 'attention' ? String(payload.message ?? payload.tool_name ?? '').slice(0, 300) : null,
      prompt: state === 'working' && payload.prompt ? payload.prompt : null,
      ...(hookEvent.toolUseId ? { requestId: hookEvent.toolUseId } : {}) });
  }

  return { followClaude, followClaudeSession, publishCliState, applyActivity, claudeActivity, claudeHook };
}

module.exports = { createClaudeActivity };
