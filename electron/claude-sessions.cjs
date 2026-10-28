const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { messageText, promptText } = require('./prompt-queue.cjs');

const SESSION_ID = /^[\w-]{1,100}$/;
const READ_BUDGET = 256 * 1024;
const claudeConfigDir = () => path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
// Claude replaces each non-ASCII-alphanumeric character, including each CJK character, separately.
const encodeClaudeCwd = cwd => cwd.replace(/[^A-Za-z0-9]/gu, '-');
const projectFolder = (cwd, home) => path.join(home, 'projects', encodeClaudeCwd(cwd));

async function directories(folder) {
  try { return (await fs.readdir(folder, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => path.join(folder, entry.name)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

async function findClaudeSession(cwd, id, home = claudeConfigDir()) {
  if (typeof id !== 'string' || !SESSION_ID.test(id)) return null;
  const folder = projectFolder(cwd, home);
  // Prefer the known project; scan only session transcripts if encoding differs at the edges.
  let folders;
  try { await fs.access(folder); folders = [folder]; }
  catch (error) { if (error.code !== 'ENOENT') throw error; folders = await directories(path.join(home, 'projects')); }
  for (const candidate of folders) {
    const filename = path.join(candidate, `${id}.jsonl`);
    try { if ((await fs.stat(filename)).isFile()) return filename; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
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
    let title = '', messages = 0;
    for (const line of complete.toString('utf8').split('\n')) {
      try {
        const record = JSON.parse(line);
        if (record.type === 'user' || record.type === 'assistant') messages++;
        if (!title) title = promptTitle(record);
      } catch { /* malformed/partial JSONL is not a session title */ }
    }
    // Exact for small files; extrapolate the user+assistant record density for larger ones.
    if (stat.size > bytesRead && complete.length) messages = Math.round(messages * stat.size / complete.length);
    return { id, updatedAt: stat.mtimeMs, title, messages };
  } finally { await file.close(); }
}

async function listClaudeSessions(cwd, currentId = null, home = claudeConfigDir()) {
  const folder = projectFolder(cwd, home);
  let entries;
  try { entries = await fs.readdir(folder, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const candidates = [];
  for (const entry of entries) {
    const id = entry.name.replace(/\.jsonl$/, '');
    if (!entry.isFile() || !entry.name.endsWith('.jsonl') || !SESSION_ID.test(id) || id === currentId) continue;
    const filename = path.join(folder, entry.name);
    try { candidates.push({ id, filename, modified: (await fs.stat(filename)).mtimeMs }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  candidates.sort((a, b) => b.modified - a.modified || a.id.localeCompare(b.id));
  const result = [];
  for (const item of candidates.slice(0, 30)) {
    try { result.push(await sessionSummary(item.filename, item.id)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return result;
}

module.exports = { claudeConfigDir, encodeClaudeCwd, findClaudeSession, listClaudeSessions, promptTitle, READ_BUDGET };
