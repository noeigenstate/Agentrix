const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { records, rolloutFiles, sessionMeta } = require('./session-files.cjs');

function sameDirectory(a, b) {
  if (typeof a !== 'string') return false;
  const normalize = value => { let result; try { result = fs.realpathSync(value); } catch { result = path.resolve(value); } return process.platform === 'win32' ? result.toLowerCase() : result; };
  return normalize(a) === normalize(b);
}

function advanceTaskState(state, record) {
  const item = record.payload || {};
  if (record.type === 'event_msg') {
    if (['task_started', 'turn_started', 'user_message', 'turn_aborted', 'turn_interrupted'].includes(item.type)) return 'interrupted';
    if (['task_complete', 'turn_completed'].includes(item.type)) return 'complete';
  }
  if (record.type === 'response_item' && item.type === 'message') {
    if (item.role === 'user') return 'interrupted';
    if (item.role === 'assistant' && item.phase === 'final') return 'complete';
  }
  return state;
}

// Whether a rollout file is an interactive session (not a child agent or exec run) started in this folder.
function interactiveSession(meta, directory) {
  return !!meta && ['cli', 'vscode'].includes(meta.source || 'cli') && sameDirectory(meta.cwd, directory) && /^[a-f\d-]{36}$/i.test(meta.id || '');
}

async function recentSession(projectPath, codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), threadId = null) {
  const files = (await rolloutFiles(path.join(codexHome, 'sessions'))).sort((a, b) => b.modified - a.modified);
  for (const file of files) {
    try {
      const meta = await sessionMeta(file.filename);
      if (!interactiveSession(meta, projectPath) || threadId && meta.id !== threadId) continue;
      let state = 'unknown';
      for await (const record of records(file.filename, { historyWindow: true })) {
        state = advanceTaskState(state, record);
      }
      return { id: meta.id, state, modifiedAt: file.modified };
    } catch { }
  }
  return null;
}

// Claude Code reopens its own conversation. Its hooks record the session and whether the last turn was
// left unfinished; that turn gets the same "继续". Without a recorded session, continue the newest one here.
function claudeResumeCommand(restore) {
  if (!restore?.threadId) return 'claude --continue\r';
  if (!/^[a-f\d-]{36}$/i.test(restore.threadId)) throw new Error('无效的 Claude Code 会话。');
  return `claude --resume ${restore.threadId}${restore.interrupted ? ' "继续"' : ''}\r`;
}

module.exports = { recentSession, claudeResumeCommand, records, interactiveSession };
