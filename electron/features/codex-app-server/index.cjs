const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const { homedir } = require('node:os');
const { createRpc } = require('./rpc.cjs');
const { createEvents, itemPayload, turnCompletion } = require('./events.cjs');
const { createRequests } = require('./requests.cjs');
const { mergeLimits, accountConnection, restrictedLimits } = require('./account.cjs');
const { assertCompatible, probeCapabilities } = require('./compatibility.cjs');
const { codexExecutable } = require('../agents/codex-account-usage.cjs');
const { workerEnvironment } = require('./environment.cjs');

const occupied = new Map();
function stopProcess(child) {
  if (!child || child.exitCode != null || child.signalCode != null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const closed = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { child.removeListener('close', closed); reject(new Error('process_stop_timeout')); }, 3000);
    child.once('close', closed);
    if (process.platform === 'win32' && child.pid) {
      execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/taskkill.exe'), ['/pid', String(child.pid), '/t', '/f'],
        { windowsHide: true, timeout: 2000 }, error => { if (error && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }
  });
}

function createCodexRuntime({ spawnProcess = spawn, resolveExecutable = codexExecutable, now = Date.now, renderImage } = {}) {
  const scopes = new Map();
  return {
    limits: scope => scopes.get(scope) || null,
    create(initialSpec, emit) {
      const spec = { ...initialSpec, runtimeSessionId: initialSpec.runtimeSessionId || randomUUID() };
      let currentUsage = null;
      const events = createEvents(spec, event => { if (event.type === 'usage.updated') currentUsage = event.payload; emit(event); }, now, renderImage), receipts = new Map(), finished = new Set();
      let rpc, child, requests, state = 'stopped', closed = false, sending = Promise.resolve(), origin = 'user', clientMessageId = null;
      let lockKey, active = false, threadResponse, accountGeneration = 0, limitsRead = null;
      let accountRead = null;
      const setState = (value, reason = null) => { state = value; events.publish('session.state', { state, reason }); };
      function bind(threadId) {
        const home = spec.codexHome || spec.env?.CODEX_HOME || path.join(spec.env?.HOME || spec.env?.USERPROFILE || homedir(), '.codex');
        const key = `${path.resolve(home)}:${threadId}`;
        if (occupied.has(key) && occupied.get(key) !== spec.runtimeSessionId) throw new Error('thread_in_use');
        occupied.set(key, spec.runtimeSessionId); lockKey = key; events.binding.providerSessionId = threadId;
      }
      function started(turn) {
        if (!turn || typeof turn.id !== 'string') throw Object.assign(new Error('invalid_turn'), { uncertain: true });
        if (finished.has(turn.id) || active && events.binding.turnId === turn.id) return;
        events.binding.turnId = turn.id; active = true; currentUsage = null; events.beginTurn();
        events.publish('turn.started', { origin, clientMessageId }); setState('running');
      }
      function notification(method, params) {
        if (closed) return;
        if (params.threadId && params.threadId !== events.binding.providerSessionId) return;
        if (method === 'item/completed' && params.item?.type === 'userMessage') {
          const id = params.item.clientId;
          if (receipts.has(id)) inputReceipt(id, 'consumed');
        }
        if (method === 'turn/started') started(params.turn);
        else if (method === 'turn/completed') {
          const turn = params.turn;
          if (!turn || typeof turn.id !== 'string' || finished.has(turn.id) || turn.id !== events.binding.turnId) return;
          finished.add(turn.id); active = false; requests.cancelAll();
          const outcome = turnCompletion(turn, currentUsage);
          if (['usageLimitExceeded', 'rateLimitExceeded'].includes(outcome.terminalReason)) {
            const scope = spec.scopeId || spec.runtimeSessionId, limit = restrictedLimits(scopes.get(scope), outcome.terminalReason === 'usageLimitExceeded' ? 'spend_limit' : 'rate_limited', scope, now());
            scopes.set(scope, limit); events.publish('limits.updated', limit);
          }
          events.finishTurn(); events.publish('turn.completed', outcome);
          setState('idle');
        } else if (method === 'serverRequest/resolved') requests.resolved(params.requestId);
        else if (method === 'account/rateLimits/updated') {
          const scope = spec.scopeId || spec.runtimeSessionId, value = mergeLimits(scopes.get(scope), params, scope, now());
          scopes.set(scope, value); events.publish('limits.updated', value);
        } else if (method === 'account/updated') {
          ++accountGeneration;
          accountRead = null;
          limitsRead = null;
          scopes.delete(spec.scopeId || spec.runtimeSessionId);
          events.publish('limits.updated', { scopeId: spec.scopeId || spec.runtimeSessionId, billingRoute: 'unknown', observedAtMs: now(), state: 'unavailable', limitsById: {}, resetCredits: null, ordinaryUsageAllowed: null, source: 'codex-app-server' });
        } else events.notification(method, params);
      }
      async function open(resuming, override) {
        if (rpc || closed) throw new Error('session_already_started');
        Object.assign(spec, override || {}); setState('starting'); origin = resuming ? 'resume' : 'user';
        let stage = 'resolve_executable';
        try {
          if (!path.isAbsolute(spec.cwd || '')) throw new Error('invalid_cwd');
          const env = workerEnvironment(spec.env || process.env), executable = await resolveExecutable(env);
          if (!executable) throw new Error('codex_cli_required');
          stage = 'spawn';
          child = spawnProcess(executable, ['app-server', '--listen', 'stdio://'], { cwd: spec.cwd, env, windowsHide: true,
            detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
          rpc = createRpc(child, { timeout: spec.rpcTimeoutMs || 8000, onNotification: notification,
            onRequest: message => requests.open(message), onDisconnect: reason => {
              if (closed) return;
              requests?.cancelAll(); setState('disconnected', reason);
            } });
          requests = createRequests(rpc, events, setState);
          stage = 'initialize';
          const init = await rpc.request('initialize', { clientInfo: { name: 'agentrix', version: '1.0.0' }, capabilities: { experimentalApi: true } });
          const compatibility = assertCompatible(init);
          rpc.notify('initialized');
          stage = 'capability_probe'; await probeCapabilities(rpc);
          stage = resuming ? 'thread_resume' : 'thread_start';
          const threadId = spec.providerSessionId || spec.threadId || spec.sessionId;
          if (resuming && !threadId) throw new Error('missing_thread');
          if (resuming) bind(threadId);
          const options = { cwd: spec.cwd, model: spec.model ?? null, serviceTier: spec.fast === false ? 'default' : spec.fast === true ? 'fast' : null,
            config: { model_reasoning_effort: spec.effort || 'high' },
            ...((spec.readOnly || spec.roundtable) ? { sandbox: 'read-only' }
              : spec.policy?.sandbox ? { sandbox: spec.policy.sandbox }
                : spec.owner === 'dispatch' ? { sandbox: 'workspace-write' } : {}),
            ...(spec.policy?.approvalPolicy ? { approvalPolicy: spec.policy.approvalPolicy } : {}), approvalsReviewer: 'user' };
          let result, resumed = resuming;
          try { result = await rpc.request(resuming ? 'thread/resume' : 'thread/start', { ...options, ...(resuming ? { threadId, excludeTurns: true } : {}) }); }
          catch (error) {
            if (!resuming || !spec.allowFreshResume || !error.missingThread) throw error;
            occupied.delete(lockKey); lockKey = null; events.binding.providerSessionId = null; resumed = false;
            result = await rpc.request('thread/start', options);
          }
          if (typeof result?.thread?.id !== 'string' || resumed && result.thread.id !== threadId || result.cwd && path.resolve(result.cwd) !== path.resolve(spec.cwd)) throw new Error('invalid_thread');
          if ((spec.readOnly || spec.roundtable) && result.sandbox?.type !== 'readOnly') throw new Error('sandbox_mismatch');
          if (spec.owner === 'dispatch' && !spec.readOnly && !spec.roundtable && !spec.policy?.sandbox && result.sandbox?.type !== 'workspaceWrite') throw new Error('sandbox_mismatch');
          if (resuming && result.thread.status?.type === 'active') throw new Error('thread_in_use');
          bind(result.thread.id); threadResponse = result;
          events.publish('routing.updated', { declared: { model: spec.model ?? null, effort: spec.effort ?? null, fast: spec.fast ?? null },
            effective: { model: result.model ?? null, effort: result.reasoningEffort ?? null, fast: result.serviceTier === 'fast' ? true : result.serviceTier === 'default' ? false : null }, observed: { model: null, effort: null, fast: null }, reason: null });
          // Dispatch needs the resumed model context, not a copy of its historical output.
          if (resumed && spec.owner !== 'dispatch') await replayHistory();
          setState('idle');
          void readLimits().catch(() => {});
          return { providerSessionId: result.thread.id, runtimeSessionId: spec.runtimeSessionId, reason: compatibility.reason };
        } catch (error) {
          error.stage ||= stage;
          if (error.code === -32601 || error.code === -32602) error.code = 'unsupported_codex_capabilities';
          await close(); setState('failed', typeof error.code === 'string' ? error.code : error.message); throw error;
        }
      }
      async function replayHistory() {
        const history = [], cursors = new Set();
        let cursor = null, limit = 50, bytes = 0, turns = 0;
        while (history.length < 1000 && turns < 1000) {
          let page;
          try {
            page = await rpc.request('thread/turns/list', { threadId: events.binding.providerSessionId, cursor, limit, sortDirection: 'desc', itemsView: 'full' });
          } catch (error) {
            if (error.code !== 'history_frame_limit') throw error;
            if (limit > 1) { limit = Math.max(1, Math.floor(limit / 2)); continue; }
            // A single enormous turn cannot fit the display budget. Advance using metadata, keeping the session usable.
            page = await rpc.request('thread/turns/list', { threadId: events.binding.providerSessionId, cursor, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
          }
          if (!Array.isArray(page?.data)) throw new Error('invalid_history');
          limit = Math.min(50, limit * 2);
          for (const turn of page.data) {
            ++turns;
            for (const item of [...(turn.items || [])].reverse()) {
              const serialized = JSON.stringify({ payload: itemPayload(item, true, renderImage), itemId: item.id, turnId: turn.id });
              const size = Buffer.byteLength(serialized) + 1024;
              if (history.length >= 1000 || bytes + size > 4 * 1024 * 1024) { turns = 1000; break; }
              // Detach bounded text slices from the large provider frame before retaining them.
              history.push(JSON.parse(serialized)); bytes += size;
            }
            if (turns >= 1000) break;
          }
          if (!page.nextCursor || cursors.has(page.nextCursor)) break;
          cursors.add(page.nextCursor); cursor = page.nextCursor;
        }
        for (const item of history.reverse()) events.publish('item.upsert', item.payload, { itemId: item.itemId, turnId: item.turnId, replay: true });
      }
      function inputReceipt(id, status) {
        const entry = receipts.get(id);
        if (entry?.status === 'consumed') return;
        if (entry) entry.status = status;
        events.publish('input.receipt', { clientMessageId: id, status });
      }
      function send(input) {
        const imageValid = value => typeof value === 'string' && (spec.owner === 'dispatch' && path.isAbsolute(value) || /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value));
        if (!input || typeof input.clientMessageId !== 'string' || !/^[\w:.-]{1,160}$/.test(input.clientMessageId) || typeof input.text !== 'string' || !input.text.trim() && !input.images?.length || input.text.length > 1024 * 1024 || input.images && (!Array.isArray(input.images) || input.images.length > 8 || input.images.some(x => !imageValid(x)))) return Promise.reject(new Error('invalid_input'));
        const fingerprint = createHash('sha256').update(JSON.stringify([input.text, input.images || []])).digest('hex'), prior = receipts.get(input.clientMessageId);
        if (prior) return prior.fingerprint === fingerprint ? prior.promise : Promise.reject(new Error('message_id_conflict'));
        if (receipts.size >= 2000) return Promise.reject(new Error('input_limit'));
        const promise = sending.catch(() => {}).then(async () => {
          if (!rpc || closed || !['idle', 'running', 'waiting'].includes(state)) throw new Error('session_unavailable');
          const clientId = input.clientMessageId;
          inputReceipt(clientId, 'queued');
          const userInput = [...(input.text.trim() ? [{ type: 'text', text: input.text, text_elements: [] }] : []), ...(input.images || []).map(value => value.startsWith('data:') ? { type: 'image', url: value } : { type: 'localImage', path: value })];
          const steering = active;
          try {
            clientMessageId = clientId; origin = 'user';
            const base = { threadId: events.binding.providerSessionId, clientUserMessageId: clientId, input: userInput };
            const startTurn = () => rpc.request('turn/start', { ...base, effort: spec.effort ?? null, serviceTier: spec.fast === true ? 'fast' : spec.fast === false ? 'default' : null });
            let result, newTurn = !steering;
            try { result = steering ? await rpc.request('turn/steer', { ...base, expectedTurnId: events.binding.turnId }) : await startTurn(); }
            catch (error) {
              if (!steering || error.uncertain || error.code !== -32602) throw error;
              const read = await rpc.request('thread/read', { threadId: events.binding.providerSessionId, includeTurns: false });
              const page = await rpc.request('thread/turns/list', { threadId: events.binding.providerSessionId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
              const previous = page?.data?.find(turn => turn.id === events.binding.turnId);
              if (read?.thread?.id !== events.binding.providerSessionId || read.thread.status?.type !== 'idle' || !['completed', 'failed', 'interrupted'].includes(previous?.status)) throw error;
              // Only an explicit rejected steer plus an idle thread proves the input did not execute.
              notification('turn/completed', { turn: previous });
              newTurn = true; result = await startTurn();
            }
            if (newTurn) started(result.turn);
            else if (result?.turnId !== events.binding.turnId) throw Object.assign(new Error('invalid_steer_response'), { uncertain: true });
            inputReceipt(clientId, 'delivered');
            return { clientMessageId: clientId, status: 'delivered' };
          } catch (error) {
            const status = error.uncertain ? 'unknown' : 'rejected';
            inputReceipt(clientId, status);
            if (error.uncertain) setState('disconnected', 'input_delivery_unknown');
            return { clientMessageId: clientId, status };
          }
        });
        receipts.set(input.clientMessageId, { fingerprint, promise }); sending = promise; return promise;
      }
      async function interrupt() {
        if (closed || !rpc) return;
        requests.cancelAll();
        if (active) await rpc.request('turn/interrupt', { threadId: events.binding.providerSessionId, turnId: events.binding.turnId });
      }
      async function close() {
        if (closed) return;
        closed = true; setState('stopping'); requests?.cancelAll();
        if (active && rpc) { try { await rpc.request('turn/interrupt', { threadId: events.binding.providerSessionId, turnId: events.binding.turnId }, 250); } catch {} }
        rpc?.close(); await stopProcess(child);
        if (lockKey && occupied.get(lockKey) === spec.runtimeSessionId) occupied.delete(lockKey);
        setState('stopped');
      }
      function readLimits() {
        if (limitsRead) return limitsRead;
        const generation = accountGeneration;
        const task = (async () => {
          const scope = spec.scopeId || spec.runtimeSessionId, result = await rpc.request('account/rateLimits/read', {});
          if (closed || generation !== accountGeneration) throw new Error('account_changed');
          const value = mergeLimits(scopes.get(scope), result, scope, now()); scopes.set(scope, value); events.publish('limits.updated', value); return value;
        })();
        limitsRead = task.finally(() => { if (generation === accountGeneration) limitsRead = null; }); return limitsRead;
      }
      function readAccount() {
        if (closed || !rpc) return Promise.resolve({ kind: 'none', source: null, observedAt: null });
        if (accountRead) return accountRead;
        const generation = accountGeneration;
        const task = rpc.request('account/read', { refreshToken: false }).then(value => {
          if (closed || generation !== accountGeneration) return { kind: 'unknown', source: null, observedAt: null };
          return accountConnection(value, now());
        }).catch(() => ({ kind: 'unknown', source: 'codex-app-server account/read', observedAt: null }));
        accountRead = task.finally(() => { if (generation === accountGeneration) accountRead = null; });
        return accountRead;
      }
      return { start: override => open(false, override), resume: override => open(true, override), send, interrupt,
        answer: (id, answer) => requests.answer(id, answer), snapshot: () => ({ ...events.snapshot(), state, requests: requests?.snapshot() || [] }), close,
        readLimits, readAccount, activity: events.activity,
        readUsage: () => rpc.request('account/usage/read', {}),
        history: cursor => rpc.request('thread/turns/list', { threadId: events.binding.providerSessionId, cursor: cursor || null, limit: 50, sortDirection: 'desc', itemsView: 'full' }),
        get pid() { return child?.pid; }, get threadResponse() { return threadResponse; },
      };
    },
  };
}

module.exports = { createCodexRuntime, workerEnvironment };
