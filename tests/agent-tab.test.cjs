const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const fixture = require('./fixtures/team-seats.json');
const { roleGroups, routeVerdict } = require('../src/features/agents/skill-seats.ts');

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

test('the routing verdict uses owning-session seats and actual model facts', () => {
  const info = { ...fixture, current: fixture.defaults, effective: { developer: { model: 'sonnet' } } };
  assert.equal(routeVerdict(row('dev', 'developer', 'gpt-6.2-sol', { specialty: 'frontend' }), info), 'match');
  assert.equal(routeVerdict(row('dev', 'developer', 'sonnet'), info), 'mismatch');
  assert.equal(routeVerdict(row('dev', 'developer', 'sonnet', {}, { modelUnconfirmed: true }), info), 'unknown');
  assert.equal(routeVerdict(row('dev', 'developer', 'gpt-6.2-sol', { declared: { model: 'gpt-6.2-sol', effort: 'high', fast: true } }), info), 'mismatch');
});

test('the collapsed rail keeps its original tab buttons and the narrow popover owns its split toggle', () => {
  const source = relative => readFileSync(path.join(__dirname, '..', relative), 'utf8');
  const explorer = source('src/features/files/ProjectExplorer.tsx');
  const popover = source('src/features/agents/SubagentChip.tsx');
  assert.doesNotMatch(explorer, /AgentTabScope|team-seats|data-seat/);
  assert.match(popover, /closest\('\.activity-call-open'\)/);
  assert.doesNotMatch(popover, /callFile|agent-team-details/);
});
