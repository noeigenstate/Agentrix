const fs = require('node:fs');

// The terminal side of a run-mode switch: the local Claude terminals a switch can take over, what each one is doing,
// the terminal a switch to it stages, and retiring or replacing the terminal when the switch ends. `deps` is the app
// shell (main.cjs), read on every call so its late values are current; these functions are among its members and
// reach each other through it too. A closure a call leaves behind (a staged switch's cancel, send and commit) keeps
// the members that call read.
function createSwitchHost(deps) {
  function localSwitchSessions() {
    const { sessions, store, randomUUID } = deps;
    const result = [];
    for (const [id, current] of sessions) {
      const s = current.switchPreviousHost || current, project = store.findTerminal(id)?.project;
      if (!project || project.kind === 'ssh' || !s.codexActive || s.nativeStructured || s.status === 'exited' || s.agent !== 'claude') continue;
      s.nativeRuntimeSessionId ||= randomUUID();
      const providerSessionId = s.claudeSessionId || s.claudeResumeId || null;
      result.push({ identity: s, path: 'terminal', spec: { owner: 'gui', agent: s.agent, kind: project.kind,
        projectId: project.id, terminalId: id, runtimeSessionId: s.nativeRuntimeSessionId, providerSessionId,
        sessionId: s.sessionId, skillSessionId: s.skillSessionId, sessionKey: s.sessionKey, controlCapability: s.controlCapability, bootstrapFile: s.bootstrapFile,
        cwd: store.findTerminal(id)?.record.restore?.cwd || project.path, env: s.usageEnv, context: s.skillNote || '',
        hasHistory: s.conversation?.list.some(entry => ['user', 'assistant'].includes(entry.role)) } });
    }
    return result;
  }
  function observeSwitchTerminal(session) {
    const s = session.identity;
    const work = s.completionWork;
    const tasks = new Set([...(work?.tasks?.values() || [])].map(task => task.id));
    for (const id of work?.services || []) tasks.add(id);
    for (const call of s.calls?.running?.() || []) tasks.add(call.id);
    // A fresh CLI does not create its transcript until the first prompt. ENOENT here is an empty observation,
    // whereas unreadable history, a resumed thread or a failed reader must still remain unknown.
    const empty = s.agent === 'claude' && s.claudeSessionSource === 'startup' && s.claudeTranscript?.missing === true
      && !s.claudeResumeId && !session.spec?.hasHistory && !s.activityInputAt;
    return { state: s.cliState?.sessionId === s.sessionId && s.cliState.state === 'idle' ? 'idle' : 'working',
      pending: !!s.nativeInputRequests?.size || s.promptQueue?.list().some(item => item.state === 'queued'),
      draftBlocked: !!s.submissions?.hasText,
      background: !work || work.uncertain || work.reading && !empty ? { known: false, count: null } : { known: true, count: tasks.size } };
  }
  function retainAgentState(target, source) {
    const { sessions, findProject, applyActivity, scheduleState } = deps;
    target.plannerSessionId = source.plannerSessionId || source.sessionId;
    target.switchBootstrapFiles = [...new Set([...(source.switchBootstrapFiles || []), source.bootstrapFile].filter(file => file && file !== target.bootstrapFile))];
    for (const key of ['sessionKey', 'controlCapability', 'calls', 'completionWork', 'promptQueue', 'lastCompletedAt', 'lastTask', 'lastTaskSummary', 'lastTaskTitle',
      'activityInputAt', 'activityConfirmedInputAt', 'activityPromptAt', 'claudePromptEventId', 'nativeMessages', 'switchState']) {
      if (source[key] !== undefined) target[key] = source[key];
    }
    target.completionWork.changed = () => {
      if (sessions.get(target.terminalId) === target && target.codexActive && target.activitySnapshot) applyActivity(findProject(target.terminalId), target, target.activitySnapshot);
    };
    target.promptQueue.changed = expired => {
      if (sessions.get(target.terminalId) !== target) return;
      if (expired?.length) target.activityInputAt = Math.max(target.activityConfirmedInputAt || 0, ...target.promptQueue.items.map(item => item.at));
      scheduleState();
    };
  }
  async function prepareSwitchTerminal(spec, _handoff, currentChange, transition = {}) {
    const { sessions, store, nativeSpecs, launchPlans, launchCommand, startTerminal, disposeTerminal, broadcast, terminalInput, retainAgentState } = deps;
    const id = spec.terminalId, old = sessions.get(id);
    if (!old?.nativeStructured || spec.agent !== 'claude') throw new Error('session_changed');
    sessions.delete(id);
    launchPlans.set(id, { agent: spec.agent, command: launchCommand(spec.agent, spec.providerSessionId ? { id: spec.providerSessionId } : null), threadId: spec.providerSessionId });
    let staged;
    const cancel = () => {
      const owned = staged && sessions.get(id) === staged;
      if (owned) disposeTerminal(id, { preserveSwitch: true });
      launchPlans.delete(id);
      if ((owned || !staged && currentChange()) && store.findTerminal(id)) { sessions.set(id, old); nativeSpecs.set(id, old.nativeSpec); }
      broadcast();
    };
    try {
      startTerminal(id, true, old); staged = sessions.get(id);
      staged.nativeRuntimeSessionId = spec.runtimeSessionId;
      Object.assign(spec, { sessionId: staged.sessionId, bootstrapFile: staged.bootstrapFile, env: staged.usageEnv || spec.env });
      // OS/shell cold starts have no reliable wall-clock limit. Keep the source
      // surface until the same CLI is ready; closing or changing the switch
      // cancels this wait and disposes only the staged PTY.
      while (currentChange() && sessions.get(id) === staged && staged.status !== 'exited') {
        if (staged.error) throw new Error('terminal_start_failed');
        if (staged.status === 'shell' && staged.ready && !staged.agentStarting && !launchPlans.has(id)) throw new Error('terminal_agent_exited');
        const provider = staged.claudeSessionId;
        const ready = staged.cliState?.state === 'idle';
        if (provider && ready) {
          if (spec.providerSessionId && provider !== spec.providerSessionId) throw new Error('terminal_resume_identity_mismatch');
          spec.providerSessionId = provider; break;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (!currentChange() || sessions.get(id) !== staged || staged.status === 'exited') throw new Error('session_changed');
      return { session: { identity: staged, path: 'terminal', spec }, cancel,
        async send(input) {
          const tracker = staged.submissions;
          if (!terminalInput || spec.agent !== 'claude' || sessions.get(id) !== staged || !currentChange()
            || staged.cliState?.state !== 'idle' || !tracker || tracker.hasText || tracker.history || tracker.pasting
            || !input.text || input.text.length > 4000 || /^[!/]/.test(input.text) || /[\x00-\x08\x0b-\x1f\x7f]/.test(input.text)) return { status: 'rejected' };
          // Reuse the tracked terminal input path. Never clear or overwrite a CLI draft.
          terminalInput.write(id, `\x1b[200~${input.text}\x1b[201~`);
          await new Promise(resolve => setTimeout(resolve, 400));
          if (sessions.get(id) !== staged || !currentChange() || staged.cliState?.state !== 'idle' || tracker.history
            || tracker.text !== input.text) return { status: 'unknown' };
          terminalInput.write(id, '\r');
          return { status: 'delivered' };
        },
        commit() {
          store.setRestore(id, { terminal: true, codex: true, agent: spec.agent, threadId: spec.providerSessionId, nativeTransport: null });
          retainAgentState(staged, old); delete staged.switchPreviousHost; staged.nativeRuntimeSessionId = spec.runtimeSessionId; broadcast();
          if (transition.discardBackground) staged.completionWork?.discardBackground?.();
        } };
    } catch (error) { cancel(); throw error; }
  }
  function retireTerminal(session, reason) {
    const { sessions, store, broadcast } = deps;
    const host = sessions.get(session.spec.terminalId);
    if (host !== session.identity) return;
    host.status = 'exited'; host.codexActive = false; host.nativePathReason = reason;
    store.setRestore(session.spec.terminalId, { codex: false }); broadcast();
  }
  function activateNative(spec, _handoff, transition = {}) {
    const { sessions, nativeSpecs, observeSwitchTerminal, disposeTerminal, writeBootstrap, eventServer, controlAddress, nativeEnvironment } = deps;
    const old = sessions.get(spec.terminalId);
    if (transition.newConversation) {
      if (!old?.nativeStructured) throw new Error('session_changed');
      spec.switchHost = old; nativeSpecs.set(spec.terminalId, spec); return;
    }
    if (!old || old.sessionId !== spec.sessionId || !transition.recovering && observeSwitchTerminal({ identity: old }).draftBlocked) throw new Error('session_changed');
    if (spec.bootstrapFile && !fs.existsSync(spec.bootstrapFile)) writeBootstrap({ file: spec.bootstrapFile, eventServer, projectId: spec.terminalId,
      projectPath: spec.cwd, sessionKey: spec.sessionKey, controlAddress, controlCapability: spec.controlCapability });
    // The same env as a native session started directly: a planner's with the shims, and the owner's for ! commands.
    if (spec.bootstrapFile) Object.assign(spec, { env: nativeEnvironment(spec.bootstrapFile), shellEnv: nativeEnvironment(spec.bootstrapFile, null, { planner: false }) });
    spec.switchHost = old; disposeTerminal(spec.terminalId, { preserveSwitch: true }); nativeSpecs.set(spec.terminalId, spec);
    if (transition.discardBackground) old.completionWork?.discardBackground?.();
  }

  return { localSwitchSessions, observeSwitchTerminal, retainAgentState, prepareSwitchTerminal, retireTerminal, activateNative };
}

module.exports = { createSwitchHost };
