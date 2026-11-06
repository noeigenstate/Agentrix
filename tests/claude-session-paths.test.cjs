require('./fixtures/team-isolation.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { encodeClaudeCwd, findClaudeSession, listClaudeSessions } = require('../electron/claude-sessions.cjs');
const { sessionHistory } = require('../electron/features/claude-sdk/history.cjs');

test('aliased history is scoped by physical project, excludes foreign IDs and deduplicates sessions', async t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agx-history-alias-')));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const cwd = path.join(root, 'project'), alias = path.join(root, 'alias'), other = path.join(root, 'other'), home = path.join(root, 'home');
  for (const folder of [cwd, other, home]) fs.mkdirSync(folder);
  fs.symlinkSync(cwd, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const id = randomUUID(), foreignId = randomUUID(), noCwdId = randomUUID();
  function transcript(project, sessionId, text, recordedCwd = project) {
    const folder = path.join(home, 'projects', encodeClaudeCwd(project)); fs.mkdirSync(folder, { recursive: true });
    const filename = path.join(folder, sessionId + '.jsonl');
    fs.writeFileSync(filename, JSON.stringify({ type: 'user', uuid: randomUUID(), sessionId, cwd: recordedCwd,
      timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: text } }) + '\n');
    return filename;
  }
  const legacy = transcript(alias, id, 'LEGACY_ALIAS');
  transcript(other, foreignId, 'FOREIGN');
  transcript(other, noCwdId, 'UNVERIFIED', null);
  // An ID in another project must not replace the verified local transcript.
  transcript(other, id, 'FOREIGN_COLLISION');
  assert.equal(await findClaudeSession(cwd, foreignId, home, { strict: true }), null);
  assert.equal(await findClaudeSession(cwd, noCwdId, home, { strict: true }), null);
  assert.equal(await findClaudeSession(cwd, foreignId, home), null);
  assert.equal(fs.realpathSync.native(await findClaudeSession(cwd, id, home, { strict: true })), legacy);
  assert.deepEqual((await listClaudeSessions(cwd, null, home)).map(row => row.title), ['LEGACY_ALIAS']);
  const current = transcript(cwd, id, 'CANONICAL_NEWER');
  fs.utimesSync(legacy, 1, 1); fs.utimesSync(current, 2, 2);
  const legacyOnly = randomUUID(), legacyFile = transcript(alias, legacyOnly, 'ANOTHER_LEGACY');
  fs.utimesSync(legacyFile, 1, 1);
  assert.equal(await findClaudeSession(cwd, legacyOnly, home), legacyFile, 'a canonical folder must not hide another aliased session');
  assert.deepEqual((await listClaudeSessions(alias, legacyOnly, home)).map(row => row.title), ['CANONICAL_NEWER']);

  const calls = [];
  const sdk = { async getSessionMessages(sessionId, options) {
    calls.push(options);
    if (!options.sessionStore) return [{ message: { content: 'STALE_CANONICAL' } }];
    const rows = await options.sessionStore.load({ sessionId });
    assert.equal(await options.sessionStore.load({ sessionId: foreignId }), null);
    assert.equal(await options.sessionStore.load({ sessionId, subpath: 'subagents/foreign' }), null);
    return rows;
  } };
  const history = await sessionHistory(sdk, { cwd: alias, env: { CLAUDE_CONFIG_DIR: home } }, id);
  assert.equal(history[0].message.content, 'LEGACY_ALIAS', 'an alias selects its actual file even if the SDK found a stale canonical copy');
  assert.equal(calls.length, 2);
  assert.deepEqual(fs.readdirSync(path.dirname(legacy)).sort(), [id + '.jsonl', legacyOnly + '.jsonl'].sort(), 'history creates no copied transcript');
});
