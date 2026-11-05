const { TextDecoder } = require('node:util');
const { createHash } = require('node:crypto');
const MAX_BYTES = 256 * 1024;
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const validId = id => typeof id === 'string' ? id.length > 0 && id.length <= 256 : Number.isSafeInteger(id);
const keyOf = id => JSON.stringify([typeof id, id]);
const validRpc = m => object(m) && (m.jsonrpc === undefined || m.jsonrpc === '2.0') && (Object.hasOwn(m, 'method')
  ? typeof m.method === 'string' && m.method.length > 0 && m.method.length <= 256 && (!Object.hasOwn(m, 'id') || validId(m.id))
  : validId(m.id) && Object.hasOwn(m, 'result') !== Object.hasOwn(m, 'error'));

// CLI stdout is newline-delimited JSON, never a terminal/text parser. Fatal UTF-8 and bounded partial records.
class JsonLines {
  constructor(message, fail, limit = MAX_BYTES) { Object.assign(this, { message, fail, limit }); this.decoder = new TextDecoder('utf-8', { fatal: true }); this.buffer = ''; this.closed = false; }
  push(bytes) {
    if (this.closed) return;
    try {
      const text = this.decoder.decode(bytes, { stream: true });
      for (const piece of text.split(/(?<=\n)/)) {
        this.buffer += piece;
        if (Buffer.byteLength(this.buffer) > this.limit) throw new Error('oversized-json');
        if (!this.buffer.endsWith('\n')) continue;
        const line = this.buffer.trim(); this.buffer = '';
        if (!line) continue;
        const value = JSON.parse(line);
        if (!object(value)) throw new Error('invalid-json-envelope');
        this.message(value);
        if (this.closed) return;
      }
    } catch { this.closed = true; this.fail('malformed-native-stream'); }
  }
  end() {
    if (this.closed) return;
    try { this.buffer += this.decoder.decode(); if (this.buffer.trim()) throw new Error(); }
    catch { this.fail('truncated-native-stream'); }
    this.closed = true;
  }
}

// Only the remote TUI owns responses. The proxy validates framing and correlates typed request IDs;
// it creates no capabilities, answers, cancellation timers or schema-dependent replacement dialogs.
class CodexProtocol {
  constructor(fail = () => {}, maxSeen = 8192) { this.fail = fail; this.maxSeen = maxSeen; this.issued = new Map(); this.closed = false; }
  close() { this.closed = true; this.issued.clear(); }
  fault(reason) { if (!this.closed) { this.close(); this.fail(reason); } return false; }
  server(message) {
    if (this.closed) return false;
    if (!validRpc(message)) return this.fault('invalid-server-envelope');
    if (message.method && Object.hasOwn(message, 'id')) {
      const key = keyOf(message.id), previous = this.issued.get(key);
      const signature = createHash('sha256').update(JSON.stringify(message)).digest('hex');
      if (previous) return previous.pending && previous.signature === signature ? false : this.fault('native-id-reuse');
      if (this.issued.size >= this.maxSeen) return this.fault('request-limit');
      this.issued.set(key, { signature, pending: true, thread: message.params?.threadId });
    }
    if (message.method === 'serverRequest/resolved') {
      const params = message.params;
      if (!object(params) || !validId(params.requestId) || typeof params.threadId !== 'string') return this.fault('invalid-resolution');
      const issued = this.issued.get(keyOf(params.requestId));
      if (issued && issued.thread !== undefined && issued.thread !== params.threadId) return this.fault('resolution-binding-conflict');
      if (issued) issued.pending = false;
    }
    return true;
  }
  client(message) {
    if (this.closed) return false;
    if (!validRpc(message)) return this.fault('invalid-client-envelope');
    if (Object.hasOwn(message, 'method')) return true;
    const issued = this.issued.get(keyOf(message.id));
    if (!issued) return this.fault('unknown-client-response');
    if (!issued.pending) return false;
    issued.pending = false;
    return true;
  }
}

// A write accepted into a backed-up pipe is not retried. Close the connection rather than queue another approval.
function writeJson(stream, message, fail) {
  if (stream.destroyed || stream.writableEnded || stream.writableLength > MAX_BYTES) throw new Error('Native channel unavailable');
  const data = JSON.stringify(message) + '\n';
  if (Buffer.byteLength(data) > MAX_BYTES) throw new Error('Native response too large');
  if (!stream.write(data, error => { if (error) fail('native-write-error'); })) { fail('native-backpressure'); throw new Error('Native channel backpressure'); }
}
module.exports = { JsonLines, CodexProtocol, writeJson, MAX_BYTES };
