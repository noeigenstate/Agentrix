const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { messageText, promptText, rememberClaudeSource, claudeSessionSource } = require('./prompt-queue.cjs');
const { containedFile, records } = require('./session-files.cjs');

const SESSION_ID = /^[\w-]{1,100}$/;
const READ_BUDGET = 256 * 1024;
const claudeConfigDir = () => path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
// Claude replaces each non-ASCII-alphanumeric character, including each CJK character, separately.
const encodeClaudeCwd = cwd => cwd.replace(/[^A-Za-z0-9]/gu, '-');
const projectFolder = (cwd, home) => path.join(home, 'projects', encodeClaudeCwd(cwd));

async function projectIdentity(cwd) {
  let parent = path.resolve(cwd), suffix = [];
  for (;;) {
    try {
      const resolved = path.join(await fs.realpath(parent), ...suffix);
      return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
      if (path.dirname(parent) === parent) return process.platform === 'win32' ? path.resolve(cwd).toLowerCase() : path.resolve(cwd);
      suffix.unshift(path.basename(parent)); parent = path.dirname(parent);
    }
  }
}

async function recordedProject(filename) {
  let count = 0;
  for await (const record of records(filename)) {
    if (typeof record.cwd === 'string' && ['user', 'assistant', 'system'].includes(record.type)) return record.cwd;
    if (++count === 32) break;
  }
  return null;
}

// One ownership probe per project directory, shared by concurrent card mounts.
// Directory changes invalidate the probe; transcript growth alone needs no rescan.
const folderOwners = new Map(), OWNER_LIMIT = 2048;
async function folderOwner(folder, root) {
  const stat = await fs.stat(folder);
  const stamp = [stat.dev, stat.ino, stat.mtimeMs, stat.ctimeMs].join(':');
  if (folderOwners.get(folder)?.stamp === stamp) return folderOwners.get(folder).value;
  const value = (async () => {
    const entries = await fs.readdir(folder, { withFileTypes: true });
    const sample = entries.find(entry => entry.isFile() && entry.name.endsWith('.jsonl') && SESSION_ID.test(entry.name.slice(0, -6)));
    if (!sample) return null;
    const filename = await containedFile(root, path.join(folder, sample.name), { exact: true });
    return filename ? recordedProject(filename) : null;
  })();
  const cached = { stamp, value }; folderOwners.set(folder, cached);
  if (folderOwners.size > OWNER_LIMIT) folderOwners.delete(folderOwners.keys().next().value);
  try {
    const cwd = await value;
    // Empty/partial first records can become readable without a directory change.
    if (!cwd && folderOwners.get(folder) === cached) folderOwners.delete(folder);
    return cwd;
  } catch (error) { if (folderOwners.get(folder) === cached) folderOwners.delete(folder); throw error; }
}
async function matchingFolders(cwd, home) {
  const root = path.join(home, 'projects'), exact = projectFolder(cwd, home);
  const identity = await projectIdentity(cwd), identities = new Map(), result = [exact];
  let directories;
  try { directories = (await fs.readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => path.join(root, entry.name)); }
  catch (error) { if (error.code === 'ENOENT') return result; throw error; }
  // Bound outstanding filesystem reads when many cards mount together.
  for (let i = 0; i < directories.length; i += 16) {
    const matching = await Promise.all(directories.slice(i, i + 16).map(async folder => {
      if (folder === exact) return null;
      try {
        const recorded = await folderOwner(folder, root);
        if (!recorded || !path.isAbsolute(recorded) || process.platform === 'win32' && /^[\\/]{2}/.test(recorded) && !/^[\\/]{2}/.test(identity)) return null;
        if (!identities.has(recorded)) identities.set(recorded, projectIdentity(recorded).catch(() => null));
        return await identities.get(recorded) === identity ? folder : null;
      } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    }));
    result.push(...matching.filter(Boolean));
  }
  return result;
}
async function findClaudeSession(cwd, id, home = claudeConfigDir(), { strict = false } = {}) {
  if (typeof id !== 'string' || !SESSION_ID.test(id)) return null;
  const root = path.join(home, 'projects'), exact = projectFolder(cwd, home);
  const own = await containedFile(root, path.join(exact, id + '.jsonl'), { exact: strict });
  if (own) return own;
  for (const folder of await matchingFolders(cwd, home)) {
    if (folder === exact) continue;
    const filename = await containedFile(root, path.join(folder, id + '.jsonl'), { exact: strict });
    if (filename) return filename;
  }
  return null;
}

