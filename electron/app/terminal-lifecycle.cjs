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

  async function requestQuit() {
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

module.exports = { createCloseGuards, restoreTerminals, launchAfterPrompt };
