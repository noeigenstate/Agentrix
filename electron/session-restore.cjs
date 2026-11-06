const { records, sameDirectory } = require('./session-files.cjs');

// Whether a rollout file is an interactive session (not a child agent or exec run) started in this folder.
function interactiveSession(meta, directory) {
  return !!meta && ['cli', 'vscode'].includes(meta.source || 'cli') && sameDirectory(meta.cwd, directory) && /^[a-f\d-]{36}$/i.test(meta.id || '');
}

// Claude Code reopens its own conversation. Its hooks record the session and whether the last turn was
// left unfinished; that turn gets the same "继续". Without a recorded session, continue the newest one here.
function claudeResumeCommand(restore) {
  if (!restore?.threadId) return 'claude --continue\r';
  if (!/^[a-f\d-]{36}$/i.test(restore.threadId)) throw new Error('无效的 Claude Code 会话。');
  return `claude --resume ${restore.threadId}${restore.interrupted ? ' "继续"' : ''}\r`;
}

module.exports = { claudeResumeCommand, records, interactiveSession };
