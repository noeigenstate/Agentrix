const { test } = require('node:test');
const assert = require('node:assert/strict');
const { cleanSeat, cleanStoredSeats, migrateSeats, catalog, defaultsFor, effective, leadOptions } = require('../electron/features/skills/model-seats.cjs');
const fixture = require('./fixtures/team-seats.json');
const ids = fixture.seats;
const both = { claude: true, codex: true };
const seat = (model, effort = 'high', fast) => ({ model, effort, ...(fast === undefined ? {} : { fast }) });
const rejected = (pick, code) => assert.throws(() => cleanSeat(pick), error => error.code === code);

test('seat validation rejects unsafe and oversized model ids and keeps dispatch model syntax', () => {
  for (const model of ['', 'bad model', '-option', 'model;echo', 'model\n', 'a'.repeat(161)]) rejected(seat(model), 'invalid-model');
  for (const model of ['gpt-6.1-sol', 'provider/model:v1@[q]+test', 'a'.repeat(160)]) assert.equal(cleanSeat(seat(model)).model, model);
});

test('effort and fast follow capabilities and orchestrator takes either family', () => {
  rejected(seat('gpt-6.1-sol', 'max'), 'invalid-effort');
  rejected(seat('sonnet', 'ultra'), 'invalid-effort');
  assert.throws(() => cleanSeat(seat('claude-sonnet-5-5', 'high', true), 'designer',
    [{ model: 'claude-sonnet-5-5', efforts: ['high'], fast: false }]), error => error.code === 'fast-not-allowed');
  assert.throws(() => cleanSeat(seat('claude-next', 'high', true)), error => error.code === 'fast-not-allowed');
  rejected(seat('gpt-next', 'high', 'true'), 'fast-not-allowed');
  for (const model of ['gpt-6.1-sol', 'opus']) assert.deepEqual(cleanSeat(seat(model), 'orchestrator'), seat(model));
  assert.equal(cleanSeat(seat('opus', 'max')).effort, 'max');
  assert.equal(cleanSeat(seat('gpt-next', 'xhigh', true)).fast, true);
});

test('normalization drops unknown seats and fields without mutating its input', () => {
  const raw = { invented: seat('opus'), developer: { ...seat('gpt-6.1-sol'), private: 'discard' }, orchestrator: seat('opus') };
  const copy = structuredClone(raw), cleaned = cleanStoredSeats(raw, ids);
  assert.deepEqual(cleaned, { developer: seat('gpt-6.1-sol'), orchestrator: seat('opus') });
  assert.deepEqual(raw, copy);
});

test('defaults and catalog describe installed-agent substitutions and provider efforts without enumerating models', () => {
  const models = catalog({ claude: false, codex: true }, [{ value: 'gpt-next', displayName: 'Next', efforts: ['low', 'max', 'high'] }, { value: 'fable-secret' }]);
  assert.equal(models.find(row => row.model === 'opus').available, false);
  assert.match(models.find(row => row.model === 'opus').reason, /not installed/);
  assert.deepEqual(models.find(row => row.model === 'gpt-next').efforts, ['low', 'max', 'high']);
  assert.equal(models.find(row => row.model === 'gpt-next').rank, 3);
  assert.equal(models.some(row => /fable/.test(row.model)), true);
});

test('team defaults follow the newest Sol and substitute on either single-agent install', () => {
  assert.deepEqual(defaultsFor(both, fixture.catalog), fixture.defaults);
  assert.deepEqual(defaultsFor({ claude: true }, fixture.catalog), { ...fixture.defaults, developer: seat('opus'), devops: seat('sonnet') });
  assert.deepEqual(defaultsFor({ codex: true }, fixture.catalog), Object.fromEntries(ids.map(id => [id, seat('gpt-6.2-sol', 'high', true)])));
  assert.deepEqual(defaultsFor({}), {});
});

