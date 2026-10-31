const { test } = require('node:test');
const assert = require('node:assert/strict');
const { suggestions } = require('../electron/features/dashboard/suggestions.cjs');

const model = 'gpt-6.1-sol', other = 'claude-sonnet-5-5';
const rate = (name, runs, firstPassRate, kind = 'core') => ({ model: name, kind, runs, firstPassRate });
const incident = (key, extra = {}) => ({ key, row: { model, kind: 'core', cause: 'test missed',
  weight: { model, kind: 'core', from: 1, to: 0.8 }, ...extra } });
const round = (key, build, rework, count = rework === null ? 0 : 1) => ({ key, row: { rework: count, phases: { build, rework } }, issues: null });

test('every weighted incident produces a stable suggestion and an unweighted incident does not', () => {
  const one = incident('first'), two = incident('second'), unknown = incident('none', { weight: null });
  const first = suggestions({ incidents: [one, two, unknown] });
  assert.equal(first.length, 2); assert.ok(first.every(value => value.kind === 'weight' && value.state === 'open'));
  assert.deepEqual(first, suggestions({ incidents: [unknown, two, one] }));
  assert.notEqual(first[0].id, first[1].id);
});

test('a first-pass gap needs five runs on each model, a shared task kind and at least thirty percentage points', () => {
  for (const kinds of [
    [rate(model, 4, 0.4), rate(other, 5, 1)], [rate(model, 5, 0.4), rate(other, 4, 1)],
    [rate(model, 5, 0.4), rate(other, 5, 0.69)], [rate(model, 5, null), rate(other, 5, 1)],
    [rate(model, 5, 0.4), rate(other, 5, 1, 'frontend')],
  ]) assert.equal(suggestions({ kinds }).length, 0);
  const kinds = [rate(model, 5, 0.4), rate(other, 5, 0.7)];
  const result = suggestions({ kinds });
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].weight, { model, kind: 'core', from: 1, to: 0.8 });
  assert.equal(suggestions({ kinds: [rate(model, 5, 0.4, 'unreported'), rate(other, 5, 1, 'unreported')] }).length, 0);
});

test('weight reductions respect adopted weights and bounds, and adoption never applies the same evidence twice', () => {
  const kinds = [rate(model, 5, 0), rate(other, 5, 1)];
  const base = [{ id: 'base', state: 'adopted', at: 1, weight: { model, kind: 'core', from: 1, to: 0.4 } }];
  const proposal = suggestions({ kinds, decisions: base }).find(value => value.state === 'open');
  assert.equal(proposal.weight.to, 0.3);
  const adopted = { ...proposal, at: 2, state: 'adopted' };
  const next = suggestions({ kinds, decisions: [...base, adopted] }).find(value => value.id === proposal.id);
  assert.equal(next.id, proposal.id); assert.equal(next.state, 'adopted');
  assert.deepEqual(next.weight, proposal.weight);
  assert.match(next.text, /从 0.4 调整为 0.3/);
  const reopened = suggestions({ kinds, decisions: [...base, adopted, { ...adopted, at: 3, state: 'open' }] }).find(value => value.id === proposal.id);
  assert.equal(reopened.state, 'open'); assert.deepEqual(reopened.weight, proposal.weight);
});

test('performance suggestion ids survive changed rates and runs but distinguish the pair and starting weight', () => {
  const kinds = [rate(model, 5, 0.2), rate(other, 5, 0.9)];
  const evidence = [{ model, kind: 'core', key: 'weak-1' }, { model: other, kind: 'core', key: 'best-1' }];
  const first = suggestions({ kinds, evidence });
  const translated = suggestions({ kinds: [...kinds].reverse(), evidence: [...evidence].reverse(), t: value => `EN:${value}` });
  assert.equal(first[0].id, translated[0].id); assert.notEqual(first[0].title, translated[0].title);
  assert.equal(first[0].id, suggestions({ kinds: [rate(model, 6, 0.3), rate(other, 8, 1)],
    evidence: [...evidence, { model, kind: 'core', key: 'new' }] })[0].id);
  assert.notEqual(first[0].id, suggestions({ kinds: [rate(model, 5, 0.2), rate('gpt-6.1-terra', 5, 0.9)] })[0].id);
  const decisions = [{ id: 'independent', state: 'adopted', at: 1, weight: { model, kind: 'core', from: 1, to: 0.6 } }];
  assert.notEqual(first[0].id, suggestions({ kinds, decisions }).find(value => value.state === 'open').id);
});

