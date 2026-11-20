const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { builtinMetadata } = require('../electron/features/skills/builtin-format.cjs');
const { MAX_BYTES, readRouting, writeRouting, routingState, reviewFile } = require('../electron/features/skills/project-routing.cjs');
const { resolveTeam } = require('../electron/features/skills/team-roles.cjs');
const modelSeats = require('../electron/features/skills/model-seats.cjs');

const text = fs.readFileSync(path.join(__dirname, '../resources/skills/model-routing/SKILL.md'), 'utf8');
const entry = { ...builtinMetadata(text, 'model-routing'), text };
const installed = { claude: true, codex: true }, catalog = modelSeats.catalog(installed);
const context = [entry, catalog, modelSeats.defaultsFor(installed, catalog, entry.seats)];
const document = (roles = {}, operations = {}) => ({ format: 'agentrix-routing', version: 1, roles, operations });

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentrix-project-routing-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folder = path.join(root, '.agentrix'), file = path.join(folder, 'routing.json');
  const write = bytes => { fs.mkdirSync(folder, { recursive: true }); fs.writeFileSync(file, bytes); };
  const read = () => readRouting(root, ...context);
  return { root, folder, file, write, read };
}

test('canonical digests include ignored content and ignore LF, CRLF, and key order', t => {
  const { write, read } = fixture(t);
  const input = document({ future: { enabled: true }, designer: { enabled: true, fast: true } });
  write(JSON.stringify(input, null, 2)); const first = read();
  assert.deepEqual(first.ignored, ['roles.future', 'roles.designer.seat']);
  write(JSON.stringify({ operations: input.operations, roles: { designer: { fast: true, enabled: true }, future: { enabled: true } },
    version: 1, format: input.format }, null, 2).replace(/\n/g, '\r\n'));
  assert.equal(read().digest, first.digest);
  input.operations = { retired: { unrelated: true } };
  write(JSON.stringify(input));
  assert.notEqual(read().digest, first.digest);
  assert.deepEqual(read().config, first.config);
  input.roles.future.enabled = false;
  write(JSON.stringify(input)); assert.notEqual(read().digest, first.digest);
});

test('the conductor switch is kept only when on and survives a round trip', t => {
  const { write, read } = fixture(t);
  write(JSON.stringify({ ...document(), conductor: true }));
  assert.equal(read().config.conductor, true);
  write(JSON.stringify({ ...document(), conductor: false }));
  assert.equal(Object.hasOwn(read().config, 'conductor'), false);
});

test('routing rejects unknown keys, prototype keys, newer versions, depth, invalid bytes and unsafe teams', t => {
  const { write, read } = fixture(t);
  for (const [contents, code] of [
    [JSON.stringify({ ...document(), version: 2 }), 'newer-version'],
    [JSON.stringify(document({ qa: { path: 'outside' } })), 'unknown-key'],
    ['{"format":"agentrix-routing","version":1,"roles":{"__proto__":{}},"operations":{}}', 'unknown-key'],
    [JSON.stringify(document({ qa: { enabled: { extra: { a: {} } } } })), 'too-deep'],
    [JSON.stringify({ ...document(), conductor: 'yes' }), 'bad-format'],
    [Buffer.from([0xc0, 0xaf]), 'bad-utf8'], ['{', 'bad-json'], [Buffer.alloc(MAX_BYTES + 1, 0x20), 'too-large'],
  ]) {
    write(contents);
    const result = read();
    assert.equal(result.error.code, code);
    assert.match(result.digest, /^[a-f0-9]{64}$/);
    assert.equal(result.config, undefined);
  }
});

test('routing rejects junctions and non-regular targets, preserving their contents', t => {
  const { root, folder, file, read } = fixture(t), other = path.join(root, 'elsewhere');
  fs.mkdirSync(other); fs.writeFileSync(path.join(other, 'routing.json'), 'private');
  fs.symlinkSync(other, folder, 'junction');
  const linked = read();
  assert.equal(linked.error.code, 'link'); assert.equal(linked.raw, undefined);
  assert.equal(writeRouting(root, { roles: {} }, linked.digest, context, assert.fail).code, 'file-unwritable');
  assert.equal(fs.readFileSync(path.join(other, 'routing.json'), 'utf8'), 'private');
  fs.unlinkSync(folder);
  fs.mkdirSync(file, { recursive: true });
  assert.equal(read().error.code, 'not-file');
});

