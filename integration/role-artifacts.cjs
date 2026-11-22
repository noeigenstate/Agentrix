const fs = require('node:fs/promises');
const { existsSync, lstatSync, readFileSync, writeFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { isOwnedDirectory } = existsSync(path.join(__dirname, 'electron'))
  ? require('./electron/session-files.cjs') : require('../electron/session-files.cjs');

const PREFIX = 'agentrix-role-';
const NAME = /^agentrix-role-[A-Za-z0-9]{6}$/;
const MARKER = '.agentrix-role';
const DAY = 86400000;
const RETENTION = 7 * DAY;
const ORPHAN_RETENTION = 30 * DAY;
const MAX_FOLDERS = 256;
const MAX_SCAN = 16384;
const MAX_REMOVALS = 32;
const RETRY_DELAY = 60000;
const failed = new Map();
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const privateFolder = stat => isOwnedDirectory(stat, process.getuid?.(), process.getuid ? 0o022 : 0);

async function createRoleArtifacts(root = os.tmpdir()) {
  const folder = await fs.mkdtemp(path.join(await fs.realpath(root), PREFIX));
  const token = randomUUID();
  await fs.writeFile(path.join(folder, MARKER), token, { flag: 'wx', mode: 0o600 });
  return { folder, token };
}

async function readStamp(folder, name, limit) {
  const file = path.join(folder, name);
  const stat = await fs.lstat(file).catch(() => null);
  if (!stat?.isFile() || stat.size > limit) return null;
  const handle = await fs.open(file, 'r');
  try {
    if (!sameFile(stat, await handle.stat())) return null;
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(buffer);
    return bytesRead <= limit ? buffer.toString('utf8', 0, bytesRead) : null;
  } finally { await handle.close(); }
}

async function stampRoleArtifacts({ folder, token }, state, now = Date.now()) {
  try {
    if (!NAME.test(path.basename(folder)) || !privateFolder(await fs.lstat(folder)) || await readStamp(folder, MARKER, 36) !== token) return;
    const value = state === 'ended' ? `${token}:${now}` : token;
    await fs.writeFile(path.join(folder, `${MARKER}-${state}`), value, { flag: 'wx', mode: 0o600 });
  } catch { /* Artifact bookkeeping must not change a role's result. */ }
}

function trackRoleProcess({ folder, token }, pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return;
  if (!NAME.test(path.basename(folder)) || !privateFolder(lstatSync(folder))) throw new Error('Unsafe role artifact directory');
  const marker = path.join(folder, MARKER), stat = lstatSync(marker);
  if (!stat.isFile() || stat.size !== 36 || readFileSync(marker, 'utf8') !== token) throw new Error('Invalid role artifact marker');
  try { writeFileSync(path.join(folder, `${MARKER}-pid-${pid}`), token, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}

async function orphaned(folder, token, now) {
  const marker = await fs.lstat(path.join(folder, MARKER));
  if (now - marker.mtimeMs < ORPHAN_RETENTION) return false;
  for await (const entry of await fs.opendir(folder)) {
    const pid = Number(/^\.agentrix-role-pid-([1-9]\d*)$/.exec(entry.name)?.[1]);
    if (!Number.isSafeInteger(pid) || await readStamp(folder, entry.name, 36) !== token) continue;
    try { process.kill(pid, 0); return false; }
    catch (error) { if (error.code !== 'ESRCH') return false; }
  }
  return true;
}

async function inspectRole(folder, now) {
  const identity = await fs.lstat(folder);
  if (!privateFolder(identity) || await fs.realpath(folder) !== folder) return null;
  const token = await readStamp(folder, MARKER, 36);
  if (!token || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(token)) return null;
  const stamp = await readStamp(folder, MARKER + '-ended', 53);
  const ended = stamp?.startsWith(token + ':') ? Number(stamp.slice(37)) : null;
  const settled = Number.isSafeInteger(ended) && ended > 0 && ended <= now;
  const read = settled && await readStamp(folder, MARKER + '-read', 36) === token;
  return { folder, identity, ended: settled ? ended : null, read, orphan: !settled && await orphaned(folder, token, now) };
}

async function sweepRoleArtifacts(root, { now = Date.now(), maxFolders = MAX_FOLDERS, remove = fs.rm, onRemoved = () => {} } = {}) {
  try {
    for (const [folder, retryAt] of failed) if (retryAt <= now) failed.delete(folder);
    const parent = await fs.realpath(root);
    const roles = [];
    let scanned = 0;
    for await (const entry of await fs.opendir(parent)) {
      if (++scanned > MAX_SCAN) break;
      if (!entry.isDirectory() || !NAME.test(entry.name)) continue;
      const role = await inspectRole(path.join(parent, entry.name), now).catch(() => null);
      if (role) roles.push(role);
    }
    let excess = roles.length - maxFolders, removed = 0;
    roles.sort((a, b) => (a.ended ?? Infinity) - (b.ended ?? Infinity));
    for (const { folder, identity, ended, read, orphan } of roles) {
      if (removed >= MAX_REMOVALS) break;
      const days = orphan ? 30 : ended !== null && now - ended >= RETENTION ? 7 : null;
      if (failed.has(folder) || !(days || read && excess > 0)) continue;
      try {
        if (await fs.realpath(folder) !== folder) continue;
        const names = await fs.readdir(folder);
        if (orphan && !(await inspectRole(folder, now))?.orphan) continue;
        const current = await fs.lstat(folder);
        if (!privateFolder(current) || !sameFile(identity, current)) continue;
        // Retain the ownership and settlement stamps if deleting a locked artifact fails.
        for (const name of names) {
          if (name === MARKER || name.startsWith(MARKER + '-')) continue;
          await remove(path.join(folder, name), { recursive: true, force: true });
        }
        const final = await fs.lstat(folder);
        if (!privateFolder(final) || !sameFile(identity, final)) continue;
        await fs.rm(folder, { recursive: true });
        excess--;
        removed++;
        onRemoved(folder, days);
      } catch { failed.set(folder, now + RETRY_DELAY); }
    }
  } catch { /* A missing or unreadable temp root does not block MCP. */ }
}

module.exports = { createRoleArtifacts, stampRoleArtifacts, trackRoleProcess, sweepRoleArtifacts, RETENTION, ORPHAN_RETENTION };
