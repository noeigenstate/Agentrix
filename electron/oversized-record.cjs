// Large user images and generated pictures are parsed with bounded pixel strings.
const HEAD = 64 * 1024;
const IMAGE_LIMIT = 2_800_000, RECORD_LIMIT = 16 * 1024 * 1024;
const IMAGE_OMITTED = Object.freeze({ omitted: true });

// Claude puts pasted screenshots between the prompt's text blocks. Keep small images intact and replace larger
// base64 strings with a small marker before parsing, so the reading view can explain why the picture is absent.
class ClaudeImageLine {
  constructor(start, keys = /"data"\s*:\s*"/, { recordLimit = RECORD_LIMIT, imageLimit = IMAGE_LIMIT } = {}) {
    this.keys = new RegExp(keys.source, 'g');
    this.recordLimit = recordLimit; this.imageLimit = imageLimit;
    this.quoted = false; this.escaped = false; this.parts = []; this.size = 0; this.buffer = Buffer.alloc(0); this.data = null;
    this.add(start);
  }
  scan(end, state = this, start = 0) {
    for (let at = start; at < end; at++) {
      const byte = this.buffer[at];
      if (state.escaped) state.escaped = false;
      else if (state.quoted && byte === 92) state.escaped = true;
      else if (byte === 34) state.quoted = !state.quoted;
    }
  }
  matchData() {
    this.keys.lastIndex = 0;
    const text = this.buffer.toString('latin1');
    const state = { quoted: this.quoted, escaped: this.escaped };
    let match, cursor = 0;
    while ((match = this.keys.exec(text))) {
      this.scan(match.index, state, cursor);
      if (!state.quoted && !state.escaped) return match;
      cursor = match.index;
    }
    return null;
  }
  keep(part) {
    if (!part.length) return;
    this.size += part.length;
    if (this.size > this.recordLimit) { this.discarded = true; this.parts = []; this.data = null; this.buffer = Buffer.alloc(0); }
    else this.parts.push(part);
  }
  pixels(part) {
    this.dataSize += part.length;
    if (this.dataSize > this.imageLimit) { this.omitted = true; this.data = []; }
    else if (!this.omitted) this.data.push(part);
  }
  add(chunk) {
    if (this.discarded) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length && !this.discarded) {
      if (this.data !== null) {
        const quote = this.buffer.indexOf(34);
        if (quote < 0) { this.pixels(this.buffer); this.buffer = Buffer.alloc(0); return; }
        this.pixels(this.buffer.subarray(0, quote));
        const rest = this.buffer.subarray(quote + 1);
        this.keep(this.omitted ? Buffer.from(JSON.stringify(IMAGE_OMITTED)) : Buffer.concat([Buffer.from('"'), ...this.data, Buffer.from('"')]));
        this.data = null; this.buffer = this.discarded ? Buffer.alloc(0) : rest;
        this.quoted = false; this.escaped = false;
      } else {
        const match = this.matchData();
        if (match) {
          const end = match.index + match[0].length;
          const rest = this.buffer.subarray(end);
          this.keep(this.buffer.subarray(0, end - 1));
          if (this.discarded) return;
          this.hasData = true; this.data = []; this.dataSize = 0; this.omitted = false; this.buffer = rest;
        } else {
          // A data key may straddle reads; bytes are decoded only once the whole record is rebuilt.
          const end = Math.max(0, this.buffer.length - 64), rest = this.buffer.subarray(end);
          this.scan(end);
          this.keep(this.buffer.subarray(0, end)); this.buffer = this.discarded ? Buffer.alloc(0) : rest;
          return;
        }
      }
    }
  }
  record() {
    if (this.discarded || !this.hasData || this.data !== null) return null;
    this.keep(this.buffer);
    if (this.discarded) return null;
    try { return JSON.parse(Buffer.concat(this.parts).toString('utf8')); } catch { return null; }
  }
}

function generatedPictureRecord(record) {
  const item = record?.payload?.item;
  if (record?.type !== 'event_msg' || record.payload?.type !== 'item_completed' || !item) return null;
  if (item.kind !== 'image_gen.generation' && item.type !== 'imageGeneration') return null;
  const { id, status, revisedPrompt, savedPath } = item;
  if (typeof savedPath !== 'string' || !savedPath) return null;
  return { timestamp: record.timestamp, type: 'event_msg', payload: { type: 'item_completed', item: {
    type: 'Extension', kind: 'image_gen.generation', id: id ?? null, status: status ?? null, revisedPrompt: revisedPrompt ?? null, savedPath,
  } } };
}

const CODEX_IMAGE_KEYS = /"data"\s*:\s*"|"(?:image_url|url)"\s*:\s*"(?=data:image\/[\w.+-]+;base64,)|"(?=data:image\/[\w.+-]+;base64,)/;
const userImageRecord = head => {
  const text = head.toString('utf8');
  return /"type"\s*:\s*"response_item"/.test(text) && /"role"\s*:\s*"user"/.test(text)
    || /"type"\s*:\s*"event_msg"/.test(text) && /"type"\s*:\s*"(?:UserMessage|user_message)"/.test(text);
};

