const { MAX_FRAME, jsonFrames } = require('../../oversized-record.cjs');
const MAX_HISTORY_FRAME = MAX_FRAME;
const HISTORY_READS = new Set(['thread/turns/list', 'thread/items/list']);
const keyOf = id => `${typeof id}:${id}`;

// A write accepted by the stream is never retried, including after backpressure or timeout.
function createRpc(child, { onNotification = () => {}, onRequest = () => {}, onDisconnect = () => {}, onDropped = () => {}, timeout = 8000 } = {}) {
  const pending = new Map();
  let counter = 0, closed = false, blocked = false, queue = [], queuedBytes = 0;
  function fail(code = 'disconnected') {
    if (closed) return;
    closed = true;
    for (const task of pending.values()) { clearTimeout(task.timer); task.reject(Object.assign(new Error(code), { code, uncertain: task.sent })); }
    pending.clear(); queue = []; queuedBytes = 0;
    onDisconnect(code);
  }
  function flush() {
    while (!closed && !blocked && queue.length) {
      const entry = queue.shift(); queuedBytes -= Buffer.byteLength(entry.line);
      if (entry.task && !pending.has(entry.key)) continue;
      try {
        if (entry.task) entry.task.sent = true;
        blocked = !child.stdin.write(entry.line);
      } catch { fail('write_failed'); }
    }
  }
  function write(message, task) {
    if (closed) throw Object.assign(new Error('disconnected'), { code: 'disconnected' });
    const line = JSON.stringify(message) + '\n', bytes = Buffer.byteLength(line);
    if (bytes > MAX_FRAME || queuedBytes + bytes > MAX_FRAME * 2) throw Object.assign(new Error('frame_limit'), { code: 'frame_limit' });
    queue.push({ line, task, key: keyOf(message.id) }); queuedBytes += bytes; flush();
  }
  const read = jsonFrames(message => {
    if (closed) return;
    if (!message || typeof message !== 'object' || Array.isArray(message)) return fail('invalid_frame');
    if (message.id !== undefined && typeof message.id !== 'string' && !Number.isSafeInteger(message.id)) return fail('invalid_id');
    try {
      if (typeof message.method === 'string') {
        if (message.id !== undefined) onRequest(message); else onNotification(message.method, message.params || {});
      } else if (message.id !== undefined) {
        const key = keyOf(message.id), task = pending.get(key);
        if (!task) return;
        pending.delete(key); clearTimeout(task.timer);
        if (message.error) task.reject(Object.assign(new Error('rpc_rejected'), { code: message.error.code, uncertain: false,
          // 0.166 reports parameter deserialization failures as Invalid Request. Keep only this static classification.
          missingThreadId: message.error.code === -32600 && message.error.message === 'Invalid request: missing field `threadId`',
          missingThread: message.error.code === -32600 && /^no rollout found for thread id [a-f\d-]{36}$/i.test(message.error.message) }));
        else if ('result' in message) task.resolve(message.result);
        else { task.reject(Object.assign(new Error('invalid_response'), { uncertain: task.sent })); fail('invalid_response'); }
      } else fail('invalid_frame');
    } catch { fail('invalid_payload'); }
  }, (envelope, bytes) => {
    if (closed) return;
    const task = pending.get(keyOf(envelope.id));
    if (task && typeof envelope.method !== 'string') {
      pending.delete(keyOf(envelope.id)); clearTimeout(task.timer);
      const history = HISTORY_READS.has(task.method);
      task.reject(Object.assign(new Error(history ? 'history_frame_limit' : 'frame_limit'),
        { code: history ? 'history_frame_limit' : 'frame_limit', uncertain: history ? false : task.sent }));
    } else if (envelope.id !== undefined && typeof envelope.method === 'string') {
      try { write({ id: envelope.id, error: { code: -32600, message: 'Frame too large' } }); } catch {}
    }
    onDropped(bytes);
  }, fail);
  child.stdout.on('data', read);
  child.stdout.on('end', () => { read.end(); fail('disconnected'); });
  child.stdin.on('drain', () => { blocked = false; flush(); });
  child.stdin.on('error', () => fail('write_failed'));
  child.on('error', error => fail(['ENOENT', 'EACCES', 'EPERM', 'EINVAL'].includes(error.code) ? error.code : 'process_failed'));
  child.once('exit', () => fail('process_exited'));
  // Drain diagnostics without forwarding provider stderr or credentials to any consumer.
  child.stderr?.on('data', () => {});
  return {
    request(method, params, deadline = timeout) {
      return new Promise((resolve, reject) => {
        const id = String(++counter), key = keyOf(id), task = { resolve, reject, sent: false, method };
        task.timer = setTimeout(() => {
          pending.delete(key); reject(Object.assign(new Error('rpc_timeout'), { code: 'rpc_timeout', uncertain: task.sent }));
        }, deadline);
        pending.set(key, task);
        try { write({ id, method, params }, task); } catch (error) { pending.delete(key); clearTimeout(task.timer); reject(error); }
      });
    },
    notify: (method, params = {}) => write({ method, params }),
    respond: (id, result) => write({ id, result }),
    reject: (id, code = -32601) => write({ id, error: { code, message: 'Unsupported request' } }),
    close() { fail('closed'); read.clear(); try { child.stdin.end(); } catch {} },
  };
}

module.exports = { createRpc, MAX_FRAME, MAX_HISTORY_FRAME };