test('project choices merge over global seat by seat including one orchestrator', () => {
  const defaults = defaultsFor(both), global = { orchestrator: seat('sonnet'), researcher: seat('haiku') };
  const project = { orchestrator: seat('gpt-next', 'medium', false), developer: seat('gpt-next') };
  const merged = effective(defaults, global, project);
  assert.deepEqual(merged.orchestrator, project.orchestrator);
  assert.equal(merged.researcher.model, 'haiku'); assert.equal(merged.developer.model, 'gpt-next');
  merged.designer.model = 'changed'; assert.equal(defaults.designer.model, 'sonnet');
});

test('v1 migration prefers Claude and core and copies visual and lookup to the new team', () => {
  const old = { lead: { claude: seat('sonnet'), codex: seat('gpt-6.2-sol') }, core: seat('gpt-6.1-sol'), execution: seat('opus'),
    visual: seat('sonnet'), lookup: seat('haiku'), architect: seat('opus'), reviewer: seat('opus') };
  const before = structuredClone(old), { map, notice } = migrateSeats(old);
  assert.deepEqual(map, { orchestrator: old.lead.claude, developer: old.core, designer: old.visual, qa: old.visual,
    researcher: old.lookup, architect: old.architect, reviewer: old.reviewer });
  assert.match(notice, /Claude.*sonnet.*Codex.*gpt-6\.2-sol/);
  assert.deepEqual(old, before);
  assert.deepEqual(migrateSeats({ lead: { codex: old.lead.codex }, execution: old.execution }).map,
    { orchestrator: old.lead.codex, developer: old.execution });
});

test('the other-family lead uses its family default and an uninstalled family has no lead', () => {
  const models = fixture.catalog, map = { orchestrator: seat('sonnet', 'max') };
  assert.deepEqual(leadOptions(map, 'claude', both, models), map.orchestrator);
  assert.deepEqual(leadOptions(map, 'codex', both, models), seat('gpt-6.2-sol', 'high', true));
  map.orchestrator = seat('gpt-6.1-sol', 'medium', false);
  assert.deepEqual(leadOptions(map, 'codex', both, models), map.orchestrator);
  assert.deepEqual(leadOptions(map, 'claude', both, models), seat('opus'));
  assert.equal(leadOptions(map, 'claude', { codex: true }, models), null);
});

test('routing IPC forwards saves and review actions with the exact contract arguments', async () => {
  const { registerSkillsIpc } = require('../electron/features/skills/ipc.cjs');
  const handlers = {}, calls = [], config = { roles: { researcher: seat('sonnet') } };
  const record = (...args) => { calls.push(args); return { ok: true }; };
  registerSkillsIpc({ handle: (name, fn) => handlers[name] = fn, skills: {
    seatsInfo: (...args) => { calls.push(args); return { skill: 'declaring-skill' }; },
    setRouting: record, resolveRouting: record,
  } });
  assert.equal(handlers['skills:seats']('project', 'terminal').skill, 'declaring-skill');
  assert.deepEqual(await handlers['skills:setRouting']('project', 'p', config, null), { ok: true });
  assert.deepEqual(await handlers['skills:resolveRouting']('p', 'keep', 'digest'), { ok: true });
  assert.deepEqual(calls, [['project', 'terminal', true], ['project', 'p', config, null], ['p', 'keep', 'digest']]);
});
test('seat reads and refreshes carry the last local Claude fast refusal in conductor mode only', async () => {
  const { registerSkillsIpc } = require('../electron/features/skills/ipc.cjs');
  const handlers = new Map();
  let reason = 'Fast mode requires usage credits';
  const seatsInfo = project => ({ conductor: project !== 'native', routing: { remote: project === 'ssh' } });
  registerSkillsIpc({ handle: (name, fn) => handlers.set(name, fn), claudeFastRefusal: () => reason,
    skills: { seatsInfo, refreshSeats: async project => seatsInfo(project) } });
  for (const channel of ['skills:seats', 'skills:seats-refresh']) {
    const read = handlers.get(channel);
    assert.equal((await read('local')).claudeFastRefusal, reason);
    assert.equal((await read('ssh')).claudeFastRefusal, undefined);
    assert.equal((await read('native')).claudeFastRefusal, undefined);
  }
  reason = null;
  assert.deepEqual(handlers.get('skills:seats')('local'), seatsInfo('local'));
});
