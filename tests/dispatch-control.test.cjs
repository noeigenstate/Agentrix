const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');
const { createDispatchControl, connectDispatchControl } = require('../electron/features/agents/dispatch-control.cjs');
const { createInterventions } = require('../electron/features/agents/interventions.cjs');
const { projectTeam } = require('../electron/features/team/team.cjs');
const { run } = require('../integration/dispatch.cjs');

test('persistent channel authenticates a binding, streams events and deduplicates control receipts', async t => {
  const id = randomUUID(), controls = [];
  const run = { runId: id, projectId: 'p', cwd: os.tmpdir(), worktree: os.tmpdir(), allow: [], readOnly: false, roundtable: false };
  const control = createDispatchControl({ resolveRun: input => input.sessionKey === 'synthetic-key' && input.runId === id ? run : null });
  const { address } = await control.listen(); t.after(() => control.close());
  await assert.rejects(connectDispatchControl({ address, runId: id, projectId: 'p', sessionKey: 'wrong' }));
  const events = [], client = await connectDispatchControl({ address, runId: id, projectId: 'p', sessionKey: 'synthetic-key',
    onEvent: event => events.push(event), onControl: messageId => { controls.push(messageId); return 'delivered'; } });
  t.after(() => client.close());
  control.onRequest('synthetic.run', async (binding, payload, stream) => {
    assert.deepEqual(binding, run); assert.deepEqual(payload, { text: 'brief' }); stream.emit({ type: 'test-event' });
  });
  await client.request('synthetic.run', { text: 'brief' }); assert.equal(events.length, 1);
  const message = { messageId: randomUUID(), type: 'intervene', text: 'hello' };
  const [a, b] = await Promise.all([control.pushControl(id, message), control.pushControl(id, message)]);
  assert.deepEqual(a, b); assert.equal(a.status, 'delivered'); assert.equal(controls.length, 1);
  await assert.rejects(control.pushControl(id, { ...message, text: 'conflict' }), /conflict/);
});

test('broker forwards later controls to the registered provider handler without an SDK in the helper', async t => {
  const id = randomUUID(), run = { runId: id, projectId: 'p', cwd: os.tmpdir(), allow: [] };
  const control = createDispatchControl({ resolveRun: () => run });
  const { address } = await control.listen(); t.after(() => control.close());
  let ready, finish;
  const waiting = new Promise(resolve => { ready = resolve; });
  control.onRequest('claude-sdk.run', async (_run, _payload, stream) => {
    stream.onControl(input => { assert.equal(input.text, 'change'); return { status: 'delivered' }; }); ready();
    await new Promise(resolve => { finish = resolve; });
  });
  const client = await connectDispatchControl({ address, runId: id, projectId: 'p' }); t.after(() => client.close());
  const result = client.request('claude-sdk.run', {}); await waiting;
  assert.deepEqual(await client.request('control.deliver', { messageId: randomUUID(), type: 'intervene', text: 'change' }), { status: 'delivered' });
  finish(); await result;
});

test('a disconnected in-flight push reports unknown and never resends automatically', async t => {
  const id = randomUUID(), control = createDispatchControl({ resolveRun: () => ({ runId: id, projectId: 'p', cwd: os.tmpdir(), allow: [] }) });
  const { address } = await control.listen(); t.after(() => control.close());
  let client;
  client = await connectDispatchControl({ address, runId: id, projectId: 'p', onControl: () => { client.close(); return 'delivered'; } });
  const message = { messageId: randomUUID(), type: 'stop' };
  assert.equal((await control.pushControl(id, message)).status, 'unknown');
  assert.equal((await control.pushControl(id, message)).status, 'unknown');
});

