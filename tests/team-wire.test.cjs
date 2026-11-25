const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { teamAt } = require('../electron/features/team/team.cjs');
const { RunInbox } = require('../electron/features/team/inbox.cjs');

function project(t) {
  const common = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'team-wire-')));
  t.after(() => fs.rmSync(common, { recursive: true, force: true }));
  return teamAt(common, common, true);
}

const jsonLine = value => JSON.stringify(value) + '\n';
const worker = team => ({ title: 'Task', role: 'build', agent: 'codex', model: 'test', cwd: team.cwd, allow: ['src/**'] });
const versionError = (channel, version) => ({ code: 'wire.unsupported_version', message: `${channel}: unsupported version ${version}` });

test('journal appends version one and reads unmodified historical rows', t => {
  const team = project(t), legacy = { type: 'incident', time: 1, cause: 'historical' };
  const initial = jsonLine(legacy) + '{torn}\n';
  fs.writeFileSync(team.journal, initial);
  team.append({ type: 'consolidate', v: 9, meeting: 'current' });
  assert.ok(fs.readFileSync(team.journal, 'utf8').startsWith(initial));
  const [first, current] = team.entries();
  assert.deepEqual(first, legacy);
  assert.deepEqual(current, { v: 1, type: 'consolidate', meeting: 'current', time: current.time });
  assert.ok(Number.isSafeInteger(current.time));
  const future = jsonLine({ type: 'consolidate', v: 9, time: 2 });
  fs.appendFileSync(team.journal, future);
  assert.deepEqual(team.journalHistory(), { entries: [first, current], skipped: 2 });
  assert.deepEqual(team.entries(), [first, current]);
  assert.ok(fs.readFileSync(team.journal, 'utf8').endsWith(future));
});

test('board reads historical peers and validates the version before using or deleting an entry', async t => {
  const team = project(t), id = randomUUID(), previous = randomUUID(), file = path.join(team.board, id + '.json');
  const legacy = { ...worker(team), id: previous, pid: process.pid, startedAt: 1 };
  fs.writeFileSync(path.join(team.board, previous + '.json'), jsonLine(legacy));
  team.register(worker(team), id);
  const current = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual({ format: current.format, version: current.version }, { format: 'agentrix.board', version: 1 });
  assert.deepEqual(team.live().find(row => row.id === previous), legacy);
  assert.deepEqual(team.live().find(row => row.id === id), current);
  const inbox = new RunInbox(team, previous);
  await inbox.open();
  assert.deepEqual(team.live().find(row => row.id === previous), { ...legacy, format: 'agentrix.board', version: 1, controls: true });
  fs.writeFileSync(file, jsonLine({ ...current, version: 8 }));
  assert.throws(() => team.live(), versionError('agentrix.board', 8));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 8);
  fs.writeFileSync(file, jsonLine({ ...current, format: 'agentrix.other' }));
  assert.throws(() => team.live(), { code: 'wire.invalid', message: 'agentrix.board: expected format agentrix.board' });
  fs.writeFileSync(file, jsonLine({ ...current, version: undefined }));
  assert.throws(() => team.live(), versionError('agentrix.board', '0 (missing)'));
});

test('inbox writes the versioned 1.6.4 shape and reads both legacy and explicit intervention messages', async t => {
  const team = project(t), id = randomUUID(), inbox = new RunInbox(team, id);
  team.register(worker(team), id);
  await inbox.open();
  const intervention = { id: randomUUID(), at: 1, text: 'Ship the audited patch' };
  const explicit = { id: randomUUID(), at: 2, text: 'Follow up' };
  const historical = { id: randomUUID(), at: 3, text: 'Old format' };
  const stop = { id: randomUUID(), at: 4, type: 'stop', reason: 'Stop cleanly', noResume: true };
  assert.deepEqual(await team.queueControl(id, intervention), intervention);
  assert.deepEqual(JSON.parse(fs.readFileSync(inbox.file, 'utf8')), { v: 1, ...intervention });
  fs.appendFileSync(inbox.file, jsonLine({ v: 1, type: 'intervention', ...explicit }) + jsonLine(historical));
  assert.deepEqual(await team.queueControl(id, stop), stop);
  assert.equal(JSON.parse(fs.readFileSync(inbox.file, 'utf8').trim().split('\n').at(-1)).v, 1);
  assert.deepEqual(await inbox.take(), [intervention, explicit, historical, stop]);
  assert.deepEqual(await inbox.take(), []);
  await inbox.recordReceipt(intervention.id, 'delivered');
  await inbox.recordReceipt(intervention.id, 'delivered');
  const receipts = fs.readFileSync(team.memoryJsonl, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line))
    .filter(row => row.source === 'control-receipt');
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].runId, id);
  assert.deepEqual(receipts[0].text, { messageId: intervention.id, status: 'delivered' });
  assert.deepEqual(team.entries().map(row => [row.v, row.type]), [[1, 'intervention'], [1, 'stop'], [1, 'control-receipt']]);
  assert.match(fs.readFileSync(team.memory, 'utf8'), /owner intervention receipt/);
});

test('an unknown inbox version reports the channel without consuming earlier messages in the same batch', async t => {
  const team = project(t), id = randomUUID(), inbox = new RunInbox(team, id);
  team.register(worker(team), id);
  await inbox.open();
  const first = { id: randomUUID(), at: 1, text: 'Retry this' }, future = { id: randomUUID(), at: 2, text: 'New format' };
  fs.writeFileSync(inbox.file, jsonLine(first) + jsonLine({ ...future, v: 5 }));
  await assert.rejects(inbox.take(), versionError('inbox.jsonl', 5));
  assert.equal(inbox.offset, 0);
  assert.equal(inbox.seen.size, 0);
  fs.writeFileSync(inbox.file, jsonLine(first) + jsonLine({ ...future, v: 1 }));
  assert.deepEqual(await inbox.take(), [first, future]);
});

test('failed planner admission logs a versioned withdrawal and leaves the inbox available', async t => {
  const team = project(t), id = randomUUID(), inbox = new RunInbox(team, id);
  team.register(worker(team), id);
  await inbox.open();
  const stop = { id: randomUUID(), at: 4, type: 'stop', noResume: true };
  await assert.rejects(team.queueControl(id, stop, () => { throw new Error('planner refused'); }), /planner refused/);
  const [request, withdrawal] = team.entries();
  assert.equal(request.v, 1);
  assert.deepEqual(withdrawal, { type: 'withdrawn', v: 1, id, messageId: stop.id, at: stop.at, time: withdrawal.time });
  assert.deepEqual(await inbox.take(), []);
  assert.equal(team.live().find(row => row.id === id).closing, false);
});
