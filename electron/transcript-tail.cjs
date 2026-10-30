const fs = require('node:fs/promises');
const { transcriptWindow, LIVE_READ_LIMIT } = require('./transcript-window.cjs');
const { CompletionHistory } = require('./completion-history.cjs');
const { ClaudeImageLine, readTranscriptChunk } = require('./oversized-record.cjs');

// Follows a growing JSON-lines file from where the last read stopped, a bounded amount per call.
class TranscriptTail {
  constructor(filename, { onHistory = () => {}, onWorkRecord = null, onReset = () => {}, catchUpHistory = false, isCurrent = () => true } = {}) {
    this.filename = filename; this.offset = 0; this.buffer = Buffer.alloc(0); this.skipping = false; this.oversized = null;
    this.onHistory = onHistory; this.historyPending = true; onHistory(false);
    this.onWorkRecord = onWorkRecord;
    this.onReset = onReset;
    this.catchUpHistory = catchUpHistory; this.isCurrent = isCurrent;
  }
  async read(onRecord) {
    let file; try { file = await fs.open(this.filename, 'r'); } catch { return false; }
    try {
      // NTFS file IDs can exceed Number's exact range; keep their identity as bigint.
      const stat = await file.stat({ bigint: true }), size = Number(stat.size);
      const identity = `${stat.dev}:${stat.ino}`;
      if (this.fileIdentity !== identity || size < this.fileSize) {
        const rebinding = this.fileIdentity != null;
        Object.assign(this, transcriptWindow(size)); this.buffer = Buffer.alloc(0); this.oversized = null;
        this.workHistory = this.onWorkRecord ? new CompletionHistory(this.offset) : null;
        this.historyPending = true;
        if (rebinding) this.onHistory(false);
        await this.onReset(this.offset > 0, file);
      }
      this.fileIdentity = identity; this.fileSize = size;
      if (this.workHistory && !await (this.catchUpHistory
        ? this.workHistory.catchUp(file, this.onWorkRecord, this.isCurrent)
        : this.workHistory.read(file, this.onWorkRecord))) return;
      const end = this.historyPending ? size : Math.min(size, this.offset + LIVE_READ_LIMIT);
      while (this.offset < end) {
        const chunk = Buffer.alloc(Math.min(65536, end - this.offset));
        const { bytesRead } = await file.read(chunk, 0, chunk.length, this.offset);
        if (!bytesRead) break;
        this.offset += bytesRead;
        readTranscriptChunk(this, chunk.subarray(0, bytesRead), onRecord, ClaudeImageLine);
      }
      if (this.historyPending && this.offset >= size) { this.historyPending = false; this.onHistory(true); }
      return true;
    } finally { await file.close(); }
  }
}

module.exports = { TranscriptTail };
