const { test, resources } = require('./fixtures/codex-app-server-lifecycle.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { run } = require('../integration/dispatch.cjs');
const { createDispatchControl } = require('../electron/features/agents/dispatch-control.cjs');
const { createInterventions } = require('../electron/features/agents/interventions.cjs');
const { AgentCalls } = require('../electron/features/agents/agent-calls.cjs');
const { acceptDispatch } = require('../electron/features/agents/dispatch-events.cjs');
const { createEventServer } = require('../electron/events.cjs');
const { registerClaudeWorker } = require('../electron/features/native-session/worker.cjs');
const { createClaudeRuntime } = require('../electron/features/claude-sdk/index.cjs');
const { projectTeam } = require('../electron/features/team/team.cjs');
const { RunInbox } = require('../electron/features/team/inbox.cjs');

async function until(predicate) {
  for (let n = 0; n < 500; n++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Synthetic Claude worker timed out');
}
function sdkFixture() {
  const values = [], inputs = [], calls = [];
  let wake, error, done = false, count = 0, abortErrors = 0;
  const sessionId = randomUUID();
  const put = value => { values.push(value); wake?.(); };
  const sdk = { query(spec) {
    error = undefined; done = false;
    calls.push(spec);
    spec.options.abortController.signal.addEventListener('abort', () => { error = Object.assign(new Error('Synthetic abort'), { name: 'AbortError' }); done = true; wake?.(); }, { once: true });
    void (async () => {
      let initialized = false;
      for await (const input of spec.prompt) {
        inputs.push(input);
        if (!initialized) { initialized = true; put({ type: 'system', subtype: 'init', session_id: sessionId, apiKeySource: 'ANTHROPIC_API_KEY', model: 'synthetic-model' }); }
      }
    })().catch(() => {});
    return { async *[Symbol.asyncIterator]() {
      for (;;) {
        if (values.length) yield values.shift();
        else if (error) { if (error.name === 'AbortError') abortErrors++; throw error; }
        else if (done) return;
        else await new Promise(resolve => { wake = resolve; });
      }
    }, close() { done = true; wake?.(); } };
  } };
  return { sdk, calls, inputs, sessionId, end() { done = true; wake?.(); }, abortErrors: () => abortErrors, fail() { error = new Error('Synthetic mid-run failure'); wake?.(); },
    finish(text = 'Synthetic answer', queuedTurns = 0) {
      const input = inputs.at(-1);
      put({ type: 'assistant', uuid: randomUUID(), user_message_uuid: input.uuid, message: { id: randomUUID(), content: [{ type: 'text', text }] } });
      put({ type: 'result', uuid: randomUUID(), user_message_uuid: input.uuid, user_message_uuids: [input.uuid], subtype: 'success',
        queued_turn_count: queuedTurns, total_cost_usd: ++count * 0.01, modelUsage: { synthetic: { inputTokens: count, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: count } } });
    } };
}

async function fixture(t, { late = false, lateStop = false, reopenFailure = false, disconnectAtFinish = false } = {}) {
  const lifetime = resources(t);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agx-claude-worker-'))), main = path.join(root, 'main'), repo = path.join(root, 'worker');
  fs.mkdirSync(main); fs.mkdirSync(path.join(main, 'src'));
  fs.writeFileSync(path.join(main, 'src/a.js'), 'base'); fs.writeFileSync(path.join(main, '.gitignore'), '.dispatch/\n');
  fs.writeFileSync(path.join(main, 'outside.txt'), 'original');
  const git = args => execFileSync('git', args, { cwd: main, windowsHide: true, stdio: 'ignore' });
  git(['init', '-q']); git(['add', '-A']); git(['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '-qm', 'Synthetic fixture']);
  git(['worktree', 'add', '-qb', 'synthetic-worker', repo]);
  const team = projectTeam(repo, true), sdk = sdkFixture(), events = [], calls = new AgentCalls({ local: false });
  const owner = { terminalId: 'terminal', sessionKey: 'synthetic-owner' };
  const eventServer = await createEventServer(event => { events.push(event); acceptDispatch(owner, event, calls); });
  lifetime.defer('close events', () => eventServer.close());
  const control = createDispatchControl({ resolveRun: auth => {
    const entry = team.live().find(value => value.id === auth.runId);
    return auth.sessionKey === owner.sessionKey && auth.capability === 'synthetic-capability' && entry ? {
      runId: entry.id, projectId: owner.terminalId, cwd: repo, worktree: repo, allow: entry.allow, readOnly: false, roundtable: false, agent: entry.agent,
    } : null;
  } });
  const { address } = await control.listen();
  lifetime.defer('close control', () => control.close());
  const claude = createClaudeRuntime({ directory: path.join(root, 'data'), loadSdk: async () => sdk.sdk, resolveExecutable: async () => 'synthetic-only',
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() } });
  claude.credentials.save('sk-ant-synthetic-worker-only-000000');
  lifetime.defer('close Claude runtime', () => claude.close());
  let api, target, sentLate = false;
  registerClaudeWorker({ control, claude, settings: () => ({ claudePath: 'api-only', monthlyBudgetUsd: null }), env: () => ({ PATH: '' }) });
  const bootstrap = path.join(root, 'bootstrap.json'), brief = path.join(root, 'brief.md'), out = path.join(repo, '.dispatch/answer.md');
  fs.mkdirSync(path.dirname(out)); fs.writeFileSync(brief, 'Synthetic task');
  fs.writeFileSync(bootstrap, JSON.stringify({ pipeName: eventServer.address, controlAddress: address, controlCapability: 'synthetic-capability', ...owner, projectId: owner.terminalId }));
  if (reopenFailure) {
    const read = fs.readFileSync; let bootstrapReads = 0;
    t.mock.method(fs, 'readFileSync', function(file, ...args) {
      if (file === bootstrap && ++bootstrapReads > 2) throw new Error('Synthetic control reopen failure');
      return read.call(this, file, ...args);
    });
  }
  const take = RunInbox.prototype.take;
  if (late || disconnectAtFinish) t.mock.method(RunInbox.prototype, 'take', async function(finish) {
    if (finish && !sentLate) {
      sentLate = true;
      if (disconnectAtFinish) control.close();
      else {
        await this.team.queueControl(this.id, { id: randomUUID(), text: 'Late owner correction', at: Date.now() });
        if (lateStop) await this.team.queueControl(this.id, { id: randomUUID(), type: 'stop', noResume: true, at: Date.now() });
      }
    }
    return take.call(this, finish);
  });
  let stdout = '', finished = false;
  const result = run(['claude', '--role', 'exec', '--title', 'Synthetic Claude worker', '--model', 'synthetic-model', '--effort', 'high',
    '--permission', 'acceptEdits', '--cwd', repo, '--brief', brief, '--out', out, '--allow', 'src/**', '--skip-meeting', 'Synthetic SDK regression'], {
    env: { PATH: '', HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'), CODEX_HOME: path.join(root, 'codex'), AGENTRIX_BOOTSTRAP: bootstrap,
      ANTHROPIC_API_KEY: 'synthetic-parent-key', CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-oauth' },
    stdout: { write: text => { stdout += text; } },
    resolveExecutable: (_agent, args) => ({ file: process.execPath, args: [path.join(__dirname, 'fixtures/codex-app-server-env.cjs'), ...args] }),
    launch: () => assert.fail('API-only worker must not spawn a CLI'),
  }).finally(() => { finished = true; });
  lifetime.defer('finish Claude helper', async () => {
    if (!finished) { control.close(); await lifetime.wait(claude.close(), 'stop Claude'); }
    await lifetime.wait(result, `helper result; output=${stdout}`);
  });
  t.after(() => { calls.reset(); fs.rmSync(root, { recursive: true, force: true }); });
  await until(() => sdk.inputs.length === 1);
  const id = team.live()[0].id;
  target = { terminalId: 'terminal', callId: `dispatch:${id}`, parentSessionId: 'planner', confirmed: true, route: 'dispatch', runId: id,
    title: 'Synthetic Claude worker', cwd: repo, projectPath: repo, local: true };
  api = createInterventions({ resolve: () => target, pushControl: control.pushControl });
  return { root, repo, sdk, api, id, target, team, calls, events, out, result, stdout: () => stdout, finished: () => finished };
}

test('B1: real Claude helper publishes started and a running activity row before the first result', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  await until(() => f.stdout().includes('[dispatch] started') && f.events.some(event => event.type === 'dispatch-start'));
  assert.equal(f.sdk.calls[0].options.env.AGENTRIX_SDK_PARENT, '1');
  assert.equal(f.finished(), false); assert.equal(f.calls.snapshot()[0].running, 1);
  const receipt = await f.api.interveneAgent('terminal', f.target.callId, 'Owner correction');
  assert.ok(['queued', 'delivered'].includes(receipt.status)); await until(() => f.sdk.inputs.length === 2);
  f.sdk.finish(); assert.equal(await f.result, 0);
  assert.match(f.stdout(), /intervention .* consumed/); assert.doesNotMatch(f.stdout(), /intervention .* unknown/);
});

for (const ending of ['stop', 'failure']) test(`B2: ${ending} after an out-of-scope write still restores and reports the scope`, { timeout: 15000 }, async t => {
  const f = await fixture(t); await until(() => f.stdout().includes('[dispatch] started'));
  fs.writeFileSync(path.join(f.repo, 'outside.txt'), 'outside worker edit'); fs.writeFileSync(path.join(f.repo, 'new-outside.txt'), 'new outside file');
  if (ending === 'stop') await f.api.stopAgent('terminal', f.target.callId); else f.sdk.fail();
  assert.equal(await f.result, 1); assert.match(f.stdout(), /OUT OF SCOPE: new-outside\.txt, outside\.txt/);
  assert.match(f.stdout(), ending === 'stop' ? /reason killed/ : /reason error/); assert.doesNotMatch(f.stdout(), /reason unconfirmed/);
  assert.equal(fs.readFileSync(path.join(f.repo, 'outside.txt'), 'utf8'), 'original'); assert.equal(fs.existsSync(path.join(f.repo, 'new-outside.txt')), false);
  const quarantine = f.stdout().match(/quarantined new files: (.*?) ·/)[1];
  assert.equal(fs.readFileSync(path.join(quarantine, 'new-outside.txt'), 'utf8'), 'new outside file');
  if (ending === 'stop') assert.ok(f.sdk.abortErrors() > 0, 'fake close exercises the SDK AbortError path');
  await until(() => f.events.some(event => event.type === 'dispatch-end'));
  assert.equal(f.events.find(event => event.type === 'dispatch-end').outOfScopeCount, 2);
});

test('M8: an accepted correction at the final result is processed before the worker closes', { timeout: 15000 }, async t => {
  const f = await fixture(t, { late: true }); await until(() => f.stdout().includes('[dispatch] started'));
  f.sdk.finish('First result'); await until(() => f.sdk.inputs.length === 2);
  assert.equal(f.sdk.inputs[1].message.content, 'Late owner correction'); f.sdk.finish('Correction result');
  assert.equal(await f.result, 0); assert.equal(fs.readFileSync(f.out, 'utf8'), 'Correction result');
  assert.equal(f.sdk.calls.length, 2); assert.equal(f.sdk.calls[1].options.resume, f.sdk.sessionId);
  assert.doesNotMatch(f.stdout(), /native worker ended before correction/);
});

test('M8: a correction rejected by an already-ended runtime resumes the same session instead of disappearing', { timeout: 15000 }, async t => {
  const f = await fixture(t, { late: true }); await until(() => f.stdout().includes('[dispatch] started'));
  // A queued turn prevents normal idle retirement; the ended stream stops the logical runtime instead.
  f.sdk.finish('First result', 1); f.sdk.end();
  await until(() => f.sdk.inputs.length === 2); assert.match(f.sdk.inputs[1].message.content, /Late owner correction/);
  assert.equal(f.sdk.calls[1].options.resume, f.sdk.sessionId); f.sdk.finish('Resumed correction result');
  assert.equal(await f.result, 0); assert.equal(fs.readFileSync(f.out, 'utf8'), 'Resumed correction result');
  assert.equal(f.sdk.inputs.length, 2); assert.equal(f.sdk.calls.length, 2);
  assert.match(f.stdout(), /native worker ended before correction/);
  assert.doesNotMatch(f.stdout(), /claude-cli fallback/);
});

test('B2: broker loss during finalization cannot turn its failed outcome into success', { timeout: 15000 }, async t => {
  const f = await fixture(t, { disconnectAtFinish: true }); await until(() => f.stdout().includes('[dispatch] started'));
  fs.writeFileSync(path.join(f.repo, 'outside.txt'), 'outside edit'); f.sdk.finish('Completed before disconnect');
  assert.equal(await f.result, 1); assert.match(f.stdout(), /reason error .*OUT OF SCOPE: outside\.txt/);
  assert.equal(fs.readFileSync(path.join(f.repo, 'outside.txt'), 'utf8'), 'original');
});

for (const ending of ['scope', 'failure', 'stop', 'reopen']) test(`N6: a deferred correction is rejected when ${ending} prevents resume`, { timeout: 15000 }, async t => {
  const f = await fixture(t, { late: true, lateStop: ending === 'stop', reopenFailure: ending === 'reopen' });
  await until(() => f.stdout().includes('[dispatch] started'));
  if (ending === 'scope') fs.writeFileSync(path.join(f.repo, 'outside.txt'), 'scope violation');
  if (ending === 'failure') f.sdk.fail();
  else { f.sdk.finish('First result', 1); f.sdk.end(); }
  assert.equal(await f.result, ['scope', 'stop'].includes(ending) ? 0 : 1);
  const receipts = f.team.entries().filter(entry => entry.type === 'control-receipt' && entry.id === f.id);
  const queued = receipts.find(entry => entry.status === 'queued'); assert.ok(queued);
  assert.equal(receipts.findLast(entry => entry.messageId === queued.messageId).status, 'rejected');
  assert.equal(receipts.at(-1).reason, 'worker_ended_without_resume');
  assert.match(f.stdout(), /rejected: worker_ended_without_resume/); assert.equal(f.sdk.inputs.length, 1);
});
