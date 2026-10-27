// This folder's Codex conversations for the reading view's "恢复会话" list: newest first, named the way Codex's own
// /resume picker names them (session_index.jsonl), else by the first thing asked in them.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { rolloutFiles, sessionMeta } = require('./session-files.cjs');
const { interactiveSession } = require('./session-restore.cjs');
const { sameThread } = require('./terminal-title.cjs');

const READ_BUDGET = 256 * 1024, SCAN_LIMIT = 3000, LIST_LIMIT = 30;

// Codex names a conversation in session_index.jsonl, a line per rename: the last one for an id wins.
async function threadNames(codexHome) {
  const names = new Map();
  let text = '';
  try { text = await fs.readFile(path.join(codexHome, 'session_index.jsonl'), 'utf8'); } catch { return names; }
  for (const line of text.split('\n')) {
    try { const record = JSON.parse(line); if (record?.id && typeof record.thread_name === 'string') names.set(record.id, record.thread_name.trim()); } catch { }
  }
  return names;
}

// The first thing asked in it, and roughly how many messages it holds, from the start of its rollout.
async function rolloutSummary(filename) {
  const file = await fs.open(filename, 'r');
  try {
    const stat = await file.stat(), buffer = Buffer.alloc(Math.min(stat.size, READ_BUDGET));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const complete = bytesRead < stat.size ? buffer.subarray(0, Math.max(0, buffer.lastIndexOf(10, bytesRead - 1) + 1)) : buffer.subarray(0, bytesRead);
    const hasCompletedMessages = complete.includes('"item_completed"');
    let title = '', messages = 0;
    for (const line of complete.toString('utf8').split('\n')) {
      let record; try { record = JSON.parse(line); } catch { continue; }
      if (record?.type !== 'event_msg') continue;
      const payload = record.payload || {}, item = payload.item || {};
      const user = payload.type === 'user_message' || (payload.type === 'item_completed' && item.type === 'UserMessage');
      const agent = payload.type === 'agent_message' || (payload.type === 'item_completed' && item.type === 'AgentMessage');
      // Newer Codex reports a message both ways; the completed item is the one counted.
      if ((user || agent) && (payload.type === 'item_completed' || !hasCompletedMessages)) messages++;
      if (!title && user) {
        const text = typeof payload.message === 'string' ? payload.message
          : (Array.isArray(item.content) ? item.content.map(part => typeof part?.text === 'string' ? part.text : '').join(' ') : '');
        const line = text.replace(/\s+/g, ' ').trim();
        if (line && !line.startsWith('<')) title = [...line].slice(0, 60).join('');
      }
    }
    if (stat.size > bytesRead && complete.length) messages = Math.round(messages * stat.size / complete.length);
    return { title, messages, updatedAt: stat.mtimeMs };
  } finally { await file.close(); }
}

async function listCodexSessions(cwd, currentId = null, codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')) {
  const files = (await rolloutFiles(path.join(codexHome, 'sessions'))).sort((a, b) => b.modified - a.modified).slice(0, SCAN_LIMIT);
  const names = await threadNames(codexHome), result = [];
  for (const file of files) {
    if (result.length >= LIST_LIMIT) break;
    let meta; try { meta = await sessionMeta(file.filename); } catch { continue; }
    // currentId may be only how its id begins (a title cut short, before its first round).
    if (!interactiveSession(meta, cwd) || sameThread(meta.id, currentId)) continue;
    try {
      const summary = await rolloutSummary(file.filename);
      result.push({ id: meta.id, updatedAt: summary.updatedAt, title: names.get(meta.id) || summary.title, messages: summary.messages });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return result;
}

module.exports = { listCodexSessions };
