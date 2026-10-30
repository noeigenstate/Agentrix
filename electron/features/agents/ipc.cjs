function registerAgentsIpc({ handle, agents, openExternal, getSession, findProject, getRestoreCwd, listClaudeSessions, listCodexSessions, followClaudeSession, listAgentCommands, readingPage, t }) {
  handle('agents:status', () => agents.getState());
  handle('agents:install', agent => agents.install(agent));
  handle('agents:open-node', () => openExternal('https://nodejs.org/'));
  handle('terminal:actions', id => { findProject(id); return getSession(id)?.actions.list || []; });
  handle('terminal:conversation', id => { findProject(id); return getSession(id)?.conversation.snapshot() || []; });
  handle('terminal:conversationPage', (id, request) => {
    findProject(id);
    if (!request || typeof request.key !== 'string' || request.cursor != null && typeof request.cursor !== 'string') throw new Error('无效的对话分页请求。');
    return readingPage(id, request);
  });
  handle('terminal:agentSessions', id => {
    const project = findProject(id), s = getSession(id);
    if (!s) return [];
    // Over SSH the CLI's own list is used, shown by the reading view (reading-sessions.ts).
    if (project.kind === 'ssh') return [];
    const cwd = getRestoreCwd(id) || project.path;
    // Codex's own list leaves out the conversation it is in; so does this one.
    if (s.agent === 'codex') return listCodexSessions(cwd, s.rootThreadId || s.reportedThreadId, s.codexHome);
    if (s.agent !== 'claude') return [];
    return listClaudeSessions(cwd, s.codexActive ? s.claudeSessionId : s.claudeResumeId);
  });
  handle('terminal:followAgentSession', async (id, sessionId) => {
    const project = findProject(id), s = getSession(id);
    if (project.kind === 'ssh' || !s?.codexActive || s.agent !== 'claude') return false;
    return followClaudeSession(project, s, sessionId);
  });
  handle('terminal:commands', async id => {
    const project = findProject(id), s = getSession(id);
    const commands = await listAgentCommands({ agent: s?.agent || 'claude', projectPath: project.kind === 'ssh' ? undefined : project.path });
    return commands.map(command => command.source === 'builtin' ? { ...command, description: t(command.description) } : command);
  });
}

module.exports = { registerAgentsIpc };
