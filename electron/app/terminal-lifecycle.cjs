const { remoteGuide } = require('../features/routing/store.cjs');
function createCloseGuards({ app, dialog, getWindow, sessions, findProject, allowEditorClose, t, setQuitting }) {
  const liveTerminalCount = () => [...sessions.values()].filter(s => s.status !== 'exited').length;
  // always: ask even with nothing running (removing a project by its shortcut).
  async function confirmTerminalClose(id, verb, all = false, always = false) {
    const project = findProject(id);
    const chosen = all ? [...sessions.values()].filter(item => item.projectId === project.id) : [sessions.get(id)].filter(Boolean);
    const count = chosen.filter(item => item.status !== 'exited').length;
    if (!count && !always) return true;
    const result = await dialog.showMessageBox(getWindow(), {
      type: 'question', title: t(`${verb}${all ? '项目' : '终端'}`),
      message: count ? t('{verb}“{name}”的 {count} 个终端？', { verb: t(verb), name: project.name, count }) : t('移除项目“{name}”？', { name: project.name }),
      detail: count ? t('所选终端内的 Codex 和其他运行中的命令会被结束。项目文件会保留。') : t('项目文件会保留，以后可以重新添加。'),
      buttons: [t('取消'), t(`确认${verb}`)], defaultId: 0, cancelId: 0,
    });
    return result.response === 1;
  }

  let quitRequest;
  function requestQuit() {
    return quitRequest ??= confirmQuit().finally(() => { quitRequest = null; });
  }

  async function confirmQuit() {
    if (!await allowEditorClose()) return false;
    const count = liveTerminalCount();
    if (count) {
      const result = await dialog.showMessageBox(getWindow(), {
        type: 'question', message: t('退出并关闭 {count} 个终端？', { count }),
        detail: t('运行中的任务会被结束。若要让任务继续，请最小化窗口或关闭到系统托盘。'),
        buttons: [t('继续运行'), t('退出应用')], defaultId: 0, cancelId: 0,
      });
      if (result.response !== 1) return false;
    }
    setQuitting(true);
    app.quit();
    return true;
  }
  return { confirmTerminalClose, requestQuit, liveTerminalCount };
}

function restoreTerminals({ store, restorePlans, startupErrors, startTerminal, broadcast, isQuitting }) {
  if (!store.settings.restoreSessions || process.env.AGENTRIX_DATA_DIR && process.env.AGENTRIX_TEST_RESTORE !== '1') return;
  const terminals = store.projects.flatMap(project => [project, ...(project.terminals || [])].filter(record => record.restore === null || record.restore?.terminal));
  terminals.forEach((record, index) => {
    if (record.restore === null || record.restore.codex) restorePlans.set(record.id, { codex: record.restore?.codex === true, cwd: record.restore?.cwd });
    const timer = setTimeout(() => {
      if (isQuitting() || !store.settings.restoreSessions || !store.findTerminal(record.id) || record.restore?.terminal === false) return;
      try { startTerminal(record.id); } catch (error) { restorePlans.delete(record.id); startupErrors.set(record.id, error.message); broadcast(); }
    }, index * 300);
    timer.unref?.();
  });
}

function launchAfterPrompt(project, session, { launchPlans, t, broadcast, followClaudeSession }) {
  const plan = launchPlans.get(session.terminalId);
  if (!plan || !session.ready || session.inputDirty || session.cliActive) return;
  launchPlans.delete(session.terminalId);
  if (!session.claudeAvailable) {
    session.error = project.kind === 'ssh' ? t('远端主机上没有找到 Claude Code。请在该主机上安装，并确保它在 PATH 中。')
      : t('没有找到 {agent}，请在设置 › 编码助手中安装。', { agent: 'Claude Code' });
    broadcast(); return;
  }
  session.ready = false;
  if (plan.threadId) { session.claudeResumeId = plan.threadId; void followClaudeSession(project, session, plan.threadId); }
  if (project.kind === 'ssh') session.gate.input(plan.command); else session.gate.afterPrompt(plan.command);
  broadcast();
}

const startupWait = ms => new Promise(resolve => setTimeout(resolve, ms));

function applyFastHookSettings(hooks, env) {
  if (hooks) {
    hooks.fastSettings = Object.fromEntries(Object.entries(hooks.settings).map(([channel, text]) =>
      [channel, JSON.stringify({ ...JSON.parse(text), fastMode: true })]));
    env.AGENTRIX_FAST_HOOK_SETTINGS = hooks.fastSettings.http;
    env.AGENTRIX_FAST_HOOK_FALLBACK = hooks.fastSettings.fallback;
  }
}

