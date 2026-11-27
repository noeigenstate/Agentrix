const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { MAX_FRAME, jsonFrames } = require('../../oversized-record.cjs');
const { accountKey: processAccountKey } = require('./codex-account-usage.cjs');
const { workerOf, brokerMethods } = require('../cli-adapters/workers.cjs');

/**
 * @typedef {{operation:'read'|'edit'|'command'|'network'|'other', toolName:string, cwd:string|null,
 * paths:string[], command:string|null, argv:string[]|null, requestsNetwork:boolean|null}} ToolIntent
 * @typedef {{behavior:'allow'|'deny'|'ask', reasonCode:string, reason:string}} ToolDecision
 * A converts Claude tools to ToolIntent and applies its policy. This channel never executes a tool.
 */

const validId = value => typeof value === 'string' && /^[\w-]{1,160}$/.test(value);
const status = value => ['queued', 'delivered', 'consumed', 'rejected', 'unknown'].includes(value);
const registrationCodes = new Set(['dispatch.session_mismatch', 'dispatch.control_unbound', 'dispatch.unknown_run',
  'dispatch.project_mismatch', 'dispatch.duplicate_run']);
const leadModes = new Set(['native', 'terminal', 'codex', 'native-independent']);
function makeReceiptRoom(receipts, limit) {
  if (receipts.size < limit) return true;
  const oldest = [...receipts].find(([, entry]) => entry.settled);
  return !!oldest && receipts.delete(oldest[0]);
}
function rememberReceipt(receipts, id, signature, task) {
  const receipt = { signature, settled: false, promise: task.finally(() => { receipt.settled = true; }) };
  receipts.set(id, receipt);
  return receipt.promise;
}
function frames(socket, receive, disconnected) {
  let queue = [], bytes = 0, blocked = false, ended = false;
  const flush = () => {
    while (!blocked && queue.length && !socket.destroyed) {
      const line = queue.shift(); bytes -= Buffer.byteLength(line); blocked = !socket.write(line);
    }
  };
  socket.on('drain', () => { blocked = false; flush(); });
  const read = jsonFrames(value => {
    if (socket.destroyed) { read.clear(); return; }
    if (!value || value.v !== 1) { socket.destroy(); read.clear(); return; }
    try { receive(value); } catch { socket.destroy(); }
    if (socket.destroyed) read.clear();
  }, (envelope, bytes) => {
    if (envelope.type === 'result') receive({ v: 1, type: 'result', requestId: envelope.requestId, ok: false, error: 'control_frame_limit' });
    else if (envelope.type === 'request') {
      try { send({ type: 'result', requestId: envelope.requestId, ok: false, error: 'control_frame_limit' }); } catch {}
    }
  }, () => socket.destroy());
  socket.on('data', read);
  socket.on('error', () => socket.destroy());
  socket.once('close', () => { read.clear(); if (!ended) { ended = true; disconnected(); } });
  const send = value => {
    if (socket.destroyed) throw new Error('control_disconnected');
    const line = JSON.stringify({ ...value, v: 1 }) + '\n', size = Buffer.byteLength(line);
    if (size > MAX_FRAME || bytes + size > MAX_FRAME * 2) throw new Error('control_frame_limit');
    queue.push(line); bytes += size; flush();
  };
  return send;
}

