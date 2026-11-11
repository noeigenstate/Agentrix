const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const vm = require('node:vm');
const { promptText, rememberClaudeSource } = require('../electron/prompt-queue.cjs');
const { listClaudeSessions, encodeClaudeCwd } = require('../electron/claude-sessions.cjs');

test('host identities distinguish default SDK owner messages from workers and unknown old records', () => {
  const owner = randomUUID(), worker = randomUUID();
  rememberClaudeSource(owner, 'gui'); rememberClaudeSource(worker, 'dispatch');
  const record = { turnOrigin: 'sdk', promptSource: 'sdk', entrypoint: 'sdk-ts' };
  assert.equal(promptText('Owner input', { ...record, sessionId: owner }), 'Owner input');
  assert.equal(promptText('Brief', { ...record, sessionId: worker }), null);
  assert.equal(promptText('Unknown', { ...record, sessionId: randomUUID() }), null);
  assert.equal(promptText('Incomplete old SDK provenance', { promptSource: 'sdk', entrypoint: 'sdk-ts' }), null);
  assert.equal(promptText('Legacy owner', { ...record, entrypoint: 'agentrix-sdk' }), 'Legacy owner');
  assert.equal(promptText('A worker cannot inherit ownership', { ...record, sessionId: worker, entrypoint: 'agentrix-sdk' }), null);
  assert.equal(promptText('Injection', { ...record, sessionId: owner, isMeta: true }), null);
});

test('team session identities exclude CLI workers from restore and project memory without inspecting their text', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-provenance-')); t.after(async () => { await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
  const home = path.join(root, 'fake-home'), folder = path.join(home, 'projects', encodeClaudeCwd(root)); fs.mkdirSync(folder, { recursive: true });
  const worker = randomUUID(), owner = randomUUID();
  for (const id of [worker, owner]) fs.writeFileSync(path.join(folder, id + '.jsonl'), JSON.stringify({ type: 'user', sessionId: id, message: { content: 'The identical normal human text' } }) + '\n');
  const journal = path.join(root, '.git/agentrix/journal.jsonl'); fs.mkdirSync(path.dirname(journal));
  fs.writeFileSync(journal, JSON.stringify({ type: 'end', agent: 'claude', session: worker }) + '\n');
  const result = await listClaudeSessions(root, null, home);
  assert.deepEqual(result.map(row => row.id), [owner]);
  const memory = require('../electron/features/agents/project-memory.cjs');
  await memory.gather(path.join(root, 'archive'), root, { claudeHome: home, codexHome: path.join(root, 'empty-codex') });
  const rounds = await memory.readArchive(path.join(root, 'archive'), root);
  assert.ok(rounds.every(row => row.session !== worker));
});

test('host owner identities survive a fresh process without a query or a transcript marker', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-owner-source-')); t.after(async () => { await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const id = randomUUID(), runtimeFile = path.join(__dirname, '../electron/features/claude-sdk/index.cjs'), promptFile = path.join(__dirname, '../electron/prompt-queue.cjs');
  require(runtimeFile).createClaudeRuntime({ directory: root }).create({ owner: 'gui', cwd: root, providerSessionId: id }, () => {});
  const script = `require(${JSON.stringify(runtimeFile)}).createClaudeRuntime({directory:${JSON.stringify(root)}});process.stdout.write(String(require(${JSON.stringify(promptFile)}).promptText('Owner after restart',{sessionId:${JSON.stringify(id)},turnOrigin:'sdk',promptSource:'sdk',entrypoint:'sdk-ts'})));`;
  assert.equal(execFileSync(process.execPath, ['-e', script], { windowsHide: true, encoding: 'utf8' }), 'Owner after restart');
});

test('only an authenticated confirmed dispatch start registers a live worker identity in real main composition', () => {
  const id = randomUUID(), sessionId = randomUUID(), session = { terminalId: 't', projectId: 'p', sessionKey: 'fake-session-key' };
  const context = { sessions: new Map([['t', session]]), store: { projects: [{ id: 'p' }] },
    callsOf: () => ({ dispatch: () => true }), broadcast() {}, rememberClaudeSource,
    require: () => require('../electron/features/agents/dispatch-events.cjs') };
  const main = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8'); vm.createContext(context);
  vm.runInContext(main.slice(main.indexOf('function onEvent('), main.indexOf('// The agent chosen on a new project')), context);
  const event = { type: 'dispatch-start', id, sessionId, projectId: 't', sessionKey: 'fake-session-key', agent: 'claude', role: '执行',
    model: 'claude-sonnet', effort: 'high', fast: false, title: 'Offline task', cwd: '/offline', brief: '/offline/brief', out: '/offline/out', startedAt: 1 };
  const record = { sessionId, turnOrigin: 'sdk', promptSource: 'sdk', entrypoint: 'agentrix-sdk' };
  context.onEvent({ ...event, sessionKey: 'wrong' }); assert.equal(promptText('Legacy record', record), 'Legacy record');
  context.onEvent({ ...event, unconfirmed: true }); assert.equal(promptText('Legacy record', record), 'Legacy record');
  context.onEvent(event); assert.equal(promptText('Legacy record', record), null);
});