// A restored local terminal is told the Claude Code and the Codex to run: both first looks are waited for, at most three seconds.
function firstLooksSettled(deps, wait = startupWait) { return Promise.race([Promise.all([deps.claudeFirst, deps.codexFirst]), wait(3000)]); }

function launchInitialAgent(deps, project, session) {
  launchAfterPrompt(project, session, { launchPlans: deps.launchPlans, t: deps.t, broadcast: deps.broadcast, followClaudeSession: deps.followClaudeSession });
}

async function resumeAfterPrompt(deps, project, session) {
  const plan = deps.restorePlans.get(session.terminalId);
  if (!plan || !session.ready) return;
  deps.restorePlans.delete(session.terminalId);
  session.agentStarting = true;
  try {
    if (session.inputDirty) return;
    const restore = deps.store.findTerminal(session.terminalId)?.record.restore;
    // Claude Code resumes its own conversation, here or on the terminal's SSH channel.
    if (restore?.agent === 'claude') {
      if (!session.claudeAvailable || !plan.codex) return;
      const command = deps.claudeResumeCommand(restore);
      if (deps.sessions.get(session.terminalId) !== session || !session.ready || session.inputDirty || session.cliActive) return;
      deps.store.expectCompletion(project.id, restore.interrupted === true);
      session.ready = false;
      session.claudeResumeId = restore.threadId || null;
      if (project.kind === 'ssh') session.gate.input(command); else session.gate.afterPrompt(command);
      // Remote SessionStart hooks bind the server transcript; never search this computer for that path.
      if (restore.threadId && project.kind !== 'ssh') await deps.followClaudeSession(project, session, restore.threadId);
      deps.broadcast();
      return;
    }
    // Codex restoration belongs to restoreTerminal, before a shell is created.

  } catch (error) { session.error = `恢复会话失败：${error.message}`; deps.broadcast(); }
  finally {
    if (deps.sessions.get(session.terminalId) === session && session.ready) { session.agentStarting = false; deps.readingHistory.close(session.terminalId); deps.broadcast(); }
  }
}

function remoteFor(deps, id) {
  const project = deps.findProject(id);
  const channel = session => session.remoteConnection || session.terminal;
  const session = channel(deps.sessions.get(id) || {})?.connected ? deps.sessions.get(id) : [...deps.sessions.values()].find(item => item.projectId === project.id && channel(item)?.connected);
  if (project.kind !== 'ssh' || !session || channel(session).closed) throw new Error('请先启动终端，连接 SSH 服务器。');
  return channel(session);
}

// New local terminals use the chosen shell: Bash by default on macOS, the login shell's kind on Linux,
// PowerShell or Command Prompt on Windows.
// Recheck macOS and Linux shells when a terminal starts, so one installed meanwhile is used.
function localShell(deps, shellCache, fresh = false) {
  const process = deps.process || globalThis.process;
  if (!['darwin', 'linux'].includes(process.platform)) return { kind: deps.store.settings.shell === 'cmd' ? 'cmd' : 'powershell', file: null };
  if (fresh || shellCache.current?.choice !== deps.store.settings.shell) {
    const choose = process.platform === 'darwin' ? deps.macShell : deps.linuxShell;
    shellCache.current = { ...choose(deps.store.settings.shell), choice: deps.store.settings.shell };
  }
  return shellCache.current;
}

function restoreTerminal(deps, id) {
  const found = deps.store.findTerminal(id), saved = found?.record.restore;
  const agent = saved?.agent || deps.legacyRestoreAgent, nativePolicy = deps.adapterOf(agent)?.nativePolicy;
  const legacyNative = nativePolicy?.restoreWithoutNative && (saved?.codex || saved?.nativeTransport);
  if (legacyNative || saved?.nativeTransport && deps.nativeSessions) {
    if (found) terminalStartPath(deps, found.project, id);
    deps.restorePlans.delete(id);
    if (!deps.nativeSessions) throw new Error(nativePolicy.restoreWithoutNative);
    const interrupted = saved.interrupted === true;
    return deps.nativeSessions.start(id, { agent, resume: !!saved.threadId }).catch(error => {
      deps.startupErrors.set(id, error.message); deps.broadcast();
    }).then(async opened => {
      if (!opened) return opened;
      if (nativePolicy?.canContinueInterrupted && saved.threadId && interrupted) {
        try { await deps.nativeSessions.continueInterrupted(id, opened.runtimeSessionId, () => deps.store.setRestore(id, { interrupted: false })); }
        catch (error) { deps.report(error); }
      }
      return opened;
    });
  }
  deps.startTerminal(id);
}

