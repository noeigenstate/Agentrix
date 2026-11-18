const { test } = require('node:test');
const assert = require('node:assert/strict');
const { cleanSeats, checkReviewer, catalog, defaultsFor, effective, renderSeats, leadOptions } = require('../electron/features/skills/model-seats.cjs');
const ids = ['lead', 'architect', 'core', 'execution', 'visual', 'lookup', 'reviewer'];
const both = { claude: true, codex: true };
const seat = (model, effort = 'high', fast) => ({ model, effort, ...(fast === undefined ? {} : { fast }) });
const rejected = (raw, code) => assert.throws(() => cleanSeats(raw, ids), error => error.code === code);

test('seat validation rejects unsafe and oversized model ids and keeps dispatch model syntax', () => {
  for (const model of ['', 'bad model', '-option', 'model;echo', 'model\n', 'a'.repeat(161)]) rejected({ core: seat(model) }, 'invalid-model');
  for (const model of ['gpt-6.1-sol', 'provider/model:v1@[q]+test', 'a'.repeat(160)]) assert.equal(cleanSeats({ core: seat(model) }, ids).core.model, model);
});

test('efforts follow the catalog, fast follows capabilities and lead slots keep their family', () => {
  rejected({ core: seat('gpt-6.1-sol', 'max') }, 'invalid-effort');
  rejected({ execution: seat('sonnet', 'ultra') }, 'invalid-effort');
  assert.throws(() => cleanSeats({ visual: seat('claude-sonnet-5-5', 'high', true) }, ids,
    [{ model: 'claude-sonnet-5-5', efforts: ['high'], fast: false }]), error => error.code === 'fast-not-allowed');
  assert.throws(() => cleanSeats({ visual: seat('claude-next', 'high', true) }, ids), error => error.code === 'fast-not-allowed');
  rejected({ core: seat('gpt-next', 'high', 'true') }, 'fast-not-allowed');
  rejected({ lead: { claude: seat('gpt-6.1-sol') } }, 'lead-family');
  rejected({ lead: { codex: seat('opus') } }, 'lead-family');
  assert.equal(cleanSeats({ architect: seat('opus', 'max'), core: seat('gpt-next', 'xhigh', true) }, ids).architect.effort, 'max');
});

test('normalization drops unknown seats and fields without mutating its input', () => {
  const raw = { invented: seat('opus'), core: { ...seat('gpt-6.1-sol'), private: 'discard' }, lead: { codex: seat('gpt-6.1-sol'), invented: seat('opus') } };
  const copy = structuredClone(raw), cleaned = cleanSeats(raw, ids);
  assert.deepEqual(Object.keys(cleaned).sort(), ['core', 'lead']);
  assert.deepEqual(Object.keys(cleaned.lead), ['codex']);
  assert.equal('private' in cleaned.core, false); assert.deepEqual(raw, copy);
});

test('reviewer independence is refused only when a distinct available model is at least as strong', () => {
  const map = { core: seat('gpt-6.1-sol'), execution: seat('sonnet'), reviewer: seat('gpt-6.1-sol') };
  assert.equal(checkReviewer(map, catalog(both)).code, 'reviewer-same-model');
  assert.equal(checkReviewer(map, catalog({ codex: true, claude: false })), null, 'missing Opus does not count as an alternative');
  const claude = defaultsFor({ claude: true, codex: false });
  assert.equal(checkReviewer(claude, catalog({ claude: true })), null, 'Sonnet is weaker than the Opus author/reviewer');
  assert.equal(checkReviewer(map, catalog({ codex: true }, [{ value: 'gpt-other', efforts: ['high'] }])).code, 'reviewer-same-model');
  assert.equal(checkReviewer({ ...map, reviewer: seat('opus') }, catalog(both)), null);
  assert.equal(checkReviewer({ ...map, reviewer: seat('sonnet') }, catalog(both)).code, 'reviewer-same-model', 'execution is an author too');
  assert.equal(checkReviewer({ core: seat('gpt-sonnet'), reviewer: seat('gpt-sonnet') }, [{ model: 'sonnet', rank: 2, available: true }]).code, 'reviewer-same-model');
});

