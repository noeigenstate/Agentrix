const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { exact, text, assert } = require('./validate.cjs');
const { choosePath } = require('./routing.cjs');
const { createEventStream } = require('./events.cjs');
const { validModel, EFFORT } = require('../routing/seat-rules.mjs');
const { READ_ONLY_MODE } = require('../claude-runtime/decide.cjs');
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACP_WORKER = 'agy-acp.run';

function workerEnvironment(env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) =>
    !/^AGENTRIX_(?:BOOTSTRAP|CONTROL|CAPABILITY|.*SESSION_KEY)|^CLAUDE_CODE_ENTRYPOINT$/i.test(name)));
}

// terminals: main's worker terminals (worker-terminals/BOUNDARY.md); a local terminal lead's worker runs in one of them.
function registerClaudeWorker({ control, claude, settings, terminals = null, context = () => '', env = () => process.env, roleResultServer }) {
  return control.onRequest('claude-sdk.run', async (run, payload, stream) => {
    assert(exact(payload, ['prompt', 'model', 'effort', 'fast', 'resume', 'images', 'out', 'permission', 'roleResultFolder']) && text(payload.prompt) &&
      (payload.model === undefined || validModel(payload.model)) && (payload.effort === undefined || typeof payload.effort === 'string' && EFFORT.test(payload.effort))
      && (payload.fast === undefined || typeof payload.fast === 'boolean')
      && (payload.roleResultFolder === undefined || text(payload.roleResultFolder, 4096) && path.isAbsolute(payload.roleResultFolder))
      && (payload.permission == null || ['plan', READ_ONLY_MODE, 'acceptEdits'].includes(payload.permission)) && (payload.resume == null || SESSION_ID.test(payload.resume)));
    const runtimeSessionId = randomUUID();
    const runtimeEnv = workerEnvironment(env(run));
    const spec = { agent: 'claude', owner: 'dispatch', runtimeSessionId, terminalId: run.runId, projectId: run.projectId, runId: run.runId,
      cwd: run.cwd, worktree: run.worktree || run.cwd, allow: run.allow, readOnly: run.readOnly,
      model: payload.model, effort: payload.effort, fast: payload.fast, context: context(run), env: runtimeEnv,
      providerSessionId: payload.resume || null, permission: run.readOnly ? READ_ONLY_MODE : 'acceptEdits' };
    const pathEvent = reason => createEventStream(spec, event => stream.emit(event)).publish('path.changed', { previous: null, selected: 'terminal', reason });
    // Only a local terminal lead's worker is billed like its terminal; an SSH one keeps the CLI path.
    const terminal = run.leadMode === 'terminal' && run.local === true && terminals;
    if (run.leadMode === 'terminal' && !terminal) { pathEvent('terminal lead (subscription)'); return; }
    if (payload.roleResultFolder) spec.roleServer = roleResultServer?.(run.runId, payload.roleResultFolder);
    let claudePath = null;
    if (!terminal) {
      await claude.refreshAvailability?.();
      claudePath = run.leadMode === 'native' ? 'api-only' : settings().claudePath;
      const apiState = claude.apiState(run.projectId, null, 'dispatch');
      const selection = choosePath({ agent: 'claude', claudePath, apiState });
      if (selection.path === 'terminal') { pathEvent(selection.reason); return; }
      if (!selection.path) throw new Error(apiState.reason || 'Claude API 路径当前不可用。');
      // Descendant helpers may remove only authentication supplied by this SDK parent.
      runtimeEnv.AGENTRIX_SDK_PARENT = '1';
    }
    const create = onEvent => terminal ? terminal.create(run, spec, createEventStream(spec, onEvent)) : claude.create(spec, onEvent);
    const startupFallback = error => terminal && error.beforeInput === true ? error.code || error.message
      : claudePath === 'api-then-terminal' && (error.code === 'native_cli_required' || error.beforeInput === true)
        ? error.beforeInput ? error.message : error.code : null;
    return driveWorker({ spec, payload, stream, create, startupFallback, pathEvent });
  });
}

function registerAgyWorker({ control, adapterOf, adapterOfModel, runtimeOf, geminiDir, env = () => process.env, roleResultServer, readRoleResult }) {
  return control.onRequest(ACP_WORKER, (run, payload, stream) => {
    const adapter = adapterOf(run.agent);
    assert(adapter?.worker?.brokerMethod === ACP_WORKER && run.local === true
      && exact(payload, ['prompt', 'model', 'effort', 'fast', 'resume', 'images', 'out', 'permission', 'roleResultFolder'])
      && text(payload.prompt) && (payload.model === undefined || validModel(payload.model) && adapterOfModel(payload.model) === adapter)
      && (payload.effort === undefined || typeof payload.effort === 'string' && EFFORT.test(payload.effort))
      && (payload.resume == null || typeof payload.resume === 'string' && SESSION_ID.test(payload.resume))
      && (payload.roleResultFolder === undefined || text(payload.roleResultFolder, 4096) && path.isAbsolute(payload.roleResultFolder)));
    const scope = { cwd: run.cwd, allow: run.allow, readOnly: run.readOnly };
    const context = [
      'Follow the role brief and use the Agentrix role tools to report your result.',
      run.readOnly ? 'This role is read-only.' : 'Write only to these project paths: ' + JSON.stringify(run.allow),
    ].join('\n');
    const roleServer = payload.roleResultFolder && roleResultServer?.(run.runId, payload.roleResultFolder);
    const spec = { ...scope, agent: adapter.manifest.id, owner: 'dispatch', kind: 'local', runtimeSessionId: randomUUID(),
      terminalId: run.runId, projectId: run.projectId, runId: run.runId, worktree: run.worktree || run.cwd,
      model: payload.model, effort: payload.effort, providerSessionId: payload.resume || null, geminiDir,
      env: workerEnvironment(env(run)), decidePermission: () => null,
      ...adapter.notes.startup(context).config, ...(roleServer && adapter.roleTools.config(roleServer)) };
    const events = createEventStream(spec, event => stream.emit(event));
    const publishRefusal = event => {
      const { reason, resolution, action } = event.payload;
      if (resolution !== 'denied' || !reason) return null;
      events.provider(event.providerSessionId);
      events.turn(event.turnId);
      const refusal = { action: action || 'Tool request', reason };
      events.publish('worker.refused', refusal, { itemId: event.itemId });
      return refusal;
    };
    const hasResult = roleServer && readRoleResult && (async () => (await readRoleResult(payload.roleResultFolder, run.runId))?.source === 'finish-role');
    const create = async emit => (await runtimeOf(adapter)).create(spec, emit);
    return driveWorker({ spec, payload, stream, create, approval: { publishRefusal, hasResult } });
  });
}

