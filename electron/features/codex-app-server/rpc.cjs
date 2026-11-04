const { StringDecoder } = require('node:string_decoder');

const MAX_FRAME = 4 * 1024 * 1024;
const keyOf = id => `${typeof id}:${id}`;

// A write accepted by the stream is never retried, including after backpressure or timeout.
function createRpc(child, { onNotification = () => {}, onRequest = () => {}, onDisconnect = () => {}, timeout = 8000 } = {}) {
  const decoder = new StringDecoder('utf8'), pending = new Map();
  let buffer = '', counter = 0, closed = false, blocked = false, queue = [], queuedBytes = 0;
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
  function read(chunk) {
    buffer += decoder.write(chunk);
    let end;
    while (!closed && (end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (Buffer.byteLength(line) > MAX_FRAME) return fail('frame_limit');
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
    if (Buffer.byteLength(buffer) > MAX_FRAME) fail('frame_limit');
  }
  child.stdout.on('data', read);
  child.stdout.on('end', () => fail(buffer.trim() ? 'truncated_frame' : 'disconnected'));
  child.stdin.on('drain', () => { blocked = false; flush(); });
  child.stdin.on('error', () => fail('write_failed'));
  child.on('error', error => fail(['ENOENT', 'EACCES', 'EPERM', 'EINVAL'].includes(error.code) ? error.code : 'process_failed'));
  child.once('exit', () => fail('process_exited'));
  // Drain diagnostics without forwarding provider stderr or credentials to any consumer.
  child.stderr?.on('data', () => {});
  return {
    request(method, params, deadline = timeout) {
      return new Promise((resolve, reject) => {
        const id = String(++counter), key = keyOf(id), task = { resolve, reject, sent: false };
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

module.exports = { createRpc, MAX_FRAME };
