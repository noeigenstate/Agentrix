require('./fixtures/team-isolation.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTeamLocator } = require('../electron/features/team/team-locate.cjs');

// Main's team lookup with Git and the clock stood in: a project folder whose Git directory is its own .git, and a fake execFile that
// counts the calls and answers as `git rev-parse --git-common-dir` does. Only the team folder is looked at on the real disk.
function project(t, { team = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agx-team-locate-'))); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.git'));
  if (team) fs.mkdirSync(path.join(root, '.git', 'agentrix', 'board'), { recursive: true });
  return root;
}
function git(answer = () => ({ stdout: '.git\n' })) {
  const calls = [];
  const execFile = (file, args, options, done) => {
    calls.push({ file, args, options });
    const reply = answer(calls.length);
    setImmediate(() => reply.error ? done(reply.error) : done(null, reply.stdout));
  };
  return { calls, execFile };
}
let clock = 0;
const locator = fake => createTeamLocator({ execFile: fake.execFile, now: () => clock });

test('the common directory is remembered for 30 s by the folder\'s real path, and asked again at 30 s', async t => {
  const root = project(t), fake = git(), locate = locator(fake);
  clock = 1000;
  assert.ok(await locate(root)); assert.equal(fake.calls.length, 1);
  assert.deepEqual(fake.calls[0].args, ['rev-parse', '--git-common-dir']); assert.equal(fake.calls[0].file, 'git');
  assert.equal(fake.calls[0].options.cwd, root);
  clock = 1000 + 29_999;
  assert.ok(await locate(root)); assert.equal(fake.calls.length, 1, 'inside the 30 s Git is not asked again');
  clock = 1000 + 30_000;
  assert.ok(await locate(root)); assert.equal(fake.calls.length, 2, 'at 30 s it is asked again');
});

test('a failed lookup and a folder outside Git are not remembered', async t => {
  const root = project(t), missing = path.join(root, 'gone');
  const fake = git(call => call === 1 ? { error: new Error('git failed') } : call === 2 ? { error: Object.assign(new Error('not a repository'), { code: 128 }) } : { stdout: '.git\n' });
  const locate = locator(fake); clock = 0;
  assert.equal(await locate(root), null); assert.equal(await locate(root), null);
  assert.equal(fake.calls.length, 2, 'each failure is asked about again at once');
  assert.ok(await locate(root), 'the third answer is the repository'); assert.equal(fake.calls.length, 3);
  assert.equal(await locate(missing), null, 'a folder that does not exist is no team'); assert.equal(fake.calls.length, 3, 'and costs no Git call');
});

test('three lookups at the same time run Git once and share its answer', async t => {
  const root = project(t), fake = git(), locate = locator(fake); clock = 0;
  const teams = await Promise.all([locate(root), locate(root), locate(root)]);
  assert.equal(fake.calls.length, 1);
  assert.ok(teams.every(team => team && team.board === teams[0].board));
});

test('a team created after the first lookup is found at once: only Git\'s answer is remembered, never whether the team exists', async t => {
  const root = project(t, { team: false }), fake = git(), locate = locator(fake); clock = 0;
  assert.equal(await locate(root), null, 'no team folder yet'); assert.equal(fake.calls.length, 1);
  fs.mkdirSync(path.join(root, '.git', 'agentrix', 'board'), { recursive: true });
  const team = await locate(root);
  assert.ok(team, 'the helper has just made it'); assert.equal(fake.calls.length, 1, 'found without asking Git again');
  fs.rmSync(path.join(root, '.git', 'agentrix'), { recursive: true });
  assert.equal(await locate(root), null, 'and gone again when it is removed');
});

test('Git that never answers gives null after 10 s and is asked again next time', async t => {
  const root = project(t);
  // Git is asked to give up after 10 s (node kills it and reports an error); the stand-in does the same.
  const calls = [];
  // The lookup reaches Git only after the folder's real path is read on the thread pool, which takes however long it takes: wait for the call.
  let onCall; const called = new Promise(resolve => { onCall = resolve; });
  const execFile = (file, args, options, done) => {
    calls.push(options); onCall();
    if (calls.length === 1) setTimeout(() => done(Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' })), options.timeout);
    else setImmediate(() => done(null, '.git\n'));
  };
  const locate = createTeamLocator({ execFile, now: () => 0 });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = locate(root);
  await called;
  assert.equal(calls.length, 1); assert.equal(calls[0].timeout, 10_000, 'Git is told to stop after 10 s');
  t.mock.timers.tick(9_999);
  assert.equal(await Promise.race([pending.then(() => 'answered'), new Promise(resolve => setImmediate(() => resolve('waiting')))]), 'waiting', 'before 10 s it still waits');
  t.mock.timers.tick(1);
  assert.equal(await pending, null);
  t.mock.timers.reset();
  assert.ok(await locate(root), 'the timeout was not remembered'); assert.equal(calls.length, 2);
});
