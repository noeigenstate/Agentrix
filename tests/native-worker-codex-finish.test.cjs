const { test, resources } = require('./fixtures/codex-app-server-lifecycle.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');
const { run } = require('../integration/dispatch.cjs');
const { createDispatchControl } = require('../electron/features/agents/dispatch-control.cjs');
const { createInterventions } = require('../electron/features/agents/interventions.cjs');

test('an accepted unread Codex steer resumes the same thread once before helper exit', { timeout: 15000 }, async t => {
  const lifetime = resources(t), root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-unread-codex-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = args => execFileSync('git', args, { cwd: root, stdio: 'ignore', windowsHide: true });
  git(['init', '-q']); fs.writeFileSync(path.join(root, '.gitignore'), '.dispatch/\n'); git(['add', '.gitignore']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Fixture']);
  const work = path.join(root, '.dispatch'); fs.mkdirSync(work);
  const log = path.join(work, 'wire.jsonl'), brief = path.join(work, 'brief.md'), out = path.join(work, 'answer.md'), bootstrap = path.join(work, 'bootstrap.json');
  fs.writeFileSync(brief, 'Initial task');
  const control = createDispatchControl({ resolveRun: auth => auth.capability === 'offline-capability' ? {
    runId: auth.runId, projectId: 'p', cwd: root, allow: [], agent: 'codex', readOnly: true,
  } : null });
  const { address } = await control.listen(); lifetime.defer('close control', () => control.close());
  fs.writeFileSync(bootstrap, JSON.stringify({ controlAddress: address, controlCapability: 'offline-capability', sessionKey: 'offline-key', projectId: 'p', pipeName: 'offline-absent-events' }));
  let stdout = '', finished = false;
  const result = run(['codex', '--role', 'review', '--title', 'Unread correction', '--model', 'synthetic-model', '--effort', 'high',
    '--cwd', root, '--brief', brief, '--out', out], { env: { PATH: '', HOME: work, USERPROFILE: work, CODEX_HOME: work,
    AGENTRIX_BOOTSTRAP: bootstrap, SYNTHETIC_CODEX_MODE: 'unread-worker', SYNTHETIC_CODEX_LOG: log },
    stdout: { write: value => { stdout += value; } },
    resolveExecutable: (_agent, args) => ({ file: process.execPath, args: [path.join(__dirname, 'fixtures/codex-app-server.cjs'), ...args] }),
    launch: (file, args, options) => lifetime.child(spawn(file, args, options)),
  }).finally(() => { finished = true; });
  lifetime.defer('finish helper', async () => { if (!finished) control.close(); await lifetime.wait(result, 'Codex helper'); });
  for (let n = 0; !stdout.includes('[dispatch] started ') && n < 500; n++) await new Promise(resolve => setTimeout(resolve, 10));
  const id = /\[dispatch\] started ([\w-]+)/.exec(stdout)?.[1]; assert.ok(id, stdout);
  const target = { terminalId: 'p', callId: `dispatch:${id}`, parentSessionId: 'planner', confirmed: true, local: true,
    route: 'dispatch', runId: id, cwd: root, projectPath: root, title: 'Unread correction' };
  const api = createInterventions({ resolve: () => target, pushControl: control.pushControl });
  const receipt = await api.interveneAgent('p', target.callId, 'Handle this correction');
  assert.equal(await result, 0);
  assert.equal(fs.readFileSync(out, 'utf8'), 'Correction handled');
  const requests = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(requests.filter(value => value.method === 'thread/start').length, 1);
  const resumes = requests.filter(value => value.method === 'thread/resume' && value.params?.threadId);
  assert.equal(resumes.length, 1); assert.equal(resumes[0].params.threadId, 'synthetic-thread');
  assert.equal((await api.receipts('p', target.callId)).find(value => value.id === receipt.id).status, 'consumed');
});
