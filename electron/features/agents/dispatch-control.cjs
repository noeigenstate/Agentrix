const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const { projectTeam } = require('../team/team.cjs');

/**
 * @typedef {{operation:'read'|'edit'|'command'|'network'|'other', toolName:string, cwd:string|null,
 * paths:string[], command:string|null, argv:string[]|null, requestsNetwork:boolean|null}} ToolIntent
 * @typedef {{behavior:'allow'|'deny'|'ask', reasonCode:string, reason:string}} ToolDecision
 * A converts Claude tools to ToolIntent and applies its policy. This channel never executes a tool.
 */

const MAX_FRAME = 4 * 1024 * 1024;
const validId = value => typeof value === 'string' && /^[\w-]{1,160}$/.test(value);
const status = value => ['queued', 'delivered', 'rejected', 'unknown'].includes(value);

function frames(socket, receive, disconnected) {
  const decoder = new StringDecoder('utf8');
  let buffer = '', queue = [], bytes = 0, blocked = false, ended = false;
  const flush = () => {
    while (!blocked && queue.length && !socket.destroyed) {
      const line = queue.shift(); bytes -= Buffer.byteLength(line); blocked = !socket.write(line);
    }
  };
  socket.on('drain', () => { blocked = false; flush(); });
  socket.on('data', chunk => {
    buffer += decoder.write(chunk);
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (Buffer.byteLength(line) > MAX_FRAME) return socket.destroy();
      try { const value = JSON.parse(line); if (!value || value.v !== 1) return socket.destroy(); receive(value); }
      catch { return socket.destroy(); }
    }
    if (Buffer.byteLength(buffer) > MAX_FRAME) socket.destroy();
  });
  socket.on('error', () => socket.destroy());
  socket.once('close', () => { if (!ended) { ended = true; disconnected(); } });
  return value => {
    if (socket.destroyed) throw new Error('control_disconnected');
    const line = JSON.stringify({ ...value, v: 1 }) + '\n', size = Buffer.byteLength(line);
    if (size > MAX_FRAME || bytes + size > MAX_FRAME * 2) { socket.destroy(); throw new Error('control_frame_limit'); }
    queue.push(line); bytes += size; flush();
  };
}

