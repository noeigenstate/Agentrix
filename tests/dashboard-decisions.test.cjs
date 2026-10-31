const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { DashboardDecisions, currentWeights, routingNote } = require('../electron/features/dashboard/decisions.cjs');
const { READ_LIMIT, LINE_LIMIT, FILE_LIMIT } = require('../electron/features/dashboard/jsonl.cjs');

const model = 'gpt-6.1-sol';
const weight = (to, kind = 'core') => ({ model, kind, from: 1, to });
async function lab(t, options = {}) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dashboard-decisions-')));
  let clock = 100;
  const store = new DashboardDecisions(directory, { now: () => clock++, ...options });
  t.after(async () => { await store.flush(); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, store, file: path.join(directory, 'dashboard', 'decisions.jsonl'), previous: path.join(directory, 'dashboard', 'decisions.1.jsonl') };
}

test('latest adopted weight wins and withdrawal restores the earlier still-adopted suggestion', async t => {
  const { store } = await lab(t);
  await store.decide('first', 'adopted', weight(0.8));
  await store.decide('second', 'adopted', weight(0.6));
  await store.decide('frontend', 'adopted', weight(1.2, 'frontend'));
  assert.deepEqual(currentWeights(await store.read()), [weight(0.6), weight(1.2, 'frontend')]);
  await store.decide('second', 'open', weight(0.6));
  assert.deepEqual(currentWeights(await store.read()), [weight(0.8), weight(1.2, 'frontend')]);
  await store.decide('first', 'dismissed', weight(0.8));
  assert.deepEqual(currentWeights(await store.read()), [weight(1.2, 'frontend')]);
  await store.decide('first', 'adopted', weight(0.8));
  assert.equal(currentWeights(await store.read())[0].to, 0.8);
});

test('routingNote reads durable adopted weights in one English paragraph and is empty when none apply', async t => {
  const { directory, store } = await lab(t);
  assert.equal(routingNote(directory), '');
  await store.decide('mechanism', 'adopted');
  assert.equal(routingNote(directory), '');
  await store.decide('weight', 'adopted', weight(0.8));
  const note = routingNote(directory);
  assert.match(note, /Owner-adopted routing weights/); assert.match(note, /"gpt-6\.1-sol" \/ core: 0\.8/);
  assert.doesNotMatch(note, /\r|\n/);
  await store.decide('weight', 'dismissed', weight(0.8));
  assert.equal(routingNote(directory), '');
});

test('concurrent decisions serialize and ties keep adoption order across reloads', async t => {
  const { directory, store } = await lab(t, { now: () => 100 });
  assert.deepEqual(await Promise.all([store.decide('one', 'adopted', weight(0.8)), store.decide('two', 'adopted', weight(0.6))]), [true, true]);
  const reloaded = new DashboardDecisions(directory);
  assert.equal(currentWeights(await reloaded.read())[0].to, 0.6);
  await store.decide('two', 'open');
  assert.equal(currentWeights(await store.read())[0].to, 0.8);
});

test('invalid decisions are refused without writing or inventing a routing weight', async t => {
  const { directory, store } = await lab(t);
  for (const args of [ ['', 'adopted', weight(0.8)], ['x'.repeat(161), 'adopted'], ['bad\nid', 'open'],
    ['one', 'unknown'], ['one', 'adopted', weight(0.2)], ['one', 'adopted', weight(1.6)],
    ['one', 'adopted', weight(NaN)], ['one', 'adopted', weight(0.8, 'unknown')],
    ['one', 'adopted', { ...weight(0.8), prompt: 'not metadata' }],
  ]) assert.equal(await store.decide(...args), false);
  assert.deepEqual(await fs.readdir(directory), []);
});

test('decision disk failures never reject, warn once and leave weights unapplied', async t => {
  const warnings = [], { directory, store } = await lab(t, { log: value => warnings.push(value) });
  await fs.writeFile(path.join(directory, 'dashboard'), 'blocks mkdir');
  assert.equal(await store.decide('one', 'adopted', weight(0.8)), false);
  assert.equal(await store.decide('two', 'adopted', weight(0.6)), false);
  assert.equal(warnings.length, 1); assert.deepEqual(await store.read(), []); assert.equal(routingNote(directory), '');
});

