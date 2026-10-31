function registerNativeIpc({ handle, findProject, getSession }) {
  handle('terminal:native-approval', (id, answer) => {
    findProject(id);
    const s = getSession(id);
    if (!s?.native || s.approvalRemote || s.status === 'exited') throw new Error('No live native approval channel');
    return s.native.answer(answer);
  });
  handle('terminal:native-question', (id, answer) => {
    findProject(id);
    const s = getSession(id);
    if (!s?.native || s.approvalRemote || s.status === 'exited') throw new Error('No live native question channel');
    return s.native.answerQuestion(answer);
  });
  handle('terminal:managed-prompt', (id, sessionId, text) => {
    findProject(id); const s = getSession(id);
    if (!s?.native || s.approvalRemote || s.nativeMode !== 'claude-sdk' || s.sessionId !== sessionId || s.status === 'exited') throw new Error('Managed session changed');
    s.native.prompt(text); return true;
  });
}
module.exports = { registerNativeIpc };