test('defaults and catalog describe installed-agent substitutions and provider efforts without enumerating models', () => {
  const models = catalog({ claude: false, codex: true }, [{ value: 'gpt-next', displayName: 'Next', efforts: ['low', 'max', 'high'] }, { value: 'fable-secret' }]);
  assert.equal(models.find(row => row.model === 'opus').available, false);
  assert.match(models.find(row => row.model === 'opus').reason, /not installed/);
  assert.deepEqual(models.find(row => row.model === 'gpt-next').efforts, ['low', 'max', 'high']);
  assert.equal(models.find(row => row.model === 'gpt-next').rank, 3);
  assert.equal(models.some(row => /fable/.test(row.model)), true);
  assert.deepEqual(defaultsFor({ claude: true }).core, seat('opus'));
  assert.deepEqual(defaultsFor({ codex: true }).visual, seat('gpt-6.1-sol', 'high', true));
  assert.deepEqual(defaultsFor({}), {});
  assert.deepEqual(defaultsFor(both).lead, { claude: seat('opus'), codex: seat('gpt-6.1-sol', 'high', true) });
});

test('project choices merge over global seat by seat, including independent lead slots', () => {
  const defaults = defaultsFor(both), global = { lead: { claude: seat('sonnet') }, lookup: seat('sonnet') };
  const project = { lead: { codex: seat('gpt-next', 'medium', false) }, core: seat('gpt-next') };
  const merged = effective(defaults, global, project);
  assert.deepEqual(merged.lead, { claude: seat('sonnet'), codex: seat('gpt-next', 'medium', false) });
  assert.equal(merged.lookup.model, 'sonnet'); assert.equal(merged.core.model, 'gpt-next');
  merged.visual.model = 'changed'; assert.equal(defaults.visual.model, 'sonnet');
});

test('rendered seats name Agent and helper launch forms, fresh instances and fixed lookup', () => {
  const map = defaultsFor(both), helper = '/isolated tools/dispatch.cjs';
  const claude = renderSeats(map, 'claude', helper), codex = renderSeats(map, 'codex', helper);
  assert.match(claude, /Agent call with model:"opus", effort:"high"/);
  assert.match(claude, /node "\/isolated tools\/dispatch.cjs" codex --model gpt-6.1-sol --effort high --fast/);
  assert.match(codex, /node "\/isolated tools\/dispatch.cjs" claude --model sonnet --effort high/);
  assert.match(codex, /fast off/); assert.match(codex, /fresh instances/); assert.match(codex, /agentrix-lookup stays Haiku/);
  assert.match(renderSeats(map, 'codex', helper, { codex: true }), /Substituted for opus: claude is not installed/);
  assert.match(renderSeats({ architect: seat('claude-opus-5-5', 'max') }, 'claude', helper), /Agent call with model:"opus", effort:"max"/);
  assert.match(codex, /supplement.*full helper form.*--role.*--title.*--cwd.*--brief.*--out/i);
});

test('lead options preserve explicit launch/model-menu choices and their own defaults', () => {
  const map = defaultsFor(both);
  assert.deepEqual(leadOptions(map, 'codex'), seat('gpt-6.1-sol', 'high', true));
  assert.deepEqual(leadOptions(map, 'codex', { model: 'gpt-custom', effort: 'medium', fast: false }), seat('gpt-custom', 'medium', false));
  assert.deepEqual(leadOptions(map, 'claude', { model: 'sonnet' }), { model: 'sonnet' });
  assert.deepEqual(leadOptions(map, 'codex', { effort: 'low', fast: false }), seat('gpt-6.1-sol', 'low', false));
});

test('seat IPC passes the shared contract arguments unchanged', () => {
  const { registerSkillsIpc } = require('../electron/features/skills/ipc.cjs');
  const handlers = {}, calls = [], map = { lookup: seat('sonnet') };
  registerSkillsIpc({ handle: (name, fn) => handlers[name] = fn, skills: {
    seatsInfo: (...args) => { calls.push(args); return { skill: 'declaring-skill' }; },
    setSeats: (...args) => { calls.push(args); return { ok: true }; },
  } });
  assert.equal(handlers['skills:seats']('project', 'terminal').skill, 'declaring-skill');
  assert.deepEqual(handlers['skills:setSeats']('project', 'project', map), { ok: true });
  assert.deepEqual(calls, [['project', 'terminal'], ['project', 'project', map]]);
});
