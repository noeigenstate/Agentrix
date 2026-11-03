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
    const config = settings(), selection = choosePath({ agent: 'claude', ...config, apiState: claude.apiState(config.monthlyBudgetUsd) });
    const pathEvent = reason => createEventStream(spec, event => stream.emit(event)).publish('path.changed', { previous: null, selected: 'terminal', reason });
    if (selection.path === 'terminal') { pathEvent(selection.reason); return; }
    if (!selection.path) throw new Error('Claude API 路径当前不可用。');
    // Descendant helpers may remove only authentication supplied by this SDK parent.
    runtimeEnv.AGENTRIX_SDK_PARENT = '1';
    let finish, done = false, stopping = false, state = 'starting', outcome = 'failed';
    const completed = new Promise(resolve => { finish = resolve; });
    void completed.catch(() => {});
    const runtime = claude.create(spec, event => {
      stream.emit(event);
      if (event.type === 'turn.completed') { done = true; outcome = event.payload.status; }
      if (event.type === 'session.state') {
        state = event.payload.state;
        if (state === 'idle' && done && !stream.supportsFinish) finish({ status: outcome });
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
        if (state !== 'idle' || !done) return { status: 'queued' };
        finish({ status: outcome }); return { status: 'delivered' };
      }
      if (controlMessage.type === 'intervene') {
        if (['failed', 'stopped', 'stopping', 'disconnected'].includes(state)) return { status: 'rejected', reason: 'worker_ended' };
        return (await runtime.send({ clientMessageId: controlMessage.messageId, text: controlMessage.text })).status;
      }
      return 'rejected';
    });
    try {
      try { await runtime[payload.resume ? 'resume' : 'start'](spec); }
      catch (error) {
        if (error.code === 'native_cli_required' && config.claudePath === 'api-then-terminal') { pathEvent(error.code); return; }
        throw error;
      }
      await runtime.send({ clientMessageId: randomUUID(), text: payload.prompt, images: payload.images });
      return await completed;
    } finally { unsubscribe?.(); await runtime.close(); }
  });
}
module.exports = { registerClaudeWorker };
