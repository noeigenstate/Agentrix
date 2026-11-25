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
  function publishAction(s, change) {
    const { sessions, scheduleState, skills, findProject } = host;
    if (sessions.get(s.terminalId) !== s) return;
    scheduleState();
    // Only a successful tool result proves a read; round settlement/idle callbacks do not.
    if (change?.finished) skills?.recordAction(change.action, { cwd: s.actionsCwd || findProject(s.terminalId).path, project: s.projectId,
      agent: s.agent, since: s.activitySince || 0, clockOffset: s.activityClockOffset || 0, remotePaths: s.terminal.info?.skills || null });
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
    const { skills, findProject, skillDescription } = host;
    s.actionsCwd = cwd;
    for (const action of actions || []) {
      if (action.kind !== 'skill') continue;
      const skill = skills?.matchFile(action.skillFile, action.cwd || cwd, s.projectId, s.terminal.info?.skills || null);
      if (skill) { action.description = skill.description; s.actions.update(action); continue; }
      if (findProject(s.terminalId).kind === 'ssh') continue;
      skillDescription(action.target, cwd, action.skillFile).then(description => { if (description) { action.description = description; s.actions.update(action); } }).catch(() => {});
    }
  }
  function startSkillSession(project, s, sequence, started = true) {
    const { skills, randomUUID, path, startupNote, startupNoteFields, READING_NOTE, handoffFile, writeFileAtomic, report } = host;
    skills.endSession(project.id, s.skillSessionId);
    s.skillSessionId = randomUUID();
    const remote = project.kind === 'ssh';
    const delivery = skills.delivery(project, remote, s.skillSessionId, { agent: s.agent, started });
    if (remote) {
      const note = startupNote(READING_NOTE, '{AGENTRIX_HANDOFF}', path.posix.join(project.path, 'skills'), delivery, '{AGENTRIX_DISPATCH}');
      void s.terminal.request('skill-note', { sequence, note, skills: delivery.bundle }).then(paths => {
        if (s.terminal.info) s.terminal.info.skills = paths;
      }).catch(report);
    } else {
      const note = startupNoteFields(READING_NOTE, handoffFile(s.terminalId), path.join(project.path, 'skills'), delivery);
      writeFileAtomic(s.skillNoteFile, note.full);
      if (s.bootstrapFile) writeFileAtomic(s.bootstrapFile + '.launch-note', note.launch);
      s.skillNote = note.full;
    }
  }

  function endSkillSession(s) {
    const { skills } = host;
    skills.endSession(s.projectId, s.skillSessionId);
    s.skillSessionId = null;
  }

  // Wrappers reread idle shells' notes. Running agents keep the note actually delivered at their launch.
  function refreshSkillNotes() {
    const { sessions, store, nativeSessions, skills, report, refreshRemoteRouting, tellRemoteRouting, send, t,
        updateDispatchSeats, updateBootstrapMode, tellMode, adapterOf, updateBootstrapLead, startupNoteFields, READING_NOTE, handoffFile, path, writeFileAtomic } = host;
    const remoteWrites = [];
    for (const s of sessions.values()) {
      if (s.status === 'exited') continue;
      const project = store.projects.find(project => project.id === s.projectId);
      if (!project) continue;
      const lead = s.nativeStructured && nativeSessions && skills.leadOptions(project.id, s.agent);
      // A running terminal conductor reads its seats once; a change rides its next prompt, as a mode switch does.
      if (!s.nativeStructured && s.agent === 'claude' && s.cliActive && project.kind !== 'ssh') {
        const change = skills.routingChange(project.id, s.sessionId, s.toldSeats);
        if (change) { s.toldSeats = change.table; s.routingNote = change.note; }
      }
      if (lead) nativeSessions.applyRouting(s.terminalId, { model: lead.model, effort: lead.effort, fast: lead.fast === true }).catch(report);
      if (project.kind === 'ssh') {
        const remote = s.remoteConnection || s.terminal;
        if (remote?.request && !remote.closed) {
          const lead = s.nativeStructured ? null : skills.terminalLead(project.id, { remote: true });
          const routing = skills.seatsInfo(project.id);
          const refresh = { ...(lead ?? { seatsMap: skills.dispatchSeats(project.id) ?? {} }), conductor: routing?.conductor === true };
          const update = refreshRemoteRouting(remote, refresh, routing, {
            bound: () => sessions.get(s.terminalId) === s && (s.remoteConnection || s.terminal) === remote,
            changed: modeChanged => { tellRemoteRouting(s, project, remote, modeChanged); send('skills:changed', skills.infos()); },
            failed: () => report(new Error(t('远程请求失败。'))),
          });
          if (update) remoteWrites.push(update);
        }
        continue;
      }
      if (s.bootstrapFile) {
        try {
          updateDispatchSeats(s.bootstrapFile, skills.dispatchSeats(project.id) ?? {});
          if (updateBootstrapMode(s.bootstrapFile, skills.seatsInfo(project.id)?.conductor) && s.cliActive) tellMode(s, project);
        } catch (error) { report(error); }
        if (s.skillNoteFile || lead && adapterOf(s.agent)?.terminal?.hookSession) {
          try { updateBootstrapLead(s.bootstrapFile, s.nativeStructured ? lead : skills.terminalLead(project.id)); } catch (error) { report(error); }
        }
      }
      if (!s.skillNoteFile || s.cliActive) continue;
      const note = startupNoteFields(READING_NOTE, handoffFile(s.terminalId), path.join(project.path, 'skills'),
        skills.delivery(project, false, s.sessionId, { agent: 'claude' }));
      if (note.full !== s.skillNote) {
        writeFileAtomic(s.skillNoteFile, note.full);
        if (s.bootstrapFile) writeFileAtomic(s.bootstrapFile + '.launch-note', note.launch);
        s.skillNote = note.full;
      }
    }
    return remoteWrites.length ? Promise.allSettled(remoteWrites) : null;
  }

  return { prepareReading, publishAction, publishConversation, readEvery, describeActions, startSkillSession, endSkillSession, refreshSkillNotes };
}

module.exports = { createSessionPresentation };
