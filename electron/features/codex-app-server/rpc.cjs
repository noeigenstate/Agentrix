const MAX_FRAME = 4 * 1024 * 1024;
const MAX_HISTORY_FRAME = 16 * 1024 * 1024;
const HISTORY_READS = new Set(['thread/turns/list', 'thread/items/list']);
const keyOf = id => `${typeof id}:${id}`;

// A write accepted by the stream is never retried, including after backpressure or timeout.
function createRpc(child, { onNotification = () => {}, onRequest = () => {}, onDisconnect = () => {}, timeout = 8000 } = {}) {
  const pending = new Map();
  let parts = [], bytes = 0, prefix = '', discarding = false, counter = 0, closed = false, blocked = false, queue = [], queuedBytes = 0;
  function fail(code = 'disconnected') {
    if (closed) return;
    closed = true;
    for (const task of pending.values()) { clearTimeout(task.timer); task.reject(Object.assign(new Error(code), { code, uncertain: task.sent })); }
    pending.clear(); queue = []; queuedBytes = 0; parts = []; bytes = 0; prefix = '';
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
  function historyResponse() {
    // Our string request IDs lead real app-server response envelopes. Never discard an unbound frame.
    const id = /^\s*\{\s*"id"\s*:\s*"(\d+)"\s*,\s*"result"\s*:/.exec(prefix)?.[1];
    const task = id && pending.get(keyOf(id));
    return task && HISTORY_READS.has(task.method) ? { id, task } : null;
  }
  function read(chunk) {
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
    let offset = 0;
    while (!closed && offset < chunk.length) {
      const end = chunk.indexOf(10, offset), segment = chunk.subarray(offset, end < 0 ? chunk.length : end);
      offset = end < 0 ? chunk.length : end + 1;
      if (!discarding) {
        if (prefix.length < 256) prefix += segment.subarray(0, 256 - prefix.length).toString('ascii');
        const history = historyResponse(), limit = history ? MAX_HISTORY_FRAME : MAX_FRAME;
        if (bytes + segment.length > limit) {
          if (!history) return fail('frame_limit');
          // History is optional, read-only data. Drain this one response without losing the live session.
          pending.delete(keyOf(history.id)); clearTimeout(history.task.timer);
          history.task.reject(Object.assign(new Error('history_frame_limit'), { code: 'history_frame_limit', uncertain: false }));
          parts = []; bytes = 0; discarding = true;
        } else { parts.push(segment); bytes += segment.length; }
      }
      if (end < 0) continue;
      if (discarding) { discarding = false; prefix = ''; continue; }
      // Decode and parse once per bounded frame; repeated string concatenation rescans long UTF-8 frames.
      const line = Buffer.concat(parts, bytes).toString('utf8'); parts = []; bytes = 0; prefix = '';
      let message;
      try { message = JSON.parse(line); } catch { return fail('invalid_json'); }
      if (!message || typeof message !== 'object' || Array.isArray(message)) return fail('invalid_frame');
      if (message.id !== undefined && typeof message.id !== 'string' && !Number.isSafeInteger(message.id)) return fail('invalid_id');
      try {
        if (typeof message.method === 'string') {
          if (message.id !== undefined) onRequest(message); else onNotification(message.method, message.params || {});
        } else if (message.id !== undefined) {
          const key = keyOf(message.id), task = pending.get(key);
          if (!task) continue;
          pending.delete(key); clearTimeout(task.timer);
          if (message.error) task.reject(Object.assign(new Error('rpc_rejected'), { code: message.error.code, uncertain: false,
            // 0.166 reports parameter deserialization failures as Invalid Request. Keep only this static classification.
            missingThreadId: message.error.code === -32600 && message.error.message === 'Invalid request: missing field `threadId`',
            missingThread: message.error.code === -32600 && /^no rollout found for thread id [a-f\d-]{36}$/i.test(message.error.message) }));
          else if ('result' in message) task.resolve(message.result);
          else { task.reject(Object.assign(new Error('invalid_response'), { uncertain: task.sent })); fail('invalid_response'); }
        } else fail('invalid_frame');
      } catch { fail('invalid_payload'); }
    }
  }
  child.stdout.on('data', read);
  child.stdout.on('end', () => fail(bytes || discarding ? 'truncated_frame' : 'disconnected'));
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
    close() { fail('closed'); try { child.stdin.end(); } catch {} },
  };
}

module.exports = { createRpc, MAX_FRAME, MAX_HISTORY_FRAME };
