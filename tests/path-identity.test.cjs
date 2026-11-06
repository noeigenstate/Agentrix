const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { sameDirectory, expandShortPath, findRolloutSession } = require('../electron/session-files.cjs');
const { interactiveSession } = require('../electron/session-restore.cjs');
const { usageScope } = require('../electron/features/agents/codex-account-usage.cjs');
const { shortPath } = require('./fixtures/short-path.cjs');

test('interactive history, worker lookup and account scope share junction and 8.3 project identity', async t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentrix path identity long directory ')));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const cwd = path.join(root, 'project'), alias = path.join(root, 'alias'), home = path.join(root, 'home'), other = path.join(root, 'other');
  for (const directory of [cwd, home, other]) fs.mkdirSync(directory);
  fs.symlinkSync(cwd, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const id = randomUUID(), sessions = path.join(home, 'sessions'); fs.mkdirSync(sessions);
  const filename = path.join(sessions, 'rollout-' + id + '.jsonl');
  fs.writeFileSync(filename, JSON.stringify({ type: 'session_meta', payload: { id, cwd, source: 'vscode' } }) + '\n');
  const short = shortPath(cwd);
  for (const [kind, directory] of [['junction', alias], ['8.3', short]]) await t.test(kind, st => {
    if (kind === '8.3' && (process.platform !== 'win32' || !short.includes('~'))) return st.skip('volume has no Windows 8.3 alias');
    assert.equal(sameDirectory(cwd, directory), true);
    assert.equal(sameDirectory(other, directory), false);
    assert.equal(interactiveSession({ id, cwd, source: 'vscode' }, directory), true);
    const options = { cwd: directory, recordedCwd: cwd, provider: 'openai', accountLaunch: 'model-only-v1', codexHome: home, env: {} };
    assert.equal(usageScope(options).reason, undefined);
    assert.equal(usageScope({ ...options, recordedCwd: other }).reason, 'scope');
    assert.equal(expandShortPath(directory), kind === '8.3' ? cwd : directory);
    return findRolloutSession(sessions, id, directory).then(found => assert.equal(found, filename));
  });
});

test('ordinary junction, subst and mapped/UNC spellings never request physical-path expansion', t => {
  const probe = t.mock.method(fs.realpathSync, 'native', () => { throw new Error('must not resolve'); });
  for (const value of ['Z:\\project', 'R:\\project', '\\\\server\\share\\project', 'C:\\trusted-junction\\project']) assert.equal(expandShortPath(value), value);
  assert.equal(probe.mock.callCount(), 0);
});

test('8.3 expansion retains mapped and subst drive roots', { skip: process.platform !== 'win32' }, t => {
  const roots = { 'Z:\\': '\\\\fixture-host\\share', 'R:\\': 'C:\\fixture-root',
    'Z:\\PROJEC~1': '\\\\fixture-host\\share\\Project Long', 'R:\\PROJEC~1': 'C:\\fixture-root\\Project Long' };
  t.mock.method(fs.realpathSync, 'native', value => {
    assert.ok(Object.hasOwn(roots, value), 'only synthetic root mappings are resolved');
    return roots[value];
  });
  assert.equal(expandShortPath('Z:\\PROJEC~1'), 'Z:\\Project Long');
  assert.equal(expandShortPath('R:\\PROJEC~1'), 'R:\\Project Long');
});
