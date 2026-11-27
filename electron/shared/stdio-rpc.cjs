const { MAX_FRAME, jsonFrames } = require('../oversized-record.cjs');
const STDERR_TAIL = 4096;
const WRITE_FAILURE_GRACE_MS = 250;
const PROCESS_ERROR_CODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'EINVAL']);
const noop = () => {};

function readMessages({ pending, write, fail, isClosed }, { onNotification, onRequest, onDropped, oversizedResponseCode, errorDetails }) {
  return jsonFrames(message => {
    if (isClosed()) return;
    if (!message || typeof message !== 'object' || Array.isArray(message)) return fail('invalid_frame');
    const { id, method, error } = message;
    if (id !== undefined && typeof id !== 'string' && !Number.isSafeInteger(id)) return fail('invalid_id');
    try {
      if (typeof method === 'string') {
        if (id !== undefined) onRequest(message); else onNotification(method, message.params || {});
      } else if (id !== undefined) {
        const task = pending.get(id);
        if (!task) return;
        const rejection = error && Object.assign(new Error('rpc_rejected'), { code: error.code, uncertain: false,
          serverMessage: typeof error.message === 'string' ? error.message.slice(0, 1000) : null }, errorDetails?.(error));
        pending.delete(id); clearTimeout(task.timer);
        if (rejection) task.reject(rejection);
        else if ('result' in message) task.resolve(message.result);
        else { task.reject(Object.assign(new Error('invalid_response'), { uncertain: task.sent })); fail('invalid_response'); }
      } else fail('invalid_frame');
    } catch { fail('invalid_payload'); }
  }, ({ id, method }, bytes) => {
    if (isClosed()) return;
    const task = pending.get(id), code = task && oversizedResponseCode?.(task.method);
    if (task && typeof method !== 'string') {
      pending.delete(id); clearTimeout(task.timer);
      task.reject(Object.assign(new Error(code || 'frame_limit'), { code: code || 'frame_limit', bytes, uncertain: code ? false : task.sent }));
    } else if (id !== undefined && typeof method === 'string') {
      try { write({ id, error: { code: -32600, message: 'Frame too large' } }); } catch {}
    }
    if (!code) onDropped(bytes);
  }, fail);
}

function observeProcess(child, read, fail, passthroughErrorCodes) {
  let ending = false, stderrTail = '', processError = null;
  // Close follows exit and the last pipe data.
  const processClosed = new Promise(resolve => child.once('close', () => { ending = true; resolve(); fail('process_exited'); }));
  const pipes = [child.stdin, child.stdout, child.stderr];
  const pipesClosed = pipes.map(pipe => pipe?.once ? new Promise(resolve => pipe.once('close', resolve)) : null);
  const passthrough = new Set(passthroughErrorCodes);
  child.stdout.on('end', () => { ending = true; read.end(); fail('disconnected'); });
  child.stdin.on('error', error => fail(passthrough.has(error.code) ? error.code : 'write_failed'));
  child.on('error', error => {
    ending = true; processError ||= error;
    fail(PROCESS_ERROR_CODES.has(error.code) || passthrough.has(error.code) ? error.code : 'process_failed');
  });
  child.once('exit', () => { ending = true; fail('process_exited'); });
  child.stderr?.setEncoding?.('utf8');
  child.stderr?.on('data', text => { stderrTail = (stderrTail + text).slice(-STDERR_TAIL); });
  return async function diagnostics({ stop, timers = globalThis, writeFailed = false } = {}) {
    if (ending || writeFailed) await new Promise((resolve, reject) => {
      // A bounded stop can release inherited pipes even when the process never reports close.
      const released = () => Promise.all(pipes.map((pipe, index) => pipe?.destroyed ? pipesClosed[index] : null));
      // Give a failed write time to report the exit status before cleanup can terminate the process.
      const timer = writeFailed ? timers.setTimeout(resolve, WRITE_FAILURE_GRACE_MS)
        : stop && timers.setTimeout(() => { Promise.resolve().then(stop).then(released).then(resolve, reject); }, 3000);
      processClosed.then(() => { timers.clearTimeout(timer); resolve(); });
    });
    return { stderr: stderrTail, processError: processError?.message || null, exitCode: child.exitCode ?? null, signal: child.signalCode ?? null };
  };
}

function createRpc(child, {
  jsonrpc = false, timeout = 8000, onNotification = noop, onRequest = noop, onDisconnect = noop, onDropped = noop,
  oversizedResponseCode, errorDetails, passthroughErrorCodes = [],
} = {}) {
  const pending = new Map();
  let counter = 0, closed = false, blocked = false, queue = [], queuedBytes = 0;
  function fail(code = 'disconnected') {
    if (closed) return;
    closed = true;
    for (const task of pending.values()) { clearTimeout(task.timer); task.reject(Object.assign(new Error(code), { code, uncertain: task.sent })); }
    pending.clear(); queue = []; queuedBytes = 0;
    onDisconnect(code);
  }
  // An accepted write is never retried, including after backpressure or timeout.
  function flush() {
    while (!closed && !blocked && queue.length) {
      const { line, task, id, bytes } = queue.shift(); queuedBytes -= bytes;
      if (task && !pending.has(id)) continue;
      try {
        if (task) task.sent = true;
        blocked = !child.stdin.write(line);
        if (task?.armDeadline && pending.has(id)) task.armDeadline();
        task?.onWritten?.();
      } catch { fail('write_failed'); }
    }
  }
  function write(message, task) {
    if (closed) throw Object.assign(new Error('disconnected'), { code: 'disconnected' });
    const line = JSON.stringify(jsonrpc ? { jsonrpc: '2.0', ...message } : message) + '\n', bytes = Buffer.byteLength(line);
    if (bytes > MAX_FRAME || queuedBytes + bytes > MAX_FRAME * 2) throw Object.assign(new Error('frame_limit'), { code: 'frame_limit' });
    queue.push({ line, task, id: message.id, bytes }); queuedBytes += bytes; flush();
  }
  const read = readMessages({ pending, write, fail, isClosed: () => closed }, { onNotification, onRequest, onDropped, oversizedResponseCode, errorDetails });
  const diagnostics = observeProcess(child, read, fail, passthroughErrorCodes);
  child.stdout.on('data', read);
  child.stdin.on('drain', () => { blocked = false; flush(); });
  return {
    request(method, params, deadline = timeout, { onWritten, timeoutFromWrite = false } = {}) {
      return new Promise((resolve, reject) => {
        const id = String(++counter), task = { resolve, reject, sent: false, method, onWritten };
        const arm = () => {
          clearTimeout(task.timer);
          task.timer = setTimeout(() => {
            pending.delete(id); reject(Object.assign(new Error('rpc_timeout'), { code: 'rpc_timeout', uncertain: task.sent }));
          }, deadline);
        };
        if (timeoutFromWrite) task.armDeadline = arm;
        arm();
        pending.set(id, task);
        try { write({ id, method, params }, task); } catch (error) { pending.delete(id); clearTimeout(task.timer); reject(error); }
      });
    },
    notify: (method, params = {}) => write({ method, params }),
    respond: (id, result) => write({ id, result }),
    get closed() { return closed; },
    reject: (id, code = -32601, message = 'Unsupported request') => write({ id, error: { code, message } }),
    // The process owner stops the child and ends its input.
    close() { fail('closed'); read.clear(); },
    diagnostics,
  };
}

module.exports = { createRpc, MAX_FRAME };
