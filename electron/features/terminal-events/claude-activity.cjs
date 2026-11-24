const path = require('node:path');
const { createSessionMachine, reduce, cliFields, SCREEN_IDLE_MS } = require('./session-machine.cjs');
const { AgentCalls } = require('../agents/agent-calls.cjs');
const { claudeFastModeEcho } = require('../agents/agent-settings.cjs');

// The hook events the pipe's claude-hook.ps1 kinds stood for (C-2), by the state claudeActivity takes.
const HOOK_STATES = { UserPromptSubmit: 'working', Stop: 'complete', StopFailure: 'failed', Notification: 'attention', PermissionRequest: 'attention',
  Elicitation: 'attention', PreToolUse: 'progress', PostToolUse: 'progress', PostToolUseFailure: 'progress', PermissionDenied: 'progress',
  ElicitationResult: 'progress' };
// The notifications that mean Claude waits for an answer; an idle one must not turn a finished round back into a waiting one.
const ATTENTION_NOTICES = ['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog'];
// The session machine's signal for each state claudeActivity takes.
const SIGNALS = { working: 'start', complete: 'stop', attention: 'attention', progress: 'progress', session: 'session' };
// Prompts the CLI holds back while it works, as the prompt queue and the transcript's queue records show them.
const queuedOf = s => s.promptQueue.list?.().some(item => item.state === 'queued') || !!s.conversation?.queue?.length;
// Background work the round waits for, as CompletionWork reports it.
const backgroundOf = s => !!(s.completionWork?.tasks?.size || s.completionWork?.notifications?.size || s.dispatchHold?.count);