function terminalStartPath(deps, project, id) {
  const plan = deps.restorePlans.get(id);
  const saved = deps.store.findTerminal(id)?.record.restore?.cwd;
  const startPath = plan?.cwd || saved || project.path;
  if (project.kind === 'ssh' || startPath === project.path) return startPath;
  try {
    if (deps.fs.statSync(startPath, { throwIfNoEntry: false })?.isDirectory()) return startPath;
  } catch (error) { if (error.code !== 'ENOTDIR') throw error; }
  if (plan) delete plan.cwd;
  deps.store.setRestore(id, { cwd: null });
  return project.path;
}

function startTerminal(deps, shellCache, id, agentStarting = false, transfer = null) {
  const process = deps.process || globalThis.process;
  const project = deps.findProject(id);
  const old = deps.sessions.get(id);
  if (old && old.status !== 'exited') return;
  if (old) disposeTerminal(deps, id, { preserveCalls: true });
  if (!['win32', 'darwin', 'linux'].includes(process.platform)) throw new Error('此版本的终端集成面向 Windows 10/11、macOS 和 Linux。');
  if (project.kind !== 'ssh' && !deps.fs.existsSync(project.path)) throw new Error('项目目录不存在，请重新添加。');
  const sessionId = deps.randomUUID();
  const sessionKey = transfer?.sessionKey || deps.randomUUID();
  const controlCapability = transfer?.controlCapability || deps.randomUUID();
  const startPath = terminalStartPath(deps, project, id);
  // Local terminals use the shell chosen in settings; SSH projects always run Bash on the server.
  const shell = project.kind === 'ssh' ? { kind: 'bash', file: null } : localShell(deps, shellCache, true), shellKind = shell.kind;
  const bootstrapFile = project.kind !== 'ssh' ? deps.path.join(deps.runtimeDir, `${id}.json`) : null;
  const skillNoteFile = project.kind === 'ssh' ? null : deps.path.join(deps.runtimeDir, `${sessionId}-skills.txt`);
  const env = deps.createTerminalEnvironment(deps.withoutAppImage(process.env), bootstrapFile || '', { allowBackgroundTasks: deps.store.settings?.claudeBackgroundTasks });
  // How this terminal's Claude Code reports to main (hook-channel.cjs): HTTP hooks, or command hooks behind a proxy.
  const claudeHookPath = deps.path.join(deps.integrationDir, 'claude-hook.ps1');
  const hooks = bootstrapFile && deps.terminalHooks({ port: deps.hookServer?.port, terminalId: id, sessionKey, eventServer: deps.eventServer, env, cwd: startPath, seatRouting: true,
    shell: { posix: ['zsh', 'bash'].includes(shellKind), powershellPath: deps.powershellPath, script: claudeHookPath, node: process.execPath,
      helper: deps.path.join(deps.integrationDir, 'agent-event.cjs') } });
  const { terminal, remoteLaunch, env: terminalEnv } = prepareAndSpawnTerminal(deps, { project, shell, id, sessionId, sessionKey,
    controlCapability, startPath, hooks, env, process, bootstrapFile, skillNoteFile, claudeHookPath, transfer });
  const s = createTerminalSession(deps, { id, project, terminal, env: terminalEnv, transfer, sessionId, sessionKey, controlCapability,
    bootstrapFile, hooks, skillNoteFile, agentStarting, shellKind });
  if (remoteLaunch) terminal.appliedRouting = { effective: remoteLaunch.seatsMap, roles: remoteLaunch.roles, conductor: remoteLaunch.conductor === true };
  registerTerminalSession(deps, s, project);
  bindTerminalEvents(deps, s, project, terminalEnv);
}

function prepareAndSpawnTerminal(deps, options) {
  const { sessionId, bootstrapFile, skillNoteFile, transfer } = options;
  try {
    writeTerminalStartupFiles(deps, options);
    return spawnTerminal(deps, options);
  } catch (error) {
    cleanupTerminalFiles(deps, { bootstrapFile: transfer?.bootstrapFile === bootstrapFile ? null : bootstrapFile, skillNoteFile, sessionId });
    throw error;
  }
}

