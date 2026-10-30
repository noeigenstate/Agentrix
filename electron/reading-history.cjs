const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { rolloutFiles } = require('./session-files.cjs');
const { interactiveSession } = require('./session-restore.cjs');
const { findClaudeSession } = require('./claude-sessions.cjs');
const { ConversationLog, codexConversation, claudeConversation } = require('./conversation.cjs');
const { readTranscriptChunk, ClaudeImageLine } = require('./oversized-record.cjs');

const INITIAL_BLOCKS = 80, PAGE_BLOCKS = 40, CHUNK = 256 * 1024, BYTE_LIMIT = 8 * 1024 * 1024;
const changedHistory = () => new Error('对话历史已变化，请重新打开会话。');
const identity = stat => `${stat.dev}:${stat.ino}`;
const inside = (root, file) => file === root || file.startsWith(root + path.sep);
const yieldTurn = () => new Promise(resolve => setImmediate(resolve));
async function anchor(filename, end) {
  const file = await fs.open(filename, 'r');
  try {
    const bytes = Buffer.alloc(Math.min(64, end));
    const { bytesRead } = await file.read(bytes, 0, bytes.length, end - bytes.length);
    return createHash('sha256').update(bytes.subarray(0, bytesRead)).digest('hex');
  } finally { await file.close(); }
}

function grouped(entries) {
  const blocks = [];
  for (const entry of entries) {
    const last = blocks.at(-1);
    if (entry.role === 'tool' && last?.[0].role === 'tool') last.push(entry);
    else blocks.push([entry]);
  }
  return blocks;
}

// Decode with the live readers' converter, so pictures, queue receipts and new entry fields share one contract.
async function convert(bytes, start, source) {
  const offsets = new Map(), log = new ConversationLog(change => {
    if (change.entry && !offsets.has(change.entry.id)) offsets.set(change.entry.id, position);
  }, 2048);
  const reader = { buffer: Buffer.alloc(0), skipping: false, oversized: null };
  let position = start, line = 0, records = 0;
  if (start) { line = bytes.indexOf(10) + 1; if (!line) return { entries: [], offsets }; }
  while (line < bytes.length) {
    const end = bytes.indexOf(10, line); if (end < 0) break;
    position = start + line;
    for (let at = line; at <= end; at += 65536) {
      readTranscriptChunk(reader, bytes.subarray(at, Math.min(at + 65536, end + 1)), record => {
        (source.agent === 'codex' ? codexConversation : claudeConversation)(log, record, source.cwd);
      }, source.agent === 'claude' ? ClaudeImageLine : undefined);
    }
    line = end + 1;
    if (++records % 256 === 0) await yieldTurn();
  }
  return { entries: log.list, offsets };
}

async function sourceFile(source) {
  const root = await fs.realpath(path.join(source.home, source.agent === 'codex' ? 'sessions' : 'projects'));
  let filename = source.filename;
  if (!filename && source.agent === 'claude') filename = await findClaudeSession(source.cwd, source.threadId, source.home);
  if (!filename && source.agent === 'codex') filename = (await rolloutFiles(root)).find(item => item.name.endsWith(`${source.threadId}.jsonl`))?.filename;
  if (!filename) throw changedHistory();
  filename = await fs.realpath(filename);
  const normalized = value => process.platform === 'win32' ? value.toLowerCase() : value;
  if (!inside(normalized(root), normalized(filename))) throw changedHistory();
  const file = await fs.open(filename, 'r');
  try {
    const header = Buffer.alloc(1024 * 1024), { bytesRead } = await file.read(header, 0, header.length, 0);
    const end = header.subarray(0, bytesRead).indexOf(10);
    if (source.agent === 'codex') {
      if (end < 0) throw changedHistory();
      const record = JSON.parse(header.subarray(0, end).toString('utf8'));
      if (record.type !== 'session_meta' || record.payload?.id !== source.threadId || !interactiveSession(record.payload, source.cwd)) throw changedHistory();
    } else {
      if (path.basename(filename) !== `${source.threadId}.jsonl`) throw changedHistory();
      const reported = /"sessionId"\s*:\s*"([\w-]+)"/.exec(header.subarray(0, bytesRead).toString('utf8'))?.[1];
      if (reported && reported !== source.threadId) throw changedHistory();
    }
    const stat = await file.stat({ bigint: true });
    return { ...source, filename, identity: identity(stat), size: Number(stat.size) };
  } finally { await file.close(); }
}

