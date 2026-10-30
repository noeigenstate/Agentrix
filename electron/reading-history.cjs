const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { rolloutFiles } = require('./session-files.cjs');
const { interactiveSession } = require('./session-restore.cjs');
const { findClaudeSession } = require('./claude-sessions.cjs');
const { ConversationLog, codexConversation, claudeConversation } = require('./conversation.cjs');
const { readTranscriptChunk, ClaudeImageLine } = require('./oversized-record.cjs');
const { conversationBlocks } = require('./conversation-blocks.mjs');

const INITIAL_BLOCKS = 80, PAGE_BLOCKS = 40, CHUNK = 256 * 1024, BYTE_LIMIT = 8 * 1024 * 1024;
const changedHistory = () => new Error('对话历史已变化，请重新打开会话。');
const identity = stat => `${stat.dev}:${stat.ino}`;
const inside = (root, file) => file === root || file.startsWith(root + path.sep);
const yieldTurn = () => new Promise(resolve => setImmediate(resolve));
const normalized = value => process.platform === 'win32' ? value.toLowerCase() : value;
async function anchor(filename, end) {
  const file = await fs.open(filename, 'r');
  try {
    const bytes = Buffer.alloc(Math.min(64, end));
    const { bytesRead } = await file.read(bytes, 0, bytes.length, end - bytes.length);
    return createHash('sha256').update(bytes.subarray(0, bytesRead)).digest('hex');
  } finally { await file.close(); }
}

// Decode with the live readers' converter, so pictures, queue receipts and new entry fields share one contract.
async function convert(bytes, start, source, current, settled) {
  const offsets = new Map(), log = new ConversationLog(change => {
    if (change.entry && !offsets.has(change.entry.id)) offsets.set(change.entry.id, position);
  }, 2048);
  const reader = { buffer: Buffer.alloc(0), skipping: false, oversized: null };
  let position = start, line = 0, yielded = performance.now();
  if (start) { line = bytes.indexOf(10) + 1; if (!line) return { entries: [], offsets }; }
  while (line < bytes.length) {
    const end = bytes.indexOf(10, line); if (end < 0) break;
    position = start + line;
    for (let at = line; at <= end; at += 65536) {
      readTranscriptChunk(reader, bytes.subarray(at, Math.min(at + 65536, end + 1)), record => {
        (source.agent === 'codex' ? codexConversation : claudeConversation)(log, record, source.cwd);
      }, source.agent === 'claude' ? ClaudeImageLine : undefined);
      if (performance.now() - yielded >= 8) {
        await yieldTurn(); yielded = performance.now();
        if (!current()) throw changedHistory();
      }
    }
    line = end + 1;
  }
  if (settled) log.settle();
  return { entries: log.list, offsets };
}

async function sourceFile(source) {
  const root = await fs.realpath(path.join(source.home, source.agent === 'codex' ? 'sessions' : 'projects'));
  let filename = source.filename;
  if (!filename && source.agent === 'claude') filename = await findClaudeSession(source.cwd, source.threadId, source.home);
  if (!filename && source.agent === 'codex') filename = (await rolloutFiles(root)).find(item => item.name.endsWith(`${source.threadId}.jsonl`))?.filename;
  if (!filename) throw changedHistory();
  filename = await fs.realpath(filename);
  if (!inside(normalized(root), normalized(filename))) throw changedHistory();
  const file = await fs.open(filename, 'r');
  try {
    const header = Buffer.alloc(1024 * 1024), { bytesRead } = await file.read(header, 0, header.length, 0);
    const end = header.subarray(0, bytesRead).indexOf(10);
    if (source.agent === 'codex') {
      if (end < 0) throw changedHistory();
      const record = JSON.parse(header.subarray(0, end).toString('utf8'));
      const meta = record.payload;
      if (record.type !== 'session_meta' || meta?.id !== source.threadId || typeof meta.cwd !== 'string'
        || !interactiveSession({ ...meta, cwd: await fs.realpath(meta.cwd) }, source.cwd)) throw changedHistory();
    } else {
      if (path.basename(filename) !== `${source.threadId}.jsonl`) throw changedHistory();
      const reported = /"sessionId"\s*:\s*"([\w-]+)"/.exec(header.subarray(0, bytesRead).toString('utf8'))?.[1];
      if (reported && reported !== source.threadId) throw changedHistory();
    }
    const stat = await file.stat({ bigint: true });
    return { ...source, filename, identity: identity(stat), size: Number(stat.size) };
  } finally { await file.close(); }
}

// Skip an unrenderable giant record without retaining it or repeatedly offering empty pages of its pixels.
async function lineStart(file, end, current) {
  while (end > 0) {
    if (!current()) throw changedHistory();
    const bytes = Buffer.alloc(Math.min(CHUNK, end)); end -= bytes.length;
    const { bytesRead } = await file.read(bytes, 0, bytes.length, end);
    if (bytesRead !== bytes.length) throw changedHistory();
    const newline = bytes.lastIndexOf(10);
    if (newline >= 0) return end + newline + 1;
    await yieldTurn();
  }
  return 0;
}

