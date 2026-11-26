const { test } = require('node:test');
const assert = require('node:assert/strict');
const { elements } = require('./helpers/renderer-fixtures.cjs');
const { explorerView } = require('./helpers/explorer-view.cjs');
const { identifiers } = require('./helpers/source-structure.cjs');
const fixture = require('./fixtures/team-seats.json');
const { callSeatRole, roleGroups, routeVerdict } = require('../src/features/agents/routing-seats.ts');

const row = (id, seat, model, item = {}, call = {}) => ({
  terminalId: 't1', item: { id, seat, ...item }, call: { model, effort: 'high', fast: false, ...call },
});

test('the Agent tab groups only occupied roles in chart order and keeps developer specialties in Developer', () => {
  const rows = [row('review', 'reviewer', 'opus'), row('frontend', 'developer', 'gpt-6.2-sol', { specialty: 'frontend' }),
    row('product', 'product', 'opus'), row('backend', 'developer', 'gpt-6.2-sol', { specialty: 'backend' })];
  const groups = roleGroups(fixture.roles, rows);
  assert.deepEqual(groups.map(group => [group.role.id, group.rows.map(entry => entry.item.id)]),
    [['product', ['product']], ['developer', ['frontend', 'backend']], ['reviewer', ['review']]]);
});

test('the routing verdict uses the call snapshot even after the live seat changes', () => {
  const info = { ...fixture, current: { ...fixture.defaults, developer: { model: 'sonnet' } } };
  const expected = { model: 'gpt-6.2-sol', effort: 'high', fast: false };
  const declared = { seatSource: 'declared', specialty: 'frontend', expected };
  assert.equal(routeVerdict(row('dev', 'developer', expected.model, declared), info), 'match');
  assert.equal(routeVerdict(row('dev', 'developer', 'sonnet', declared), info), 'mismatch');
  assert.equal(routeVerdict(row('dev', 'developer', expected.model, declared, { effort: 'low' }), info), 'mismatch');
  assert.equal(routeVerdict(row('dev', 'developer', expected.model, declared, { fast: true }), info), 'mismatch');
  assert.equal(routeVerdict(row('dev', 'developer', 'sonnet', declared, { modelUnconfirmed: true }), info), 'unknown');
  assert.equal(routeVerdict(row('dev', 'developer', 'sonnet', { ...declared, expected: null }), info), 'unknown');
  assert.equal(routeVerdict(row('dev', 'developer', 'gpt-6.2-sol', { declared: { model: 'gpt-6.2-sol', effort: 'high', fast: true } }), info), 'mismatch');
});

test('missing and unknown seats stay in Developer and the role lookup marks them inferred', () => {
  const rows = [row('missing', undefined, 'sonnet'), row('unknown', 'legacy-role', 'opus', { seatSource: 'declared' })];
  for (const roles of [fixture.roles, fixture.roles.filter(role => role.id !== 'developer')]) {
    const groups = roleGroups(roles, rows);
    assert.deepEqual(groups.map(group => [group.role.id, group.rows]), [['developer', rows]]);
    for (const { item } of rows) assert.deepEqual(callSeatRole(roles, item), { role: groups[0].role, inferred: true });
  }
});

test('inferred seats only check dispatch declarations against recorded model facts', () => {
  const info = { ...fixture, current: { ...fixture.defaults, researcher: { model: 'sonnet' } } };
  const lookup = { seatSource: 'inferred' };
  assert.equal(routeVerdict(row('lookup', 'researcher', 'haiku', lookup), info), 'unknown');
  assert.equal(routeVerdict(row('general', 'developer', 'sonnet'), info), 'unknown');
  assert.equal(routeVerdict(row('lookup', 'researcher', 'haiku', { ...lookup, declared: { model: 'haiku' } }), info), 'match');
  assert.equal(routeVerdict(row('lookup', 'researcher', 'haiku', { ...lookup, declared: { model: 'sonnet' } }), info), 'mismatch');
});

test('the collapsed rail keeps its original tab buttons and the narrow popover owns its split toggle', t => {
  const { render } = explorerView(t);
  const rail = render({ collapsed: true }).find(node => node.props.className === 'explorer-rail');
  assert.deepEqual(elements(rail.props.children).filter(node => node.type === 'button').map(node => node.props['aria-label']),
    ['Agent', '资源管理器', 'Git 历史']);
  assert.deepEqual(identifiers('src/features/agents/SubagentChip.tsx', ['callFile', 'AgentTabScope']), []);
  // The row click and popover closure are exercised in subagent-pane.test.cjs.
});