async function readPage(source, end, limit, current) {
  const file = await fs.open(source.filename, 'r');
  try {
    const stat = await file.stat({ bigint: true });
    if (identity(stat) !== source.identity || Number(stat.size) < source.size || end > Number(stat.size)) throw changedHistory();
    let start = end, bytes = Buffer.alloc(0), result, blocks = [];
    const began = performance.now();
    do {
      if (!current()) throw changedHistory();
      const length = Math.min(CHUNK, start), chunk = Buffer.alloc(length); start -= length;
      const { bytesRead } = await file.read(chunk, 0, length, start);
      if (bytesRead !== length) throw changedHistory();
      bytes = Buffer.concat([chunk, bytes]);
      result = await convert(bytes, start, source);
      blocks = grouped(result.entries);
    } while (start > 0 && blocks.length <= limit && bytes.length < BYTE_LIMIT && performance.now() - began < 150);
    if (!current()) throw changedHistory();
    const selected = blocks.slice(-limit), entries = selected.flat();
    // Carry the parent of a cut turn/group. On overlap the renderer retains its already mounted identity.
    let turn, tools;
    const metadata = new Map();
    for (const entry of result.entries) {
      if (entry.role === 'user') { turn = tools = undefined; continue; }
      turn ||= { id: entry.id, at: entry.at };
      tools = entry.role === 'tool' ? tools || { id: entry.id, at: entry.at } : undefined;
      metadata.set(entry.id, { turn, ...(tools ? { tools } : {}) });
    }
    const before = entries.length ? result.offsets.get(entries[0].id) ?? start : start;
    return { entries: entries.map(entry => metadata.has(entry.id) ? { ...entry, timeline: metadata.get(entry.id) } : entry),
      before, hasEarlier: start > 0 || blocks.length > limit, watermark: end, bytesRead: bytes.length };
  } finally { await file.close(); }
}

// A cursor is an opaque capability for one terminal binding, never a renderer-supplied file/offset.
class ReadingHistory {
  constructor(changed = () => {}) { this.bindings = new Map(); this.changed = changed; }
  summary(id) { const b = this.bindings.get(id); return b?.ready ? { key: b.key, agent: b.source.agent, threadId: b.source.threadId } : null; }
  close(id) { if (this.bindings.delete(id)) this.changed(); }
  bind(id, source) {
    const signature = JSON.stringify([source.agent, source.threadId, path.resolve(source.cwd), path.resolve(source.home)]);
    const previous = this.bindings.get(id);
    if (previous?.signature === signature && (!source.filename || path.resolve(source.filename) === previous.source.filename)) return previous.pending.then(async () => {
      if (this.bindings.get(id) !== previous || !previous.ready) return;
      try {
        const stat = await fs.stat(previous.source.filename, { bigint: true });
        if (identity(stat) === previous.source.identity && Number(stat.size) >= previous.source.size) return;
      } catch { }
      this.close(id); return this.bind(id, source);
    });
    const b = { key: randomUUID(), signature, source, cursors: new Map(), ready: false };
    this.bindings.set(id, b); this.changed();
    const current = () => this.bindings.get(id) === b;
    b.pending = (async () => {
      b.source = await sourceFile(source);
      b.initial = await readPage(b.source, b.source.size, INITIAL_BLOCKS, current);
      if (current()) { b.ready = true; this.changed(); }
    })().catch(() => { if (current()) { this.bindings.delete(id); this.changed(); } });
    return b.pending;
  }
  async page(id, key, cursor = null) {
    const b = this.bindings.get(id);
    if (!b || b.key !== key) throw changedHistory();
    await b.pending;
    const current = () => this.bindings.get(id) === b;
    if (!current() || !b.ready) throw changedHistory();
    let stat;
    try { stat = await fs.stat(b.source.filename, { bigint: true }); }
    catch { this.close(id); throw changedHistory(); }
    if (identity(stat) !== b.source.identity || Number(stat.size) < b.source.size) { this.close(id); throw changedHistory(); }
    let result;
    if (cursor !== null) {
      const before = b.cursors.get(cursor);
      if (!before) throw changedHistory();
      if (await anchor(b.source.filename, before.offset) !== before.anchor) { this.close(id); throw changedHistory(); }
      result = await readPage(b.source, before.offset, PAGE_BLOCKS, current);
    } else {
      if (Number(stat.size) !== b.initial.watermark) b.initial = await readPage(b.source, Number(stat.size), INITIAL_BLOCKS, current);
      result = b.initial;
    }
    if (!current()) throw changedHistory();
    let beforeCursor = null;
    if (result.hasEarlier && result.before > 0) {
      beforeCursor = [...b.cursors].find(([, cursor]) => cursor.offset === result.before)?.[0] || randomUUID();
      if (b.cursors.size >= 256) b.cursors.delete(b.cursors.keys().next().value);
      b.cursors.set(beforeCursor, { offset: result.before, anchor: await anchor(b.source.filename, result.before) });
    }
    if (!current()) throw changedHistory();
    return { key, entries: result.entries, beforeCursor, hasEarlier: !!beforeCursor, watermark: result.watermark };
  }
}

module.exports = { ReadingHistory, INITIAL_BLOCKS, PAGE_BLOCKS };