test('a project beneath a junction can read and save its own routing file', t => {
  const { root } = fixture(t), real = path.join(root, 'real'), link = path.join(root, 'linked');
  fs.mkdirSync(path.join(real, 'project'), { recursive: true });
  fs.symlinkSync(real, link, 'junction');
  const project = path.join(link, 'project'), config = { roles: { qa: { enabled: false } } };
  assert.equal(readRouting(project, ...context).digest, null);
  assert.deepEqual(writeRouting(project, config, null, context, () => () => {}), { ok: true });
  assert.deepEqual(readRouting(project, ...context).config, config);
});

test('routing accepts BOM and absent operations and rejects duplicate keys and unsafe file fields', t => {
  const { read, write } = fixture(t);
  write('\uFEFF{"format":"agentrix-routing","version":1,"roles":{}}');
  assert.deepEqual(read().config, { roles: {} });
  write('{"format":"agentrix-routing","version":1,"roles":{"qa":{"enabled":true,"en\\u0061bled":false}}}');
  assert.equal(read().error.code, 'bad-json');
  for (const roles of [
    { 'not a seat': {} }, { qa: { model: 'evil:', effort: 'high' } }, { qa: { model: 'evil://model', effort: 'high' } },
  ]) {
    write(JSON.stringify(document(roles)));
    assert.equal(read().error.code, 'bad-format');
  }
  for (const name of ['\uFF26rontend', '\u524D\u7AEF']) {
    write(JSON.stringify(document({ 'x-extra': { from: 'frontend', name, duty: 'Test' } })));
    assert.equal(read().error.code, 'role-text');
  }
  const unknown = Object.fromEntries(Array.from({ length: 20 }, (_, id) => ['future' + id, {}]));
  write(JSON.stringify(document({ qa: { model: 'sonnet', effort: 'unknown' }, ...unknown }, { lookup: { model: 'opus', effort: 'unknown' } })));
  assert.equal(Object.hasOwn(read().config, 'operations'), false);
  assert.equal(read().config.roles.qa.model, undefined);
  assert.equal(read().ignored[0], 'roles.qa.seat');
  assert.equal(read().ignored.length, 16);
});

function reviewChanges(roles, priorRoles = {}) {
  const config = { roles };
  const previous = resolveTeam(entry, { roles: priorRoles }, context[2]);
  const next = resolveTeam(entry, config, context[2]);
  return reviewFile({ config, ignored: [] }, 'changed', next, previous, catalog);
}

test('changing Developer omits unmentioned disabled inheritors from the routing diff', () => {
  const developer = { model: 'gpt-mini', effort: 'medium' };
  const review = reviewChanges({ developer });
  assert.deepEqual(new Set(review.changes.flatMap(change => change.role ? [change.role] : [])), new Set(['developer']));
  assert.deepEqual(review.roleChanges.map(change => change.role), ['developer']);
  const named = reviewChanges({ developer, frontend: { enabled: false } });
  assert.deepEqual(named.roleChanges.map(change => change.role), ['developer', 'frontend']);
});

test('the grouped routing diff carries status, source and full custom text once per role', () => {
  const old = { from: 'frontend', name: 'Mobile', duty: 'Build the app', outputs: 'Release brief' };
  const current = { ...old, name: 'Mobile lead', duty: 'Ship the next app', outputs: 'Release and test report' };
  const removed = { ...old, name: 'Legacy', duty: 'Maintain the previous app' };
  const review = reviewChanges(
    { qa: { enabled: false }, frontend: { enabled: true }, 'x-mobile': current, 'x-new': { ...old, name: 'New role' } },
    { 'x-mobile': old, 'x-old': removed },
  );
  const byId = Object.fromEntries(review.roleChanges.map(change => [change.role, change]));
  assert.equal(Object.keys(byId).length, review.roleChanges.length);
  assert.equal(byId.frontend.source, 'library');
  assert.equal(byId.frontend.status, 'added');
  assert.equal(byId.qa.source, 'builtin');
  assert.equal(byId.qa.status, 'removed');
  assert.equal(byId.qa.after.enabled, false);
  assert.equal(byId['x-mobile'].source, 'custom');
  assert.equal(byId['x-mobile'].status, 'changed');
  assert.deepEqual(byId['x-mobile'].before.custom, { name: old.name, duty: old.duty, outputs: old.outputs });
  assert.deepEqual(byId['x-mobile'].after.custom, { name: current.name, duty: current.duty, outputs: current.outputs });
  assert.equal(byId['x-old'].status, 'removed');
  assert.equal(byId['x-old'].after, null);
  assert.equal(byId['x-new'].status, 'added');
  assert.equal(byId['x-new'].before, null);
  assert.equal(review.flags.find(flag => flag.code === 'custom-text' && flag.role === 'x-mobile').text, current.name);
});

