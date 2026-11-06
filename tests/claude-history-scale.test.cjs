require('./fixtures/team-isolation.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { listClaudeSessions, findClaudeSession, encodeClaudeCwd } = require('../electron/claude-sessions.cjs');

test('10000 transcripts with five local sessions probe one header per foreign directory and cache warm reads', async t => {
  const { timeoutScale } = await import('../scripts/wait.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-history-scale-')), cwd = path.join(root, 'project'), home = path.join(root, 'home');
  t.after(() => fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  fs.mkdirSync(cwd);
  function transcript(folder, id, recordedCwd) {
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, id + '.jsonl'), JSON.stringify({ type: 'user', cwd: recordedCwd, message: { content: id } }) + '\n');
  }
  const own = path.join(home, 'projects', encodeClaudeCwd(cwd));
  for (let i = 0; i < 5; i++) transcript(own, 'local-' + i, cwd);
  for (let n = 0; n < 500; n++) for (let i = 0; i < (n === 499 ? 15 : 20); i++) {
    transcript(path.join(home, 'projects', 'foreign-' + n), 'foreign-' + i, path.join(root, 'foreign-' + n));
  }
  let headers = 0, opens = 0;
  const stream = fs.createReadStream, open = fsp.open;
  t.mock.method(fs, 'createReadStream', (...args) => { headers++; return stream(...args); });
  t.mock.method(fsp, 'open', (...args) => { opens++; return open(...args); });
  const coldAt = performance.now(), cold = await listClaudeSessions(cwd, null, home), coldMs = performance.now() - coldAt;
  t.diagnostic(JSON.stringify({ phase: 'cold', headers, summaryOpens: opens, coldMs }));
  assert.equal(cold.length, 5);
  // 500 unrelated directories, not 9995 unrelated files. These IO budgets are
  // deterministic; time budgets allow slow CI while preventing the observed 7s scan.
  assert.ok(headers <= 500, `cold header reads ${headers} exceed one per directory`);
  assert.ok(opens <= 5, `cold summary reads ${opens} must stay in the current project`);
  assert.ok(coldMs < 2000 * timeoutScale, `cold list took ${coldMs.toFixed(0)}ms`);
  headers = opens = 0;
  const warmAt = performance.now(), warm = await listClaudeSessions(cwd, null, home), warmMs = performance.now() - warmAt;
  assert.equal(warm.length, 5);
  assert.equal(headers, 0, 'unchanged foreign directories reuse their ownership probes');
  assert.equal(opens, 5);
  assert.ok(warmMs < 500 * timeoutScale, `warm list took ${warmMs.toFixed(0)}ms`);
  assert.equal(await findClaudeSession(cwd, 'not-present', home, { strict: true }), null);
  assert.equal(headers, 0, 'missing-ID lookups share the directory cache');
  const changed = path.join(home, 'projects', 'foreign-499');
  await fsp.rm(changed, { recursive: true, force: true });
  transcript(changed, 'new-alias-session', cwd);
  assert.ok((await listClaudeSessions(cwd, null, home)).some(row => row.id === 'new-alias-session'));
  assert.equal(headers, 1, 'a replaced directory invalidates only its own probe');
  t.diagnostic(JSON.stringify({ transcripts: 10000, local: 5, coldMs, warmMs, coldHeaderLimit: 500, warmHeaderLimit: 0 }));
});
