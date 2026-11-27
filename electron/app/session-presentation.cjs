const { remoteGuide } = require('../features/routing/store.cjs');
const { conversationBatchDelay } = require('../conversation-timing.cjs');

function createSessionPresentation(host) {
  function prepareReading(id, restore, filename) {
    const { findProject, adapterOf, sessions, readingHistory, store } = host;
    const project = findProject(id);
    const transcript = adapterOf(restore?.agent)?.transcript, session = sessions.get(id);
    if (project.kind === 'ssh' || !transcript || !/^[\w-]{1,100}$/.test(restore?.threadId || '')) return Promise.resolve();
    return readingHistory.bind(id, { agent: restore.agent, threadId: restore.threadId,
      cwd: session?.agentCwd || restore.cwd || store.findTerminal(id)?.record.restore?.cwd || project.path,
      home: transcript.terminalHome?.(session) ?? transcript.home(), filename });
  }
  // A step that starts or ends changes the card's one-line status.
  function publishAction(s) {
    const { sessions, scheduleState } = host;
    if (sessions.get(s.terminalId) !== s) return;
    scheduleState();
  }
  // The conversation for the reading view reaches the window in small batches.
  function publishConversation(s, change) {
    const { sessions, readingHistory, send, setTimeout = globalThis.setTimeout, clearTimeout = globalThis.clearTimeout } = host;
    if (sessions.get(s.terminalId) !== s || s.conversation.loading) return;
    (s.conversationChanges ||= []).push(change);
    const delay = conversationBatchDelay(s.conversationChanges);
    if (s.conversationTimer && s.conversationDelay === delay) return;
    clearTimeout(s.conversationTimer); s.conversationDelay = delay;
    s.conversationTimer = setTimeout(() => {
      const changes = s.conversationChanges; s.conversationChanges = []; s.conversationTimer = null; s.conversationDelay = null;
      if (sessions.get(s.terminalId) !== s || s.conversation.loading) return;
      // An answer streamed word by word puts the same entry many times in one batch: only its latest version goes.
      const latest = new Map();
      for (const item of changes) if (item.entry) latest.set(item.entry.id, item.entry);
      const scope = { id: s.terminalId, sessionId: s.sessionId, historyKey: readingHistory.summary(s.terminalId)?.key };
      send('terminal:conversation', latest.size > 40 || changes.some(item => item.reset) ? { ...scope, list: s.conversation.snapshot() } : { ...scope, changes: [...latest.values()] });
    }, delay);
  }
  // How often an agent's records are read when nothing told of a write: often while it works, so the reading view keeps
  // up with it (and over SSH, where no write is told), seldom while it waits.
  const readEvery = s => s.codexActivity === 'working' ? 250 : 1000;
  // A skill step names the skill; what the skill is for comes from its SKILL.md, a moment later.
  function describeActions(s, cwd, actions) {
    const { findProject, skillDescription } = host;
    for (const action of actions || []) {
      if (action.kind !== 'skill') continue;
      if (findProject(s.terminalId).kind === 'ssh') continue;
      skillDescription(action.target, cwd, action.skillFile).then(description => { if (description) { action.description = description; s.actions.update(action); } }).catch(() => {});
    }
  }
  function startSkillSession(project, s, sequence, started = true) {
    const { routing, randomUUID, path, startupNote, READING_NOTE, handoffFile, writeFileAtomic, report } = host;
    routing.endSession(project.id, s.skillSessionId);
    s.skillSessionId = randomUUID();
    const remote = project.kind === 'ssh';
    const launch = routing.launch(project, remote, s.skillSessionId, { agent: s.agent, started });
    if (remote) {
      const note = startupNote(READING_NOTE, '{AGENTRIX_HANDOFF}', path.posix.join(project.path, 'skills'), launch, '{AGENTRIX_DISPATCH}');
      void s.terminal.request('launch-note', { sequence, note, guide: remoteGuide(launch.guide) }).catch(report);
    } else {
      const note = startupNote(READING_NOTE, handoffFile(s.terminalId), path.join(project.path, 'skills'), launch);
      writeFileAtomic(s.skillNoteFile, note);
      s.skillNote = note;
    }
  }

  function endSkillSession(s) {
    const { routing } = host;
    routing.endSession(s.projectId, s.skillSessionId);
    s.skillSessionId = null;
  }

  // Wrappers reread idle shells' notes. Running agents keep the note actually delivered at their launch.
  function refreshRoutingNotes() {
    const { sessions, store, nativeSessions, routing, report, refreshRemoteRouting, tellRemoteRouting, send, t,
        updateDispatchSeats, updateBootstrapMode, tellMode, adapterOf, updateBootstrapLead, startupNote, READING_NOTE, handoffFile, path, writeFileAtomic } = host;
    const remoteWrites = [];
    for (const s of sessions.values()) {
      if (s.status === 'exited') continue;
      const project = store.projects.find(project => project.id === s.projectId);
      if (!project) continue;
      const remoteSeat = project.kind === 'ssh' && adapterOf(s.agent)?.nativePolicy?.rememberModelOptions;
      const lead = s.nativeStructured && nativeSessions && routing.leadOptions(project.id, s.agent, { remote: !!remoteSeat });
      // A running terminal conductor reads its seats once; a change rides its next prompt, as a mode switch does.
      if (!s.nativeStructured && s.agent === 'claude' && s.cliActive && project.kind !== 'ssh') {
        const change = routing.routingChange(project.id, s.skillSessionId || s.sessionId, s.toldSeats);
        if (change) { s.toldSeats = change.table; s.routingNote = change.note; }
      }
      if (lead) nativeSessions.applyRouting(s.terminalId, { model: lead.model, effort: lead.effort, fast: lead.fast === true }).catch(report);
      if (project.kind === 'ssh') {
        const remote = s.remoteConnection || s.terminal;
        if (remote?.request && !remote.closed) {
          const lead = s.nativeStructured ? null : routing.terminalLead(project.id, { remote: true });
          const info = routing.seatsInfo(project.id);
          const refresh = { ...(lead ?? { seatsMap: routing.dispatchSeats(project.id) ?? {} }), conductor: info?.conductor === true };
          const update = refreshRemoteRouting(remote, refresh, info, {
            bound: () => sessions.get(s.terminalId) === s && (s.remoteConnection || s.terminal) === remote,
            changed: modeChanged => { tellRemoteRouting(s, project, remote, modeChanged); send('routing:changed'); },
            failed: () => report(new Error(t('远程请求失败。'))),
          });
          if (update) remoteWrites.push(update);
        }
        continue;
      }
      if (s.bootstrapFile) {
        try {
          updateDispatchSeats(s.bootstrapFile, routing.dispatchSeats(project.id) ?? {});
          if (updateBootstrapMode(s.bootstrapFile, routing.seatsInfo(project.id)?.conductor) && s.cliActive) tellMode(s, project);
        } catch (error) { report(error); }
        if (s.skillNoteFile || lead && adapterOf(s.agent)?.terminal?.hookSession) {
          try { updateBootstrapLead(s.bootstrapFile, s.nativeStructured ? lead : routing.terminalLead(project.id)); } catch (error) { report(error); }
        }
      }
      if (!s.skillNoteFile || s.cliActive) continue;
      const note = startupNote(READING_NOTE, handoffFile(s.terminalId), path.join(project.path, 'skills'),
        routing.launch(project, false, s.sessionId, { agent: 'claude' }));
      if (note !== s.skillNote) {
        writeFileAtomic(s.skillNoteFile, note);
        s.skillNote = note;
      }
    }
    return remoteWrites.length ? Promise.allSettled(remoteWrites) : null;
  }

  return { prepareReading, publishAction, publishConversation, readEvery, describeActions, startSkillSession, endSkillSession, refreshRoutingNotes };
}

module.exports = { createSessionPresentation };
