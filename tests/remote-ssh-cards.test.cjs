const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { SSHAuthServer } = require('../electron/ssh-auth.cjs');
const { RemoteConnection } = require('../electron/remote-connection.cjs');
const { remoteClaudeResult } = require('../electron/features/ssh/claude-account.cjs');
const { parseAgentScreen } = require('../src/features/agents/agent-screen.ts');
const { createSSHFixture } = require('./helpers/ssh-fixture.cjs');

test('SSH carries Claude quota numbers and real-shaped question, Review, permission and waiting screens', async t => {
  const { waitFor } = await import('../scripts/wait.mjs');
  // Always the fake CLI/worker, on every platform; no developer account or installed assistant is used.
  const fixture = await createSSHFixture({ nativeWorker: false, claudeAccount: { state: 'ready', account: { at: Date.now(),
    limits: [{ minutes: 300, percent: 23, resetsAt: null }, { minutes: 10080, percent: 11, resetsAt: null }], source: 'Claude' } } });
  const auth = await new SSHAuthServer().start();
  const sshPath = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/OpenSSH/ssh.exe') : 'ssh';
  const project = { id: randomUUID(), kind: 'ssh', path: '/srv/fixture', ssh: { host: 'fixture', configFile: fixture.configFile } };
  const remote = new RemoteConnection(project, { integrationDir: path.resolve(__dirname, '../integration'), auth, sshPath, sessionKey: 'isolated-ssh-card-fixture' });
  t.after(async () => { remote.close(); auth.close(); await fixture.close(); });
  await remote.ready;
  const account = remoteClaudeResult(await remote.request('claude-account'));
  assert.equal(account.state, 'ready'); assert.equal(account.account.limits[0].percent, 23);
  let output = '';
  remote.onData(value => { output += value; });
  for (const [agent, folder, filename, kind] of [
    ['claude', 'questions', 'claude-question', 'question'], ['claude', 'questions', 'claude-question-multi', 'question'],
    ['claude', 'screens', 'claude-investigation-review', 'question'], ['claude', 'screens', 'claude-investigation-plan', 'permission'],
    ['claude', 'screens', 'claude-investigation-mcp-url', 'permission'], ['claude', 'screens', 'claude-investigation-mcp-form', 'waiting'],
    ['codex', 'screens', 'codex-investigation-question', 'question'], ['codex', 'screens', 'codex-investigation-question-notes', 'question'],
    ['codex', 'screens', 'codex-investigation-plan-complete', 'permission'], ['codex', 'screens', 'codex-investigation-mcp-url', 'permission'],
    ['codex', 'screens', 'codex-investigation-mcp-form', 'waiting'],
  ]) {
    const text = await fs.readFile(path.join(__dirname, 'fixtures', folder, filename + '.txt'), 'utf8');
    const expected = parseAgentScreen(agent, text.split('\n'));
    const bytes = Buffer.from(text), start = output.length;
    // An SSH packet can end inside a UTF-8 cursor or Chinese label, just like any stream of PTY output.
    const point = Math.max(1, bytes.findIndex(value => value >= 0xe0) + 1);
    remote.send({ op: 'input', data: bytes.subarray(0, point).toString('base64') });
    remote.send({ op: 'input', data: bytes.subarray(point).toString('base64') });
    await waitFor(() => output.length >= start + text.length, 'SSH fixture screen ' + filename, 15000);
    const received = output.slice(start, start + text.length);
    assert.equal(received, text, filename);
    const screen = parseAgentScreen(agent, received.split('\n'));
    assert.deepEqual(screen, expected, filename);
    if (kind === 'waiting') { assert.ok(screen.waiting, filename); assert.equal(screen.choice, null); }
    else assert.equal(screen.choice?.kind, kind, filename);
  }
});