function writeTerminalStartupFiles(deps, { project, id, sessionId, sessionKey, controlCapability, startPath, hooks, env, process, bootstrapFile, skillNoteFile, claudeHookPath }) {
  applyFastHookSettings(hooks, env);
  if (bootstrapFile) deps.writeBootstrap({ file: bootstrapFile, eventServer: deps.eventServer, projectId: id, projectPath: startPath,
    sessionKey, controlAddress: deps.controlAddress, controlCapability,
    claudeBackgroundTasks: deps.store.settings?.claudeBackgroundTasks, powershellPath: deps.powershellPath, notifyPath: deps.path.join(deps.integrationDir, 'notify.ps1'), claudeHookPath,
    nodePath: process.execPath, accountScopeHelper: deps.path.join(deps.integrationDir, 'codex-account-scope.cjs'), hooks,
    lead: deps.routing.terminalLead?.(project.id) ?? null, dispatchSeats: deps.routing.dispatchSeats?.(project.id), conductor: !!deps.routing.seatsInfo?.(project.id)?.conductor });
  setTerminalExecutables(deps, project, env);
  if (project.kind !== 'ssh') env.AGENTRIX_ACCOUNT_BASELINE = JSON.stringify(deps.accountEnvironment(env));
  // The agent wrappers tell Claude Code and Codex what the reading view shows (an SSH project's worker is told on start),
  // and where the work done in this folder before is written down for them (handoff.cjs), so either one carries it on.
  if (project.kind !== 'ssh') {
    const note = deps.startupNote(deps.READING_NOTE, deps.handoffFile(id), deps.path.join(project.path, 'skills'),
      deps.routing.launch(project, false, sessionId, { agent: 'claude' }));
    env.AGENTRIX_READING_NOTE = note;
    deps.writeFileAtomic(skillNoteFile, note);
    env.AGENTRIX_READING_NOTE_FILE = skillNoteFile;
    void deps.writeHandoff(deps.handoffFile(id), startPath, { memoryDir: deps.memoryDir() }).catch(() => {});
  }
}

function createTerminalSession(deps, { id, project, terminal, env, transfer, sessionId, sessionKey, controlCapability,
  bootstrapFile, hooks, skillNoteFile, agentStarting, shellKind }) {
  const s = {
    switchPreviousHost: transfer, terminal, terminalId: id, projectId: project.id, sessionId, skillSessionId: null, sessionKey,
    controlCapability, bootstrapFile, hooks, skillNoteFile, skillNote: env.AGENTRIX_READING_NOTE, status: 'starting', agentStarting, ready: false, shellKind,
    recordRun: (call, event) => deps.dashboard.run(project, call, event),
    recordQuota: (provider, limits) => deps.dashboard.quota(provider, limits, deps.quotaScope(provider, project, s)),
    // Command Prompt reports its prompts through markers in its output instead of the event pipe.
    usageEnv: project.kind === 'ssh' ? null : { ...env },
    prompts: shellKind === 'cmd' ? new deps.PromptMarkers() : null,
    tools: shellKind === 'cmd' ? { codex: !!env.AGENTRIX_CODEX_EXECUTABLE || deps.onPath('codex', env), claude: !!env.AGENTRIX_CLAUDE_EXECUTABLE || deps.onPath('claude', env) } : null,
    titles: new deps.TerminalTitleTracker(), reportedThreadId: null,
    cliActive: false, codexAvailable: null, seq: 0, chunks: [], bytes: 0, pending: '',
    flushTimer: null, error: null, submissions: new deps.SubmissionTracker(), draftSubmissions: null,
    approval: new deps.ApprovalGuard(sessionId), approvalRemote: project.kind === 'ssh',
    native: null, nativeMode: null,
    observeNativeSwitch: () => deps.nativeSessions?.observe?.(id),
  };
  s.actions = new deps.ActionLog(change => deps.publishAction(s, change));
  return s;
}