test('save clears abandoned routing temporaries while keeping recent files', t => {
  const { root, folder, write, read } = fixture(t);
  write(JSON.stringify(document()));
  const abandoned = path.join(folder, '.routing-abandoned.tmp'), recent = path.join(folder, '.routing-recent.tmp');
  fs.writeFileSync(abandoned, 'old'); fs.writeFileSync(recent, 'recent');
  fs.utimesSync(abandoned, 100, 100);
  assert.deepEqual(writeRouting(root, { roles: {} }, read().digest, context, () => () => {}), { ok: true });
  assert.equal(fs.existsSync(abandoned), false);
  assert.equal(fs.existsSync(recent), true);
});

test('atomic writes record trust before rename and refuse to replace a stale base', t => {
  const { root, folder, read } = fixture(t), config = { roles: { qa: { enabled: false } } };
  let trust;
  const write = base => writeRouting(root, config, base, context, digest => {
    assert.equal(read().digest, base);
    trust = { digest, config };
    return () => { trust = undefined; };
  });
  assert.deepEqual(write(null), { ok: true });
  const current = read();
  assert.equal(current.digest, trust.digest);
  assert.match(current.raw, /\n  "version": 1,/);
  assert.ok(!current.raw.includes('\r'));
  assert.equal(write(null).code, 'file-changed');
  assert.deepEqual(fs.readdirSync(folder), ['routing.json']);
});

test('a competing write during trust persistence restores trust and leaves the competing file', t => {
  const { root, folder, write, read } = fixture(t), config = { roles: {} };
  const original = JSON.stringify(document({ qa: { enabled: false } }));
  const next = JSON.stringify(document({ qa: { fresh: false } }));
  write(original); let rollback = false;
  const result = writeRouting(root, config, read().digest, context, () => {
    write(next);
    return () => { rollback = true; };
  });
  assert.equal(result.code, 'file-changed');
  assert.equal(rollback, true);
  assert.equal(read().raw, next);
  assert.deepEqual(fs.readdirSync(folder), ['routing.json']);
});

test('trust states select exactly one fallback and reject unavailable invalid-file actions', t => {
  const { root, write, read } = fixture(t);
  const project = { id: 'p', path: root }, local = { roles: { qa: { enabled: false } } };
  const stored = { local: { p: local } };
  write(JSON.stringify(document())); const candidate = read();
  assert.equal(routingState(project, candidate, stored).source.state, 'pending');
  assert.equal(routingState(project, candidate, stored).config, local);
  stored.trust = { p: { digest: candidate.digest, config: candidate.config } };
  assert.equal(routingState(project, candidate, stored).source.state, 'trusted');
  const changedCleanedConfig = { ...candidate, config: local };
  assert.equal(routingState(project, changedCleanedConfig, stored).source.state, 'pending');
  write('{'); const invalid = read();
  assert.equal(routingState(project, invalid, stored).source.layer, 'accepted');
  assert.deepEqual(routingState(project, invalid, stored).source.actions, ['keep', 'overwrite']);
  stored.trust.p.rejected = invalid.digest;
  assert.equal(routingState(project, invalid, stored).source.state, 'rejected');
  assert.deepEqual(routingState(project, invalid, stored).source.actions, ['overwrite']);
  assert.equal(routingState(project, { digest: null }, { trust: stored.trust }).source.notice, 'file-deleted');
});
