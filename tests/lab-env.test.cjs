const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

test('Lab composition carries current background policy to later runs without reopening the engine', async () => {
  const file = path.join(__dirname, '../electron/features/lab/index.cjs'), native = createRequire(file), module = { exports: {} };
  const settings = { claudeBackgroundTasks: false };
  let deferred, options;
  const context = { module, process: { env: { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: 'inherited' }, platform: process.platform },
    setTimeout, clearTimeout, clearImmediate, require: name => name === './window.cjs'
      ? { createLabWindow: () => ({ getWindow: () => null }) } : name === './ipc.cjs'
        ? { registerLabIpc: value => { deferred = value.engine; return () => {}; } } : native(name) };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context);
  const lab = module.exports.createLab({ userData: 'fixture', root: 'fixture', getSettings: () => settings, getMainWindow: () => null,
    engineFactory: value => { options = value; return { subscribe: () => () => {}, list: () => [], close() {} }; } });
  await deferred.list();
  // runnerOptions is the same path used for the source reference and every model run.
  const engineFile = path.join(__dirname, '../electron/features/lab/engine.cjs');
  const body = fs.readFileSync(engineFile, 'utf8').match(/  runnerOptions\(lane, signal\) \{[\s\S]*?\n  \}/)[0];
  const engine = vm.runInNewContext('({' + body + '})');
  Object.assign(engine, { env: options.env, store: {}, active: null });
  const lane = { provider: {}, ctx: { cacheDirectory: 'fixture' } };
  for (const allow of [false, true, false]) {
    settings.claudeBackgroundTasks = allow;
    const env = engine.runnerOptions(lane).env;
    assert.equal(env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, allow ? undefined : '1');
  }
  lab.dispose();
});