async function readPage(source, end, limit, current, settled = false) {
  const file = await fs.open(source.filename, 'r');
  try {
    const stat = await file.stat({ bigint: true });
    if (identity(stat) !== source.identity || Number(stat.size) < source.size || end > Number(stat.size)) throw changedHistory();
    let start = end, bytes = Buffer.alloc(0), result, blocks = [];
    const began = performance.now();
    do {
      if (!current()) throw changedHistory();
      const length = Math.min(bytes.length || CHUNK, BYTE_LIMIT - bytes.length, start), chunk = Buffer.alloc(length); start -= length;
      const { bytesRead } = await file.read(chunk, 0, length, start);
      if (bytesRead !== length) throw changedHistory();
      bytes = Buffer.concat([chunk, bytes]);
      result = await convert(bytes, start, source, current, settled);
      blocks = conversationBlocks(result.entries);
    } while (start > 0 && blocks.length <= limit && bytes.length < BYTE_LIMIT && performance.now() - began < 150);
    if (!current()) throw changedHistory();
    const selected = blocks.slice(-limit), entries = selected.flat();
    // A final line larger than the byte window still leaves a visible, copyable explanation.
    let omittedBefore;
    if (!entries.length && start > 0 && bytes.lastIndexOf(10, bytes.length - 2) < 0 && bytes.at(-1) === 10) {
      omittedBefore = await lineStart(file, start, current);
      entries.push({ id: `omitted:${source.identity}:${omittedBefore}`, at: 0, role: 'assistant', omitted: true, text: '此条对话过大，未在此显示。' });
    }
    // Carry the parent of a cut turn/group. On overlap the renderer retains its already mounted identity.
    let turn, tools;
    const metadata = new Map();
    for (const entry of result.entries) {
      if (entry.role === 'user') { turn = tools = undefined; continue; }
      turn ||= { id: entry.id, at: entry.at };
      tools = entry.role === 'tool' ? tools || { id: entry.id, at: entry.at } : undefined;
      metadata.set(entry.id, { turn, ...(tools ? { tools } : {}) });
    }
    const before = omittedBefore ?? (start > 0 || blocks.length > limit ? result.offsets.get(entries[0]?.id) ?? start : 0);
    return { entries: entries.map(entry => metadata.has(entry.id) ? { ...entry, timeline: metadata.get(entry.id) } : entry),
      before, end };
  } finally { await file.close(); }
}

// A cursor is an opaque capability for one terminal binding, never a renderer-supplied file/offset.
class ReadingHistory {
  constructor(changed = () => {}) { this.bindings = new Map(); this.requests = new Map(); this.changed = changed; }
  summary(id) { const b = this.bindings.get(id); return b?.ready ? { key: b.key, agent: b.source.agent, threadId: b.source.threadId } : null; }
  close(id) { this.requests.delete(id); if (this.bindings.delete(id)) this.changed(); }
  async bind(id, source) {
    const previous = this.bindings.get(id);
    if (previous && (source.agent !== previous.source.agent || source.threadId !== previous.source.threadId)) this.close(id);
    const request = {}; this.requests.set(id, request);
    try {
      const [cwd, home, filename] = await Promise.all([fs.realpath(source.cwd), fs.realpath(source.home), source.filename ? fs.realpath(source.filename) : null]);
      source = { ...source, cwd, home, filename };
      const signature = JSON.stringify([source.agent, source.threadId, normalized(cwd), normalized(home)]);
      if (previous?.signature === signature && (!filename || normalized(filename) === normalized(previous.source.filename))) {
        await previous.pending;
        if (this.requests.get(id) !== request) return;
        const stat = await fs.stat(previous.source.filename, { bigint: true });
        if (identity(stat) === previous.source.identity && Number(stat.size) >= previous.source.size) return;
      }
      if (this.requests.get(id) !== request) return;
      const b = { key: randomUUID(), signature, source, cursors: new Map(), pages: new Map(), ready: false };
      this.bindings.set(id, b); this.changed();
      const current = () => this.bindings.get(id) === b;
      b.pending = (async () => {
        b.source = await sourceFile(source);
        b.initial = await readPage(b.source, b.source.size, INITIAL_BLOCKS, current);
        if (current()) { b.ready = true; this.changed(); }
      })().catch(() => { if (current()) { this.bindings.delete(id); this.changed(); } });
      await b.pending;
    } catch { if (this.requests.get(id) === request) this.close(id); }
  }
  page(id, key, cursor = null) {
    const b = this.bindings.get(id);
    if (!b || b.key !== key) return Promise.reject(changedHistory());
    if (!b.pages.has(cursor)) b.pages.set(cursor, this.readPage(id, b, cursor).finally(() => b.pages.delete(cursor)));
    return b.pages.get(cursor);
  }
  async readPage(id, b, cursor) {
    await b.pending;
    const current = () => this.bindings.get(id) === b;
    if (!current() || !b.ready) throw changedHistory();
    let stat;
    try { stat = await fs.stat(b.source.filename, { bigint: true }); }
    catch { this.close(id); throw changedHistory(); }
    if (identity(stat) !== b.source.identity || Number(stat.size) < b.source.size) { this.close(id); throw changedHistory(); }
    b.source.size = Number(stat.size);
    let result;
    if (cursor !== null) {
      const before = b.cursors.get(cursor);
      if (!before) throw changedHistory();
      if (await anchor(b.source.filename, before.offset) !== before.anchor) { this.close(id); throw changedHistory(); }
      result = await readPage(b.source, before.offset, PAGE_BLOCKS, current, true);
    } else {
      if (Number(stat.size) !== b.initial.end) b.initial = await readPage(b.source, Number(stat.size), INITIAL_BLOCKS, current);
      result = b.initial;
    }
    if (!current()) throw changedHistory();
    let beforeCursor = null;
    if (result.before > 0) {
      beforeCursor = [...b.cursors].find(([, cursor]) => cursor.offset === result.before)?.[0] || randomUUID();
      if (b.cursors.size >= 256) b.cursors.delete(b.cursors.keys().next().value);
      b.cursors.set(beforeCursor, { offset: result.before, anchor: await anchor(b.source.filename, result.before) });
    }
    if (!current()) throw changedHistory();
    return { key: b.key, entries: result.entries, beforeCursor };
  }
}

module.exports = { ReadingHistory };
