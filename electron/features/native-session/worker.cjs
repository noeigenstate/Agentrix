const { randomUUID } = require('node:crypto');
const { exact, text, assert } = require('./validate.cjs');
const { choosePath } = require('./routing.cjs');
const { createEventStream } = require('./events.cjs');
function registerClaudeWorker({ control, claude, settings, context = () => '', env = () => process.env }) {
  return control.onRequest('claude-sdk.run', async (run, payload, stream) => {
    assert(exact(payload, ['prompt', 'model', 'effort', 'fast', 'resume', 'images', 'out']) && text(payload.prompt) &&
      (payload.model === undefined || text(payload.model, 160)) && (payload.effort === undefined || ['low', 'medium', 'high', 'max', 'xhigh'].includes(payload.effort)));
    const runtimeSessionId = randomUUID();
    const runtimeEnv = { ...env(run) };
    for (const name of Object.keys(runtimeEnv)) if (/^AGENTRIX_(?:BOOTSTRAP|CONTROL|CAPABILITY|.*SESSION_KEY)/i.test(name)) delete runtimeEnv[name];
    const spec = { agent: 'claude', owner: 'dispatch', runtimeSessionId, terminalId: run.runId, projectId: run.projectId, runId: run.runId,
      cwd: run.cwd, worktree: run.worktree || run.cwd, allow: run.allow, readOnly: run.readOnly, roundtable: run.roundtable,
      model: payload.model, effort: payload.effort, fast: payload.fast, context: context(run), env: runtimeEnv,
      monthlyBudgetUsd: settings().monthlyBudgetUsd, providerSessionId: payload.resume || null };
    await claude.refreshAvailability?.();
    const config = settings(), apiState = claude.apiState(config.monthlyBudgetUsd, run.projectId);
    const selection = choosePath({ agent: 'claude', ...config, apiState });
    const pathEvent = reason => createEventStream(spec, event => stream.emit(event)).publish('path.changed', { previous: null, selected: 'terminal', reason });
    if (selection.path === 'terminal') { pathEvent(selection.reason); return; }
    if (!selection.path) throw new Error(apiState.reason || 'Claude API 路径当前不可用。');
    // Descendant helpers may remove only authentication supplied by this SDK parent.
    runtimeEnv.AGENTRIX_SDK_PARENT = '1';
    let finish, finishRequested = false, done = false, stopping = false, state = 'starting', outcome = 'failed';
    const identityFailure = [];
    const completed = new Promise(resolve => { finish = resolve; });
    void completed.catch(() => {});
    const runtime = claude.create(spec, event => {
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
    });
    const unsubscribe = stream.onControl(async controlMessage => {
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
        finishRequested = false; done = false;
        try {
          const result = await runtime.send({ clientMessageId: controlMessage.messageId, text: controlMessage.text });
          if (result.status === 'rejected') { done = previous.done; finishRequested = previous.finishRequested; }
          return result.status;
        } catch (error) { done = previous.done; finishRequested = previous.finishRequested; throw error; }
      }
      return 'rejected';
    });
    try {
      try {
        await runtime[payload.resume ? 'resume' : 'start'](spec);
        await runtime.send({ clientMessageId: randomUUID(), text: payload.prompt, images: payload.images });
      }
      catch (error) {
        if (settings().claudePath === 'api-then-terminal' && (error.code === 'native_cli_required' || error.beforeInput === true)) {
          pathEvent(error.beforeInput ? error.message : error.code); return;
        }
        for (const event of identityFailure) stream.emit(event);
        throw error;
      }
      return await completed;
    } finally { unsubscribe?.(); await runtime.close(); }
  });
}
module.exports = { registerClaudeWorker };