function bindTerminalInput(deps, s) {
  const { terminal, terminalId: id } = s;
  s.gate = new deps.InputGate(data => {
    if (deps.sessions.get(id) !== s || s.status === 'exited') return;
    if (!deps.isTerminalResponse(data)) s.approval.invalidate();
    if (!deps.isTerminalResponse(data)) {
      deps.nativeSessions?.input?.(id, s.nativeRuntimeSessionId);
      void Promise.resolve().then(() => s.observeNativeSwitch?.());
    }
    terminal.write(data);
  }, { shellOwnsInput: () => !s.cliActive });
}

function registerTerminalSession(deps, s, project) {
  const id = s.terminalId;
  bindTerminalInput(deps, s);
  const refreshCompletion = () => {
    if (deps.sessions.get(id) === s && s.cliActive && (s.activityRawSnapshot || s.activitySnapshot)) deps.applyActivity(project, s, s.activityRawSnapshot || s.activitySnapshot);
  };
  s.completionWork = new deps.CompletionWork({ changed: refreshCompletion });
  s.promptQueue = new deps.PromptQueue(expired => {
    if (deps.sessions.get(id) !== s) return;
    deps.scheduleState();
    if (expired?.length) {
      // Release only the expired submissions' provisional guard. Received prompts
      // and submissions still waiting must continue to reject older completions.
      s.activityInputAt = Math.max(s.activityConfirmedInputAt || 0, ...s.promptQueue.items.map(item => item.at));
      queueMicrotask(() => {
        if (s.activityRawSnapshot) deps.applyActivity(project, s, s.activityRawSnapshot);
      });
      return;
    }
    // Queue receipt/cancellation/expiry can change a deferred completion even if
    // no new lifecycle snapshot arrives. This never arms another notification.
    if (s.activitySnapshot?.state === 'complete') queueMicrotask(refreshCompletion);
  });
  // A prompt the agent's own record shows it received is being worked on. History read when a session is
  // resumed is older than the agent's start and is left out.
  s.conversation = new deps.ConversationLog(change => {
    deps.publishConversation(s, change);
    const entry = change.entry;
    // Local transcripts already use the main clock; the hook offset includes delivery latency.
    const at = (entry?.receivedAt ?? entry?.at) + (project.kind === 'ssh' ? s.activityClockOffset || 0 : 0);
    if (entry?.cancelled) s.promptQueue.cancel(entry.original ?? entry.text, at, entry.id);
    else if (entry?.role === 'user' && entry.queued && s.cliActive && at >= (s.activitySince || 0) - 1000) s.promptQueue.enqueue(entry.original ?? entry.text, at, entry.id);
    if (entry?.role === 'assistant' && s.cliActive) s.promptQueue.reply({ ...entry, at });
    // An answer to the agent's own question is not a prompt: it goes on with the round it answered.
    if (entry?.role === 'user' && !entry.answer && !entry.queued && s.cliActive) {
      const localCommand = deps.isLocalAgentCommand(s.agent, entry.text);
      if (at >= (s.activitySince || 0) - 1000) {
        const inputAt = s.promptQueue.start(entry.original ?? entry.text, at, entry.id, localCommand);
        if (inputAt !== undefined) {
          s.activityConfirmedInputAt = Math.max(s.activityConfirmedInputAt || 0, inputAt);
          s.activityInputAt = Math.max(s.activityInputAt || 0, s.activityConfirmedInputAt);
        }
      }
      // Recalled prompts, custom slash commands and command-line prompts are not always visible to the key
      // tracker. Codex's received user message confirms them. A time watermark excludes history and replays;
      // working/completion snapshots alone can never grant another alert. Claude has UserPromptSubmit hooks.
      if (s.agent === 'codex' && !localCommand && at >= Math.max(s.activitySince || 0, s.activityInputAt || 0) && at > Math.max(s.activityPromptAt || 0, s.lastCompletedAt || 0)) {
        // task_started may already have published this turn before its user item arrives.
        // Retire the previous turn only when no newer start is awaiting its prompt receipt.
        const started = s.activitySnapshot?.state === 'working' && s.activitySnapshot.turnId
          && s.activitySnapshot.updatedAt > (s.activityPromptAt || 0);
        deps.publishCliState(s, 'working', { at, threadId: s.reportedThreadId || s.rootThreadId, eventId: `input:${entry.id}`, newTurn: !started });
        s.activityPromptAt = at;
        s.completionWork?.begin(at);
        deps.store.expectCompletion(project.id);
      }
    }
  });
  deps.sessions.set(id, s);
}

