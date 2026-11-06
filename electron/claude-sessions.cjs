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

async function belongsToProject(filename, identity, knownFolder, identities = new Map()) {
  // Preserve the CLI's exact namespace, including old/relocated transcripts
  // whose first cwd no longer exists. Only additional alias folders need proof.
  if (knownFolder) return true;
  const cwd = await recordedProject(filename);
  // Older transcripts may have no cwd. Only their exact project folder remains
  // admissible; an arbitrary alias candidate always needs filesystem identity.
  if (!cwd) return false;
  if (!path.isAbsolute(cwd) || process.platform === 'win32' && /^[\\/]{2}/.test(cwd) && !/^[\\/]{2}/.test(identity)) return false;
  if (!identities.has(cwd)) identities.set(cwd, projectIdentity(cwd).catch(() => null));
  return await identities.get(cwd) === identity;
}

async function directories(folder) {
  try { return (await fs.readdir(folder, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => path.join(folder, entry.name)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

async function findClaudeSession(cwd, id, home = claudeConfigDir(), { strict = false } = {}) {
  if (typeof id !== 'string' || !SESSION_ID.test(id)) return null;
  const folder = projectFolder(cwd, home);
  const identity = await projectIdentity(cwd);
  for (const candidate of new Set([folder, ...await directories(path.join(home, 'projects'))])) {
    const filename = await containedFile(path.join(home, 'projects'), path.join(candidate, `${id}.jsonl`), { exact: strict });
    if (filename && await belongsToProject(filename, identity, candidate === folder)) return filename;
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
  const folder = projectFolder(cwd, home), identity = await projectIdentity(cwd), identities = new Map();
  const candidates = [];
  for (const candidate of new Set([folder, ...await directories(path.join(home, 'projects'))])) {
    let entries;
    try { entries = await fs.readdir(candidate, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const entry of entries) {
      const id = entry.name.replace(/\.jsonl$/, '');
      if (!entry.isFile() || !entry.name.endsWith('.jsonl') || !SESSION_ID.test(id) || id === currentId || claudeSessionSource({ sessionId: id }) === 'dispatch') continue;
      const filename = path.join(candidate, entry.name);
      try { candidates.push({ id, filename, knownFolder: candidate === folder, modified: (await fs.stat(filename)).mtimeMs }); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  candidates.sort((a, b) => b.modified - a.modified || a.id.localeCompare(b.id));
  const result = [], seen = new Set();
  for (const item of candidates) {
    if (seen.has(item.id)) continue;
    try {
      const filename = await containedFile(path.join(home, 'projects'), item.filename, { exact: true });
      if (!filename || !await belongsToProject(filename, identity, item.knownFolder, identities)) continue;
      const summary = await sessionSummary(filename, item.id);
      if (summary) { result.push(summary); seen.add(item.id); }
      if (result.length === 30) break;
    }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return result;
}

module.exports = { claudeConfigDir, encodeClaudeCwd, findClaudeSession, listClaudeSessions, promptTitle, READ_BUDGET };
