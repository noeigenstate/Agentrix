const { randomUUID, createHash } = require('node:crypto');
const MAX_BYTES = 256 * 1024;
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const validId = id => typeof id === 'string' ? id.length > 0 && id.length <= 256 : Number.isSafeInteger(id);
const keyOf = id => `${typeof id}:${id}`;
const clone = value => JSON.parse(JSON.stringify(value));
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// A capability addresses one native request; it is never used as the provider request ID.
class NativeApprovals {
  constructor(binding, { changed = () => {}, fail = () => {}, write = () => { throw new Error('Native channel unavailable'); }, now = Date.now, ttl = 10 * 60 * 1000, maxPending = 64, maxSeen = 8192 } = {}) {
    this.binding = Object.freeze({ ...binding });
    Object.assign(this, { changed, fail, write, now, ttl, maxPending, maxSeen });
    this.records = new Map(); this.tokens = new Map(); this.closed = false;
    this.timer = setInterval(() => this.expire(), Math.min(ttl, 1000)); this.timer.unref();
  }
  fault(reason) { if (this.closed) return; this.close(); this.fail(reason); }
  close() { if (this.closed) return; this.closed = true; clearInterval(this.timer); this.tokens.clear(); this.records.clear(); this.changed(); }
  expire() {
    for (const record of this.tokens.values()) {
      if (this.now() < record.expires) continue;
      if (!record.question) { this.fault('approval-timeout'); return; }
      try { this.respond(record, 'cancel', undefined, this.write); }
      catch { this.fault('response-write-failed'); return; }
    }
  }
  add(id, method, params, decisions, response, question) {
    if (this.closed) return null;
    if (!validId(id) || !object(params) || Buffer.byteLength(JSON.stringify(params)) > MAX_BYTES) { this.fault('invalid-request'); return null; }
    const key = keyOf(id), signature = fingerprint([method, params]), previous = this.records.get(key);
    if (previous) {
      if (previous.pending && previous.signature === signature) return { duplicate: true };
      this.fault('native-id-reuse'); return null;
    }
    if (this.records.size >= this.maxSeen || this.tokens.size >= this.maxPending) { this.fault('request-limit'); return null; }
    const token = randomUUID(), data = clone(params);
    const record = { id, signature, pending: true, token, method, params: data, decisions: [...decisions], response,
      ...(question ? { question: clone(question) } : {}), expires: this.now() + this.ttl, at: this.now() };
    this.records.set(key, record); this.tokens.set(token, record); this.changed(); return record;
  }
  list() {
    this.expire();
    return [...this.tokens.values()].map(r => ({ ...this.binding, token: r.token, requestId: r.id, method: r.method,
      params: clone(r.params), decisions: [...r.decisions], ...(r.question ? { question: clone(r.question) } : {}), at: r.at }));
  }
  consume(record) { record.pending = false; this.tokens.delete(record.token); delete record.params; delete record.response; this.changed(); }
  answer(binding, answer, write, question = false) {
    this.expire();
    let bytes = Infinity;
    // Structured-cloneable answers can still contain cycles or BigInts, which are not wire JSON.
    try { bytes = Buffer.byteLength(JSON.stringify(answer)); } catch { }
    if (!object(answer) || bytes > MAX_BYTES
      || Object.keys(answer).sort().join(',') !== (question && answer.decision === 'submit' ? 'decision,token,values' : 'decision,token')) throw new Error(`Invalid native ${question ? 'question' : 'approval'} answer`);
    const r = this.tokens.get(answer.token);
    if (this.closed || !r || !!r.question !== question || Object.keys(this.binding).some(k => binding[k] !== this.binding[k])) throw new Error('Native approval expired or unsupported');
    if (!r.decisions.includes(answer.decision)) throw new Error(question ? 'Invalid native question decision' : 'Native approval expired or unsupported');
    return this.respond(r, answer.decision, answer.values, write);
  }
  respond(r, decision, values, write) {
    const message = r.response(decision, r.id, values);
    this.consume(r); // irrevocably claim before any synchronous write/callback
    if (this.closed) throw new Error('Native approval channel closed before response');
    try { write(message); } catch (error) { this.fault('response-write-failed'); throw error; }
    return { mode: 'native', requestId: r.id };
  }
  clientResponse(id) {
    this.expire();
    const r = this.records.get(keyOf(id));
    if (!r) return !this.closed; // non-approval JSON-RPC response, owned by the TUI
    if (this.closed || !r.pending) return false;
    this.consume(r); return true;
  }
  resolve(id, threadId) {
    const r = this.records.get(keyOf(id));
    if (!r || !r.pending) return;
    if (threadId !== undefined && r.params.threadId !== undefined && threadId !== r.params.threadId) { this.fault('resolution-binding-conflict'); return; }
    this.consume(r);
  }
  endTurn(threadId, turnId) {
    for (const r of this.tokens.values()) if (r.params.threadId === threadId && r.params.turnId === turnId) this.consume(r);
  }
}

module.exports = { NativeApprovals, MAX_BYTES, object, validId, fingerprint };
