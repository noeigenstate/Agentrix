const { LIVE_READ_LIMIT } = require('./transcript-window.cjs');
const RECORD_LIMIT = 16 * 1024 * 1024;

// The reading view keeps a tail, but an outstanding worker may have launched
// before that window. Replay its prefix to the completion counter only, in bounded
// reads, including the record cut by the display window's byte boundary.
class CompletionHistory {
  constructor(end) { this.end = end; this.offset = 0; this.buffer = Buffer.alloc(0); this.done = !end; this.skipping = false; this.uncertain = false; }
  async read(file, onRecord) {
    const limit = this.offset + LIVE_READ_LIMIT;
    while (!this.done && this.offset < limit) {
      const chunk = Buffer.alloc(Math.min(65536, limit - this.offset));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, this.offset);
      if (!bytesRead) return false;
      this.offset += bytesRead;
      this.buffer = Buffer.concat([this.buffer, chunk.subarray(0, bytesRead)]);
      let newline;
      while ((newline = this.buffer.indexOf(10)) !== -1) {
        const line = this.buffer.subarray(0, newline); this.buffer = this.buffer.subarray(newline + 1);
        if (!this.skipping) { try { onRecord(JSON.parse(line.toString('utf8'))); } catch { this.uncertain = true; } }
        this.skipping = false;
        if (this.offset - this.buffer.length > this.end) { this.done = true; break; }
      }
      // Tool receipts can follow large outputs or pictures in the same record.
      // Keep them beyond the display reader's cap, with a fixed memory bound.
      if (this.buffer.length > RECORD_LIMIT) {
        this.buffer = Buffer.alloc(0); this.skipping = true; this.uncertain = true;
      }
    }
    return this.done;
  }
}

module.exports = { CompletionHistory };
