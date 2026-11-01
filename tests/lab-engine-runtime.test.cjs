const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');

async function temporary(t) {
  const base = process.platform === 'darwin' ? path.join(os.homedir(), '.ctmp') : os.tmpdir();
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'lab-runtime-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 8 }));
  const app = path.join(root, 'Electron');
  await fs.writeFile(app, 'never execute the app');
  return { root, app };
}

async function electronRuntime(app, overrides = {}) {
  const file = path.join(__dirname, '../electron/features/lab/runtime.cjs'), localRequire = createRequire(file);
  const module = { exports: {} };
  vm.runInNewContext(await fs.readFile(file, 'utf8'), {
    module, process: { execPath: app, versions: { electron: 'fixture' }, env: {} },
    require: name => overrides[name] || localRequire(name),
  });
  return module.exports.resolveNode;
}

test('an Electron host selects independent Node from PATH without probing or exposing its app runtime', {
  skip: !process.allowedNodeEnvironmentFlags.has('--disable-sigusr1') ? 'a supported Node runtime is required' : false,
}, async t => {
  const { root, app } = await temporary(t), commands = [];
  const { command } = require('../electron/features/lab/process.cjs');
  const resolveNode = await electronRuntime(app, {
    './process.cjs': { async command(file, ...args) { commands.push(file); return command(file, ...args); } },
  });
  const node = await resolveNode({ nodePath: app, env: { PATH: path.dirname(process.execPath) }, protectedPaths: [root] });
  assert.equal(node, await fs.realpath(process.execPath));
  assert.deepEqual(commands, [node]);
});

test('a missing independent Node runtime is an infrastructure error and never falls back to Electron', async t => {
  const { app } = await temporary(t);
  const resolveNode = await electronRuntime(app, {
    './disk.cjs': { fs: { async realpath(file) {
      if (file === app) return app;
      throw Object.assign(new Error('fixture missing Node'), { code: 'ENOENT' });
    } } },
    './process.cjs': { command() { assert.fail('Electron must never be used as a fallback'); } },
  });
  await assert.rejects(resolveNode({ env: {} }), error => {
    assert.equal(error.code, 'ERR_LAB_NODE_RUNTIME'); assert.equal(error.infrastructure, true);
    assert.equal(error.message, '需要先安装 Node.js'); return true;
  });
});
