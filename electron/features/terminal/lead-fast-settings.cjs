const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');

const RESTORE_MS = 90_000;
const unavailable = () => new Error('无法读取或恢复 Claude Code 的快速模式默认设置。');

function read(file) {
  let bytes, writtenAt;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw unavailable();
    bytes = fs.readFileSync(file);
    writtenAt = stat.mtimeMs;
  } catch (error) {
    if (error.code === 'ENOENT') return { bytes: null, data: {} };
    throw error;
  }
  const data = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  if (!data || Array.isArray(data) || typeof data !== 'object') throw unavailable();
  return { bytes, data, writtenAt };
}

function restore({ file, before, target, startedAt, until }, writeFileAtomic, automatic = false) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const after = read(file);
    const matches = target ? after.data.fastMode === true : !Object.hasOwn(after.data, 'fastMode');
    if (!after.bytes || !matches || isDeepStrictEqual(before.data.fastMode, after.data.fastMode)) return;
    // Claude writes the file. With no screen confirmation, require a modification within this automatic switch.
    if (automatic && (after.writtenAt < startedAt - 1 || after.writtenAt > until || after.writtenAt === before.writtenAt)) return;
    if (Object.hasOwn(before.data, 'fastMode')) after.data.fastMode = before.data.fastMode;
    else delete after.data.fastMode;
    const bytes = before.bytes && isDeepStrictEqual(after.data, before.data) ? before.bytes : JSON.stringify(after.data, null, 2) + '\n';
    // Compare again after staging the temporary file. Re-read once if another writer got there first.
    if (writeFileAtomic(file, bytes, () => {
      const current = read(file);
      return current.writtenAt === after.writtenAt && current.bytes?.equals(after.bytes);
    })) return;
  }
  throw unavailable();
}

function registerLeadFastSettings({ handle, getSession, findProject, claudeConfigDir, writeFileAtomic, now = Date.now, onQuit, report = () => {} }) {
  const pending = new Map();
  const remoteSettings = (remote, request) => remote.request('claude-fast-settings', request, { timeout: 3000 });
  const forget = (token, run) => { clearTimeout(run.timer); pending.delete(token); };
  const recover = (token, run) => {
    try { restore(run, writeFileAtomic, true); forget(token, run); }
    catch { report(unavailable()); }
  };
  onQuit?.(() => {
    for (const [token, run] of pending) if (run.file) { clearTimeout(run.timer); recover(token, run); }
  });
  handle('terminal:leadFastSettings', (id, request) => {
    try {
      if (!request || typeof request !== 'object') throw unavailable();
      const time = now();
      for (const [token, run] of pending) {
        if (run.until > time) continue;
        if (run.file) recover(token, run); else forget(token, run);
      }
      if (typeof request.token === 'string' && typeof request.confirmed === 'boolean') {
        const run = pending.get(request.token);
        if (!run || run.id !== id) throw unavailable();
        if (!run.remote && request.confirmed) restore(run, writeFileAtomic);
        forget(request.token, run);
        if (run.remote) return remoteSettings(run.remote, { token: run.remoteToken, confirmed: request.confirmed }).catch(() => { throw unavailable(); });
        return null;
      }
      const session = getSession(id);
      if (typeof request.sessionId !== 'string' || typeof request.target !== 'boolean' || session?.sessionId !== request.sessionId
        || session.nativeStructured || session.status === 'exited' || !session.cliActive || session.agent !== 'claude') throw unavailable();
      if (findProject(id).kind === 'ssh') {
        const remote = session.terminal;
        if (!remote?.request || !remote.connected || remote.closed) throw unavailable();
        return remoteSettings(remote, { target: request.target }).then(remoteToken => {
          if (typeof remoteToken !== 'string' || !/^[a-f0-9]{32}$/.test(remoteToken)) throw unavailable();
          const token = randomUUID();
          pending.set(token, { id, remote, remoteToken, until: time + RESTORE_MS });
          return token;
        }).catch(() => { throw unavailable(); });
      }
      if (!session.usageEnv) throw unavailable();
      const folder = session.usageEnv.CLAUDE_CONFIG_DIR;
      const file = path.join(folder ? path.resolve(session.usageCwd || process.cwd(), folder) : claudeConfigDir(), 'settings.json');
      const fileKey = process.platform === 'win32' ? file.toLowerCase() : file;
      if ([...pending.values()].some(run => run.fileKey === fileKey)) throw unavailable();
      const before = read(file), token = randomUUID();
      const run = { id, file, fileKey, before, target: request.target, startedAt: time, until: time + RESTORE_MS };
      run.timer = setTimeout(() => recover(token, run), RESTORE_MS);
      run.timer.unref?.();
      pending.set(token, run);
      return token;
    } catch { throw unavailable(); }
  });
}

module.exports = { registerLeadFastSettings };