// resolveRun: main's { run } or { refused: code, leadMode? }; injected bindings may return the run directly. It names the run's agent:
// channel does not look it up, and only a run bound to 'claude' may request a Claude SDK run.
// accountKey: this process's key for naming Codex accounts (accountScopeId). Only a run main's resolver marks local
// receives it, so a local helper names a worker's account as main does; an SSH host's account keeps its own channel.
function createDispatchControl({ resolveRun, accountKey = processAccountKey, now = Date.now }) {
  const clients = new Map(), handlers = new Map(), sockets = new Set(), receipts = new Map();
  let server, address, socketDirectory;
  function closeListener(listener) {
    if (!listener) return;
    const directory = socketDirectory;
    socketDirectory = null;
    listener.close(() => { if (directory) { try { fs.rmdirSync(directory); } catch {} } });
  }
  function accept(socket, registration) {
    sockets.add(socket);
    let client, registering = false, send;
    const refuse = (runId, code, leadMode) => {
      send({ type: 'refused', runId, code: registrationCodes.has(code) ? code : 'dispatch.control_unbound',
        ...(leadModes.has(leadMode) ? { leadMode } : {}) }); socket.end();
    };
    const handle = async value => {
      if (!client) {
        if (registering || value.type !== 'register' || !validId(value.runId)) return socket.destroy();
        registering = true;
        // Credentials are consumed by main's resolver, never retained or sent to the provider.
        const result = await resolveRun({ runId: value.runId, projectId: value.projectId, sessionKey: value.sessionKey, capability: value.capability,
          cwd: value.cwd, agent: value.agent, allow: value.allow, readOnly: value.readOnly });
        if (socket.destroyed) return;
        if (result?.refused) return refuse(value.runId, result.refused, result.leadMode);
        const verified = result?.run || result;
        if (!verified || verified.runId !== value.runId || verified.projectId !== value.projectId || !path.isAbsolute(verified.cwd || '') || !Array.isArray(verified.allow)) return refuse(value.runId, 'dispatch.control_unbound', verified?.leadMode);
        // A worker may tighten its admitted mode (for example --permission plan), never loosen main's binding.
        const run = { ...verified, readOnly: !!verified.readOnly || value.readOnly === true };
        if (value.answerOnly === true) {
          const target = clients.get(run.runId);
          if (!run.local || run.leadMode !== 'terminal' || !workerOf(run.agent)?.terminalAnswers || target?.run.projectId !== run.projectId
              || target.run.leadMode !== 'terminal' || target.run.agent !== run.agent || !target.control) {
            return refuse(run.runId, 'dispatch.control_unbound', run.leadMode);
          }
          client = { run, answerTarget: target };
          socket.setTimeout(2000);
          send({ type: 'registered', runId: run.runId });
          return;
        }
        if (clients.has(run.runId)) return refuse(run.runId, 'dispatch.duplicate_run', run.leadMode);
        client = { run, send, pending: new Map(), control: null, requests: new Map(), delivered: new Map(), brokerRequested: false, supportsFinish: value.finishProtocol === 1 };
        clients.set(run.runId, client); socket.setTimeout(0);
        send({ type: 'registered', runId: run.runId, ...(accountKey && verified.local === true ? { accountKey } : {}) });
        return;
      }
      if (client.answerTarget) {
        const target = client.answerTarget;
        if (value.type !== 'request' || value.method !== 'role.answer' || !validId(value.requestId) || client.answered) return socket.destroy();
        client.answered = true;
        const result = clients.get(client.run.runId) === target && target.control
          ? await target.control({ type: 'answer-role', wait: value.payload?.wait, choice: value.payload?.choice })
          : { status: 'rejected', reason: 'not_waiting' };
        send({ type: 'result', requestId: value.requestId, ok: true, value: result });
        return;
      }
      if (value.type === 'receipt' && validId(value.messageId) && status(value.status)) {
        const task = client.pending.get(value.messageId);
        if (task) { clearTimeout(task.timer); client.pending.delete(value.messageId); task.resolve({ messageId: value.messageId, status: value.status }); }
      } else if (value.type === 'request' && validId(value.requestId) && typeof value.method === 'string') {
        if (client.requests.has(value.requestId) || !makeReceiptRoom(client.requests, 4000)) return socket.destroy();
        const request = { settled: false };
        client.requests.set(value.requestId, request);
        const broker = brokerMethods.has(value.method);
        if (broker) {
          if (workerOf(client.run.agent)?.brokerMethod !== value.method || client.brokerRequested) {
            request.settled = true;
            return send({ type: 'result', requestId: value.requestId, ok: false, error: 'run_binding_rejected' });
          }
          client.brokerRequested = true;
        }
        const handler = value.method === 'control.finish' ? async (_run, payload) => client.control
          ? client.control({ type: 'finish', ...(payload?.allowContinuation === false && { allowContinuation: false }) }) : { status: 'delivered' }
          : value.method === 'control.deliver' ? async (run, payload) => {
          if (!client.control || !validId(payload?.messageId) || !['intervene', 'stop'].includes(payload.type)) throw new Error('control_unavailable');
          const previous = client.delivered.get(payload.messageId), signature = JSON.stringify(payload);
          if (previous) { if (previous.signature !== signature) throw new Error('message_id_conflict'); return previous.promise; }
          if (!makeReceiptRoom(client.delivered, 2000)) throw new Error('control_limit');
          return rememberReceipt(client.delivered, payload.messageId, signature, Promise.resolve().then(() => client.control(payload)));
        } : handlers.get(value.method);
        try {
          if (!handler) return send({ type: 'result', requestId: value.requestId, ok: false, error: 'unsupported_request' });
          const result = await handler(client.run, value.payload, {
            supportsFinish: client.supportsFinish,
            emit: event => send({ type: 'event', requestId: value.requestId, event }),
            onControl(fn) { client.control = fn; return () => { if (client.control === fn) client.control = null; }; },
          });
          send({ type: 'result', requestId: value.requestId, ok: true, value: result });
        } catch (error) { send({ type: 'result', requestId: value.requestId, ok: false, error: error.message === 'control_unavailable' ? 'control_unavailable' : 'run_failed' }); }
        finally { request.settled = true; if (broker) client.control = null; }
      }
    };
    send = frames(socket, value => { void handle(value).catch(() => socket.destroy()); }, () => {
      sockets.delete(socket);
      if (!client || client.answerTarget) return;
      if (clients.get(client.run.runId) === client) clients.delete(client.run.runId);
      for (const [messageId, task] of client.pending) { clearTimeout(task.timer); task.resolve({ messageId, status: 'unknown' }); }
      // A's provider owns disconnect cleanup; application exit keeps today's worker policy.
      try { void Promise.resolve(client.control?.({ type: 'disconnect' })).catch(() => {}); } catch {}
    });
    // The helper gives up on registration after 2 s; this idle limit is longer, so the helper's wait is the one that ends it.
    socket.setTimeout(2500, () => socket.destroy());
    if (registration) void handle(registration).catch(() => socket.destroy());
  }
  return {
    accept,
    async listen() {
      if (server) return { address };
      const name = `agx-control-${randomUUID()}`;
      if (process.platform === 'win32') address = `\\\\.\\pipe\\${name}`;
      else {
        const prefix = path.join(os.tmpdir(), 'agx-control-');
        socketDirectory = fs.mkdtempSync(Buffer.byteLength(prefix) + 18 > 100 ? '/tmp/agx-control-' : prefix);
        address = path.join(socketDirectory, 'control.sock');
      }
      server = net.createServer(socket => accept(socket));
      try {
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(address, resolve); });
        if (socketDirectory) fs.chmodSync(address, 0o600);
      } catch (error) {
        const failed = server; server = null;
        closeListener(failed);
        throw error;
      }
      return { address };
    },
    onRequest(type, handler) { handlers.set(type, handler); return () => handlers.delete(type); },
    pushControl(runId, control) {
      if (!validId(control?.messageId) || !['intervene', 'stop'].includes(control.type) || control.type === 'intervene' && (typeof control.text !== 'string' || !control.text.trim() || control.text.length > 4000)) return Promise.reject(new Error('invalid_control'));
      const key = `${runId}:${control.messageId}`, signature = JSON.stringify(control), prior = receipts.get(key);
      if (prior) return prior.signature === signature ? prior.promise : Promise.reject(new Error('message_id_conflict'));
      if (!makeReceiptRoom(receipts, 10000)) return Promise.reject(new Error('control_limit'));
      const client = clients.get(runId);
      const promise = !client ? Promise.resolve({ messageId: control.messageId, status: 'queued' }) : new Promise(resolve => {
        const timer = setTimeout(() => { client.pending.delete(control.messageId); resolve({ messageId: control.messageId, status: 'unknown' }); }, 3000);
        client.pending.set(control.messageId, { resolve, timer });
        try {
          // The push is a wake-up. The helper obtains the actual control from its durable inbox.
          client.send({ type: 'control.push', messageId: control.messageId, at: now() });
        } catch { clearTimeout(timer); client.pending.delete(control.messageId); resolve({ messageId: control.messageId, status: 'unknown' }); }
      });
      return rememberReceipt(receipts, key, signature, promise);
    },
    close() { for (const socket of sockets) socket.destroy(); closeListener(server); },
  };
}