// A terminal's Claude Code and Codex activity: hook events, the transcript Claude writes and the turn snapshots
// readers produce become the CLI state, the lights and the completion alert. `deps` is the app shell (main.cjs),
// read on every call so its late values are current; these functions are among its members and reach each other
// through it too, so a later round can replace one of them without editing the rest. A closure a call leaves behind
// (the transcript tail's and monitor's callbacks) keeps the members that call read.
function createClaudeActivity(deps) {
  // Publication observes an existing tracker, including the host retained during a switch; it never creates one.
  function dispatchOf(s) {
    while (s.switchPreviousHost) s = s.switchPreviousHost;
    return (s.calls || AgentCalls.forTerminal(deps.sessions, s.terminalId))?.openDispatch?.() || null;
  }
  function fallbackState(s, snapshot, queued, held) {
    if (!['complete', 'interrupted'].includes(snapshot.state)) { s.dispatchWait = null; return snapshot.state; }
    const previous = s.dispatchWait, now = Date.now();
    const same = previous && previous.threadId === snapshot.threadId && previous.turnId === snapshot.turnId
      && (snapshot.turnId != null || previous.updatedAt === snapshot.updatedAt);
    const expired = !!(same && (previous.expired || Number.isFinite(previous.deadline) && previous.deadline <= now)
      || held?.count && Number.isFinite(held.deadline) && held.deadline <= now);
    s.dispatchWait = { threadId: snapshot.threadId, turnId: snapshot.turnId, updatedAt: snapshot.updatedAt,
      deadline: held?.count ? held.deadline : null, expired };
    return expired ? 'interrupted' : queued || held?.count ? 'working' : snapshot.state;
  }
  function replayCompletion(project, s) {
    if (s && deps.sessions.get(s.terminalId) === s && s.codexActive && (s.activityRawSnapshot || s.activitySnapshot)) {
      deps.applyActivity(project, s, s.activityRawSnapshot || s.activitySnapshot);
    }
  }
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
    callsOf(s, project).clockOffset = remote && Number.isFinite(s.activityClockOffset) ? s.activityClockOffset : 0;
    if (s.claudeTranscript?.filename !== file) {
      callsOf(s, project).bindBackground(file);
      let tail;
      const readCurrent = () => sessions.get(s.terminalId) === s && (!tail || s.claudeTranscript === tail)
        && (s.codexActive && s.agent === 'claude' || s.claudeResumeId === event.sessionId);
      const onHistory = ready => {
        if (ready) s.conversation.endHistory();
        else { callsOf(s, project).bindBackground(file, true); s.conversation.beginHistory(); s.actions.reset(); s.conversation.reset(); s.usage?.reset(true); }
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
        if (!remote && !s.nativeStructured) {
          const echo = claudeFastModeEcho(record);
          if (echo) deps.noteClaudeFastMode?.(echo);
        }
        callsOf(s, project).backgroundRecord(record);
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
        callsOf(s, project).clockOffset = Number.isFinite(s.activityClockOffset) ? s.activityClockOffset : 0;
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
      const stop = s.activityMonitor.stop;
      s.activityMonitor.stop = () => { callsOf(s, project).stopSubagents(); stop.call(s.activityMonitor); };
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


  // A PTY session's CLI-state watermarks and Claude session machine. Main drops them on every shell, launch and exit
  // event; keyed by the session itself, a machine fed before the first publish survives that publish.
  function metaOf(s) {
    if (s.cliStateMeta && s.cliStateMeta.sessionId === s.sessionId) return s.cliStateMeta;
    return s.cliStateMeta = { sessionId: s.sessionId, at: 0, events: new Set(), closed: new Set(), turnId: null, requestId: null,
      machine: createSessionMachine({ terminalSession: s.sessionId, claudeSession: s.cliProviderId || s.claudeSessionId || s.claudeResumeId || null, launch: s.activitySince || 0 }),
      // terminal/ipc.cjs reaches the machine through the session it holds, after validating the renderer's facts; a
      // renderer attaching again restarts its frame revisions.
      screenFacts: facts => claudeScreen(s, facts), screenAttached: () => feed(s, { type: 'attach', at: Date.now(), terminalSession: s.sessionId }) };
  }

  // Feeds a signal to the session machine: its effects, or null when the signal changed nothing.
  function feed(s, signal) {
    const meta = metaOf(s), { state, effects } = reduce(meta.machine, signal), changed = state !== meta.machine || effects.length > 0;
    meta.machine = state;
    watchIdle(s, meta);
    return changed ? effects : null;
  }

  // While the screen looks idle in a working turn, a timer asks the machine to confirm it once the quiet has lasted;
  // a newer fact restarts the quiet, and the timer then waits for the rest of it. While the CLI asks something there is
  // nothing to confirm: the next screen fact, once it is answered, starts the watch again.
  function watchIdle(s, meta) {
    const { machine } = meta;
    if (!machine.idleLooking || machine.phase !== 'working' || meta.idleTimer || s.needsInput) return;
    meta.idleTimer = setTimeout(() => {
      meta.idleTimer = null;
      if (deps.sessions.get(s.terminalId) !== s || s.cliStateMeta !== meta) return;
      if (feed(s, { type: 'confirm', at: Date.now(), asking: !!s.needsInput }) && meta.machine.screenIdle) relight(s, `screen-idle:${meta.machine.screenIdleAt}`);
    }, Math.max(0, machine.quietSince + SCREEN_IDLE_MS - Date.now()));
    meta.idleTimer.unref?.();
  }

  // Publishes the turn's light again after the screen changed it, at the newest watermark it already has so no transcript
  // record of the turn is refused for it. The state stays working; cliState.screenIdle says what the light shows.
  function relight(s, eventId) {
    const at = Math.max(metaOf(s).at, s.activitySince || 0, s.activityInputAt || 0);
    deps.publishCliState(s, 'working', { at, eventId: `${s.sessionId}:${eventId}` });
  }

  // CLI interaction is independent of project completion: progress never arms another completion notification.
  function publishCliState(s, state, { at = Date.now(), observedAt = Date.now(), threadId, turnId, requestId, eventId, message: detail, bind = false, progress = false, expectedRevision, newTurn = false } = {}) {
    const { sessions, broadcast } = deps;
    if (!s.sessionId || s.nativeStructured || !s.codexActive || sessions.get(s.terminalId) !== s || !Number.isFinite(at) || !Number.isFinite(observedAt)) return false;
    const meta = metaOf(s), before = s.cliState;
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
    s.dispatchHold = dispatchOf(s);
    // A delayed hook must not outrank a screen drawn after it was sent. Keep publication time monotone in this PTY.
    s.cliState = { sessionId: s.sessionId, revision: s.cliStateRevision,
      updatedAt: Math.max(before?.sessionId === s.sessionId ? before.updatedAt : 0, Math.min(observedAt, Date.now())),
      state, ...(message ? { message } : {}), ...(s.agent === 'claude' ? cliFields(meta.machine, state, backgroundOf(s)) : {}) };
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
    // Nor can a terminal's Claude transcript record the session machine finds late: one dated before its turn ended.
    if (s.agent === 'claude' && !s.nativeStructured && !feed(s, { type: 'record', at: snapshot.updatedAt, state: snapshot.state })) return;
    if (snapshot.ended || ['working', 'complete', 'interrupted'].includes(snapshot.state)) publishCliState(s, snapshot.state === 'working' ? 'working' : 'idle',
      { at: snapshot.updatedAt, threadId: snapshot.threadId, turnId: s.agent === 'codex' ? snapshot.turnId : undefined,
        eventId: `record:${snapshot.threadId}:${snapshot.turnId}:${snapshot.state}:${snapshot.updatedAt}` });
    if (s.completionWork?.reading) { s.codexActivity = 'working'; scheduleState(); return; }
    if (snapshot.ended || ['complete', 'interrupted'].includes(snapshot.state)) {
      s.completionWork?.end(snapshot.updatedAt);
      s.promptQueue.finish?.(snapshot.updatedAt);
    }
    s.activitySnapshot = snapshot;
    const queued = queuedOf(s), held = dispatchOf(s);
    s.dispatchHold = held;
    if (s.cliState && s.agent === 'claude' && !s.nativeStructured) s.cliState = { ...s.cliState, background: backgroundOf(s) };
    const state = s.completionWork?.state(snapshot, { queued, held })
      || fallbackState(s, snapshot, queued, held);
    // A Claude terminal's Stop completes its round only on the session machine's completion effect: the newest prompt's
    // Stop, once the final gate agrees it is complete. Asked with the queue as it stands after this round's finish,
    // and asked again whenever this snapshot is replayed (a typed submission expiring, background work ending), as
    // a held round always was; the snapshot's turn is the completion key, so without the effect nothing is raised.
    if (snapshot.hookStop && s.agent === 'claude' && !s.nativeStructured) {
      const effects = snapshot.state === 'complete'
        ? feed(s, { type: 'settled', at: snapshot.updatedAt, queued, background: backgroundOf(s), blocked: state !== 'complete' }) || [] : [];
      if (!effects.some(effect => effect.type === 'completion')) snapshot = { ...snapshot, turnId: null };
    }
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
  // working, Stop -> complete, StopFailure -> interrupted. SessionStart, always a command -> the conversation Claude writes from now on: after /clear
  // or /resume the reading view follows the new file at once.
  // Notification -> attention while Claude waits for a permission answer in its own screen; that only
  // sets the waiting indicator and never changes the round's lifecycle.
  function claudeActivity(project, s, event) {
    // StopFailure: the turn ended in an API error. It ends the round like a Stop but is an interrupted round, never a
    // completed one, so it disarms the completion alert instead of raising it.
    const failed = event.state === 'failed';
    if (failed) event = { ...event, state: 'complete' };
    const { store, publishCliState, followClaude, applyActivity, refreshClaudeAccounts, promptText, isLocalAgentCommand } = deps;
    if (!s.codexActive || s.agent !== 'claude' || !SIGNALS[event.state]) return;
    if (typeof event.sessionId !== 'string' || !/^[\w-]{1,100}$/.test(event.sessionId) || typeof event.eventId !== 'string' || event.eventId.length > 200) return;
    const at = Number.isFinite(event.sentAt) ? event.sentAt + (project.kind === 'ssh' ? s.activityClockOffset || 0 : 0) : Date.now();
    const bound = s.cliProviderId || s.claudeSessionId || s.claudeResumeId;
    if (at < Math.max(s.activitySince || 0, s.activityInputAt || 0, s.cliStateMeta?.at || 0) || s.cliStateMeta?.events.has(event.eventId)
      || event.state !== 'session' && bound && bound !== event.sessionId) return;
    // Claude Code runs its prompt hooks for automatic turns and some local slash commands (/context, /doctor, /compact)
    // too. Neither is an owner round: an automatic one starts nothing, and a local one opens a screen or prints a line.
    const typed = event.state === 'working' && typeof event.prompt === 'string';
    const human = !typed || promptText(event.prompt, event) !== null, local = typed && isLocalAgentCommand('claude', event.prompt);
    // Every hook names the prompt whose turn it belongs to, and the session machine orders them (session-machine.cjs).
    const before = metaOf(s).machine;
    if (human && !feed(s, { type: SIGNALS[event.state], at, prompt: typeof event.promptId === 'string' ? event.promptId : null, failed, local,
      notice: event.hookEvent === 'Notification', dialog: event.dialog, agent: event.agentId, async: s.hooks?.channel === 'command-async',
      claudeSession: event.sessionId, compact: event.sessionSource === 'compact' })) return;
    const after = metaOf(s).machine;
    const evidence = { at, observedAt: at, threadId: event.sessionId, turnId: event.turnId, requestId: event.requestId, eventId: event.eventId };
    // Hook eventId is an event identity, not a native approval request ID. A different observed event invalidates
    // actions conservatively, even if its message is identical. Duplicate events leave the epoch alone.
    s.approval?.context('claude-event', [event.sessionId, event.eventId, event.state]);
    if (event.state === 'attention') { publishCliState(s, 'waiting', { ...evidence, message: event.message }); return; }
    // A tool hook only releases a matching wait, unless it is a dequeued prompt's first hook or shows that a turn the
    // screen took for idle still runs: then that turn is working.
    const revived = after.phase === 'working' && (before.phase !== 'working' || before.screenIdle);
    if (event.state === 'progress') { publishCliState(s, 'working', { ...evidence, progress: !revived }); return; }
    if (event.state === 'session') {
      if (publishCliState(s, after.phase === 'working' ? 'working' : 'idle', { ...evidence, bind: true })) {
        s.claudeSessionSource = event.sessionSource; followClaude(project, s, event);
      }
      return;
    }
    if (s.usage && project.kind !== 'ssh') void refreshClaudeAccounts();
    if (event.state === 'working') {
      if (!human) return;
      if (local) { publishCliState(s, 'working', evidence); return; }
      if (!publishCliState(s, 'working', evidence)) return;
      // UserPromptSubmit is actual input, unlike a polled working snapshot or a Stop callback.
      if (s.claudePromptEventId !== event.eventId) {
        s.claudePromptEventId = event.eventId;
        if (promptText(event.prompt, event) !== null) {
          s.activityConfirmedInputAt = Math.max(s.activityConfirmedInputAt || 0, at);
          s.activityInputAt = Math.max(s.activityInputAt || 0, s.activityConfirmedInputAt);
          s.completionWork?.begin(); store.expectCompletion(project.id);
        }
      }
    } else if (before.local) { publishCliState(s, 'idle', evidence); return; }
    if (event.state === 'complete' && !publishCliState(s, 'idle', evidence)) return;
    const revision = s.cliState.revision;
    const turnId = event.eventId.slice(event.sessionId.length + 1);
    // Remember the conversation and whether its turn is still open, so a restart can resume it and continue.
    store.setRestore(s.terminalId, { threadId: event.sessionId, interrupted: event.state === 'working' });
    followClaude(project, s, event);
    // A Stop's snapshot is marked so applyActivity asks the session machine whether the round completes (hookStop).
    const stopped = event.state === 'complete' && !failed;
    const snapshot = { threadId: event.sessionId, turnId: stopped ? turnId : null, state: failed ? 'interrupted' : event.state, updatedAt: at,
      prompt: typeof event.prompt === 'string' ? event.prompt.slice(0, 2000) : undefined, ...(stopped ? { hookStop: true } : {}) };
    if (!stopped || !s.activityMonitor) { applyActivity(project, s, snapshot); return; }
    // Stop can beat the last tool-result write. Read it before granting a completion,
    // and let a newer turn/input win if it started while the read was in flight.
    const promptEvent = s.claudePromptEventId;
    void Promise.resolve(s.activityMonitor.poll()).then(() => {
      if (s.agent !== 'claude' || s.cliState?.revision !== revision || s.claudeSessionId && s.claudeSessionId !== event.sessionId || s.claudePromptEventId !== promptEvent || s.activityRawSnapshot?.updatedAt > snapshot.updatedAt) return;
      applyActivity(project, s, { ...snapshot, state: s.completionWork?.turn?.state === 'interrupted' ? 'interrupted' : snapshot.state, transcriptRead: true });
    }).catch(() => {});
  }

  // Screen facts from the renderer (terminal:screenFacts, validated by terminal/ipc.cjs) act only through the machine and
  // only on the light: Esc interrupting a turn runs no hook, so a screen that has looked idle long enough turns the light
  // idle (watchIdle). The round, its completion and every owner action still wait for a Stop, the transcript or Esc.
  function claudeScreen(s, facts) {
    if (deps.sessions.get(s.terminalId) !== s || !s.codexActive || s.agent !== 'claude') return;
    const before = metaOf(s).machine;
    if (feed(s, { ...facts, type: 'screen', at: Date.now(), terminalSession: facts.sessionId }) && before.screenIdle && !metaOf(s).machine.screenIdle) {
      relight(s, `screen:${facts.revision}`);
    }
  }

  // An HTTP hook event (hook-ingest.cjs) as the event claude-hook.ps1 sends over the pipe, which claudeActivity hands to
  // the session machine; sub-agent lifecycles and SessionEnd go to the machine directly. An event that lost its payload
  // to the size limit belongs to the session the terminal follows.
  function claudeHook(hookEvent) {
    const { sessions, store, claudeActivity, callsOf, followClaude } = deps;
    const s = sessions.get(hookEvent.terminalId), project = s && store.projects.find(item => item.id === s.projectId);
    const state = HOOK_STATES[hookEvent.event], { payload } = hookEvent;
    if (!project) return;
    const sessionId = hookEvent.sessionId || s.claudeSessionId || '';
    const message = payload.tool_name === 'SendMessage' && !hookEvent.agentId;
    const receipt = !hookEvent.agentId && hookEvent.toolUseId && ['PostToolUse', 'PostToolUseFailure', 'PermissionDenied'].includes(hookEvent.event);
    const kind = hookEvent.event === 'SubagentStart' ? 'start' : hookEvent.event === 'SubagentStop' ? 'stop'
      : !(hookEvent.event === 'PreToolUse' && message) ? null : 'continue';
    const current = s.codexActive && s.agent === 'claude' && /^[\w-]{1,100}$/.test(sessionId)
      && sessionId === (s.cliProviderId || s.claudeSessionId || s.claudeResumeId || sessionId) && hookEvent.at >= (s.activitySince || 0);
    if (current && receipt) callsOf(s, project).finishContinuation(hookEvent.toolUseId, hookEvent.at, hookEvent.event !== 'PostToolUse');
    const agentId = kind === 'continue' ? payload.tool_input?.to || payload.tool_input?.recipient : hookEvent.agentId;
    if (current && kind && /^[\w-]{1,100}$/.test(typeof agentId === 'string' ? agentId : '')) {
      // Bind the parent folder before delivering the signal: changing it resets the old transcript's tracker.
      if (hookEvent.transcriptPath) followClaude(project, s, { sessionId, transcriptPath: hookEvent.transcriptPath });
      const signal = { kind, terminalId: s.terminalId, agentId, agentType: payload.agent_type || '',
        transcriptPath: typeof payload.agent_transcript_path === 'string' ? payload.agent_transcript_path : null,
        toolUseId: hookEvent.toolUseId || null, at: hookEvent.at };
      // Claude Code runs these hooks for its internal helper agents too: the run board holds a call no tool call names.
      for (const effect of feed(s, { type: 'subagent', at: hookEvent.at, claudeSession: sessionId, signal }) || []) callsOf(s, project).subagent(effect.signal, true);
    }
    if (current && hookEvent.event === 'SessionEnd') { feed(s, { type: 'end', at: hookEvent.at, claudeSession: sessionId }); return; }
    if (!state || hookEvent.event === 'Notification' && !ATTENTION_NOTICES.includes(payload.notification_type)) return;
    const question = hookEvent.event === 'Elicitation' || /^elicitation/.test(payload.notification_type || '');
    claudeActivity(project, s, { state, sessionId, eventId: `${sessionId}:${hookEvent.at}-${hookEvent.seq}`, sentAt: hookEvent.at,
      hookEvent: hookEvent.event, transcriptPath: hookEvent.transcriptPath, promptId: hookEvent.promptId, agentId: hookEvent.agentId,
      message: state === 'attention' ? String(payload.message ?? payload.tool_name ?? '').slice(0, 300) : null,
      ...(state === 'attention' ? { dialog: question ? 'question' : 'permission' } : {}),
      prompt: state === 'working' && payload.prompt ? payload.prompt : null,
      ...(hookEvent.toolUseId ? { requestId: hookEvent.toolUseId } : {}) });
  }

  return { followClaude, followClaudeSession, publishCliState, applyActivity, replayCompletion, claudeActivity, claudeHook };
}

module.exports = { createClaudeActivity };