test('new runs never compound an adopted performance reduction and the lower bound emits no no-op', () => {
  const kinds = [rate(model, 5, 0), rate(other, 5, 1)];
  const first = suggestions({ kinds })[0];
  const decision = { id: first.id, state: 'adopted', at: 1, weight: first.weight };
  const next = suggestions({ kinds: [rate(model, 6, 1 / 6), rate(other, 5, 1)], decisions: [decision] });
  assert.equal(next.length, 1); assert.equal(next[0].id, first.id);
  assert.equal(next[0].state, 'adopted'); assert.deepEqual(next[0].weight, first.weight);
  assert.deepEqual(suggestions({ kinds, decisions: [{ id: 'floor', state: 'adopted', at: 1,
    weight: { model, kind: 'core', from: 0.4, to: 0.3 } }] }).filter(value => value.state === 'open'), []);
  assert.deepEqual(suggestions({ incidents: [incident('no-op', { weight: { model, kind: 'core', from: 0.3, to: 0.3 } })] }), []);
});

test('adopted and dismissed decisions remain reachable when their source evidence disappears', () => {
  const values = suggestions({ incidents: [incident('adopted'), incident('dismissed')] });
  const mechanism = suggestions({ rounds: [{ ...round('changed', 1, null), issues: [{ issue: 'scope', answer: 'split', result: 'changed the plan' }] }] })[0];
  const decisions = [...values.map((value, i) => ({ id: value.id, weight: value.weight, at: i + 1, state: i ? 'dismissed' : 'adopted' })),
    { id: mechanism.id, at: 3, state: 'dismissed' }, { id: 'reopened', at: 4, state: 'open' }];
  const restored = suggestions({ decisions });
  assert.equal(restored.length, 3);
  for (const value of decisions.slice(0, 3)) {
    const row = restored.find(row => row.id === value.id);
    assert.equal(row.state, value.state); assert.deepEqual(row.weight, value.weight || null);
    assert.ok(row.title && row.text);
  }
  assert.equal(suggestions({ decisions: [...decisions, { ...decisions[0], at: 5, state: 'open' }] }).some(value => value.id === decisions[0].id), false);
});

test('review follow-ups use fresh sessions when rework exceeds twenty percent across at least two measured rounds', () => {
  assert.equal(suggestions({ rounds: [round('one', 50, 50)] }).length, 0);
  assert.equal(suggestions({ rounds: [round('one', 80, 20), round('two', 80, 20)] }).length, 0);
  assert.equal(suggestions({ rounds: [round('one', null, 100), round('two', 50, 50)] }).length, 0);
  const rounds = [round('one', 50, 100), round('two', 100, null)];
  const result = suggestions({ rounds });
  assert.equal(result.length, 1); assert.equal(result[0].weight, null); assert.equal(result[0].kind, 'mechanism');
  assert.match(result[0].text, /2 轮/); assert.match(result[0].text, /40%/);
  assert.equal(result[0].id, suggestions({ rounds: [...rounds].reverse() })[0].id);
});

test('changed-plan issues generate an informational roundtable suggestion with persisted dismissal', () => {
  const issue = { issue: 'scope', answer: 'split it', result: 'changed the plan' };
  const rounds = [{ ...round('one', 1, null), issues: [issue, { ...issue, result: 'settled' }] }];
  const value = suggestions({ rounds })[0];
  assert.equal(value.kind, 'mechanism'); assert.equal(value.weight, null); assert.match(value.text, /1 个/);
  const result = suggestions({ rounds, decisions: [{ id: value.id, state: 'dismissed', at: 10 }] });
  assert.equal(result[0].state, 'dismissed');
});

test('suggestion text is sent through the injected main-process translator with values', () => {
  const calls = [];
  suggestions({ incidents: [incident('one')], t: (source, values) => { calls.push({ source, values }); return source; } });
  assert.deepEqual(calls.map(call => call.source), ['根据事故调整任务权重', '复杂代码', '{model} 在 {kind} 任务中发生事故：{cause}。建议将权重从 {from} 调整为 {to}。']);
  // The kind reads by its name and weights with one decimal, as the page shows them.
  assert.deepEqual([calls[2].values.model, calls[2].values.kind, calls[2].values.from, calls[2].values.to], [model, '复杂代码', '1.0', '0.8']);
});
