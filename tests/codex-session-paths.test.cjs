const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createCodexRuntime } = require('../electron/features/codex-app-server/index.cjs');

test('local Codex preserves junction cwd and aliases cannot bypass thread occupancy', { timeout: 15000 }, async t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agx-codex-alias-')));
  const cwd = path.join(root, 'project'), alias = path.join(root, 'alias'), home = path.join(root, 'home'), homeAlias = path.join(root, 'home-alias');
  fs.mkdirSync(cwd); fs.mkdirSync(home);
  fs.symlinkSync(cwd, alias, process.platform === 'win32' ? 'junction' : 'dir');
  fs.symlinkSync(home, homeAlias, process.platform === 'win32' ? 'junction' : 'dir');
  const log = path.join(root, 'rpc.jsonl'), launches = [], sessions = [];
  t.after(async () => { for (const session of sessions) await session.close(); await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const factory = createCodexRuntime({ resolveExecutable: async () => process.execPath, spawnProcess: (_file, _args, options) => {
    launches.push(options.cwd);
    return spawn(process.execPath, [path.join(__dirname, 'fixtures/codex-app-server.cjs')], options);
  } });
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(SystemRoot|WINDIR|COMSPEC|PATH|PATHEXT)$/i.test(name))),
    HOME: home, USERPROFILE: home, CODEX_HOME: homeAlias, GIT_CEILING_DIRECTORIES: root, SYNTHETIC_CODEX_LOG: log };
  const spec = { cwd: alias, env, owner: 'gui', runtimeSessionId: 'first-alias', context: 'Project ' + alias };
  const first = factory.create(spec, () => {}); sessions.push(first);
  const opened = await first.start(); await first.commands();
  assert.equal(spec.cwd, alias, 'the host project identity stays as supplied');
  assert.equal(launches[0], alias);
  const second = factory.create({ ...spec, cwd, env: { ...env, CODEX_HOME: home }, runtimeSessionId: 'second-alias', providerSessionId: opened.providerSessionId }, () => {});
  sessions.push(second);
  await assert.rejects(second.resume(), /thread_in_use/);
  const history = await factory.history({ ...spec, providerSessionId: opened.providerSessionId });
  assert.equal(history.id, opened.providerSessionId);
  const requests = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  for (const request of requests.filter(row => row.method === 'thread/start')) {
    assert.equal(request.params.cwd, alias);
    assert.equal(request.params.config.developer_instructions, spec.context, 'junction instructions stay as supplied');
  }
  assert.deepEqual(requests.filter(row => row.method === 'thread/list').map(row => row.params.cwd), [alias, cwd]);
  assert.deepEqual(requests.find(row => row.method === 'skills/list').params.cwds, [alias]);
});
