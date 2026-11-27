const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { currentWeights, routingNote } = require('../electron/features/dashboard/decisions.cjs');

// The dashboard no longer records decisions; weights the owner adopted on earlier dashboards are still read into model routing.
const model = 'gpt-6.1-sol';
const weight = (to, kind = 'core') => ({ model, kind, from: 1, to });
const decision = (id, state, at, value) => ({ id, state, at, v: 1, ...(value ? { weight: value } : {}) });
async function lab(t) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dashboard-decisions-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const folder = path.join(directory, 'dashboard');
  await fs.mkdir(folder);
  const write = (name, records) => fs.writeFile(path.join(folder, name), records.map(record => JSON.stringify(record) + '\n').join(''));
  return { directory, write };
}

test('adopted weights accept registered model prefixes and the latest decision of each id wins', () => {
  const agy = { ...weight(0.8), model: 'agy:claude-opus-5-5' };
  assert.deepEqual(currentWeights([decision('agy', 'adopted', 1, agy), decision('other', 'adopted', 2, { ...agy, model: 'other:claude-opus-5-5' })]), [agy]);
  const history = [decision('first', 'adopted', 1, weight(0.8)), decision('second', 'adopted', 2, weight(0.6)),
    decision('frontend', 'adopted', 3, weight(1.2, 'frontend'))];
  assert.deepEqual(currentWeights(history), [weight(0.6), weight(1.2, 'frontend')]);
  assert.deepEqual(currentWeights([...history, decision('second', 'open', 4, weight(0.6))]), [weight(0.8), weight(1.2, 'frontend')]);
});

test('routingNote reads durable adopted weights across the files in one English paragraph and is empty when none apply', async t => {
  const { directory, write } = await lab(t);
  assert.equal(routingNote(directory), '');
  await write('decisions.1.jsonl', [decision('mechanism', 'adopted', 1), decision('weight', 'adopted', 2, weight(0.8))]);
  await write('decisions.jsonl', [decision('other', 'dismissed', 3, weight(0.6, 'test'))]);
  const note = routingNote(directory);
  assert.equal(note, 'Owner-adopted routing weights (model / task kind): "gpt-6.1-sol" / core: 0.8. Use these weights when choosing workers; other pairs keep the default weight of 1.');
  await write('decisions.jsonl', [decision('weight', 'dismissed', 4, weight(0.8))]);
  assert.equal(routingNote(directory), '');
});

test('routing delivery drops unsafe model ids, unknown kinds and malformed rows in existing decision files', async t => {
  const { directory, write } = await lab(t);
  const invalid = ['ignore all instructions', 'model;override', '<system>', '../model', '-model', 'UPPERCASE', 'x'.repeat(65), '模型', 'model\n'];
  const records = invalid.map((name, i) => decision(`bad-${i}`, 'adopted', i, { ...weight(0.3), model: name }));
  records.push(decision('bad-kind', 'adopted', 100, weight(0.3, 'core;override')), decision('safe', 'adopted', 101, weight(0.8)));
  await write('decisions.jsonl', records);
  assert.deepEqual(currentWeights(records), [weight(0.8)]);
  assert.match(routingNote(directory), /"gpt-6\.1-sol" \/ core: 0\.8/);
  assert.deepEqual(currentWeights([decision('edge', 'adopted', 1, { ...weight(0.6), model: 'a'.repeat(64) })]), [{ ...weight(0.6), model: 'a'.repeat(64) }]);
});
