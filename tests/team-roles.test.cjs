const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { builtinMetadata } = require('../electron/features/skills/builtin-format.cjs');
const { cleanConfig, compactConfig, resolveTeam, validateTeam } = require('../electron/features/skills/team-roles.cjs');
const modelSeats = require('../electron/features/skills/model-seats.cjs');

const skill = fs.readFileSync(path.join(__dirname, '../resources/skills/model-routing/SKILL.md'), 'utf8');
const entry = builtinMetadata(skill, 'model-routing');
const installed = { claude: true, codex: true };
const catalog = modelSeats.catalog(installed, [{ model: 'gpt-6.2-sol' }, { model: 'gpt-peer' }]);
const defaults = modelSeats.defaultsFor(installed, catalog, entry.seats);
const seat = model => ({ model, effort: 'high' });
const config = (roles = {}) => ({ roles });
const copy = (from, name, fields = {}) => ({ from, name, duty: 'Review builds', ...fields });
const resolve = value => resolveTeam(entry, cleanConfig(value, entry, catalog).config, defaults);

test('the default library is disabled and inherits the intended seats', () => {
  const team = resolve(config());
  assert.deepEqual(team.seats, entry.seats);
  assert.deepEqual(team.roles.filter(role => !role.enabled).map(role => role.id), entry.library);
  assert.deepEqual(team.effective, defaults);
  const changed = resolve(config({ developer: seat('sonnet'), frontend: { enabled: true }, docs: { enabled: true }, a11y: { enabled: true } }));
  assert.deepEqual(changed.effective.frontend, seat('sonnet'));
  assert.deepEqual(changed.effective.docs, seat('sonnet'));
  assert.deepEqual(changed.fresh, ['a11y', 'reviewer', 'qa']);
});

test('Ultracode is a boolean choice for the Claude orchestrator only', () => {
  const orchestrator = { ...seat('opus'), ultracode: true };
  const raw = config({ orchestrator, researcher: { ...seat('sonnet'), ultracode: true }, qa: { ultracode: true } });
  const { config: cleaned } = cleanConfig(raw, entry, catalog, true, true);
  assert.deepEqual(resolveTeam(entry, cleaned, defaults).effective, { ...defaults, orchestrator });
  assert.deepEqual(compactConfig(entry, cleaned), config({ orchestrator }));
  for (const rejected of [{ ...orchestrator, model: 'gpt-6.2-sol' }, { ...orchestrator, ultracode: 'true' }]) {
    assert.throws(() => cleanConfig(config({ orchestrator: rejected }), entry, catalog), { code: 'ultracode-not-allowed' });
  }
  assert.deepEqual(modelSeats.resolveSeat(orchestrator, null, installed, catalog), seat('opus'));
  assert.deepEqual(modelSeats.resolveSeat({ ...orchestrator, model: 'gpt-6.2-sol' }, null, installed, catalog, true), seat('gpt-6.2-sol'));
});

test('copies inherit roles and freshness and sit next to their source', () => {
  const roles = { reviewer: { enabled: false }, 'x-review': copy('reviewer', 'Review Lead', { fresh: false, ...seat('gpt-peer') }),
    frontend: { enabled: true }, 'x-app': copy('frontend', 'Application'), qa: { enabled: false } };
  const value = config(roles), team = resolve(value);
  assert.ok(team.seats.indexOf('x-app') === team.seats.indexOf('frontend') + 1);
  assert.deepEqual(team.reviewers, ['x-review']);
  assert.ok(!team.fresh.includes('x-review'), 'a reviewer copy may turn fresh instances off');
  assert.deepEqual(team.authors, ['developer', 'frontend', 'x-app']);
  assert.equal(validateTeam(team), null);
  assert.equal(validateTeam(resolve(config({ reviewer: { enabled: false } }))), null, 'a team without a reviewer is the conductor\'s choice');
});

test('stored partial seats are ignored and saved overrides omit inherited values', () => {
  const raw = config({ future: seat('opus'), frontend: { enabled: true, effort: 'medium' }, docs: { enabled: true, ...seat('sonnet') } }, { memory: 'follow' });
  const { config: clean, ignored } = cleanConfig(raw, entry, catalog, true);
  assert.deepEqual(ignored, ['roles.future', 'roles.frontend.seat']);
  const team = resolveTeam(entry, clean, defaults);
  assert.deepEqual(compactConfig(entry, clean, team), config({ frontend: { enabled: true }, docs: { enabled: true } }));
  assert.throws(() => cleanConfig(config({ reviewer: { name: 'Review' } }), entry, catalog), { code: 'invalid-role' });
  const tooMany = config(Object.fromEntries(Array.from({ length: 9 }, (_, index) => ['x-extra-' + index, copy('developer', 'Role ' + index, { enabled: false })])));
  assert.equal(validateTeam(resolve(tooMany)).code, 'role-limit');
});

test('Codex-only library seats expose their seed and portable files retain the explicit override', () => {
  const codex = { codex: true }, defaults = modelSeats.defaultsFor(codex, modelSeats.catalog(codex), entry.seats);
  const value = config({ docs: { enabled: true, ...defaults.orchestrator } });
  const team = resolveTeam(entry, value, defaults);
  const docs = team.roles.find(role => role.id === 'docs'), frontend = team.roles.find(role => role.id === 'frontend');
  assert.deepEqual(docs.defaultSeat, defaults.orchestrator);
  assert.equal(docs.defaultEnabled, false);
  assert.equal(docs.defaultFresh, false);
  assert.equal(frontend.inherits, 'developer');
  assert.deepEqual(compactConfig(entry, value).roles.docs, value.roles.docs);
});