function deniedTurnMessage({ action, reason }) {
  return `Agentrix denied this operation: ${action} (${reason}). Skip this operation, continue the task, and call finish_role with your result.`;
}

async function driveWorker({ spec, payload, stream, create, startupFallback, pathEvent, approval }) {
  let finish, finishRequested = false, done = false, state = 'starting', outcome = 'failed';
  let runtime, closing, cancelled, refusal, continued = false;
  const close = () => runtime && (closing ??= Promise.resolve().then(() => runtime.close()));
  const cancelStatus = () => cancelled === 'stop' ? 'interrupted' : 'failed';
  const identityFailure = [];
  const completed = new Promise(resolve => { finish = resolve; });
  const onEvent = event => {
    // Do not end the helper before the safe startup fallback decision reaches it.
    if (startupFallback && (event.type === 'error' && event.payload.stage === 'startup'
      || identityFailure.length && event.type === 'session.state' && event.payload.state === 'failed')) {
      identityFailure.push(event); return;
    }
    if (event.type === 'turn.started') { done = false; finishRequested = false; refusal = null; }
    if (event.type === 'turn.completed') { done = true; outcome = event.payload.status; }
    // Control can be delivered synchronously while emit handles turn.completed.
    stream.emit(event);
    if (event.type === 'request.resolved' && !event.replay) {
      const denied = approval?.publishRefusal(event);
      refusal ??= denied;
    }
    if (event.type === 'session.state') {
      state = event.payload.state;
      if (state === 'idle' && done && (!stream.supportsFinish || finishRequested)) finish({ status: outcome });
      if (state === 'stopped') finish({ status: cancelled ? cancelStatus() : done ? outcome : 'failed' });
      if (['failed', 'disconnected'].includes(state)) finish({ status: 'failed' });
    }
  };
  const unsubscribe = stream.onControl(async controlMessage => {
    if (controlMessage.type === 'answer-role') return runtime?.answerRole?.(controlMessage) ?? { status: 'rejected', reason: 'not_waiting' };
    if (controlMessage.type === 'disconnect' || controlMessage.type === 'stop') {
      cancelled ??= controlMessage.type;
      try { await close(); return 'delivered'; }
      finally { finish({ status: cancelStatus() }); }
    }
    if (controlMessage.type === 'finish') {
      if (!done) return { status: 'queued' };
      if (state === 'idle' && refusal && !continued && !cancelled && approval?.hasResult && controlMessage.allowContinuation !== false) {
        const denied = refusal;
        const saved = await approval.hasResult().catch(() => true);
        if (!done || state !== 'idle' || cancelled) return { status: 'queued' };
        if (!saved && !continued && refusal === denied) {
          continued = true;
          try {
            const next = await runtime.send({ clientMessageId: randomUUID(), text: deniedTurnMessage(denied) });
            if (next && next.status !== 'rejected') return { status: 'queued', continued: true };
          } catch { /* The completed turn remains the result when the continuation cannot be sent. */ }
        }
      }
      finishRequested = true;
      if (state !== 'idle' || !done) return { status: 'queued' };
      finish({ status: outcome }); return { status: 'delivered' };
    }
    if (controlMessage.type === 'intervene') {
      if (!runtime || cancelled || ['failed', 'stopped', 'stopping', 'disconnected'].includes(state)) return { status: 'rejected', reason: 'worker_ended' };
      const previous = { done, finishRequested };
      const restore = () => {
        done = previous.done; finishRequested = previous.finishRequested;
        if (state === 'idle' && done && finishRequested) finish({ status: outcome });
      };
      finishRequested = false; done = false;
      try {
        const result = await runtime.send({ clientMessageId: controlMessage.messageId, text: controlMessage.text });
        if (result.status === 'rejected') restore();
        return result.status;
      } catch (error) { restore(); throw error; }
    }
    return 'rejected';
  });
  try {
    try {
      runtime = await create(onEvent);
      if (cancelled) return await completed;
      await runtime[payload.resume ? 'resume' : 'start'](spec);
      if (cancelled) return await completed;
      const receipt = await runtime.send({ clientMessageId: randomUUID(), text: payload.prompt, images: payload.images });
      if (approval && receipt?.status === 'rejected') finish({ status: 'failed' });
    }
    catch (error) {
      if (cancelled) return await completed;
      const fallback = startupFallback?.(error);
      if (fallback) { pathEvent(fallback); return; }
      for (const event of identityFailure) stream.emit(event);
      throw error;
    }
    return await completed;
  } finally { unsubscribe?.(); await close(); }
}
module.exports = { registerClaudeWorker, registerAgyWorker };
