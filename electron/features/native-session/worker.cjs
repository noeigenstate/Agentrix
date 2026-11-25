const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { exact, text, assert } = require('./validate.cjs');
const { choosePath } = require('./routing.cjs');
const { createEventStream } = require('./events.cjs');
const { validModel, EFFORT } = require('../skills/seat-rules.mjs');
const { READ_ONLY_MODE } = require('../claude-runtime/decide.cjs');
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// terminals: main's worker terminals (worker-terminals/BOUNDARY.md); a local terminal lead's worker runs in one of them.
function registerClaudeWorker({ control, claude, settings, terminals = null, context = () => '', env = () => process.env, roleResultServer }) {
  return control.onRequest('claude-sdk.run', async (run, payload, stream) => {
    assert(exact(payload, ['prompt', 'model', 'effort', 'fast', 'resume', 'images', 'out', 'permission', 'roleResultFolder']) && text(payload.prompt) &&
      (payload.model === undefined || validModel(payload.model)) && (payload.effort === undefined || typeof payload.effort === 'string' && EFFORT.test(payload.effort))
      && (payload.fast === undefined || typeof payload.fast === 'boolean')
      && (payload.roleResultFolder === undefined || text(payload.roleResultFolder, 4096) && path.isAbsolute(payload.roleResultFolder))
      && (payload.permission == null || ['plan', READ_ONLY_MODE, 'acceptEdits'].includes(payload.permission)) && (payload.resume == null || SESSION_ID.test(payload.resume)));
    const runtimeSessionId = randomUUID();
    const runtimeEnv = { ...env(run) };
    for (const name of Object.keys(runtimeEnv)) if (/^AGENTRIX_(?:BOOTSTRAP|CONTROL|CAPABILITY|.*SESSION_KEY)|^CLAUDE_CODE_ENTRYPOINT$/i.test(name)) delete runtimeEnv[name];
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
    return driveWorker({ run, spec, payload, stream, terminal, claude, claudePath, pathEvent });
  });
}

async function driveWorker({ run, spec, payload, stream, terminal, claude, claudePath, pathEvent }) {
  let finish, finishRequested = false, done = false, stopping = false, state = 'starting', outcome = 'failed';
  const identityFailure = [];
  const completed = new Promise(resolve => { finish = resolve; });
  void completed.catch(() => {});
  const onEvent = event => {
    // Do not end the helper before the safe startup fallback decision reaches it.
    if (event.type === 'error' && event.payload.stage === 'startup'
      || identityFailure.length && event.type === 'session.state' && event.payload.state === 'failed') {
      identityFailure.push(event); return;
    }
    if (event.type === 'turn.started') { done = false; finishRequested = false; }
    if (event.type === 'turn.completed') { done = true; outcome = event.payload.status; }
    // Control can be delivered synchronously while emit handles turn.completed.
    stream.emit(event);
    if (event.type === 'session.state') {
      state = event.payload.state;
      if (state === 'idle' && done && (!stream.supportsFinish || finishRequested)) finish({ status: outcome });
      if (state === 'stopped') finish({ status: stopping ? 'interrupted' : done ? outcome : 'failed' });
      if (['failed', 'disconnected'].includes(state)) finish({ status: 'failed' });
    }
  };
  const runtime = terminal ? terminal.create(run, spec, createEventStream(spec, onEvent)) : claude.create(spec, onEvent);
  const unsubscribe = stream.onControl(async controlMessage => {
    if (controlMessage.type === 'answer-role') return runtime.answerRole?.(controlMessage) ?? { status: 'rejected', reason: 'not_waiting' };
    if (controlMessage.type === 'disconnect' || controlMessage.type === 'stop') {
      stopping = controlMessage.type === 'stop';
      await runtime.close(); finish({ status: controlMessage.type === 'stop' ? 'interrupted' : 'failed' }); return 'delivered';
    }
    if (controlMessage.type === 'finish') {
      if (!done) return { status: 'queued' };
      finishRequested = true;
      if (state !== 'idle' || !done) return { status: 'queued' };
      finish({ status: outcome }); return { status: 'delivered' };
    }
    if (controlMessage.type === 'intervene') {
      if (['failed', 'stopped', 'stopping', 'disconnected'].includes(state)) return { status: 'rejected', reason: 'worker_ended' };
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
      await runtime[payload.resume ? 'resume' : 'start'](spec);
      await runtime.send({ clientMessageId: randomUUID(), text: payload.prompt, images: payload.images });
    }
    catch (error) {
      if (terminal && error.beforeInput === true) { pathEvent(error.code || error.message); return; }
      if (claudePath === 'api-then-terminal' && (error.code === 'native_cli_required' || error.beforeInput === true)) {
        pathEvent(error.beforeInput ? error.message : error.code); return;
      }
      for (const event of identityFailure) stream.emit(event);
      throw error;
    }
    return await completed;
  } finally { unsubscribe?.(); await runtime.close(); }
}
module.exports = { registerClaudeWorker };
