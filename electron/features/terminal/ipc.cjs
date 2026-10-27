const { isLocalCommand, isTerminalResponse } = require('../../terminal-input.cjs');
const { approvalStamp } = require('./approval-guard.cjs');

function registerTerminalIpc({ handle, listen, findProject, getSession, hasSession, startTerminal, addTerminal, removeTerminal, confirmTerminalClose, forgetRestorePlan, disposeTerminal, clearStartupError, broadcast, getProjectById, acknowledgeProject, expectCompletion, scheduleState, applyActivity, pollAfterSubmission, send, getActiveTerminal, setActiveTerminal, setActiveFileTree, now = () => Date.now(), platform = process.platform }) {
  handle('terminal:start', startTerminal);
  handle('terminal:add', id => {
    const project = findProject(id);
    if (!hasSession(project.id) && !project.terminals?.length) { startTerminal(project.id); return project.id; }
    const terminalId = addTerminal(project.id);
    try { startTerminal(terminalId); return terminalId; }
    catch (error) { removeTerminal(terminalId); throw error; }
  });
  handle('terminal:close', async id => {
    if (!await confirmTerminalClose(id, '关闭')) return false;
    forgetRestorePlan(id); disposeTerminal(id); removeTerminal(id); clearStartupError(id); broadcast(); return true;
  });
  handle('terminal:restart', async id => {
    if (!await confirmTerminalClose(id, '重启')) return false;
    forgetRestorePlan(id);
    disposeTerminal(id); startTerminal(id); return true;
  });
  handle('terminal:attach', id => {
    findProject(id);
    const s = getSession(id);
    if (!s) return { sessionId: null, seq: 0, data: '' };
    s.flush();
    return { sessionId: s.sessionId, seq: s.seq, data: s.chunks.join(''), ...(s.approval ? { approval: approvalStamp(s) } : {}) };
  });
  // Neither local TUI nor SSH exposes a response channel that atomically targets its pending native request.
  // Keep this endpoint closed for old renderers too: no supplied epoch/request ID or key can authorize a PTY write.
  handle('terminal:approval', () => ({ mode: 'terminal-only', reason: 'native-request-identity-unavailable' }));
  // answer: keys that answer the CLI itself while it signs in (a code from the browser, an API key, Enter, Escape). They
  // reach it as typed, but are never a prompt: no round starts, nothing is queued and the text is shown nowhere.
  function writeTerminal(id, data, answer = false) {
    if (typeof data !== 'string' || data.length > 1024 * 1024) return;
    const s = getSession(id);
    if (!s || s.nativeMode === 'claude-sdk') return; // Managed prompts have a distinct structured IPC; keys cannot arm a round.
    const response = isTerminalResponse(data);
    if (!response) s.approval?.invalidate();
    if (s.status === 'exited') return;
    if (answer === true) { s.gate.input(data); return; }
    const submitted = s.submissions.write(data);
    // A line of unknown text (arrows, then Enter) is as often a choice in a menu (Codex's update prompt, a /model
    // picker) as a prompt recalled from history: the agent's own records report a round it really starts.
    const prompts = s.submissions.sent.filter(text => text && !isLocalCommand(text));
    const at = now();
    if (submitted && s.codexActive) for (const text of prompts) s.promptQueue.submit(text, s.codexActivity === 'working', at);
    // Sending a new prompt means the last result has been read: clear the unviewed state before the next round.
    if (submitted && getProjectById(s.projectId)?.unread) { acknowledgeProject(s.projectId); scheduleState(); }
    if (prompts.length && s.codexActive) {
      expectCompletion(s.projectId);
      s.activityConfirmedInputAt ??= s.activityInputAt || 0;
      s.codexActivity = 'working'; s.activityInputAt = at;
      scheduleState();
    }
    // Escape on its own interrupts a working Claude Code turn. It runs no hook then, writes nothing to its transcript
    // and only puts the prompt back in its input, so this key is the only sign the round has ended. While Claude asks
    // something (a permission or a question), Escape only answers it and the round may go on.
    if (data === '\x1b' && s.codexActive && s.agent === 'claude' && s.codexActivity === 'working' && !s.needsInput) {
      const project = getProjectById(s.projectId);
      if (project) applyActivity(project, s, { threadId: s.claudeSessionId, turnId: null, state: 'interrupted', updatedAt: now() });
    }
    // Claude runs no hook once its permission prompt is answered, so the key that answers it ends the waiting notice:
    // Enter, a number or Escape, typed in the terminal. Otherwise the notice
    // (and the reading view's switch to the terminal) would last until the round ends.
    else if (s.needsInput && s.codexActive && s.agent === 'claude' && /^(?:\r|\x1b|[1-9])$/.test(data)) { s.needsInput = null; scheduleState(); }
    if (!s.codexActive && !response) {
      const wasReady = s.ready && !s.inputDirty;
      s.inputDirty = true; if (data.includes('\r') || data.includes('\n')) s.ready = false;
      if (wasReady) scheduleState();
    }
    s.gate.input(data);
    if (submitted && s.codexActive) pollAfterSubmission(s, () => getSession(id) === s);
  }
  listen('terminal:write', writeTerminal);
  listen('terminal:resize', (id, cols, rows) => {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 2 || cols > 500 || rows > 250) return;
    const s = getSession(id);
    s?.approval?.invalidate();
    if (s && s.status !== 'exited') s.terminal.resize(cols, rows);
  });
  handle('terminal:paste', (id, text, sessionId) => {
    const session = getSession(id);
    if (session?.nativeMode === 'claude-sdk') throw new Error('Use the Claude SDK managed composer');
    if (!session || session.sessionId !== sessionId || ['starting', 'exited'].includes(session.status)) throw new Error('终端已变化或尚未就绪，请复制文字后手动粘贴。');
    if (typeof text !== 'string' || text.length > 1024 * 1024) throw new Error('无效的文字。');
    // Codex on Windows takes a pasted line break as Enter, even inside a bracketed paste, and drops a bare "\n" after
    // Chinese text; Alt+Enter is its new line.
    const lineBreak = platform === 'win32' && session.codexActive && session.agent === 'codex' ? '\x1b\r' : null;
    send('terminal:paste', { id, sessionId, text, lineBreak });
  });
  listen('terminal:focus', (id, focused) => { if (hasSession(id) && focused) { setActiveTerminal(id); setActiveFileTree(null); } else if (getActiveTerminal() === id) setActiveTerminal(null); });
}

module.exports = { registerTerminalIpc };