function bindTerminalEvents(deps, s, project, env) {
  const { terminal, terminalId: id, sessionId, sessionKey, bootstrapFile, skillNoteFile } = s;
  deps.bindDispatchInbox(s, project);
  deps.store.setRestore(id, { terminal: true, ...(deps.restorePlans.has(id) ? {} : { codex: false }) });
  deps.startupErrors.delete(id);
  const flush = () => {
    clearTimeout(s.flushTimer); s.flushTimer = null;
    if (!s.pending) return;
    deps.send('terminal:data', { id, sessionId, seq: ++s.seq, data: s.pending, approval: deps.approvalStamp(s) });
    s.pending = '';
  };
  s.flush = flush;
  terminal.onData(data => {
    if (deps.sessions.get(id) !== s) return;
    // Before the 16 ms transport batch and the renderer's 100 ms publication: even coalesced A/B/A output
    // invalidates old tickets. Identical bytes can be a new request; terminal mode provides no native request ID.
    s.approval.invalidate();
    if (s.prompts) for (const cwd of s.prompts.write(data)) {
      deps.onEvent({ projectId: id, sessionKey, type: 'shell-prompt', sequence: (s.lastShellEventSequence || 0) + 1, cwd, codexAvailable: s.tools.codex, claudeAvailable: s.tools.claude,
        codexHome: env.CODEX_HOME || deps.path.join(deps.os.homedir(), '.codex') });
    }
    for (const threadId of s.titles.write(data)) {
      if (s.reportedThreadId !== threadId) {
        const previous = deps.readingHistory.summary(id);
        if (previous && !previous.threadId.toLowerCase().startsWith(threadId.toLowerCase())) deps.readingHistory.close(id);
        if (s.agent === 'codex' && deps.wholeThread(threadId)) void deps.prepareReading(id, { agent: 'codex', threadId, cwd: deps.store.findTerminal(id)?.record.restore?.cwd || project.path });
        s.reportedThreadId = threadId;
        if (s.agent === 'codex' && s.cliProviderId && !s.cliProviderId.toLowerCase().startsWith(threadId.toLowerCase())) {
          deps.publishCliState(s, 'idle', { threadId, bind: true });
        }
        s.approval.context('terminal-title', threadId);
        // A title cut short names the session only by how its id begins: the whole id is kept once its record is found.
        if (s.cliActive) {
          s.codexActivity = 'unknown'; s.activityInputAt = s.activityConfirmedInputAt = 0;
          if (deps.wholeThread(threadId)) deps.store.setRestore(id, { threadId });
          void s.activityMonitor?.poll();
        }
      }
    }
    s.usageAccount?.output(data);
    s.gate.output(data);
    s.chunks.push(data); s.bytes += data.length; s.pending += data;
    while (s.bytes > 1024 * 1024 && s.chunks.length > 1) s.bytes -= s.chunks.shift().length;
    if (s.pending.length > 65536) flush();
    else if (!s.flushTimer) s.flushTimer = setTimeout(flush, 16);
  });
  terminal.on?.('error', () => {
    if (deps.sessions.get(id) !== s || s.terminalFaulted) return;
    s.terminalFaulted = true; s.error = deps.t('终端连接已断开。');
    try { terminal.kill(); } catch { }
  });
  terminal.onExit(({ exitCode }) => {
    if (deps.sessions.get(id) !== s) return;
    if (deps.nativeSessions?.failed?.(id, s.nativeRuntimeSessionId)) { s.ready = false; deps.broadcast(); return; }
    flush();
    deps.endSkillSession(s);
    deps.routing.endSession(project.id, sessionId);
    deps.stopUsageAccount(s);
    s.status = 'exited'; s.ready = false; s.cliActive = false;
    deps.readingHistory.close(id);
    s.activityMonitor?.stop(); s.activityMonitor = null; s.codexActivity = 'unknown';
    if (s.completionWork.reset()) deps.store.expectCompletion(project.id, false);
    s.activitySnapshot = s.activityRawSnapshot = null;
    deps.restorePlans.delete(id);
    if (terminal.error || exitCode) s.error = terminal.error || deps.t('终端已退出（代码 {code}）。', { code: exitCode });
    if (!deps.quitting && !exitCode) deps.store.setRestore(id, { terminal: false, codex: false });
    if (bootstrapFile || skillNoteFile) cleanupTerminalFiles(deps, s);
    s.calls?.endSession();
    deps.broadcast();
  });
  deps.captureBranch(project);
  deps.broadcast();
}

