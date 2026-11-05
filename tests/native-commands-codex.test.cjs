const { test, resources } = require('./fixtures/codex-app-server-lifecycle.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createCodexRuntime } = require('../electron/features/codex-app-server/index.cjs');

test('Codex lists only enabled bound skills, caches reads, invalidates changes and attaches a selected skill by host path', async t => {
  const lifetime = resources(t), root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-codex-commands-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const log = path.join(root, 'wire.jsonl'), skill = path.join(root, 'offline/SKILL.md');
  const runtime = createCodexRuntime({ resolveExecutable: async () => 'synthetic-only', spawnProcess: (_file, _args, options) => {
    return lifetime.child(spawn(process.execPath, [path.join(__dirname, 'fixtures/codex-app-server.cjs')], options));
  } }).create({ cwd: root, env: { PATH: '', CODEX_HOME: root, SYNTHETIC_CODEX_MODE: 'skill-catalog', SYNTHETIC_CODEX_LOG: log, SYNTHETIC_SKILL_PATH: skill } }, () => {});
  lifetime.defer('close runtime', () => runtime.close());
  await runtime.start();
  assert.deepEqual(await runtime.commands(), [{ name: '/offline', description: 'Offline skill', source: 'skill', view: 'reading' }]);
  await runtime.commands();
  const requests = () => fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(requests().filter(row => row.method === 'skills/list').length, 1);
  await runtime.send({ clientMessageId: 'command', text: '/offline ARG' });
  const input = requests().findLast(row => row.method === 'turn/start').params.input;
  assert.deepEqual(input.find(row => row.type === 'skill'), { type: 'skill', name: 'offline', path: skill });
  assert.equal(input[0].text, '/offline ARG');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal((await runtime.commands())[0].name, '/replacement');
  assert.equal(requests().filter(row => row.method === 'skills/list').length, 2);
  assert.ok(!JSON.stringify(await runtime.commands()).includes(root), 'renderer gets names, never an executable skill path');
});

test('an unavailable optional skills RPC returns no terminal commands and leaves the connection usable', async t => {
  const lifetime = resources(t), events = [];
  const runtime = createCodexRuntime({ resolveExecutable: async () => 'synthetic-only', spawnProcess: (_file, _args, options) =>
    lifetime.child(spawn(process.execPath, [path.join(__dirname, 'fixtures/codex-app-server.cjs')], options)),
  }).create({ cwd: os.tmpdir(), env: { PATH: '', CODEX_HOME: path.join(os.tmpdir(), 'fake-unused-home'), SYNTHETIC_CODEX_MODE: 'missing-skills' } }, event => events.push(event));
  lifetime.defer('close runtime', () => runtime.close());
  await runtime.start(); assert.deepEqual(await runtime.commands(), []);
  assert.equal((await runtime.send({ clientMessageId: 'ordinary', text: 'Continue normally' })).status, 'delivered');
  for (let n = 0; n < 200 && !events.some(event => event.type === 'turn.completed'); n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(runtime.snapshot().state, 'idle');
});