test('malformed oversized future-version and torn records are ignored, and the next decision recovers', async t => {
  const { file, store, directory } = await lab(t);
  await fs.mkdir(path.dirname(file));
  const record = { id: 'good', at: 1, v: 1, state: 'adopted', weight: weight(0.8) };
  await fs.writeFile(file, JSON.stringify(record) + '\n{bad}\n' + JSON.stringify({ ...record, v: 2, id: 'future' }) + '\n' +
    JSON.stringify({ ...record, id: 'large', extra: 'x'.repeat(LINE_LIMIT) }) + '\n' + JSON.stringify({ ...record, id: 'torn', weight: weight(0.4) }));
  assert.deepEqual((await store.read()).map(value => value.id), ['good']);
  assert.equal(await store.decide('new', 'adopted', weight(0.6)), true);
  assert.equal(currentWeights(await store.read())[0].to, 0.6);
  assert.doesNotMatch(routingNote(directory), /0\.4/);
});

test('rotation checkpoints old live decisions rather than losing their adopted routing weights', async t => {
  const { directory, store, file, previous } = await lab(t, { now: () => READ_LIMIT + 100 });
  await fs.mkdir(path.dirname(file));
  const live = { id: 'live', state: 'adopted', weight: weight(0.8), v: 1, at: 1 };
  await fs.writeFile(previous, JSON.stringify(live) + '\n');
  await fs.writeFile(file, Array.from({ length: READ_LIMIT }, (_, i) => JSON.stringify({ id: 'noise', state: 'open', v: 1, at: i + 2 }) + '\n').join(''));
  await store.decide('new', 'adopted', weight(1.2, 'frontend'));
  assert.deepEqual(currentWeights(await store.read()), [weight(0.8), weight(1.2, 'frontend')]);
  assert.match(routingNote(directory), /core: 0\.8/);
  assert.ok((await fs.stat(file)).size < FILE_LIMIT);
  assert.ok((await fs.readFile(file, 'utf8')).split('\n').length < 10);
  assert.deepEqual((await fs.readdir(path.dirname(file))).sort(), ['decisions.1.jsonl', 'decisions.jsonl']);
});

test('the decision store refuses new identities beyond its bounded live-state capacity', async t => {
  const { store, file } = await lab(t, { now: () => READ_LIMIT + 1 });
  await fs.mkdir(path.dirname(file));
  await fs.writeFile(file, Array.from({ length: READ_LIMIT }, (_, i) => JSON.stringify({ id: `id-${i}`, state: 'open', v: 1, at: i }) + '\n').join(''));
  assert.equal(await store.decide('new-id', 'open'), false);
  assert.equal(await store.decide('id-0', 'adopted', weight(0.8)), true);
  assert.equal(currentWeights(await store.read())[0].to, 0.8);
  await store.decide('id-1', 'adopted', weight(1.2, 'frontend'));
  assert.equal((await store.read()).length, READ_LIMIT);
  assert.deepEqual(currentWeights(await store.read()), [weight(0.8), weight(1.2, 'frontend')]);
});

test('an interrupted rotation preserves old adoptions without applying the failed decision and recovers on retry', async t => {
  const { directory, store, file, previous } = await lab(t, { now: () => READ_LIMIT + 100, log() {} });
  await fs.mkdir(path.dirname(file));
  await fs.writeFile(previous, JSON.stringify({ id: 'live', state: 'adopted', weight: weight(0.8), v: 1, at: 1 }) + '\n');
  await fs.writeFile(file, Array.from({ length: READ_LIMIT }, (_, i) => JSON.stringify({ id: 'noise', state: 'open', v: 1, at: i + 2 }) + '\n').join(''));
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (from === file && to === previous) throw new Error('interrupted rotation');
    return rename(from, to);
  });
  assert.equal(await store.decide('live', 'adopted', weight(0.6)), false);
  assert.equal(currentWeights(await store.read())[0].to, 0.8); assert.match(routingNote(directory), /core: 0\.8/);
  t.mock.restoreAll();
  assert.equal(await store.decide('live', 'adopted', weight(0.6)), true);
  assert.equal(currentWeights(await store.read())[0].to, 0.6);
  assert.deepEqual((await fs.readdir(path.dirname(file))).sort(), ['decisions.1.jsonl', 'decisions.jsonl']);
});