function createDispatchControl({ resolveRun, now = Date.now }) {
  const clients = new Map(), handlers = new Map(), sockets = new Set(), receipts = new Map();
  let server, address;
  function accept(socket, registration) {
    sockets.add(socket);
    let client, registering = false, send;
    const handle = async value => {
      if (!client) {
        if (registering || value.type !== 'register' || !validId(value.runId)) return socket.destroy();
        registering = true;
        // Credentials are consumed by main's resolver, never retained or sent to the provider.
        const verified = await resolveRun({ runId: value.runId, projectId: value.projectId, sessionKey: value.sessionKey, capability: value.capability });
        if (!verified || verified.runId !== value.runId || verified.projectId !== value.projectId || !path.isAbsolute(verified.cwd || '') || !Array.isArray(verified.allow) || socket.destroyed) return socket.destroy();
        // A worker may tighten its admitted mode (for example --permission plan), never loosen main's binding.
        const run = { ...verified, readOnly: !!verified.readOnly || value.readOnly === true, roundtable: !!verified.roundtable || value.roundtable === true };
        const agent = verified.agent || projectTeam(verified.cwd)?.live().find(entry => entry.id === verified.runId)?.agent;
        if (agent) run.agent = agent;
        if (clients.has(run.runId)) return socket.destroy();
        client = { run, send, pending: new Map(), control: null, requests: new Set(), delivered: new Map(), sdkRequested: false, supportsFinish: value.finishProtocol === 1 };
        clients.set(run.runId, client); socket.setTimeout(0);
        send({ type: 'registered', runId: run.runId }); return;
      }
      if (value.type === 'receipt' && validId(value.messageId) && status(value.status)) {
        const task = client.pending.get(value.messageId);
        if (task) { clearTimeout(task.timer); client.pending.delete(value.messageId); task.resolve({ messageId: value.messageId, status: value.status }); }
      } else if (value.type === 'request' && validId(value.requestId) && typeof value.method === 'string') {
        if (client.requests.has(value.requestId) || client.requests.size >= 4000) return socket.destroy();
        client.requests.add(value.requestId);
        if (value.method === 'claude-sdk.run') {
          if (client.run.agent !== 'claude' || client.sdkRequested) return send({ type: 'result', requestId: value.requestId, ok: false, error: 'run_binding_rejected' });
          client.sdkRequested = true;
        }
        const handler = value.method === 'control.finish' ? async () => client.control ? client.control({ type: 'finish' }) : { status: 'delivered' }
          : value.method === 'control.deliver' ? async (run, payload) => {
          if (!client.control || !validId(payload?.messageId) || !['intervene', 'stop'].includes(payload.type)) throw new Error('control_unavailable');
          const previous = client.delivered.get(payload.messageId), signature = JSON.stringify(payload);
          if (previous) { if (previous.signature !== signature) throw new Error('message_id_conflict'); return previous.promise; }
          if (client.delivered.size >= 2000) throw new Error('control_limit');
          const promise = Promise.resolve().then(() => client.control(payload));
          client.delivered.set(payload.messageId, { signature, promise }); return promise;
        } : handlers.get(value.method);
        if (!handler) return send({ type: 'result', requestId: value.requestId, ok: false, error: 'unsupported_request' });
        try {
          const result = await handler(client.run, value.payload, {
            supportsFinish: client.supportsFinish,
            emit: event => send({ type: 'event', requestId: value.requestId, event }),
            onControl(fn) { client.control = fn; return () => { if (client.control === fn) client.control = null; }; },
          });
          send({ type: 'result', requestId: value.requestId, ok: true, value: result });
        } catch (error) { send({ type: 'result', requestId: value.requestId, ok: false, error: error.message === 'control_unavailable' ? 'control_unavailable' : 'run_failed' }); }
        finally { if (value.method === 'claude-sdk.run') client.control = null; }
      }
    };
    send = frames(socket, value => { void handle(value).catch(() => socket.destroy()); }, () => {
      sockets.delete(socket);
      if (!client) return;
      if (clients.get(client.run.runId) === client) clients.delete(client.run.runId);
      for (const [messageId, task] of client.pending) { clearTimeout(task.timer); task.resolve({ messageId, status: 'unknown' }); }
      // A's provider owns disconnect cleanup; application exit keeps today's worker policy.
      try { void Promise.resolve(client.control?.({ type: 'disconnect' })).catch(() => {}); } catch {}
    });
    socket.setTimeout(1500, () => socket.destroy());
    if (registration) void handle(registration).catch(() => socket.destroy());
  }
  return {
    accept,
    async listen() {
      if (server) return { address };
      const name = `agx-control-${randomUUID()}`;
      address = process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : path.join(os.tmpdir(), `${name}.sock`);
      if (process.platform !== 'win32' && Buffer.byteLength(address) > 100) address = `/tmp/${name}.sock`;
      server = net.createServer(socket => accept(socket));
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(address, resolve); });
      if (process.platform !== 'win32') require('node:fs').chmodSync(address, 0o600);
      return { address };
    },
    onRequest(type, handler) { handlers.set(type, handler); return () => handlers.delete(type); },
    pushControl(runId, control) {
      if (!validId(control?.messageId) || !['intervene', 'stop'].includes(control.type) || control.type === 'intervene' && (typeof control.text !== 'string' || !control.text.trim() || control.text.length > 4000)) return Promise.reject(new Error('invalid_control'));
      const key = `${runId}:${control.messageId}`, signature = JSON.stringify(control), prior = receipts.get(key);
      if (prior) return prior.signature === signature ? prior.promise : Promise.reject(new Error('message_id_conflict'));
      if (receipts.size >= 10000) return Promise.reject(new Error('control_limit'));
      const client = clients.get(runId);
      const promise = !client ? Promise.resolve({ messageId: control.messageId, status: 'queued' }) : new Promise(resolve => {
        const timer = setTimeout(() => { client.pending.delete(control.messageId); resolve({ messageId: control.messageId, status: 'unknown' }); }, 3000);
        client.pending.set(control.messageId, { resolve, timer });
        try {
          // The push is a wake-up. The helper obtains the actual control from its durable inbox.
          client.send({ type: 'control.push', messageId: control.messageId, at: now() });
        } catch { clearTimeout(timer); client.pending.delete(control.messageId); resolve({ messageId: control.messageId, status: 'unknown' }); }
      });
      receipts.set(key, { signature, promise }); return promise;
    },
    close() { for (const socket of sockets) socket.destroy(); server?.close(); },
  };
}

function connectDispatchControl({ address, runId, projectId, sessionKey, capability, readOnly = false, roundtable = false, onControl = async () => 'queued', onEvent = () => {}, timeout = 500 }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(address), pending = new Map();
    let registered = false, counter = 0, serial = Promise.resolve();
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('control_unavailable')); }, timeout);
    const send = frames(socket, value => {
      if (value.type === 'registered' && value.runId === runId) { registered = true; clearTimeout(timer); resolve(client); }
      else if (registered && value.type === 'control.push') {
        serial = serial.catch(() => {}).then(async () => {
          let receipt;
          try { receipt = await onControl(value.messageId); } catch { receipt = 'unknown'; }
          send({ type: 'receipt', messageId: value.messageId, status: status(receipt) ? receipt : 'unknown' });
        });
        void serial.catch(() => {});
      } else if (registered && value.type === 'event') onEvent(value.event);
      else if (registered && value.type === 'result') {
        const task = pending.get(value.requestId); if (!task) return;
        pending.delete(value.requestId);
        if (value.ok) task.resolve(value.value); else task.reject(new Error(value.error));
      }
    }, () => {
      clearTimeout(timer);
      if (!registered) reject(new Error('control_unavailable'));
      for (const task of pending.values()) task.reject(Object.assign(new Error('control_disconnected'), { uncertain: true }));
      pending.clear();
    });
    const client = {
      get connected() { return registered && !socket.destroyed; },
      request(method, payload) {
        return new Promise((resolve, reject) => {
          const requestId = String(++counter); pending.set(requestId, { resolve, reject });
          try { send({ type: 'request', requestId, method, payload }); } catch (error) { pending.delete(requestId); reject(error); }
        });
      }, close() { socket.destroy(); },
    };
    socket.once('connect', () => {
      try { send({ type: 'register', runId, projectId, sessionKey, capability, readOnly, roundtable, finishProtocol: 1 }); } catch { socket.destroy(); }
    });
  });
}

module.exports = { createDispatchControl, connectDispatchControl };
