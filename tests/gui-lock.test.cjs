const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

// A copy in a temporary folder keeps its lock file away from the checkout's real GUI lock.
function lockCopy(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentrix-gui-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.copyFileSync(path.join(__dirname, '..', 'scripts', 'gui-lock.mjs'), path.join(root, 'scripts', 'gui-lock.mjs'));
  return { url: pathToFileURL(path.join(root, 'scripts', 'gui-lock.mjs')).href, lock: path.join(root, '.test-output', 'gui-probe.lock') };
}
function run(code, extra = {}) {
  const env = { ...process.env, ...extra };
  if (!extra.AGENTRIX_GUI_LOCK) delete env.AGENTRIX_GUI_LOCK;
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 20000, env });
}

test('a smoke started inside a held GUI lock runs at once instead of waiting on its parent', t => {
  const { url } = lockCopy(t);
  const inner = `import { withGuiLock } from ${JSON.stringify(url)}; await withGuiLock('smoke', async () => console.log('inner ran'));`;
  const outer = run(`import { spawnSync } from 'node:child_process'; import { withGuiLock } from ${JSON.stringify(url)};
    await withGuiLock('ci-preflight:step', async () => {
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(inner)}], { encoding: 'utf8', timeout: 15000 });
      process.stdout.write(child.stdout); if (child.status !== 0) process.exit(1);
    });
    console.log(process.env.AGENTRIX_GUI_LOCK === undefined ? 'released' : 'still set');`);
  assert.equal(outer.status, 0, outer.stderr);
  assert.deepEqual(outer.stdout.trim().split(/\r?\n/), ['inner ran', 'released']);
});

test('an inherited value that is not the held lock does not bypass a lock held by someone else', t => {
  const { url, lock } = lockCopy(t);
  fs.mkdirSync(path.dirname(lock)); fs.writeFileSync(lock, 'other-worker 2026-01-01T00:00:00.000Z\n');
  const result = run(`import { withGuiLock } from ${JSON.stringify(url)};
    const timer = setTimeout(() => { console.log('waited'); process.exit(0); }, 1500);
    await withGuiLock('smoke', async () => { clearTimeout(timer); console.log('bypassed'); });`, { AGENTRIX_GUI_LOCK: 'stale-parent\n' });
  assert.equal(result.stdout.trim(), 'waited');
});