function promptTitle(record) {
  if (record?.type !== 'user' || promptText(record.message?.content, record) === null) return '';
  const text = messageText(record.message?.content).trim();
  if (!text || /<(?:command-|local-command-)[^>]*>/i.test(text) || /^(?:\[?Caveat:|\[?local.command caveat)/i.test(text)) return '';
  return Array.from(text.replace(/\s+/g, ' ')).slice(0, 120).join('');
}

async function sessionSummary(filename, id) {
  const file = await fs.open(filename, 'r');
  try {
    const stat = await file.stat(), buffer = Buffer.alloc(Math.min(stat.size, READ_BUDGET));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    // Discard a truncated last line, including a partially read UTF-8 character.
    const complete = bytesRead < stat.size ? buffer.subarray(0, Math.max(0, buffer.lastIndexOf(10, bytesRead - 1) + 1)) : buffer.subarray(0, bytesRead);
    let title = '', messages = 0, unownedSdk = false;
    for (const line of complete.toString('utf8').split('\n')) {
      try {
        const record = JSON.parse(line);
        if (record.turnOrigin === 'sdk' && record.entrypoint !== 'agentrix-sdk' && claudeSessionSource(record) !== 'gui') unownedSdk = true;
        if (record.type === 'user' || record.type === 'assistant') messages++;
        if (!title) title = promptTitle(record);
      } catch { /* malformed/partial JSONL is not a session title */ }
    }
    // Exact for small files; extrapolate the user+assistant record density for larger ones.
    if (stat.size > bytesRead && complete.length) messages = Math.round(messages * stat.size / complete.length);
    return unownedSdk && !title ? null : { id, updatedAt: stat.mtimeMs, title, messages };
  } finally { await file.close(); }
}

async function listClaudeSessions(cwd, currentId = null, home = claudeConfigDir()) {
  // Team records are the authority for workers across restarts and worktrees.
  // Read the journal only; live() also prunes the board and is not a read API.
  const team = require('./features/team/team.cjs').projectTeam(cwd);
  for (const entry of team?.entries() || []) if (entry.agent === 'claude' && entry.session) rememberClaudeSource(entry.session, 'dispatch');
  const folders = await matchingFolders(cwd, home);
  const candidates = [];
  for (const candidate of folders) {
    let entries;
    try { entries = await fs.readdir(candidate, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const entry of entries) {
      const id = entry.name.replace(/\.jsonl$/, '');
      if (!entry.isFile() || !entry.name.endsWith('.jsonl') || !SESSION_ID.test(id) || id === currentId || claudeSessionSource({ sessionId: id }) === 'dispatch') continue;
      const filename = path.join(candidate, entry.name);
      try { candidates.push({ id, filename, modified: (await fs.stat(filename)).mtimeMs }); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  candidates.sort((a, b) => b.modified - a.modified || a.id.localeCompare(b.id));
  const result = [], seen = new Set();
  for (const item of candidates) {
    if (seen.has(item.id)) continue;
    try {
      const filename = await containedFile(path.join(home, 'projects'), item.filename, { exact: true });
      if (!filename) continue;
      const summary = await sessionSummary(filename, item.id);
      if (summary) { result.push(summary); seen.add(item.id); }
      if (result.length === 30) break;
    }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return result;
}

module.exports = { claudeConfigDir, encodeClaudeCwd, findClaudeSession, listClaudeSessions, promptTitle, READ_BUDGET };