function cleanupTerminalFiles(deps, s) {
  const { fs, path, report } = deps;
  const retry = deps.retryFileOperation || (operation => operation());
  const remove = operation => {
    try { retry(operation); }
    catch (error) { if (error.code !== 'ENOENT') report(error); }
  };
  for (const bootstrap of [s.bootstrapFile, ...(s.switchBootstrapFiles || [])].filter(Boolean)) {
    const folder = path.dirname(bootstrap), base = path.basename(bootstrap);
    const env = base.replace(/\.json$/i, '') + '-claude-env.sh';
    let entries;
    try { entries = fs.readdirSync(folder, { withFileTypes: true }); }
    catch (error) {
      if (error.code !== 'ENOENT') {
        report(error);
        remove(() => deps.removeBootstrap(bootstrap));
      }
      continue;
    }
    for (const entry of entries) {
      // Bootstrap sidecars share the exact JSON basename. Claude settings are named for this PTY session.
      const { name } = entry;
      if (!entry.isDirectory() && (name === base || name.startsWith(base + '.') || name === env || name.startsWith(`${s.sessionId}-claude-settings-`))) {
        remove(() => fs.rmSync(path.join(folder, name), { force: true }));
      }
    }
  }
  if (s.skillNoteFile) remove(() => fs.rmSync(s.skillNoteFile, { force: true }));
}

function disposeTerminal(deps, id, { preserveNative = false, preserveSwitch = false, preserveCalls = false } = {}) {
  deps.readingHistory.close(id);
  const s = deps.sessions.get(id);
  deps.sessions.delete(id);
  deps.nativeSpecs.delete(id);
  if (preserveCalls && !preserveSwitch) (s?.calls || s?.switchPreviousHost?.calls || deps.AgentCalls.forTerminal(deps.sessions, id))?.endSession();
  if (!preserveNative && !preserveSwitch) void deps.nativeSessions?.forget(id).catch(deps.report);
  if (!preserveSwitch && !preserveCalls) {
    deps.disposeDispatchInbox(id);
    (s?.calls || s?.switchPreviousHost?.calls || deps.AgentCalls.forTerminal(deps.sessions, id))?.dispose();
  }
  if (!s) return;
  if (!preserveSwitch) {
    deps.syncDashboardLive(); deps.endSkillSession(s); deps.routing.endSession(s.projectId, s.sessionId);
  }
  deps.stopUsageAccount(s);
  clearTimeout(s.flushTimer); clearTimeout(s.actionTimer); clearTimeout(s.conversationTimer);
  for (const timer of s.submissionPolls || []) clearTimeout(timer);
  s.activityMonitor?.stop(); s.gate.dispose();
  if (!preserveSwitch) { s.promptQueue.reset(); s.completionWork?.reset(); }
  try { if (!s.nativeStructured) s.terminal.kill(); } catch { }
  if (!preserveSwitch) cleanupTerminalFiles(deps, s);
}

