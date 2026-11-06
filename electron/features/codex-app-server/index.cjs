const path = require('node:path');
const fs = require('node:fs/promises');
const { spawn, execFile } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const { homedir } = require('node:os');
const { createRpc } = require('./rpc.cjs');
const { createEvents, itemPayload, turnCompletion } = require('./events.cjs');
const { createRequests } = require('./requests.cjs');
const { mergeLimits, accountConnection, restrictedLimits } = require('./account.cjs');
const { assertCompatible, probeCapabilities } = require('./compatibility.cjs');
const { codexExecutable, scopePathKey, usageAtLimit, resetCreditMessage } = require('../agents/codex-account-usage.cjs');
const { workerEnvironment } = require('./environment.cjs');

const occupied = new Map();
const localPath = value => fs.realpath(value).catch(() => value);
function stopProcess(child) {
  if (!child) return Promise.resolve();
  // A CLI metadata child can inherit stdout after the app-server itself exits.
  // Release our pipe ends on proved local exit; a pipe holder is not a live server.
  const release = () => { if (!child.remote) for (const pipe of [child.stdin, child.stdout, child.stderr]) pipe?.destroy?.(); };
  if (child.exitCode != null || child.signalCode != null) { release(); return Promise.resolve(); }
  return new Promise((resolve, reject) => {
    const remove = () => { clearTimeout(timer); child.removeListener('close', closed); child.removeListener('exit', exited); };
    const closed = () => { remove(); resolve(); };
    const exited = () => { release(); closed(); };
    const timer = setTimeout(() => { remove(); reject(new Error('process_stop_timeout')); }, 3000);
    child.once('close', closed);
    if (!child.remote) child.once('exit', exited);
    if (child.remote) child.kill('SIGKILL');
    else if (process.platform === 'win32' && child.pid) {
      execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/taskkill.exe'), ['/pid', String(child.pid), '/t', '/f'],
        { windowsHide: true, timeout: 2000 }, error => { if (error && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }
  });
}

function createCodexRuntime({ spawnProcess = spawn, resolveExecutable = codexExecutable, launchRemote, now = Date.now, renderImage, resetAtLimit, translate = value => value, platform = process.platform } = {}) {
  const scopes = new Map();
  return {
    limits: scope => scopes.get(scope) || null,
    async history(spec, { signal } = {}) {
      const abort = new AbortController(); let child, rpc;
      const cancel = () => { abort.abort(); rpc?.close(); };
      const check = () => { if (abort.signal.aborted) throw new Error('session_closed'); };
      signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) cancel();
      try {
        check();
        const remote = spec.kind === 'ssh' ? await launchRemote(spec, { signal: abort.signal, readOnly: true }) : null;
        const cwd = spec.kind === 'ssh' ? remote?.cwd || spec.cwd : await localPath(spec.cwd);
        if (remote) child = remote.child;
        else {
          const env = workerEnvironment(spec.env || process.env), file = await resolveExecutable(env);
          check();
          if (!file) throw new Error('codex_cli_required');
          child = spawnProcess(file, ['app-server', '--listen', 'stdio://'], { cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
        }
        check(); rpc = createRpc(child);
        assertCompatible(await rpc.request('initialize', { clientInfo: { name: 'agentrix-history', version: '1.0.0' }, capabilities: { experimentalApi: true } }));
        rpc.notify('initialized');
        const rows = new Map();
        // Retain threads recorded under the caller's old alias as well as new
        // threads created with the physical cwd. SSH paths stay remote-only.
        for (const directory of new Set(remote ? [cwd] : [cwd, spec.cwd])) {
          const page = await rpc.request('thread/list', { cwd: directory, limit: 100, sortKey: 'updated_at', sortDirection: 'desc', archived: false, sourceKinds: ['cli', 'vscode'] });
          if (!Array.isArray(page.data)) throw new Error('invalid_history');
          for (const row of page.data) {
            if (typeof row.cwd !== 'string' || !path.isAbsolute(row.cwd)
              || (remote ? row.cwd !== cwd : scopePathKey(await localPath(row.cwd)) !== scopePathKey(cwd))) continue;
            if (!rows.has(row.id) || row.updatedAt > rows.get(row.id).updatedAt) rows.set(row.id, row);
          }
        }
        const ordered = [...rows.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        let thread = ordered.find(thread => thread.id === spec.providerSessionId) || ordered[0];
        if (spec.providerSessionId && thread?.id !== spec.providerSessionId) {
          try { thread = (await rpc.request('thread/read', { threadId: spec.providerSessionId, includeTurns: false })).thread; }
          catch (error) { if (!error.missingThread) throw error; }
        }
        if (!thread || typeof thread.id !== 'string' || typeof thread.cwd !== 'string' || !path.isAbsolute(thread.cwd)
          || (remote ? thread.cwd !== cwd : scopePathKey(await localPath(thread.cwd)) !== scopePathKey(cwd))) return null;
        check();
        return { id: thread.id, title: String(thread.name || thread.preview || '').slice(0, 200), at: Number.isSafeInteger(thread.updatedAt) ? thread.updatedAt * 1000 : null };
      } finally {
        signal?.removeEventListener('abort', cancel); rpc?.close();
        try { await stopProcess(child); } finally { child?.dispose?.(); abort.abort(); }
      }
    },
    create(initialSpec, emit) {
      const spec = { ...initialSpec, runtimeSessionId: initialSpec.runtimeSessionId || randomUUID() };
      const render = item => renderImage?.(item, spec);
      let currentUsage = null;
      const events = createEvents(spec, event => { if (event.type === 'usage.updated') currentUsage = event.payload; emit(event); }, now, render, translate), receipts = new Map(), finished = new Set();
      let rpc, child, requests, state = 'stopped', closed = false, sending = Promise.resolve(), origin = 'user', clientMessageId = null;
      let lockKey, active = false, threadResponse, accountGeneration = 0, limitsRead = null;
      let skills = null, skillsRead = null, skillsGeneration = 0, skillsExpireAt = 0;
      let wireCwd = spec.cwd, wireHome;
      let accountRead = null;
      const connectionAbort = new AbortController();
      const assertOpen = () => { if (closed) throw Object.assign(new Error('session_closed'), { code: 'closed' }); };
      let executionSeen = false, resetting = null, resetRetry = null, lastReset = null;
      const setState = (value, reason = null) => {
        state = value;
        if (['stopping', 'stopped', 'failed', 'disconnected'].includes(value)) events.publish('context.compacting', { active: false });
        events.publish('session.state', { state, reason });
      };
      function bind(threadId) {
        const home = spec.codexHome || spec.env?.CODEX_HOME || path.join(spec.env?.HOME || spec.env?.USERPROFILE || homedir(), '.codex');
        const key = spec.kind === 'ssh' ? `ssh:${child?.remoteScope || spec.projectId}:${threadId}` : `${scopePathKey(wireHome || home)}:${threadId}`;
        if (occupied.has(key) && occupied.get(key) !== spec.runtimeSessionId) throw new Error('thread_in_use');
        occupied.set(key, spec.runtimeSessionId); lockKey = key; events.binding.providerSessionId = threadId;
      }
      function started(turn) {
        if (!turn || typeof turn.id !== 'string') throw Object.assign(new Error('invalid_turn'), { uncertain: true });
        if (finished.has(turn.id) || active && events.binding.turnId === turn.id) return;
        events.binding.turnId = turn.id; active = true; currentUsage = null; executionSeen = false; events.beginTurn();
        events.publish('turn.started', { origin, clientMessageId }); setState('running');
      }
      function notification(method, params) {
        if (closed) return;
        if (method === 'codex/event/item_completed' && params.msg?.item?.kind === 'image_gen.generation') {
          method = 'item/completed'; params = { ...params, item: { ...params.msg.item, type: 'imageGeneration' } };
        }
        if (params.threadId && params.threadId !== events.binding.providerSessionId) return;
        if (active && (method.startsWith('item/') && params.item?.type !== 'userMessage'
          || ['thread/tokenUsage/updated', 'turn/plan/updated', 'turn/diff/updated'].includes(method))) executionSeen = true;
        if (method === 'skills/changed') { ++skillsGeneration; skills = null; skillsRead = null; }
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
          events.finishTurn(outcome.status); events.publish('turn.completed', outcome);
          setState('idle');
          if (outcome.terminalReason === 'usageLimitExceeded') {
            const entry = receipts.get(clientMessageId);
            const safe = !executionSeen && !currentUsage && Array.isArray(turn.items) && turn.items.length === 0 && entry
              && ['queued', 'delivered'].includes(entry.status) && !entry.retried;
            if (!entry?.retried) void resetLimit(safe ? entry : null, turn.id);
          }
        } else if (method === 'serverRequest/resolved') requests.resolved(params.requestId);
        else if (method === 'account/rateLimits/updated') {
          const scope = spec.scopeId || spec.runtimeSessionId, value = mergeLimits(scopes.get(scope), params, scope, now());
          scopes.set(scope, value); events.publish('limits.updated', value);
          if (usageAtLimit(params)) void resetLimit(null, events.binding.turnId);
        } else if (method === 'account/updated') {
          ++accountGeneration;
          accountRead = null;
          limitsRead = null;
          scopes.delete(spec.scopeId || spec.runtimeSessionId);
          events.publish('limits.updated', { scopeId: spec.scopeId || spec.runtimeSessionId, billingRoute: 'unknown', observedAtMs: now(), state: 'unavailable', limitsById: {}, resetCredits: null, ordinaryUsageAllowed: null, source: 'codex-app-server' });
        } else events.notification(method, params);
      }
      async function resetLimit(entry, failedTurnId) {
        if (spec.owner !== 'gui' || spec.kind === 'ssh' || spec.remote || !resetAtLimit || closed) return;
        if (entry) resetRetry = { entry, turnId: failedTurnId };
        if (resetting) return;
        const reused = lastReset?.turnId === failedTurnId && lastReset.result.confirmed;
        if (reused && !entry) return;
        const generation = accountGeneration;
        const task = Promise.resolve().then(() => reused ? lastReset.result : resetAtLimit(spec, { atLimit: true, current: () => !closed && accountGeneration === generation })).then(async result => {
          if (closed || generation !== accountGeneration) return;
          const candidate = resetRetry; resetRetry = null;
          const retryTurnId = candidate?.turnId ?? failedTurnId;
          entry = candidate?.entry;
          lastReset = { turnId: retryTurnId, result };
          if (result.limits) {
            const scope = spec.scopeId || spec.runtimeSessionId, value = mergeLimits(scopes.get(scope), result.limits, scope, now());
            scopes.set(scope, value); events.publish('limits.updated', value);
          }
          let message = resetCreditMessage(result, translate);
          if (!message) return;
          if (result.auditFailed) message += translate('自动重置的日志未能保存。');
          const retry = result.confirmed && entry && !entry.retried && ['queued', 'delivered'].includes(entry.status)
            && events.binding.turnId === retryTurnId && !active && state === 'idle';
          if (result.confirmed) message += translate(retry ? '正在继续本条消息。' : '现在可以继续发送消息。');
          if (!reused || retry) events.publish('item.upsert', { kind: 'agent-message', status: 'completed', content: { text: reused ? translate('正在继续本条消息。') : message,
            resetCredit: { status: result.status, outcome: result.outcome || null, remaining: result.remaining ?? null, confirmed: !!result.confirmed } } }, { itemId: randomUUID() });
          if (!retry) return;
          entry.retried = true; clientMessageId = entry.id; origin = 'user';
          const response = await rpc.request('turn/start', { threadId: events.binding.providerSessionId, clientUserMessageId: entry.id, input: entry.input,
            effort: spec.effort ?? null, serviceTier: spec.fast === true ? 'fast' : spec.fast === false ? 'default' : null });
          started(response.turn); inputReceipt(entry.id, 'delivered');
        }).catch(error => {
          if (entry?.retried) inputReceipt(entry.id, error.uncertain ? 'unknown' : 'rejected');
          if (!closed) events.publish('error', { code: 'reset_continue_failed', message: translate('自动重置后未能继续本条消息，请核对会话后继续。'), retryable: false, willRetry: false, stage: 'turn' });
        }).finally(() => { if (resetting === task) resetting = null; });
        resetting = task; await task;
      }
      async function open(resuming, override) {
        if (rpc || closed) throw new Error('session_already_started');
        Object.assign(spec, override || {}); setState('starting'); origin = resuming ? 'resume' : 'user';
        let stage = 'resolve_executable';
        try {
          if (spec.kind === 'ssh') {
            stage = 'ssh_connect';
            if (!launchRemote) throw new Error('remote_transport_required');
            const remote = await launchRemote(spec, { signal: connectionAbort.signal });
            spec.cwd = remote.cwd; spec.env = {}; spec.context = remote.context || '';
            child = remote.child;
            if (closed) { try { await stopProcess(child); } finally { child.dispose?.(); child = null; } assertOpen(); }
          }
          if (!path.isAbsolute(spec.cwd || '')) throw new Error('invalid_cwd');
          // Windows sandbox roots must use one spelling of the same directory;
          // an 8.3 cwd otherwise becomes an unenforceable split writable root.
          wireCwd = spec.kind === 'ssh' ? spec.cwd : await localPath(spec.cwd);
          const source = spec.env || process.env, env = workerEnvironment(source);
          // The GUI planner's helpers must reach their authenticated project control channel.
          // Dispatched workers still strip the bootstrap and cannot inherit the planner capability.
          if (spec.owner === 'gui' && typeof source.AGENTRIX_BOOTSTRAP === 'string') env.AGENTRIX_BOOTSTRAP = source.AGENTRIX_BOOTSTRAP;
          const executable = child ? 'codex' : await resolveExecutable(env);
          assertOpen();
          if (!executable) throw new Error('codex_cli_required');
          stage = 'spawn';
          let compatibility, reconnecting = false;
          const connect = async () => {
            child ||= spawnProcess(executable, ['app-server', '--listen', 'stdio://'], { cwd: wireCwd, env, windowsHide: true,
              detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
            rpc = createRpc(child, { timeout: spec.rpcTimeoutMs || 8000, onNotification: notification,
              onDropped: bytes => events.publish('item.dropped', { reason: 'too_large', bytes }),
              onRequest: message => requests.open(message), onDisconnect: reason => {
                if (closed || reconnecting) return;
                requests?.cancelAll(); setState('disconnected', reason);
              } });
            requests = createRequests(rpc, events, setState);
            stage = 'initialize';
            const init = await rpc.request('initialize', { clientInfo: { name: 'agentrix', version: '1.0.0' }, capabilities: { experimentalApi: true } });
            assertOpen();
            compatibility = assertCompatible(init);
            rpc.notify('initialized');
            stage = 'capability_probe'; await probeCapabilities(rpc);
            assertOpen();
          };
          await connect();
          assertOpen();
          stage = resuming ? 'thread_resume' : 'thread_start';
          const threadId = spec.providerSessionId || spec.threadId || spec.sessionId;
          if (resuming && !threadId) throw new Error('missing_thread');
          if (spec.kind !== 'ssh') wireHome = await localPath(spec.codexHome || spec.env?.CODEX_HOME || path.join(spec.env?.HOME || spec.env?.USERPROFILE || homedir(), '.codex'));
          assertOpen();
          if (resuming) bind(threadId);
          const options = { cwd: wireCwd, model: spec.model ?? null, serviceTier: spec.fast === false ? 'default' : spec.fast === true ? 'fast' : null,
            config: { model_reasoning_effort: spec.effort || 'high', ...(spec.context ? { developer_instructions: spec.context } : {}) },
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
          assertOpen();
          if (platform === 'win32' && spec.kind !== 'ssh' && spec.owner === 'dispatch' && options.sandbox === 'workspace-write' && result.sandbox?.type === 'readOnly') {
            // A per-request override cannot elevate or alter the owner's configuration.
            // A resumed thread is cached in its process. Retire the first read-only
            // runtime before retrying the same thread so the request override is applied.
            if (resumed) {
              reconnecting = true; rpc.close(); await stopProcess(child); child.dispose?.(); child = null; reconnecting = false;
              assertOpen(); await connect(); stage = 'thread_resume';
            }
            result = await rpc.request(resumed ? 'thread/resume' : 'thread/start', { ...options,
              ...(resumed ? { threadId, excludeTurns: true } : {}), config: { ...options.config, 'windows.sandbox': 'unelevated' } });
            assertOpen();
          }
          if (typeof result?.thread?.id !== 'string' || resumed && result.thread.id !== threadId || result.cwd
            && (spec.kind === 'ssh' ? path.resolve(result.cwd) !== path.resolve(wireCwd) : scopePathKey(await localPath(result.cwd)) !== scopePathKey(wireCwd))) throw new Error('invalid_thread');
          if (options.sandbox === 'read-only' && result.sandbox?.type !== 'readOnly') throw Object.assign(new Error('Codex 未应用只读沙箱，已停止启动。请检查 Codex 沙箱配置后重试。'), { code: 'sandbox_mismatch', requestedSandbox: 'read-only' });
          if (spec.owner === 'dispatch' && options.sandbox === 'workspace-write' && result.sandbox?.type !== 'workspaceWrite') throw Object.assign(new Error('Codex 返回只读沙箱。请在 Codex 用户配置的 [windows] 中设置 sandbox = "unelevated"，然后重试。'), { code: 'sandbox_mismatch' });
          if (resuming && result.thread.status?.type === 'active') throw new Error('thread_in_use');
          assertOpen();
          bind(result.thread.id); threadResponse = result;
          events.publish('routing.updated', { declared: { model: spec.model ?? null, effort: spec.effort ?? null, fast: spec.fast ?? null },
            effective: { model: result.model ?? null, effort: result.reasoningEffort ?? null, fast: result.serviceTier === 'fast' ? true : result.serviceTier === 'default' ? false : null }, observed: { model: null, effort: null, fast: null }, reason: null });
          // Dispatch needs the resumed model context, not a copy of its historical output.
          if (resumed && spec.owner !== 'dispatch') await replayHistory();
          assertOpen();
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
            events.publish('item.dropped', { reason: 'too_large', bytes: error.bytes });
          }
          if (!Array.isArray(page?.data)) throw new Error('invalid_history');
          limit = Math.min(50, limit * 2);
          for (const turn of page.data) {
            ++turns;
            for (const item of [...(turn.items || [])].reverse()) {
              const serialized = JSON.stringify({ payload: itemPayload(item, true, render, translate), itemId: item.id, turnId: turn.id });
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
          try {
            const command = /^\/([\w][\w:.-]{0,159})(?:\s|$)/.exec(input.text.trim());
            if (command) {
              await commands();
              const skill = skills?.get(command[1]);
              if (skill) userInput.push({ type: 'skill', name: command[1], path: skill.path });
            }
            const steering = active;
            const entry = receipts.get(clientId); entry.id = clientId; entry.input = userInput;
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
            return { clientMessageId: clientId, status, ...(!error.uncertain && error.code === -32602 ? { reason: 'worker_ended' } : {}) };
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
        closed = true; connectionAbort.abort(); setState('stopping'); requests?.cancelAll();
        if (active && rpc) { try { await rpc.request('turn/interrupt', { threadId: events.binding.providerSessionId, turnId: events.binding.turnId }, 250); } catch {} }
        rpc?.close();
        try { await stopProcess(child); }
        finally {
          child?.dispose?.();
          if (lockKey && occupied.get(lockKey) === spec.runtimeSessionId) occupied.delete(lockKey);
          setState('stopped');
        }
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
      async function commands() {
        if (closed || !rpc) return [];
        const list = () => [...(skills?.values() || [])].map(skill => ({ name: '/' + skill.name,
          description: skill.description, source: 'skill', view: 'reading' }));
        if (skills && now() < skillsExpireAt) return list();
        if (skillsRead) return skillsRead;
        const generation = skillsGeneration;
        const task = rpc.request('skills/list', { cwds: [wireCwd], forceReload: false }).then(async result => {
          if (closed || generation !== skillsGeneration) return [];
          const next = new Map();
          for (const entry of result?.data || []) {
            if (typeof entry.cwd !== 'string' || scopePathKey(spec.kind === 'ssh' ? entry.cwd : await localPath(entry.cwd)) !== scopePathKey(wireCwd)) continue;
            if (closed || generation !== skillsGeneration) return [];
            for (const skill of Array.isArray(entry.skills) ? entry.skills : []) {
              if (next.size >= 300) break;
              if (skill.enabled !== true || !/^[\w][\w:.-]{0,159}$/.test(skill.name || '') || next.has(skill.name)
                || typeof skill.path !== 'string' || !path.isAbsolute(skill.path) || skill.path.length > 4096) continue;
              next.set(skill.name, { name: skill.name, path: skill.path, description: String(skill.description || '').slice(0, 1024) });
            }
          }
          if (closed || generation !== skillsGeneration) return [];
          skills = next; skillsExpireAt = now() + 30000;
          return list();
        }).catch(() => {
          if (!closed && generation === skillsGeneration) { skills = new Map(); skillsExpireAt = now() + 5000; }
          return [];
        }).finally(() => { if (skillsRead === task) skillsRead = null; });
        skillsRead = task; return task;
      }
      return { start: override => open(false, override), resume: override => open(true, override), send, interrupt,
        answer: (id, answer) => requests.answer(id, answer), snapshot: () => ({ ...events.snapshot(), state, requests: requests?.snapshot() || [] }), close,
        readLimits, readAccount, commands, activity: events.activity,
        async canContinueInterrupted() {
          if (closed || active || state !== 'idle') return false;
          const page = await rpc.request('thread/turns/list', { threadId: events.binding.providerSessionId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
          return !closed && !active && state === 'idle' && Array.isArray(page.data) && ['inProgress', 'interrupted'].includes(page.data[0]?.status);
        },
        readUsage: () => rpc.request('account/usage/read', {}),
        history: cursor => rpc.request('thread/turns/list', { threadId: events.binding.providerSessionId, cursor: cursor || null, limit: 50, sortDirection: 'desc', itemsView: 'full' }),
        get pid() { return child?.pid; }, get threadResponse() { return threadResponse; },
      };
    },
  };
}

module.exports = { createCodexRuntime, workerEnvironment };
