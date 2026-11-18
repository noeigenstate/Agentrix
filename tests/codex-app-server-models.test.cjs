const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { createCodexRuntime } = require('../electron/features/codex-app-server/index.cjs');

test('live Codex models preserve efforts, default effort and priority capability through the real adapter', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => { child.exitCode = 0; child.emit('exit', 0); child.emit('close', 0); };
  child.stdin = new Writable({ write(chunk, _encoding, done) {
    const { id, method, params } = JSON.parse(chunk);
    if (id) {
      let result = {}, error;
      if (method === 'initialize') result = { userAgent: 'codex/0.166.0' };
      else if (['thread/resume', 'turn/start', 'turn/steer', 'turn/interrupt'].includes(method)) error = { code: -32602, message: 'Missing identifiers' };
      else if (method === 'thread/start') result = { thread: { id: 'catalog-thread', turns: [] }, cwd: params.cwd,
        sandbox: { type: 'dangerFullAccess' }, approvalPolicy: 'never', approvalsReviewer: 'user' };
      else if (method === 'model/list') result = { data: [{ model: 'gpt-6.2-sol', displayName: 'New Sol',
        supportedReasoningEfforts: [{ reasoningEffort: 'ultra' }], defaultReasoningEffort: 'ultra', isDefault: true, serviceTiers: [{ id: 'priority' }] }] };
      queueMicrotask(() => child.stdout.write(JSON.stringify({ id, ...(error ? { error } : { result }) }) + '\n'));
    }
    done();
  } });
  const runtime = createCodexRuntime({ resolveExecutable: async () => 'injected-only', spawnProcess: () => child, optionsHome: root }).create({
    runtimeSessionId: 'catalog-runtime', cwd: root, env: { PATH: '', CODEX_HOME: path.join(root, 'cli-home') }, owner: 'gui' }, () => {});
  t.after(() => runtime.close());
  await runtime.start(); const [row] = await runtime.models();
  assert.deepEqual(row.efforts, ['ultra']); assert.equal(row.defaultEffort, 'ultra'); assert.equal(row.isDefault, true); assert.equal(row.fast, true);
});