test('registration may tighten plan mode but cannot loosen the main-owned read-only binding', async t => {
  const control = createDispatchControl({ resolveRun: auth => ({ runId: auth.runId, projectId: 'p', cwd: os.tmpdir(), allow: [], readOnly: auth.runId === 'trusted-read-only', roundtable: false }) });
  const { address } = await control.listen(); t.after(() => control.close());
  control.onRequest('mode', async (run, _payload, stream) => stream.emit({ readOnly: run.readOnly }));
  for (const [runId, readOnly] of [['client-plan', true], ['trusted-read-only', false]]) {
    const events = [], client = await connectDispatchControl({ address, runId, projectId: 'p', readOnly, onEvent: event => events.push(event) });
    try { await client.request('mode', {}); assert.equal(events[0].readOnly, true); }
    finally { client.close(); }
  }
});

for (const action of ['intervene', 'stop']) test(`helper delivers ${action} to a fake app-server before its turn ends`, { timeout: 15000 }, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agx-native-dispatch-'))), repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo, windowsHide: true });
  const team = projectTeam(repo, true), bootstrap = path.join(root, 'bootstrap.json'), brief = path.join(root, 'brief.md'), out = path.join(root, 'answer.md');
  fs.writeFileSync(brief, 'Synthetic task');
  const control = createDispatchControl({ resolveRun: auth => auth.sessionKey === 'synthetic-key' && team.live().some(x => x.id === auth.runId)
    ? { runId: auth.runId, projectId: 'p', cwd: repo, worktree: repo, allow: [], readOnly: false, roundtable: false } : null });
  const { address } = await control.listen();
  fs.writeFileSync(bootstrap, JSON.stringify({ pipeName: address + '-unused', controlAddress: address, projectId: 'p', sessionKey: 'synthetic-key' }));
  let stdout = '', finished = false;
  const result = run(['codex', '--role', 'exec', '--title', 'Synthetic native', '--model', 'synthetic-model', '--effort', 'high', '--fast',
    '--cwd', repo, '--brief', brief, '--out', out, '--allow', 'src/**', '--skip-meeting', 'Synthetic native fixture'], {
    env: { PATH: '', CODEX_HOME: path.join(root, 'home'), AGENTRIX_BOOTSTRAP: bootstrap, SYNTHETIC_CODEX_MODE: 'worker' },
    stdout: { write: text => { stdout += text; } },
    resolveExecutable: (_agent, args) => ({ file: process.execPath, args: [path.join(__dirname, 'fixtures/codex-app-server.cjs'), ...args] }),
    launch: (file, args, options) => spawn(file, args, options),
  }).finally(() => { finished = true; });
  t.after(async () => {
    if (!finished) for (const worker of team.live()) await team.queueControl(worker.id, { id: randomUUID(), type: 'stop', at: Date.now(), noResume: true }).catch(() => {});
    await result; control.close(); fs.rmSync(root, { recursive: true, force: true });
  });
  for (let n = 0; !stdout.includes('[dispatch] started') && n < 400 && !finished; n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.match(stdout, /\[dispatch\] started/);
  const id = /\[dispatch\] started ([\w-]+)/.exec(stdout)[1];
  const api = createInterventions({ resolve: () => ({ terminalId: 't', callId: `dispatch:${id}`, parentSessionId: 'planner', confirmed: true,
    route: 'dispatch', runId: id, title: 'Synthetic native', cwd: repo, projectPath: repo, local: true }),
    sendParentPrompt: () => assert.fail('planner paste'), pushControl: control.pushControl });
  const receipt = action === 'intervene' ? await api.interveneAgent('t', `dispatch:${id}`, 'Owner correction') : await api.stopAgent('t', `dispatch:${id}`);
  assert.equal(receipt.status, 'delivered'); assert.equal(await result, action === 'intervene' ? 0 : 1);
  if (action === 'intervene') assert.equal(fs.readFileSync(out, 'utf8'), 'Owner correction');
  assert.match(stdout, /intervention .* delivered/); assert.doesNotMatch(stdout, /fallback|resume failed/);
  assert.match(fs.readFileSync(team.memory, 'utf8'), /\[dispatch\] intervention .* delivered/);
});
