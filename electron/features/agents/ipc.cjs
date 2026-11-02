function registerAgentsIpc({ handle, agents, openExternal, getSession, findProject, listAgentCommands, readingPage, gradeDelivery, t }) {
  handle('dashboard:grade', grade => {
    const project = findProject(grade?.terminalId);
    gradeDelivery(grade, project, getSession(grade.terminalId));
  });
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
  handle('terminal:commands', async id => {
    const project = findProject(id), s = getSession(id);
    const commands = await listAgentCommands({ agent: s?.agent || 'claude', projectPath: project.kind === 'ssh' ? undefined : project.path });
    return commands.map(command => command.source === 'builtin' ? { ...command, description: t(command.description) } : command);
  });
}

module.exports = { registerAgentsIpc };
