const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { builtinMetadata } = require('../electron/features/skills/builtin-format.cjs');
const { MAX_BYTES, readRouting, writeRouting, routingState } = require('../electron/features/skills/project-routing.cjs');
const modelSeats = require('../electron/features/skills/model-seats.cjs');

const entry = builtinMetadata(fs.readFileSync(path.join(__dirname, '../resources/skills/model-routing/SKILL.md'), 'utf8'), 'model-routing');
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
  write(JSON.stringify({ operations: {}, roles: { designer: { fast: true, enabled: true }, future: { enabled: true } },
    version: 1, format: input.format }, null, 2).replace(/\n/g, '\r\n'));
  assert.equal(read().digest, first.digest);
  input.roles.future.enabled = false;
  write(JSON.stringify(input)); assert.notEqual(read().digest, first.digest);
});

test('routing rejects unknown keys, prototype keys, newer versions, depth, invalid bytes and unsafe teams', t => {
  const { write, read } = fixture(t);
  for (const [contents, code] of [
    [JSON.stringify({ ...document(), version: 2 }), 'newer-version'],
    [JSON.stringify(document({ qa: { path: 'outside' } })), 'unknown-key'],
    [JSON.stringify(document({}, { lookup: { model: 'haiku', extra: true } })), 'unknown-key'],
    ['{"format":"agentrix-routing","version":1,"roles":{"__proto__":{}},"operations":{}}', 'unknown-key'],
    [JSON.stringify(document({ qa: { enabled: { extra: { a: {} } } } })), 'too-deep'],
    [JSON.stringify(document({ reviewer: { enabled: false } })), 'reviewer-required'],
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
  assert.equal(writeRouting(root, { roles: {}, operations: {} }, linked.digest, context, assert.fail).code, 'file-unwritable');
  assert.equal(fs.readFileSync(path.join(other, 'routing.json'), 'utf8'), 'private');
  fs.unlinkSync(folder);
  fs.mkdirSync(file, { recursive: true });
  assert.equal(read().error.code, 'not-file');
});

test('atomic writes record trust before rename and refuse to replace a stale base', t => {
  const { root, folder, read } = fixture(t), config = { roles: { qa: { enabled: false } }, operations: {} };
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
  const { root, folder, write, read } = fixture(t), config = { roles: {}, operations: {} };
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
  const project = { id: 'p', path: root }, local = { roles: { qa: { enabled: false } }, operations: {} };
  const stored = { local: { p: local } };
  write(JSON.stringify(document())); const candidate = read();
  assert.equal(routingState(project, candidate, stored).source.state, 'pending');
  assert.equal(routingState(project, candidate, stored).config, local);
  stored.trust = { p: { digest: candidate.digest, config: candidate.config } };
  assert.equal(routingState(project, candidate, stored).source.state, 'trusted');
  write('{'); const invalid = read();
  assert.equal(routingState(project, invalid, stored).source.layer, 'accepted');
  assert.deepEqual(routingState(project, invalid, stored).source.actions, ['keep', 'overwrite']);
  stored.trust.p.rejected = invalid.digest;
  assert.equal(routingState(project, invalid, stored).source.state, 'rejected');
  assert.deepEqual(routingState(project, invalid, stored).source.actions, ['overwrite']);
  assert.equal(routingState(project, { digest: null }, { trust: stored.trust }).source.notice, 'file-deleted');
});
