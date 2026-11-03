const { randomUUID } = require('node:crypto');
const { exact, text, assert } = require('./validate.cjs');
const { choosePath } = require('./routing.cjs');
const { createEventStream } = require('./events.cjs');
function registerClaudeWorker({ control, claude, settings, context = () => '', env = () => process.env }) {
  return control.onRequest('claude-sdk.run', async (run, payload, stream) => {
    assert(exact(payload, ['prompt', 'model', 'effort', 'fast', 'resume', 'images', 'out']) && text(payload.prompt) &&
      (payload.model === undefined || text(payload.model, 160)) && (payload.effort === undefined || ['low', 'medium', 'high', 'max', 'xhigh'].includes(payload.effort)));
    const runtimeSessionId = randomUUID();
    const spec = { agent: 'claude', owner: 'dispatch', runtimeSessionId, terminalId: run.runId, projectId: run.projectId, runId: run.runId,
      cwd: run.cwd, worktree: run.worktree || run.cwd, allow: run.allow, readOnly: run.readOnly, roundtable: run.roundtable,
      model: payload.model, effort: payload.effort, fast: payload.fast, context: context(run), env: env(run),
      monthlyBudgetUsd: settings().monthlyBudgetUsd, providerSessionId: payload.resume || null };
    const config = settings(), selection = choosePath({ agent: 'claude', ...config, apiState: claude.apiState(config.monthlyBudgetUsd) });
    const pathEvent = reason => createEventStream(spec, event => stream.emit(event)).publish('path.changed', { previous: null, selected: 'terminal', reason });
    if (selection.path === 'terminal') { pathEvent(selection.reason); return; }
    if (!selection.path) throw new Error('Claude API 路径当前不可用。');
    let finish, fail, done = false;
    const completed = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
    void completed.catch(() => {});
    const runtime = claude.create(spec, event => {
      stream.emit(event);
      if (event.type === 'turn.completed') done = true;
      if (event.type === 'session.state' && event.payload.state === 'idle' && done) finish();
      if (event.type === 'session.state' && ['failed', 'disconnected'].includes(event.payload.state)) fail(new Error('Worker disconnected'));
    });
    const unsubscribe = stream.onControl(async controlMessage => {
      if (controlMessage.type === 'disconnect' || controlMessage.type === 'stop') { await runtime.close(); if (!done) fail(new Error('Worker stopped')); return 'delivered'; }
      if (controlMessage.type === 'intervene') return (await runtime.send({ clientMessageId: controlMessage.messageId, text: controlMessage.text })).status;
      return 'rejected';
    });
    try {
      try { await runtime[payload.resume ? 'resume' : 'start'](spec); }
      catch (error) {
        if (error.code === 'native_cli_required' && config.claudePath === 'api-then-terminal') { pathEvent(error.code); return; }
        throw error;
      }
      await runtime.send({ clientMessageId: randomUUID(), text: payload.prompt, images: payload.images });
      await completed;
    } finally { unsubscribe?.(); await runtime.close(); }
  });
}
module.exports = { registerClaudeWorker };