// Both user images and generated pictures can leave their metadata after the large pixel string.
class OversizedLine {
  constructor(start) {
    if (start.length) this.add(start);
  }
  add(chunk) {
    if (this.line) { this.line.add(chunk); return; }
    this.userImage = userImageRecord(chunk.subarray(0, HEAD));
    this.line = this.userImage ? new ClaudeImageLine(chunk, CODEX_IMAGE_KEYS)
      : new ClaudeImageLine(chunk, /"result"\s*:\s*"/, { imageLimit: 0, recordLimit: 2 * HEAD });
  }
  record() {
    const record = this.line?.record();
    return this.userImage ? record : generatedPictureRecord(record);
  }
}

// Both live readers retain the same byte boundary state; only their oversized record format differs.
function readTranscriptChunk(reader, chunk, onRecord, Line = OversizedLine) {
  reader.buffer = Buffer.concat([reader.buffer, chunk]);
  let newline;
  while ((newline = reader.buffer.indexOf(10)) !== -1) {
    const line = reader.buffer.subarray(0, newline); reader.buffer = reader.buffer.subarray(newline + 1);
    // An oversized line ends here: a generated picture's record is rebuilt from its two ends.
    const oversized = reader.oversized ?? (!reader.skipping && line.length > 1024 * 1024 ? new Line(Buffer.alloc(0)) : null);
    if (oversized) { oversized.add(line); const record = oversized.record(); if (record) onRecord(record); }
    else if (!reader.skipping) { try { onRecord(JSON.parse(line.toString('utf8'), imageMetadata)); } catch { } }
    reader.skipping = false; reader.oversized = null;
  }
  if (reader.buffer.length > 1024 * 1024) {
    if (reader.oversized) reader.oversized.add(reader.buffer); else if (!reader.skipping) reader.oversized = new Line(reader.buffer);
    reader.buffer = Buffer.alloc(0); reader.skipping = true;
  }
}

const MAX_FRAME = 64 * 1024 * 1024;

// Read only envelope scalars while draining an oversized frame, including ids after its payload.
class Envelope {
  constructor() { this.depth = 0; this.quoted = false; this.escaped = false; this.token = ''; this.key = null; this.value = {}; }
  scalar() {
    if (this.depth === 1 && this.key) {
      try { this.value[this.key] = JSON.parse(this.token); } catch {}
      this.key = null;
    }
    this.token = '';
  }
  add(buffer) {
    for (let at = 0; at < buffer.length; at++) {
      const byte = buffer[at];
      if (this.quoted) {
        if (this.escaped) { this.escaped = false; if (this.depth === 1 && this.token.length < 512) this.token += String.fromCharCode(byte); continue; }
        const quote = buffer.indexOf(34, at), slash = buffer.indexOf(92, at);
        const end = Math.min(quote < 0 ? buffer.length : quote, slash < 0 ? buffer.length : slash);
        if (this.depth === 1 && this.token.length < 512) this.token += buffer.subarray(at, Math.min(end + 1, at + 512 - this.token.length)).toString('utf8');
        if (end === buffer.length) return;
        if (buffer[end] === 92) this.escaped = true; else this.quoted = false;
        at = end;
      } else if (byte === 34) { this.quoted = true; this.token = '"'; }
      else if (byte === 58 && this.depth === 1) {
        try { const name = JSON.parse(this.token); this.key = ['id', 'requestId', 'method', 'type'].includes(name) ? name : null; } catch {}
        this.token = '';
      } else if (byte === 123 || byte === 91) { ++this.depth; this.token = ''; }
      else if (byte === 125 || byte === 93) { this.scalar(); --this.depth; }
      else if (byte === 44) this.scalar();
      else if (this.depth === 1 && byte > 32 && this.token.length < 512) this.token += String.fromCharCode(byte);
    }
  }
}

function imageMetadata(_key, value) {
  if (value && typeof value === 'object' && (value.type === 'imageGeneration' || value.kind === 'image_gen.generation')) delete value.result;
  return value;
}

function stripImageResults(value) {
  const pending = [value];
  while (pending.length) {
    const item = pending.pop();
    if (!item || typeof item !== 'object') continue;
    imageMetadata('', item);
    for (const key of Object.keys(item)) if (item[key] && typeof item[key] === 'object') pending.push(item[key]);
  }
}

function jsonFrames(receive, dropped, invalid, limit = MAX_FRAME) {
  let parts = [], bytes = 0, envelope = null, generation = 0;
  const read = chunk => {
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
    let offset = 0, epoch = generation;
    while (offset < chunk.length && epoch === generation) {
      const end = chunk.indexOf(10, offset), segment = chunk.subarray(offset, end < 0 ? chunk.length : end);
      offset = end < 0 ? chunk.length : end + 1;
      bytes += segment.length;
      if (!envelope && bytes > limit) {
        envelope = new Envelope();
        for (const part of parts) envelope.add(part);
        parts = [];
      }
      if (envelope) envelope.add(segment); else parts.push(segment);
      if (end < 0) continue;
      const size = bytes, metadata = envelope?.value;
      const line = envelope ? null : Buffer.concat(parts, bytes);
      parts = []; bytes = 0; envelope = null;
      if (metadata) { dropped(metadata, size); continue; }
      let value;
      const text = line.toString('utf8');
      try { value = JSON.parse(text); } catch { invalid('invalid_json'); return; }
      // Literal searches have no backtracking stack. Escaped keys/types are decoded
      // by the native parser before the iterative walk, separate from JSON errors.
      if (text.includes('\\u') || text.includes('imageGeneration') || text.includes('image_gen.generation')) stripImageResults(value);
      receive(value);
    }
  };
  read.end = () => { if (bytes) invalid('truncated_frame'); read.clear(); };
  read.clear = () => { ++generation; parts = []; bytes = 0; envelope = null; };
  return read;
}

module.exports = { OversizedLine, ClaudeImageLine, IMAGE_LIMIT, IMAGE_OMITTED, readTranscriptChunk, MAX_FRAME, jsonFrames, imageMetadata };
