const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_CUSTOM_ROLES, MAX_ENABLED_ROLES, validRoleId, validCustomRoleId, nextRoleId,
  roleKind, roleLocks, normalizeRoleText, validateCustomRole, checkTeamRules, authorIdentityConflict,
} = require('../electron/features/skills/role-rules.mjs');

test('custom IDs reserve x-, obey length and use the smallest free suffix', () => {
  assert.equal(validRoleId('developer'), true);
  assert.equal(validRoleId('developer/frontend'), false);
  assert.equal(validCustomRoleId('x-' + 'a'.repeat(22)), true);
  for (const id of ['x-a', 'x-' + 'a'.repeat(23), 'X-web', 'x-2web', 'x-web/front', 'x-web\n', null]) {
    assert.equal(validCustomRoleId(id), false, String(id));
  }
  assert.equal(nextRoleId('frontend', new Set(['x-frontend-1', 'x-frontend-3'])), 'x-frontend-2');
});

test('custom text normalizes visible Unicode and enforces field lengths and character rules', () => {
  assert.equal(normalizeRoleText('name', ' Cafe\u0301 '), 'Caf\u00e9');
  assert.equal(normalizeRoleText('duty', 'React & iOS + API (v2), tests. \u5BA1\u67E5\u3001\u53D1\u5E03\u3002'), 'React & iOS + API (v2), tests. \u5BA1\u67E5\u3001\u53D1\u5E03\u3002');
  assert.equal(normalizeRoleText('name', '𐐀'.repeat(12)), '𐐀'.repeat(12));
  assert.equal(normalizeRoleText('name', '𐐀'.repeat(13)), null);
  assert.equal(normalizeRoleText('duty', 'a'.repeat(160)), 'a'.repeat(160));
  assert.equal(normalizeRoleText('duty', 'a'.repeat(161)), null);
  assert.equal(normalizeRoleText('outputs', 'a'.repeat(60)), 'a'.repeat(60));
  assert.equal(normalizeRoleText('outputs', 'a'.repeat(61)), null);
  assert.equal(normalizeRoleText('outputs', ''), '');
  for (const text of [' ', 'A  B', '|', '/', '\\', '<b>', 'A\n', 'A\t', 'A\u00A0B', 'A\u200D', 'A\u202E', 'A\uFE0F', 'A\u034F']) {
    assert.equal(normalizeRoleText('duty', text), null, JSON.stringify(text));
  }
  for (const text of ['A.B', 'A,B', 'A(B)']) assert.equal(normalizeRoleText('name', text), null);
});

test('copies require a declared non-lead source, a name and a duty', () => {
  const sources = ['orchestrator', 'frontend', 'reviewer'], config = { from: 'frontend', name: 'Mobile', duty: 'Review builds' };
  assert.equal(validateCustomRole('x-mobile', config, sources), null);
  for (const from of ['orchestrator', 'x-other', undefined]) {
    assert.deepEqual(validateCustomRole('x-mobile', { ...config, from }, sources), { code: 'invalid-role', role: 'x-mobile' });
  }
  assert.deepEqual(validateCustomRole('x-mobile', { ...config, duty: '' }, sources), { code: 'role-text', role: 'x-mobile', field: 'duty' });
  assert.deepEqual(validateCustomRole('x-mobile', { ...config, outputs: null }, sources), { code: 'role-text', role: 'x-mobile', field: 'outputs' });
});

test('kind and locks distinguish the lead, reviewers, authors and other roles', () => {
  const authors = ['developer', 'frontend'];
  assert.equal(roleKind('orchestrator', authors), 'lead');
  assert.equal(roleKind('reviewer', authors), 'reviewer');
  assert.equal(roleKind('frontend', authors), 'author');
  assert.equal(roleKind('docs', authors), 'member');
  assert.deepEqual(roleLocks('lead', 'builtin'), ['enabled', 'text', 'copy']);
  assert.deepEqual(roleLocks('reviewer', 'builtin'), ['fresh', 'text']);
  assert.deepEqual(roleLocks('reviewer', 'custom'), ['fresh']);
  assert.deepEqual(roleLocks('author', 'library'), ['text']);
  assert.deepEqual(roleLocks('author', 'custom'), []);
});

