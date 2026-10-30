// Large user-image records are parsed with bounded pixel strings. Other oversized Codex records are skipped,
// except generated pictures: their id/state/prompt and saved path survive in the record's start and end.
const HEAD = 64 * 1024, TAIL = 8 * 1024;
const IMAGE_LIMIT = 2_800_000, RECORD_LIMIT = 16 * 1024 * 1024;
const IMAGE_OMITTED = Object.freeze({ omitted: true });

// Claude puts pasted screenshots between the prompt's text blocks. Keep small images intact and replace larger
// base64 strings with a small marker before parsing, so the reading view can explain why the picture is absent.
class ClaudeImageLine {
  constructor(start, keys = /"data"\s*:\s*"/) { this.keys = new RegExp(keys.source, 'g'); this.quoted = false; this.escaped = false; this.parts = []; this.size = 0; this.buffer = Buffer.alloc(0); this.data = null; this.add(start); }
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
    if (this.size > RECORD_LIMIT) { this.discarded = true; this.parts = []; this.data = null; this.buffer = Buffer.alloc(0); }
    else this.parts.push(part);
  }
  pixels(part) {
    this.dataSize += part.length;
    if (this.dataSize > IMAGE_LIMIT) { this.omitted = true; this.data = []; }
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

const field = (text, name) => {
  const match = new RegExp(`"${name}":"((?:[^"\\\\]|\\\\.)*)"`).exec(text);
  if (!match) return null;
  try { return JSON.parse(`"${match[1]}"`); } catch { return null; }
};

function oversizedRecord(head, tail) {
  const start = head.toString('utf8'), end = tail.toString('utf8');
  const item = start.indexOf('"item":');
  if (item < 0 || !/"kind":"image_gen\.generation"|"type":"imageGeneration"/.test(start.slice(item))) return null;
  const savedPath = field(end, 'savedPath');
  if (!savedPath) return null;
  const body = start.slice(item);
  return { timestamp: field(start, 'timestamp'), type: 'event_msg', payload: { type: 'item_completed', item: {
    type: 'Extension', kind: 'image_gen.generation', id: field(body, 'id'), status: field(body, 'status'), revisedPrompt: field(body, 'revisedPrompt'), savedPath,
  } } };
}

const CODEX_IMAGE_KEYS = /"data"\s*:\s*"|"(?:image_url|url)"\s*:\s*"(?=data:image\/[\w.+-]+;base64,)|"(?=data:image\/[\w.+-]+;base64,)/;
const userImageRecord = head => {
  const text = head.toString('utf8');
  return /"type"\s*:\s*"response_item"/.test(text) && /"role"\s*:\s*"user"/.test(text)
    || /"type"\s*:\s*"event_msg"/.test(text) && /"type"\s*:\s*"(?:UserMessage|user_message)"/.test(text);
};

// A user image may live inside an old input_image response item or an event's images array. Feed those lines
// through the same bounded parser as Claude; generated-image records still need only their two ends.
class OversizedLine {
  constructor(start) {
    this.head = Buffer.from(start.subarray(0, HEAD)); this.tail = Buffer.from(start.subarray(-TAIL));
    this.images = userImageRecord(this.head) ? new ClaudeImageLine(start, CODEX_IMAGE_KEYS) : null;
  }
  add(chunk) {
    if (!this.head.length) {
      this.head = Buffer.from(chunk.subarray(0, HEAD));
      if (userImageRecord(this.head)) { this.images = new ClaudeImageLine(chunk, CODEX_IMAGE_KEYS); return; }
    } else if (this.images) { this.images.add(chunk); return; }
    this.tail = Buffer.concat([this.tail, chunk]).subarray(-TAIL);
  }
  record() { return this.images ? this.images.record() : oversizedRecord(this.head, this.tail); }
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
    else if (!reader.skipping) { try { onRecord(JSON.parse(line.toString('utf8'))); } catch { } }
    reader.skipping = false; reader.oversized = null;
  }
  if (reader.buffer.length > 1024 * 1024) {
    if (reader.oversized) reader.oversized.add(reader.buffer); else if (!reader.skipping) reader.oversized = new Line(reader.buffer);
    reader.buffer = Buffer.alloc(0); reader.skipping = true;
  }
}

module.exports = { OversizedLine, oversizedRecord, ClaudeImageLine, IMAGE_LIMIT, IMAGE_OMITTED, readTranscriptChunk };
