const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const PREFIX = 'agentrix-role-';
const NAME = /^agentrix-role-[A-Za-z0-9]{6}$/;
const MARKER = '.agentrix-role';
const RETENTION = 7 * 86400000;
const MAX_FOLDERS = 256;
const MAX_SCAN = 16384;
const MAX_REMOVALS = 32;
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;

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
    if (!NAME.test(path.basename(folder)) || !(await fs.lstat(folder)).isDirectory() || await readStamp(folder, MARKER, 36) !== token) return;
    const value = state === 'ended' ? `${token}:${now}` : token;
    await fs.writeFile(path.join(folder, `${MARKER}-${state}`), value, { flag: 'wx', mode: 0o600 });
  } catch { /* Artifact bookkeeping must not change a role's result. */ }
}

async function inspectRole(folder, now) {
  const identity = await fs.lstat(folder);
  if (!identity.isDirectory() || await fs.realpath(folder) !== folder) return null;
  const token = await readStamp(folder, MARKER, 36);
  if (!token || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(token)) return null;
  const stamp = await readStamp(folder, MARKER + '-ended', 53);
  const ended = stamp?.startsWith(token + ':') ? Number(stamp.slice(37)) : null;
  const settled = Number.isSafeInteger(ended) && ended > 0 && ended <= now;
  const read = settled && await readStamp(folder, MARKER + '-read', 36) === token;
  return { folder, identity, ended: settled ? ended : null, read };
}

async function sweepRoleArtifacts(root, { now = Date.now(), maxFolders = MAX_FOLDERS, remove = fs.rm } = {}) {
  try {
    const parent = await fs.realpath(root);
    const roles = [];
    let scanned = 0;
    for await (const entry of await fs.opendir(parent)) {
      if (++scanned > MAX_SCAN) break;
      if (!entry.isDirectory() || !NAME.test(entry.name)) continue;
      const role = await inspectRole(path.join(parent, entry.name), now).catch(() => null);
      if (role) roles.push(role);
    }
    let excess = roles.length - maxFolders, attempts = 0;
    const ended = roles.filter(role => role.ended !== null).sort((a, b) => a.ended - b.ended);
    for (const { folder, identity, ended: at, read } of ended) {
      if (now - at < RETENTION && !(read && excess > 0)) continue;
      if (++attempts > MAX_REMOVALS) break;
      try {
        const current = await fs.lstat(folder);
        if (!current.isDirectory() || !sameFile(identity, current) || await fs.realpath(folder) !== folder) continue;
        // Retain the ownership and settlement stamps if deleting a locked artifact fails.
        for (const name of await fs.readdir(folder)) {
          if (name === MARKER || name === MARKER + '-ended' || name === MARKER + '-read') continue;
          await remove(path.join(folder, name), { recursive: true, force: true });
        }
        await fs.rm(folder, { recursive: true, force: true });
        excess--;
      } catch { /* A locked or concurrently removed folder can be revisited on the next sweep. */ }
    }
  } catch { /* A missing or unreadable temp root does not block MCP. */ }
}

module.exports = { createRoleArtifacts, stampRoleArtifacts, sweepRoleArtifacts, RETENTION };
