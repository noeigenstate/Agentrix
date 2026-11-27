const path = require('node:path');
const { sameDirectory } = require('../../session-files.cjs');
const { initialize, SESSION_ID, errorWithCode } = require('./session.cjs');

function historyDirectory(cwd, platform = process.platform) {
  if (typeof cwd !== 'string') return null;
  const normalized = platform === 'win32' ? cwd.replace(/^\/(?=[a-z]:[/\\])/i, '') : cwd;
  return (platform === 'win32' ? path.win32 : path.posix).isAbsolute(normalized) ? normalized : null;
}

async function listHistory(connect, spec, { signal, clientVersion }) {
  const { cwd, env, geminiDir, rpcTimeoutMs } = spec;
  const remote = spec.kind === 'ssh';
  let connection;
  const checkOpen = () => { if (signal?.aborted) throw errorWithCode('session_closed'); };
  const abort = () => { void connection?.close().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    checkOpen();
    connection = await connect({ spec, purpose: 'history', signal, cwd, env, profile: geminiDir, rpcTimeoutMs, checkOpen });
    checkOpen();
    const { rpc, cwd: directory } = connection;
    await initialize(rpc, clientVersion);
    const rows = new Map(), cursors = new Set();
    let cursor;
    for (let page = 0; page < 20; page++) {
      const result = await rpc.request('session/list', { cwd: directory, ...(cursor && { cursor }) });
      checkOpen();
      for (const session of Array.isArray(result?.sessions) ? result.sessions : []) {
        if (typeof session?.sessionId !== 'string' || !SESSION_ID.test(session.sessionId)) continue;
        const folder = historyDirectory(session.cwd, remote ? 'linux' : process.platform);
        if (!folder || !(remote ? path.posix.resolve(folder) === path.posix.resolve(directory) : sameDirectory(folder, directory))) continue;
        const id = session.sessionId, at = Date.parse(session.updatedAt);
        const title = typeof session.title === 'string' ? session.title.slice(0, 240) : null;
        if (!rows.has(id) || at > rows.get(id).at) rows.set(id, { id, title, at: Number.isFinite(at) ? at : null });
      }
      cursor = result?.nextCursor;
      if (typeof cursor !== 'string' || !cursor || cursor.length > 4096 || cursors.has(cursor)) break;
      cursors.add(cursor);
    }
    return [...rows.values()].sort((a, b) => (b.at ?? -Infinity) - (a.at ?? -Infinity)).slice(0, 100);
  } finally {
    signal?.removeEventListener('abort', abort);
    await connection?.close();
  }
}

module.exports = { listHistory, historyDirectory };