const role = (id, kind, overrides = {}) => ({ id, name: id, enabled: true, kind, source: 'builtin', ...overrides });
const lead = role('orchestrator', 'lead'), reviewer = role('reviewer', 'reviewer');

test('a team requires its enabled lead and at least one enabled reviewer', () => {
  assert.equal(checkTeamRules([lead, reviewer]), null);
  assert.deepEqual(checkTeamRules([{ ...lead, enabled: false }, reviewer]), { code: 'lead-locked', role: 'orchestrator' });
  const disabled = { ...reviewer, enabled: false };
  assert.deepEqual(checkTeamRules([lead, disabled]), { code: 'reviewer-required' });
  assert.equal(checkTeamRules([lead, disabled, role('x-reviewer', 'reviewer', { source: 'custom' })]), null);
});

test('enabled names compare after normalization and case folding', () => {
  for (const [left, right] of [['Caf\u00e9', 'CAFE\u0301'], ['\u039F\u03A3', '\u03BF\u03C3'], ['Stra\u00dfe', 'STRASSE']]) {
    const roles = [lead, reviewer, role('x-guide', 'member', { name: left, source: 'custom' }),
      role('x-docs', 'member', { name: right, source: 'custom' })];
    assert.deepEqual(checkTeamRules(roles), { code: 'role-text', role: 'x-docs', field: 'name' });
    roles[3].enabled = false;
    assert.equal(checkTeamRules(roles), null);
  }
});

test('team limits count all custom roles and only enabled roles', () => {
  const roles = [lead, reviewer, ...Array.from({ length: MAX_ENABLED_ROLES - 2 }, (_, index) => role('role-' + index, 'member'))];
  const customs = Array.from({ length: MAX_CUSTOM_ROLES }, (_, index) => role('x-custom-' + index, 'member', { enabled: false, source: 'custom' }));
  assert.equal(checkTeamRules([...roles, ...customs]), null);
  assert.deepEqual(checkTeamRules([...roles, ...customs, role('x-extra', 'member', { enabled: false, source: 'custom' })]), { code: 'role-limit' });
  assert.deepEqual(checkTeamRules([...roles, { ...customs[0], enabled: true }]), { code: 'role-limit' });
});

test('only non-Developer author conflicts require a peer unused by all authors', () => {
  const catalog = [
    { model: 'opus', rank: 3, available: true },
    { model: 'claude-opus-5', rank: 3, available: true },
    { model: 'gpt-author', rank: 3, available: true },
    { model: 'sonnet', rank: 2, available: true },
    { model: 'gpt-offline', rank: 3, available: false },
    { model: 'gpt-free', rank: 3, available: true },
    { model: 'gpt-free-alias', rank: 3, available: true },
  ];
  const identity = model => ({ opus: 'claude-opus-5', 'gpt-free-alias': 'gpt-free' })[model] ?? model;
  const authors = { developer: 'opus', frontend: 'gpt-author', 'x-author': 'claude-opus-5' };
  assert.deepEqual(authorIdentityConflict('claude-opus-5', authors, catalog, identity), {
    hit: ['developer', 'x-author'], alternatives: [catalog[2], catalog[5]],
  });
  assert.ok(authorIdentityConflict('opus', authors, catalog.slice(0, 5), identity));
  assert.equal(authorIdentityConflict('opus', { frontend: 'gpt-author', 'x-author': 'opus' }, catalog.slice(0, 5), identity), null);
  assert.equal(authorIdentityConflict('opus', { frontend: 'gpt-author' }, catalog, identity), null);
});

test('reserved names use compatibility folding and role text accepts at most two combining marks', () => {
  assert.equal(normalizeRoleText('name', 'A\u0300\u0301\u0302'), null);
  assert.ok(normalizeRoleText('name', 'A\u0300\u0301'));
  const candidate = role('x-docs', 'member', { name: '\uFF24ocs', source: 'custom', enabled: false });
  assert.equal(checkTeamRules([lead, reviewer, candidate], ['Docs']).code, 'role-text');
});