function connectDispatchControl({ address, runId, projectId, sessionKey, capability, cwd, agent, allow, readOnly = false, answerOnly,
  onControl = async () => 'queued', onEvent = () => {}, timeout = 2000 }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(address), pending = new Map();
    let registered = false, connected = false, failure, counter = 0, serial = Promise.resolve();
    const unavailable = category => Object.assign(new Error('control_unavailable'), {
      stage: connected ? 'control_register' : 'control_connect', category });
    socket.once('error', error => { failure ||= unavailable(['ENOENT', 'ECONNREFUSED', 'EACCES', 'EPERM'].includes(error.code) ? error.code : 'socket_error'); });
    const timer = setTimeout(() => { failure = unavailable('timeout'); socket.destroy(); reject(failure); }, timeout);
    const send = frames(socket, value => {
      if (!registered && value.type === 'registered' && value.runId === runId) {
        registered = true; clearTimeout(timer);
        if (typeof value.accountKey === 'string' && /^[a-f\d]{64}$/.test(value.accountKey)) client.accountKey = value.accountKey;
        resolve(client);
      }
      else if (!registered && value.type === 'refused' && value.runId === runId) {
        failure = unavailable(registrationCodes.has(value.code) ? value.code : 'dispatch.control_unbound');
        if (registrationCodes.has(value.code) && leadModes.has(value.leadMode)) failure.leadMode = value.leadMode;
        clearTimeout(timer); reject(failure); socket.destroy();
      } else if (registered && value.type === 'control.push') {
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
      if (!registered) reject(failure || unavailable('registration_closed'));
      for (const task of pending.values()) task.reject(Object.assign(new Error('control_disconnected'), { uncertain: true }));
      pending.clear();
    });
    const client = {
      accountKey: null,
      get connected() { return registered && !socket.destroyed; },
      request(method, payload) {
        return new Promise((resolve, reject) => {
          const requestId = String(++counter); pending.set(requestId, { resolve, reject });
          try { send({ type: 'request', requestId, method, payload }); } catch (error) { pending.delete(requestId); reject(error); }
        });
      }, close() { socket.destroy(); },
    };
    socket.once('connect', () => {
      connected = true;
      try { send({ type: 'register', runId, projectId, sessionKey, capability, cwd, agent, allow, readOnly, answerOnly, finishProtocol: 1 }); } catch { socket.destroy(); }
    });
  });
}

module.exports = { createDispatchControl, connectDispatchControl };
