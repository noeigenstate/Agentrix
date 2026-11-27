const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createInstall } = require('../electron/features/agy-acp/adapter.cjs');
const { readAgyAccount } = require('../electron/features/agy-acp/usage.cjs');
const { processTree, session, temporary } = require('./helpers/agy-runtime.cjs');

const realAgy = {
  skip: !process.env.AGENTRIX_REAL_AGY && 'set AGENTRIX_REAL_AGY to use the installed CLI', timeout: 90000,
};

async function ownerFixture(t) {
  const install = await createInstall().locate();
  if (!install.installed) return t.skip('agy is not installed');
  const folder = await temporary(t), cwd = path.join(folder, 'project'), geminiDir = path.join(folder, 'profile');
  await fs.mkdir(cwd);
  const spec = { cwd, geminiDir, owner: 'gui', permissions: 'ask', model: 'gemini-3.8-flash', effort: 'low', turnTimeoutMs: 45000 };
  const options = { resolveExecutable: () => install.file };
  return { spec, file: install.file, open: override => session(folder, { ...spec, ...override }, options) };
}

test('real agy owner lists and loads a private Flash Low conversation', realAgy, async t => {
  const fixture = await ownerFixture(t);
  if (!fixture) return;
  const { spec, open } = fixture, first = open();
  let id;
  try {
    id = (await first.runtime.start()).providerSessionId;
    const done = first.events.wait(event => event.type === 'turn.completed');
    await first.runtime.send({ clientMessageId: randomUUID(), text: 'Reply OK.' });
    const { payload } = await done;
    if (payload.error === 'agy_auth_required') return t.skip('agy is not signed in');
    assert.equal(payload.status, 'completed');
    assert.equal(await first.runtime.readActualModel(), 'gemini-3.8-flash-low');
  } catch (error) {
    if (error.code === 'agy_auth_required') return t.skip('agy is not signed in');
    throw error;
  } finally { await first.runtime.close(); }
  assert.ok((await first.factory.history(spec)).some(row => row.id === id));
  const next = open({ providerSessionId: id });
  try {
    assert.deepEqual(await next.runtime.resume(), { providerSessionId: id });
    assert.partialDeepStrictEqual(next.runtime.modelOptions(), { model: 'gemini-3.8-flash', effort: 'low' });
    const messages = next.runtime.snapshot().events.filter(event => event.type === 'item.upsert').map(event => event.payload);
    assert.ok(messages.some(item => item.kind === 'user-message' && item.content.text.includes('Reply OK.')));
    assert.ok(messages.some(item => item.kind === 'agent-message' && /\bOK\b/.test(item.content.text)));
  } finally { await next.runtime.close(); }
});

async function requestWrite(runtime, events, file) {
  await runtime.start();
  const opened = events.wait(event => event.type === 'request.opened');
  const done = events.wait(event => event.type === 'turn.completed');
  const receipt = await runtime.send({ clientMessageId: randomUUID(), text: `Use write_file to create ${file} with content OK.` });
  assert.equal(receipt.status, 'queued');
  const event = await Promise.race([opened, done]);
  assert.equal(event.type, 'request.opened', JSON.stringify(event.payload));
  assert.equal(event.payload.kind, 'file-change');
  assert.equal(runtime.snapshot().state, 'waiting');
  return { requestId: event.payload.requestId, done };
}

test('real agy owner in ask mode waits for and honors an allow answer', realAgy, async t => {
  const fixture = await ownerFixture(t);
  if (!fixture) return;
  const { runtime, events } = fixture.open(), file = 'approval.txt', target = path.join(fixture.spec.cwd, file);
  try {
    const { requestId, done } = await requestWrite(runtime, events, file);
    await assert.rejects(fs.access(target), { code: 'ENOENT' });
    const resolved = events.wait(event => event.type === 'request.resolved' && event.payload.requestId === requestId);
    runtime.answer(requestId, { decision: 'allow' });
    assert.equal((await resolved).payload.resolution, 'allowed');
    assert.equal((await done).payload.status, 'completed');
    assert.equal((await fs.readFile(target, 'utf8')).trim(), 'OK');
    assert.equal(await runtime.readActualModel(), 'gemini-3.8-flash-low');
  } finally { await runtime.close(); }
});

test('a real agy owner turn cancels on interrupt and closing reaps its process tree', realAgy, async t => {
  const fixture = await ownerFixture(t);
  if (!fixture) return;
  const { runtime, events } = fixture.open(), file = 'interrupted.txt';
  try {
    const { requestId, done } = await requestWrite(runtime, events, file);
    const pids = await processTree(runtime.pid);
    assert.ok(pids.size > 1, 'the test must observe a live descendant');
    await runtime.interrupt();
    const interrupted = await done;
    assert.partialDeepStrictEqual(interrupted.payload, { status: 'interrupted', terminalReason: 'cancelled' });
    assert.throws(() => runtime.answer(requestId, { decision: 'allow' }), { code: 'request_expired' });
    await assert.rejects(fs.access(path.join(fixture.spec.cwd, file)), { code: 'ENOENT' });
    const doneAgain = events.wait(event => event.type === 'turn.completed' && event.turnId !== interrupted.turnId);
    const started = await runtime.send({ clientMessageId: randomUUID(), text: 'Reply OK.' });
    assert.equal(started.status, 'queued');
    assert.equal((await doneAgain).payload.status, 'completed');
    assert.equal(await runtime.readActualModel(), 'gemini-3.8-flash-low');
    await runtime.close();
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    t.diagnostic(`all ${pids.size} processes exited`);
  } finally { await runtime.close(); }
});

test('real agy /usage reads the private profile without opening a session or running a model turn', realAgy, async t => {
  const fixture = await ownerFixture(t);
  if (!fixture) return;
  const { cwd, geminiDir } = fixture.spec;
  await fs.mkdir(geminiDir);
  const brain = path.join(geminiDir, '.gemini', 'antigravity-cli', 'brain');
  const sessions = async () => (await fs.readdir(brain).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return [];
  })).sort();
  const before = await sessions();
  const env = { ...process.env, HOME: geminiDir, USERPROFILE: geminiDir };
  const account = await readAgyAccount({ cwd, env, locate: () => fixture.file });
  // The reader accepts quota windows only from a successful, zero-turn /usage reply.
  assert.ok(account.limits.length > 0, 'agy did not return quota windows from a zero-turn /usage reply');
  assert.deepEqual(await sessions(), before);
  t.diagnostic(`/usage returned ${account.limits.length} windows, session entries: ${before.length} before and after`);
});
