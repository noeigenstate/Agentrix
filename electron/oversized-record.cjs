// An oversized Codex record (over 1 MB) is skipped, except one: Codex writes a generated picture's pixels into
// the record that reports it. What the reading view needs of it lies at its two ends, the picture's id, state and
// prompt at the start and the file it was saved to at the end, so a reader keeps the start and the end of an oversized
// line and this rebuilds the record without the pixels.
const HEAD = 64 * 1024, TAIL = 8 * 1024;
const IMAGE_LIMIT = 2_800_000, RECORD_LIMIT = 16 * 1024 * 1024;

// Claude puts pasted screenshots between the prompt's text blocks. Keep small images intact and replace larger
// base64 strings with null before parsing, so neither the pixels nor the text after them can grow memory forever.
class ClaudeImageLine {
  constructor(start) { this.parts = []; this.size = 0; this.buffer = Buffer.alloc(0); this.data = null; this.add(start); }
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
        this.keep(this.omitted ? Buffer.from('null') : Buffer.concat([Buffer.from('"'), ...this.data, Buffer.from('"')]));
        this.data = null; this.buffer = this.discarded ? Buffer.alloc(0) : rest;
      } else {
        const match = /"data"\s*:\s*"/.exec(this.buffer.toString('latin1'));
        if (match) {
          const end = match.index + match[0].length;
          const rest = this.buffer.subarray(end);
          this.keep(this.buffer.subarray(0, end - 1));
          if (this.discarded) return;
          this.hasData = true; this.data = []; this.dataSize = 0; this.omitted = false; this.buffer = rest;
        } else {
          // A data key may straddle reads; bytes are decoded only once the whole record is rebuilt.
          const end = Math.max(0, this.buffer.length - 64), rest = this.buffer.subarray(end);
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

// Follows one line that outgrew the reader's limit: the first HEAD bytes and the last TAIL bytes it had.
class OversizedLine {
  constructor(start) { this.head = Buffer.from(start.subarray(0, HEAD)); this.tail = Buffer.from(start.subarray(-TAIL)); }
  add(chunk) { this.tail = Buffer.concat([this.tail, chunk]).subarray(-TAIL); }
  record() { return oversizedRecord(this.head, this.tail); }
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

module.exports = { OversizedLine, oversizedRecord, ClaudeImageLine, IMAGE_LIMIT, readTranscriptChunk };
