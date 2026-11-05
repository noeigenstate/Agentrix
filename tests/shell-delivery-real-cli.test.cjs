require('./fixtures/team-isolation.cjs');
const { test } = require('node:test'), assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { harness, opening, textBlock, finish } = require('./fixtures/claude-real.cjs');
const skip = !process.env.AGENTRIX_REAL_CLAUDE && 'set AGENTRIX_REAL_CLAUDE';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function terminalResume(f, providerId, beforePrompt) {
  const env = { ...f.env }; delete env.CI;
  fs.writeFileSync(path.join(env.CLAUDE_CONFIG_DIR, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true,
    lastOnboardingVersion: '2.1.318', theme: 'dark', customApiKeyResponses: { approved: [env.ANTHROPIC_API_KEY.slice(-20)], rejected: [] },
    projects: { [f.cwd.replaceAll('\\', '/')]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } } }));
  const child = fork(path.join(__dirname, 'fixtures/claude-terminal-peer.cjs'), [], { env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  child.stderr.resume(); const ended = once(child, 'exit');
  f.cleanup(async () => { if (child.exitCode === null && child.signalCode === null) child.send({ type: 'stop' }); await ended; });
  const ready = new Promise(resolve => child.on('message', message => { if (message.type === 'ready') resolve(); }));
  child.send({ type: 'start', cli: process.env.AGENTRIX_REAL_CLAUDE, cwd: f.cwd, env, args: ['--resume', providerId], capture: false });
  await ready; beforePrompt(); child.send({ type: 'input', text: 'AFTER_SHELL_FAILURE' });
}
for (const mode of ['credit-400', 'server-500', 'generic-400', 'budget', 'success']) {
  test(`shell delivery real CLI ${mode} preserves output and reports only unanswered failures`, { skip, timeout: 45000 }, async t => {
    const bodies = [], raw = [], events = []; let healthy = false;
    const f = await harness(t, data => {
      bodies.push(data);
      if (healthy || mode === 'success') return [opening(data), ...textBlock(0, 'SHELL_REPLY'), ...finish('end_turn')];
      if (mode === 'budget') return [opening(data), ...finish('end_turn')];
      return { status: mode === 'server-500' ? 500 : 400, body: { type: 'error', error: {
        type: mode === 'server-500' ? 'api_error' : 'invalid_request_error',
        message: mode === 'credit-400' ? 'Credit balance is too low' : 'OFFLINE_SHELL_REFUSED',
      } } };
    });
    const runtime = require('../electron/features/claude-sdk/index.cjs').createClaudeRuntime({ directory: path.join(f.cwd, 'state'),
      loadSdk: async () => ({ ...f.sdk, query(spec) {
        const query = f.sdk.query(spec);
        return new Proxy(query, { get(target, key) {
          if (key === Symbol.asyncIterator) return async function* () { for await (const message of target) { raw.push(message); yield message; } };
          const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
        } });
      } }), resolveExecutable: async () => process.env.AGENTRIX_REAL_CLAUDE,
      safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() } });
    f.cleanup(() => runtime.close()); runtime.credentials.save(f.env.ANTHROPIC_API_KEY);
    const spec = { owner: 'gui', projectId: 'shell-project', terminalId: 't', cwd: f.cwd, env: f.env, runtimeSessionId: 'shell-delivery' };
    const budget = mode === 'budget' ? 0.000001 : null, fallback = ['credit-400', 'budget'].includes(mode);
    let router, session, opened, committed = false, draft;
    if (fallback) {
      router = require('../electron/features/native-session/router.cjs').createRouter({ claude: runtime, codex: {}, emit: event => events.push(event),
        resolveSpec: () => spec, settings: { get: () => ({ claudePath: 'api-then-terminal', monthlyBudgetUsd: budget }) }, terminal() { assert.fail('no startup fallback'); },
        prepareTerminal: async (terminalSpec, handoff) => ({ session: { identity: {}, spec: terminalSpec, path: 'terminal' }, cancel() {},
          commit() { draft = handoff.draft; assert.ok(events.some(event => event.payload.code === 'shell_context_rejected')); committed = true; },
          send() { assert.fail('fallback must not execute !command twice'); } }) });
      f.cleanup(() => router.close()); opened = await router.start('t', { agent: 'claude' });
      session = { shell: (id, command) => router.shell('t', opened.runtimeSessionId, id, command) };
    } else { session = runtime.create({ ...spec, monthlyBudgetUsd: budget }, event => events.push(event)); await session.start(); }
    if (mode === 'generic-400') {
      healthy = true; await session.send({ clientMessageId: 'previous-reply', text: 'Warm up' });
      for (let n = 0; n < 500 && session.snapshot().state !== 'idle'; n++) await pause(20);
      healthy = false; events.length = 0; raw.length = 0;
    }
    await session.shell('shell-input', 'echo SHELL_RUN >> shell-count.txt; echo SHELL_DELIVERY_OUTPUT');
    for (let n = 0; n < 1000 && !events.some(event => event.type === 'turn.completed'); n++) await pause(20);
    const result = raw.findLast(message => message.type === 'result'); assert.ok(result, 'the real CLI produced its final result');
    t.diagnostic(JSON.stringify({ mode, subtype: result.subtype, is_error: result.is_error, terminal_reason: result.terminal_reason, stop_reason: result.stop_reason }));
    const card = events.findLast(event => event.type === 'item.upsert' && event.itemId === 'shell:shell-input');
    assert.equal(card.payload.status, 'completed'); assert.equal(card.payload.content.exitCode, 0);
    assert.match(card.payload.content.output, /SHELL_DELIVERY_OUTPUT/);
    const notices = events.filter(event => event.type === 'error' && event.payload.code === 'shell_context_rejected');
    if (mode === 'success') { assert.notEqual(card.payload.content.modelDelivery, 'rejected'); assert.equal(notices.length, 0); }
    else {
      assert.equal(card.payload.content.modelDelivery, 'rejected'); assert.equal(notices.length, 1);
      assert.match(notices[0].payload.message, /命令已执行，但输出未发送给模型/);
      assert.ok(events.indexOf(notices[0]) < events.findIndex(event => event.type === 'turn.completed'), 'notice precedes completion and any fallback');
      assert.equal(events.slice(0, events.findIndex(event => event.type === 'turn.completed')).filter(event => event.type === 'error').at(-1).payload.code,
        'shell_context_rejected', 'a later budget notice cannot hide the shell delivery explanation');
    }
    if (mode !== 'budget') assert.match(JSON.stringify(bodies.at(-1).messages), /SHELL_DELIVERY_OUTPUT/);
    if (fallback) {
      assert.match(notices[0].payload.message, /切换到终端后会随下一条消息发送给模型/);
      for (let n = 0; n < 500 && router.switchState('t')?.phase !== 'preparing'; n++) await pause(20);
      const snapshot = router.snapshot('t'); assert.equal(snapshot.switchState.phase, 'preparing');
      router.answer('t', snapshot.runtimeSessionId, 'handoff', { handoff: { changeId: snapshot.switchState.changeId, draft: { version: 1, text: '', images: [], undelivered: [] } } });
      for (let n = 0; n < 500 && router.snapshot('t')?.switchState?.outcome !== 'switched'; n++) await pause(20);
      assert.equal(committed, true); assert.equal(draft.text, ''); assert.equal(draft.undelivered.length, 0);
      healthy = true; const beforeResume = bodies.length;
      await terminalResume(f, raw.find(message => message.type === 'system' && message.subtype === 'init').session_id,
        () => assert.equal(bodies.length, beforeResume, 'opening the resumed terminal does not submit another model request'));
      for (let n = 0; n < 500 && bodies.length === beforeResume; n++) await pause(20);
      assert.ok(bodies.length > beforeResume, 'the real resumed terminal sent its next owner prompt');
      assert.match(JSON.stringify(bodies.at(-1).messages.at(-1)), /AFTER_SHELL_FAILURE/);
      assert.match(JSON.stringify(bodies.at(-1).messages), /SHELL_DELIVERY_OUTPUT/, 'the same CLI transcript retains shell output for the next model request');
      assert.equal(fs.readFileSync(path.join(f.cwd, 'shell-count.txt'), 'utf8').trim().split(/\r?\n/).length, 1, 'resuming never reruns the shell');
      t.diagnostic('terminal resume retained shell context; next prompt sends output; command ran once');
    }
  });
}
