function registerSkillsIpc({ handle, skills, dialog, getWindow }) {
  handle('skills:seats', (projectId, terminalId) => skills.seatsInfo(projectId, terminalId, true));
  handle('skills:seats-refresh', (projectId, terminalId, reason = 'manual') => skills.refreshSeats(projectId, terminalId, reason === 'dialog' ? 'dialog' : 'manual'));
  handle('skills:setRouting', (scope, projectId, config, base) => skills.setRouting(scope, projectId, config, base));
  handle('skills:resolveRouting', (projectId, action, digest) => skills.resolveRouting(projectId, action, digest));
  handle('skills:list', () => skills.list());
  handle('skills:read', id => skills.read(id));
  handle('skills:save', (id, draft) => skills.save(id, draft));
  handle('skills:delete', id => skills.delete(id));
  handle('skills:options', (id, options) => skills.setOptions(id, options));
  handle('skills:revert', (id, version) => skills.revert(id, version));
  handle('skills:resolve', (id, accept) => skills.resolveChange(id, accept));
  handle('skills:import', async (scope, projectId) => {
    skills.target(scope, projectId);
    const chosen = await dialog.showOpenDialog(getWindow(), { properties: ['openDirectory'] });
    return chosen.canceled || !chosen.filePaths[0] ? null : skills.import(chosen.filePaths[0], scope, projectId);
  });
}

module.exports = { registerSkillsIpc };
