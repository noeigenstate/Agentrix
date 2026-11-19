const { test } = require('node:test');
const assert = require('node:assert/strict');
const { cleanSeats, migrateSeats, checkReviewer, catalog, defaultsFor, effective, leadOptions } = require('../electron/features/skills/model-seats.cjs');
const fixture = require('./fixtures/team-seats.json');
const ids = fixture.seats;
const both = { claude: true, codex: true };
const seat = (model, effort = 'high', fast) => ({ model, effort, ...(fast === undefined ? {} : { fast }) });
const rejected = (raw, code) => assert.throws(() => cleanSeats(raw, ids), error => error.code === code);

test('seat validation rejects unsafe and oversized model ids and keeps dispatch model syntax', () => {
  for (const model of ['', 'bad model', '-option', 'model;echo', 'model\n', 'a'.repeat(161)]) rejected({ developer: seat(model) }, 'invalid-model');
  for (const model of ['gpt-6.1-sol', 'provider/model:v1@[q]+test', 'a'.repeat(160)]) assert.equal(cleanSeats({ developer: seat(model) }, ids).developer.model, model);
});

test('effort and fast follow capabilities and orchestrator takes either family', () => {
  rejected({ developer: seat('gpt-6.1-sol', 'max') }, 'invalid-effort');
  rejected({ designer: seat('sonnet', 'ultra') }, 'invalid-effort');
  assert.throws(() => cleanSeats({ designer: seat('claude-sonnet-5-5', 'high', true) }, ids,
    [{ model: 'claude-sonnet-5-5', efforts: ['high'], fast: false }]), error => error.code === 'fast-not-allowed');
  assert.throws(() => cleanSeats({ designer: seat('claude-next', 'high', true) }, ids), error => error.code === 'fast-not-allowed');
  rejected({ developer: seat('gpt-next', 'high', 'true') }, 'fast-not-allowed');
  for (const model of ['gpt-6.1-sol', 'opus']) assert.deepEqual(cleanSeats({ orchestrator: seat(model) }, ids), { orchestrator: seat(model) });
  assert.equal(cleanSeats({ architect: seat('opus', 'max'), developer: seat('gpt-next', 'xhigh', true) }, ids).architect.effort, 'max');
});

test('normalization drops unknown seats and fields without mutating its input', () => {
  const raw = { invented: seat('opus'), developer: { ...seat('gpt-6.1-sol'), private: 'discard' }, orchestrator: seat('opus') };
  const copy = structuredClone(raw), cleaned = cleanSeats(raw, ids);
  assert.deepEqual(cleaned, { developer: seat('gpt-6.1-sol'), orchestrator: seat('opus') });
  assert.deepEqual(raw, copy);
});

test('reviewer independence is refused only when a distinct available model is at least as strong', () => {
  const map = { developer: seat('gpt-6.1-sol'), designer: seat('sonnet'), reviewer: seat('gpt-6.1-sol') };
  assert.equal(checkReviewer(map, catalog(both)).code, 'reviewer-same-model');
  assert.equal(checkReviewer(map, catalog({ codex: true, claude: false })), null, 'missing Opus does not count as an alternative');
  const claude = defaultsFor({ claude: true, codex: false });
  assert.equal(checkReviewer(claude, catalog({ claude: true })), null, 'Sonnet is weaker than the Opus author/reviewer');
  assert.equal(checkReviewer(map, catalog({ codex: true }, [{ value: 'gpt-other', efforts: ['high'] }])).code, 'reviewer-same-model');
  assert.equal(checkReviewer({ ...map, reviewer: seat('opus') }, catalog(both)), null);
  assert.equal(checkReviewer({ ...map, reviewer: seat('sonnet') }, catalog(both)), null, 'designer is independent of developer');
  assert.equal(checkReviewer({ developer: seat('gpt-sonnet'), reviewer: seat('gpt-sonnet') }, [{ model: 'sonnet', rank: 2, available: true }]).code, 'reviewer-same-model');
});

test('reviewer aliases match developer on the newest listed resolved id', () => {
  for (const alias of ['opus', 'sonnet', 'haiku']) {
    const models = catalog(both, [{ model: `claude-${alias}-5-4` }, { model: `claude-${alias}-5-5` },
      { model: `claude-${alias}-6-0`, listed: false }, { model: 'gpt-6.2-sol', rank: 3 }]);
    for (const [writer, reviewer] of [[`claude-${alias}-5-5`, alias], [alias, `claude-${alias}-5-5`]]) {
      const map = cleanSeats({ developer: seat(writer), reviewer: seat(reviewer) }, ids, models);
      assert.equal(checkReviewer(map, models)?.code, 'reviewer-same-model', `${writer}/${reviewer}`);
      assert.equal(map.reviewer.model, reviewer, 'identity comparison does not rewrite saved ids');
    }
  }
});

test('an alias and its own resolved id never provide an independent alternative', () => {
  for (const alias of ['opus', 'sonnet', 'haiku']) {
    const models = [{ model: alias, rank: 3, available: true }, { model: `claude-${alias}-5-5`, rank: 3, available: true }];
    for (const model of [alias, `claude-${alias}-5-5`]) {
      assert.equal(checkReviewer({ developer: seat(model), reviewer: seat(model) }, models), null);
    }
  }
});

test('reviewer identity ignores context/date suffixes but keeps older versions distinct', () => {
  const models = [{ model: 'opus', rank: 3, available: true },
    { model: 'claude-opus-5-9', rank: 3, available: true },
    { model: 'claude-opus-5-10-20261118[1m]', rank: 3, available: true },
    { model: 'claude-opus-6-0', rank: 3, available: true, listed: false },
    { model: 'gpt-6.2-sol', rank: 3, available: true }];
  for (const model of ['claude-opus-5-10', 'claude-opus-5-10[1m]', 'claude-opus-5-10-20261118']) {
    assert.equal(checkReviewer({ developer: seat(model), reviewer: seat('opus') }, models)?.code, 'reviewer-same-model');
  }
  for (const model of ['claude-opus-5-4', 'claude-opus-5-9', 'claude-opus-6-0']) {
    assert.equal(checkReviewer({ developer: seat(model), reviewer: seat('opus') }, models), null, model);
  }
  assert.equal(checkReviewer({ developer: seat('claude-opus-5-10[1m]'), reviewer: seat('claude-opus-5-10-20261118') }, models)?.code, 'reviewer-same-model');
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

test('routing IPC forwards saves and review actions with the exact contract arguments', () => {
  const { registerSkillsIpc } = require('../electron/features/skills/ipc.cjs');
  const handlers = {}, calls = [], config = { roles: { researcher: seat('sonnet') }, operations: {} };
  const record = (...args) => { calls.push(args); return { ok: true }; };
  registerSkillsIpc({ handle: (name, fn) => handlers[name] = fn, skills: {
    seatsInfo: (...args) => { calls.push(args); return { skill: 'declaring-skill' }; },
    setRouting: record, resolveRouting: record,
  } });
  assert.equal(handlers['skills:seats']('project', 'terminal').skill, 'declaring-skill');
  assert.deepEqual(handlers['skills:setRouting']('project', 'p', config, null), { ok: true });
  assert.deepEqual(handlers['skills:resolveRouting']('p', 'keep', 'digest'), { ok: true });
  assert.deepEqual(calls, [['project', 'terminal', true], ['project', 'p', config, null], ['p', 'keep', 'digest']]);
});
