const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');

const unavailable = () => new Error('无法读取或恢复 Claude Code 的快速模式默认设置。');

function read(file) {
  let bytes;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw unavailable();
    bytes = fs.readFileSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return { bytes: null, data: {} };
    throw error;
  }
  const data = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  if (!data || Array.isArray(data) || typeof data !== 'object') throw unavailable();
  return { bytes, data };
}

function restore(file, before, target, writeFileAtomic) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const after = read(file);
    const matches = target ? after.data.fastMode === true : !Object.hasOwn(after.data, 'fastMode');
    if (!after.bytes || !matches || isDeepStrictEqual(before.data.fastMode, after.data.fastMode)) return;
    if (Object.hasOwn(before.data, 'fastMode')) after.data.fastMode = before.data.fastMode;
    else delete after.data.fastMode;
    const bytes = before.bytes && isDeepStrictEqual(after.data, before.data) ? before.bytes : JSON.stringify(after.data, null, 2) + '\n';
    // Compare again after staging the temporary file. Re-read once if another writer got there first.
    if (writeFileAtomic(file, bytes, () => read(file).bytes?.equals(after.bytes))) return;
  }
  throw unavailable();
}

function registerLeadFastSettings({ handle, getSession, findProject, claudeConfigDir, writeFileAtomic, now = Date.now }) {
  const pending = new Map();
  handle('terminal:leadFastSettings', (id, request) => {
    try {
      if (!request || typeof request !== 'object') throw unavailable();
      const time = now();
      for (const [token, run] of pending) if (run.until <= time) pending.delete(token);
      if (typeof request.token === 'string' && typeof request.confirmed === 'boolean') {
        const run = pending.get(request.token);
        if (!run || run.id !== id) throw unavailable();
        pending.delete(request.token);
        if (request.confirmed) restore(run.file, run.before, run.target, writeFileAtomic);
        return null;
      }
      const session = getSession(id);
      if (typeof request.sessionId !== 'string' || typeof request.target !== 'boolean' || session?.sessionId !== request.sessionId
        || session.nativeStructured || session.status === 'exited' || !session.codexActive || session.agent !== 'claude'
        || !session.usageEnv || findProject(id).kind === 'ssh') throw unavailable();
      const folder = session.usageEnv.CLAUDE_CONFIG_DIR;
      const file = path.join(folder ? path.resolve(session.usageCwd || process.cwd(), folder) : claudeConfigDir(), 'settings.json');
      const fileKey = process.platform === 'win32' ? file.toLowerCase() : file;
      if ([...pending.values()].some(run => run.fileKey === fileKey)) throw unavailable();
      const before = read(file), token = randomUUID();
      pending.set(token, { id, file, fileKey, before, target: request.target, until: time + 90_000 });
      return token;
    } catch { throw unavailable(); }
  });
}

module.exports = { registerLeadFastSettings };
