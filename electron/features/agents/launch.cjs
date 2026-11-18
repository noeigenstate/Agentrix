// Starting Claude Code or Codex in a project's new terminal: fresh, or where this folder's work left off.
const path = require('node:path');
const os = require('node:os');
const { rolloutFiles, sessionMeta } = require('../../session-files.cjs');
const { interactiveSession } = require('../../session-restore.cjs');
const { listClaudeSessions } = require('../../claude-sessions.cjs');

// The latest Codex conversation started in this folder, found from the files' headers alone.
async function latestCodexSession(folder, codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')) {
  const files = (await rolloutFiles(path.join(codexHome, 'sessions'))).sort((a, b) => b.modified - a.modified);
  for (const file of files) {
    try { const meta = await sessionMeta(file.filename); if (interactiveSession(meta, folder)) return { id: meta.id, at: file.modified }; } catch { }
  }
  return null;
}

// Each agent's latest conversation in this folder ({ id, at }), or null when it has none.
async function folderHistory(folder, { claude = listClaudeSessions, codex = latestCodexSession } = {}) {
  const [last, latest] = await Promise.all([
    claude(folder).then(list => list[0] ? { id: list[0].id, at: list[0].updatedAt } : null).catch(() => null),
    codex(folder).catch(() => null),
  ]);
  return { claude: last, codex: latest };
}

// What is typed at the new terminal's first prompt.
function launchCommand(agent, history, seat = null) {
  if (agent === 'claude') {
    if (history) return `claude --resume ${history.id}\r`;
    if (!seat?.model) return 'claude\r';
    // Skills validates capabilities; the shell boundary also rejects executable syntax.
    if (seat.model.length > 160 || !/^[A-Za-z0-9][\w.:@+/[\]-]*$/.test(seat.model)) throw new Error('invalid-model');
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(seat.effort)) throw new Error('invalid-effort');
    return `claude${seat.fast === true ? ' --agentrix-seat-fast' : ''} --model "${seat.model}" --effort ${seat.effort}\r`;
  }
  throw new Error('Codex 必须通过 app-server 启动。');
}

module.exports = { folderHistory, latestCodexSession, launchCommand };