function spawnTerminal(deps, { project, shell, id, sessionId, sessionKey, startPath, hooks, env, process }) {
  const shellKind = shell.kind;
  // zsh and Bash learn where to report from their environment (integration/zsh-integration.zsh and
  // bash-integration.bash), and report through integration/agent-event.cjs run by this executable as Node.
  const local = project.kind !== 'ssh' && ['zsh', 'bash'].includes(shellKind);
  const integration = local && { folder: deps.zshStartup, socket: deps.eventServer.address, projectId: id, sessionKey, node: process.execPath,
    helper: deps.path.join(deps.integrationDir, 'agent-event.cjs'), startDir: startPath, hooks,
    loginFiles: process.platform === 'darwin' && shellKind === 'bash',
    // Every glibc since 2.35 has C.UTF-8; a Linux desktop session normally sets LANG itself.
    locale: process.platform === 'darwin' ? deps.terminalLocale(deps.app.getPreferredSystemLanguages()) : 'C.UTF-8' };
  if (local) env = shellKind === 'zsh' ? deps.zshEnvironment(env, integration) : deps.shellEnvironment(env, integration);
  const sshAskpassPath = project.kind === 'ssh' ? deps.prepareAskpass() : undefined;
  const terminalOptions = { name: 'xterm-256color', cols: 90, rows: 22, cwd: startPath, env,
    ...(!['zsh', 'bash'].includes(shellKind) ? { useConpty: true, useConptyDll: true } : {}) };
  const remoteLaunch = project.kind === 'ssh' ? deps.routing.launch(project, true, sessionId) : null;
  const terminal = project.kind === 'ssh' ? new deps.RemoteConnection({ ...project, id }, {
    integrationDir: deps.integrationDir, auth: deps.sshAuth, sessionKey, onEvent: deps.onEvent, codingPath: startPath, askpassPath: sshAskpassPath,
    allowBackgroundTasks: deps.store.settings?.claudeBackgroundTasks,
    claudeLead: { ...(deps.routing.terminalLead?.(project.id, { remote: true }) ?? { seatsMap: deps.routing.dispatchSeats?.(project.id) ?? {} }),
      conductor: remoteLaunch.conductor === true, launchSeatsMap: remoteLaunch.agentSeats ?? {} },
    readingNote: deps.startupNote(deps.READING_NOTE, '{AGENTRIX_HANDOFF}', deps.path.posix.join(project.path, 'skills'), remoteLaunch, '{AGENTRIX_DISPATCH}'), guide: remoteGuide(remoteLaunch.guide),
    onReady: info => { deps.remoteBranch(project.id, info.branch); },
  }) : shellKind === 'zsh' ? deps.pty.spawn(shell.file, ['-l', '-i'], terminalOptions)
    : shellKind === 'bash' ? deps.pty.spawn(shell.file, deps.bashArguments(deps.integrationDir), terminalOptions)
    : shellKind === 'cmd' ? deps.pty.spawn(deps.cmdPath, ['/D', '/Q', '/K', deps.path.join(deps.integrationDir, 'bootstrap.cmd')], terminalOptions)
    : deps.pty.spawn(deps.powershellPath, ['-NoLogo', '-NoProfile', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', deps.path.join(deps.integrationDir, 'bootstrap.ps1')], terminalOptions);
  return { terminal, remoteLaunch, env };
}

function setTerminalExecutables(deps, project, env) {
  // The wrapper runs, after the user's own alias, the Claude Code claude-runtime chose for the terminal (an inherited
  // choice never passes, createTerminalEnvironment drops it); an SSH project runs the server's own.
  const claudeFile = project.kind !== 'ssh' && deps.claudeLocator.peek()?.terminal?.path;
  if (claudeFile) env.AGENTRIX_CLAUDE_EXECUTABLE = claudeFile;
  // Codex likewise: the wrappers and the dispatch helper run the file found, told where it was found (an npm shim keeps
  // npm's environment for the CLI's own runs).
  const codexPath = project.kind !== 'ssh' && deps.codexLocator.peek()?.path;
  if (codexPath) env.AGENTRIX_CODEX_EXECUTABLE = codexPath;
  const parentEnv = (deps.process ?? process).env;
  if (project.kind === 'ssh' || (parentEnv.AGENTRIX_DATA_DIR && parentEnv.AGENTRIX_TEST_AGENTS !== '1')) return;
  for (const { manifest: { id: agent }, install } of deps.adapters?.() ?? []) {
    const executable = install.terminalExecutable?.(env);
    if (executable) env[`AGENTRIX_${agent.toUpperCase()}_EXECUTABLE`] = executable;
  }
}

function createTerminalLifecycle(deps) {
  const shellCache = { current: null };
  return {
    firstLooksSettled: firstLooksSettled.bind(null, deps),
    launchAfterPrompt: launchInitialAgent.bind(null, deps),
    resumeAfterPrompt: resumeAfterPrompt.bind(null, deps),
    remoteFor: remoteFor.bind(null, deps),
    localShell: localShell.bind(null, deps, shellCache),
    restoreTerminal: restoreTerminal.bind(null, deps),
    startTerminal: startTerminal.bind(null, deps, shellCache),
    bindTerminalInput: bindTerminalInput.bind(null, deps),
    registerTerminalSession: registerTerminalSession.bind(null, deps),
    bindTerminalEvents: bindTerminalEvents.bind(null, deps),
    disposeTerminal: disposeTerminal.bind(null, deps),
    cleanupTerminalFiles: cleanupTerminalFiles.bind(null, deps),
    setTerminalExecutables: setTerminalExecutables.bind(null, deps),
  };
}

module.exports = { createCloseGuards, createTerminalLifecycle, restoreTerminals, launchAfterPrompt, applyFastHookSettings };
