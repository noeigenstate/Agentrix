const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { rolloutFiles, sessionMeta } = require('../../session-files.cjs');
const { interactiveSession } = require('../../session-restore.cjs');
const { sameThread } = require('../../terminal-title.cjs');
const { codexConversation } = require('../../conversation.cjs');
const { promptText } = require('../../prompt-queue.cjs');
const { codexSettings } = require('../agents/agent-settings.cjs');
const { completion, nativeCompletion, turnOf } = require('./transcript-completion.cjs');

const home = (env = process.env) => env.CODEX_HOME || path.join(os.homedir(), '.codex');
const root = directory => path.join(directory, 'sessions');

async function find(_cwd, id, directory = home(), { canonicalRoot } = {}) {
  return (await rolloutFiles(canonicalRoot ?? root(directory))).find(item => item.name.endsWith(`${id}.jsonl`))?.filename;
}

async function list(cwd, directory = home()) {
  const sources = [];
  const files = (await rolloutFiles(root(directory)).catch(() => [])).sort((a, b) => b.modified - a.modified).slice(0, 3000);
  for (const file of files) {
    try {
      const meta = await sessionMeta(file.filename);
      if (interactiveSession(meta, cwd)) sources.push({ id: meta.id, filename: file.filename });
    } catch {}
  }
  return sources;
}

async function validate({ threadId, cwd }, header) {
  const end = header.indexOf(10);
  if (end < 0) return false;
  const record = JSON.parse(header.subarray(0, end).toString('utf8'));
  const meta = record.payload;
  return record.type === 'session_meta' && meta?.id === threadId && typeof meta.cwd === 'string'
    && interactiveSession({ ...meta, cwd: await fs.realpath(meta.cwd) }, cwd);
}

function record(value) {
  const settings = codexSettings(value);
  if (value.type !== 'event_msg') return settings ? { settings } : null;
  const item = value.payload || {};
  if (item.type === 'user_message') return { prompt: promptText(item.message, { ...value, ...item }) };
  if (item.type === 'item_completed' && item.item?.type === 'UserMessage') {
    return { prompt: promptText(item.item.content, { ...value, ...item, ...item.item }) };
  }
  if (item.type === 'token_count') return { usage: item.info };
  if (settings) return { settings };
  const turn = turnOf(item.type);
  return turn ? { ...turn, turnId: item.turn_id, at: Date.parse(value.timestamp) || 0 } : null;
}

const activity = {
  bound: (s, restore) => s.reportedThreadId || (restore ? s.rootThreadId : undefined),
  matches: (bound, id) => bound.length >= 8 && sameThread(id, bound),
  trackTurns: true,
};

module.exports = { home, root, find, list, validate, record, conversation: codexConversation, activity, completion, nativeCompletion };
