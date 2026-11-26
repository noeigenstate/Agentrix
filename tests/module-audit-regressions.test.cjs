const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');

function folder(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentrix-audit-')));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return root;
}

test('local Claude transcript tracking follows a junction and refuses a link out of that config root', t => {
  const { createClaudeActivity } = require('../electron/features/terminal-events/claude-activity.cjs');
  const root = folder(t), config = path.join(root, 'config'), alias = path.join(root, 'alias'), outside = path.join(root, 'outside');
  for (const name of [config, outside]) fs.mkdirSync(name);
  fs.symlinkSync(config, alias, 'junction');
  fs.symlinkSync(outside, path.join(config, 'escape'), 'junction');
  const filename = path.join(config, 'session.jsonl');
  fs.writeFileSync(filename, '');
  fs.writeFileSync(path.join(outside, 'another.jsonl'), '');
  const reading = [];
  const activity = createClaudeActivity({ claudeConfigDir: () => alias, prepareReading: (...args) => reading.push(args.at(-1)),
    callsOf: () => ({ setFolder() {}, bindBackground() {}, stopSubagents() {} }), TranscriptTail: class { constructor(file) { this.filename = file; } },
    monitorActivity: () => ({ stop() {} }) });
  const terminal = { terminalId: 't' };
  activity.followClaude({ kind: 'local' }, terminal, { sessionId: 'session', transcriptPath: filename });
  activity.followClaude({ kind: 'local' }, terminal, { sessionId: 'another', transcriptPath: path.join(config, 'escape', 'another.jsonl') });
  assert.deepEqual(reading, [filename]);
  assert.equal(terminal.claudeTranscript.filename, filename);
  const early = path.join(config, 'future', 'early.jsonl');
  activity.followClaude({ kind: 'local' }, terminal, { sessionId: 'early', transcriptPath: path.join(alias, 'future', 'early.jsonl') });
  assert.deepEqual(reading, [filename, early]);
  assert.equal(terminal.claudeTranscript.filename, early);
});

test('native input text is removed on final receipts and the pending queue is bounded', () => {
  const { createShellEvents } = require('../electron/features/terminal-events/shell-events.cjs');
  const { PromptQueue } = require('../electron/prompt-queue.cjs');
  const sessions = new Map(), project = { id: 'p' };
  const shell = createShellEvents({ sessions, nativeSpecs: new Map([['t', { agent: 'codex' }]]), store: { findTerminal: () => ({ project }), setRestore() {} },
    createNativeUsage: () => ({ apply() {} }), scheduleState() {}, bindDispatchInbox() {}, PromptQueue,
    CompletionWork: class {}, ActionLog: class {}, ConversationLog: class {} });
  const send = (type, payload) => shell.structuredEvent('t', { type, payload, runtimeSessionId: 'test', receivedAtMs: Date.now() });
  send('session.state', { state: 'starting' });
  const terminal = sessions.get('t');
  const enqueue = clientMessageId => send('item.upsert', { kind: 'user-message', content: { clientMessageId, text: 'Prompt ' + clientMessageId } });
  const receipt = (clientMessageId, status) => send('input.receipt', { clientMessageId, status });
  enqueue('one'); enqueue('two'); enqueue('three');
  receipt('one', 'consumed'); receipt('two', 'rejected'); receipt('three', 'unknown');
  assert.equal(terminal.nativeMessages.size, 0);
  assert.deepEqual(terminal.promptQueue.list().map(({ text, state }) => [text, state]), [['Prompt one', 'working']]);
  for (let index = 0; index < 520; index++) enqueue('q' + index);
  assert.equal(terminal.nativeMessages.size, 512);
  assert.equal(terminal.nativeMessages.has('q0'), false);
  assert.equal(terminal.promptQueue.list().length, 513);
  send('session.state', { state: 'stopped' });
  assert.equal(terminal.nativeMessages.size, 0);
  assert.equal(terminal.promptQueue.list().length, 1);
});

test('SSH sends connected routing writes in order and an old acknowledgment cannot touch a replaced session', async () => {
  const { refreshRemoteRouting } = require('../electron/features/ssh/routing.cjs');
  const began = Promise.withResolvers(), release = Promise.withResolvers(), oldBegan = Promise.withResolvers(), oldRelease = Promise.withResolvers();
  const requests = [], changes = [];
  const remote = { connected: true, request(_method, { claudeLead }) {
    requests.push(claudeLead.model);
    if (claudeLead.model === 'one') { began.resolve(); return release.promise; }
    if (claudeLead.model === 'old') { oldBegan.resolve(); return oldRelease.promise; }
  } };
  let bound = true;
  const options = { bound: () => bound, failed: assert.fail, changed: flag => changes.push(flag) };
  const save = model => refreshRemoteRouting(remote, { model, conductor: model !== 'one' }, { roles: [model] }, options);
  const one = save('one');
  await began.promise;
  const two = save('two');
  assert.deepEqual(requests, ['one']);
  release.resolve();
  await Promise.all([one, two]);
  assert.deepEqual(requests, ['one', 'two']);
  assert.deepEqual(remote.appliedRouting, { effective: {}, roles: ['two'], conductor: true });
  const old = save('old');
  await oldBegan.promise;
  bound = false;
  oldRelease.resolve();
  await old;
  assert.deepEqual(changes, [false, true]);
  assert.deepEqual(remote.appliedRouting.roles, ['two']);
});

test('a mode-switch note survives a response that closes before its write finishes', async t => {
  const { createHookServer } = require('../electron/features/terminal-events/hook-server.cjs');
  const { createHookIngest } = require('../electron/features/terminal-events/hook-ingest.cjs');
  let supplied = 'Selected a different mode', requestHandler;
  const ingest = createHookIngest({ keyOf: id => id === 't' ? 'key' : null, deliver() {},
    noteOf() { const note = supplied; supplied = null; return note; } });
  const socket = new EventEmitter();
  Object.assign(socket, { listen(_port, _host, ready) { ready(); }, address: () => ({ port: 1 }), close: done => done(), closeAllConnections() {} });
  const server = await createHookServer(ingest, { createServer: handler => { requestHandler = handler; return socket; } });
  t.after(() => server.close());
  const submit = () => {
    const request = Object.assign(new EventEmitter(), { method: 'POST', url: '/h/t/UserPromptSubmit', headers: { 'x-agentrix-key': 'key' } });
    const response = Object.assign(new EventEmitter(), { writeHead() {}, end(body) { this.result = JSON.parse(body); } });
    requestHandler(request, response);
    request.emit('end');
    return response;
  };
  const first = submit();
  assert.equal(first.result.hookSpecificOutput.additionalContext, 'Selected a different mode');
  assert.deepEqual(submit().result, {});
  first.emit('close');
  const retry = submit();
  assert.equal(retry.result.hookSpecificOutput.additionalContext, 'Selected a different mode');
  retry.emit('finish');
  assert.deepEqual(submit().result, {});
});

test('lab keeps readable experiments and counts unsupported journal rows in phase evidence', async t => {
  const { LabStore } = require('../electron/features/lab/store.cjs');
  const { journalEvidence } = require('../electron/features/lab/runner.cjs');
  const errors = [], store = new LabStore(folder(t), { report: error => errors.push(error.code) });
  const valid = { id: randomUUID(), tasks: [], runs: [], createdAt: 2 };
  const protectedId = randomUUID();
  await store.save(valid);
  await store.save({ ...valid, id: protectedId });
  const read = fsp.readFile;
  t.mock.method(fsp, 'readFile', async (file, ...args) => {
    if (file === path.join(store.folder(protectedId), 'experiment.json')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return read(file, ...args);
  });
  assert.deepEqual((await store.list()).map(entry => entry.id), [valid.id]);
  assert.deepEqual(errors, ['EACCES']);
  const known = '{"v":1,"type":"end","time":1}\n';
  const evidence = journalEvidence(known + '{"v":2,"type":"end","time":2}\n', []);
  assert.deepEqual(evidence, { ...journalEvidence(known, []), skippedJournalRows: 1 });
});

test('a dangling workspace link stays usable only when its unresolved target is inside the workspace', async t => {
  const { validateLinks } = require('../electron/features/lab/workspace.cjs');
  const directory = folder(t), root = path.join(directory, 'workspace');
  await fsp.mkdir(root);
  await fsp.symlink(path.join(root, 'missing/nested'), path.join(root, 'inside'), 'junction');
  const visited = [];
  await validateLinks(root, undefined, { onFile: name => visited.push(name) });
  assert.deepEqual(visited, ['inside']);
  await fsp.symlink(path.join(directory, 'outside/missing'), path.join(root, 'outside'), 'junction');
  await assert.rejects(validateLinks(root), /escapes the isolated workspace/);
});

test('a lab run writes diff recovery failures to the run log', async t => {
  const { recoverDiff } = require('../electron/features/lab/runner.cjs');
  const root = folder(t), artifacts = path.join(root, 'artifacts');
  const result = await recoverDiff({ cwd: path.join(root, 'missing') }, null, artifacts);
  assert.equal(result, null);
  const log = await fsp.readFile(path.join(artifacts, 'tests.log'), 'utf8');
  assert.match(log, /ENOENT/);
});

test('routing cleanup reports a busy guide and continues deleting its siblings', t => {
  const { pruneGuides } = require('../electron/features/routing/guide-cleanup.cjs');
  const root = folder(t), snapshot = name => path.join(root, name.repeat(32) + '.md');
  const busy = snapshot('a'), sibling = snapshot('b'), errors = [];
  fs.writeFileSync(busy, 'a'); fs.writeFileSync(sibling, 'b');
  const unlink = fs.unlinkSync;
  t.mock.method(fs, 'unlinkSync', file => {
    if (file === busy) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return unlink(file);
  });
  pruneGuides(root, new Set(), error => errors.push(error.code), Date.now() + 31 * 86400_000);
  assert.deepEqual(errors, ['EBUSY']);
  assert.equal(fs.existsSync(busy), true);
  assert.equal(fs.existsSync(sibling), false);
});

test('concurrent Claude and Codex lookups with different PATHs each return the correct executable', async t => {
  const { createLocator } = require('../electron/features/claude-runtime/locator.cjs');
  const { createCodexLocator } = require('../electron/features/codex-runtime/locator.cjs');
  const root = folder(t), one = path.join(root, 'one'), two = path.join(root, 'two');
  for (const directory of [one, two]) fs.mkdirSync(directory);
  const windows = process.platform === 'win32';
  for (const [name, create, versionText] of [['claude', createLocator, '2.1.332 (Claude Code)'], ['codex', createCodexLocator, 'codex-cli 0.150.0']]) {
    const binaries = [one, two].map(directory => path.join(directory, name + (windows ? '.exe' : '')));
    for (const binary of binaries) fs.writeFileSync(binary, '', { mode: 0o700 });
    const entered = Promise.withResolvers();
    const locator = create({ probe(file, _args, _options, callback) {
      if (file === binaries[0]) entered.resolve(() => callback(null, versionText)); else callback(null, versionText);
    } });
    const options = directory => ({ home: root, env: { PATH: directory, PATHEXT: '.EXE' } });
    const first = locator.locate(options(one));
    const done = await entered.promise;
    const second = locator.locate(options(two));
    done();
    const [a, b] = await Promise.all([first, second]);
    const executable = result => result.file ?? result.terminal?.file;
    assert.deepEqual([executable(a), executable(b)], binaries);
  }
});

test('Windows hook routing includes relocated managed settings written with a UTF-8 BOM', () => {
  const { terminalHooks } = require('../electron/features/claude-runtime/hooks.cjs');
  const settings = 'D:\\Applications\\ClaudeCode\\managed-settings.json', searched = [];
  const hooks = terminalHooks({ port: 4000, terminalId: 't', sessionKey: 'key', eventServer: { address: 'fixture' },
    env: { ProgramFiles: 'D:\\Applications' }, cwd: 'D:\\project', shell: { posix: true, node: '/node', helper: '/hooks' }, platform: 'win32',
    home: 'D:\\home', read(file) { searched.push(file); return file === settings ? '\uFEFF{"env":{"HTTPS_PROXY":"http://proxy.invalid"}}' : '{}'; } });
  assert.ok(searched.includes(settings));
  assert.equal(hooks.channel, 'command-async');
  assert.deepEqual(hooks.channelReason.params, { variable: 'HTTPS_PROXY', source: 'managed' });
});

test('the generated Windows hook opens a script with literal dollar signs and backticks', { skip: process.platform !== 'win32' }, t => {
  const { terminalHooks } = require('../electron/features/claude-runtime/hooks.cjs');
  const { execFileSync } = require('node:child_process');
  const root = folder(t), script = path.join(root, "Hook's $` path.ps1");
  const powershellPath = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  fs.writeFileSync(script, 'param($PipeName, $ProjectId, $SessionKey, $Kind)\n[Console]::Write($Kind)');
  const settings = terminalHooks({ terminalId: 't', sessionKey: 'key', eventServer: { name: 'fixture' }, env: {}, cwd: root,
    shell: { posix: false, powershellPath, script }, home: root, read: () => '{}' }).settings.fallback;
  const [hook] = JSON.parse(settings).hooks.SessionStart[0].hooks;
  assert.equal(hook.shell, 'powershell');
  const output = execFileSync(powershellPath, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(hook.command, 'utf16le').toString('base64')],
    { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  assert.equal(output.trim(), 'session');
});

test('a Windows PowerShell PATH shim is probed with a process-local execution policy', async t => {
  const { createPathInstall } = require('../electron/features/cli-adapters/path-install.cjs');
  const root = folder(t), file = path.join(root, 'sample.ps1');
  fs.writeFileSync(file, '');
  const install = createPathInstall({ command: 'sample', install: { minVersion: '1.0.0', versionPattern: /\d+\.\d+\.\d+/ } }, {
    platform: 'win32', run(_program, args, options, callback) {
      assert.deepEqual(args.slice(0, 5), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command']);
      assert.equal(options.env.AGENTRIX_INSTALL_PROBE_FILE, file);
      callback(null, '1.2.3');
    },
  });
  assert.deepEqual(await install.locate({ PATH: root }), { installed: true, version: '1.2.3', file, reason: null });
});

test('worker observations favor structured settings, reject plain session headers, and scope capacity to error fields', () => {
  const { claudeSettings } = require('../electron/features/cli-adapters/workers.cjs');
  const { WorkerOutput } = require('../integration/dispatch.cjs');
  const record = { type: 'user', perTurnEffort: 'high', message: { model: 'structured', usage: { speed: 'fast' },
    content: '<local-command-stdout>Set model to old\nSet effort level to low</local-command-stdout>' } };
  assert.deepEqual(claudeSettings(record), { model: 'structured', effort: 'high', fast: true, ultracode: null });
  const output = new WorkerOutput('codex');
  output.line('session id: guessed');
  output.line('tool output: overloaded');
  output.line(JSON.stringify({ type: 'error', message: 'Other error', output: 'overloaded' }));
  assert.equal(output.capacity, false);
  assert.ok(!output.sessionId);
  const id = randomUUID();
  output.line(JSON.stringify({ type: 'thread.started', thread_id: id }));
  assert.equal(output.sessionId, id);
  output.line(JSON.stringify({ type: 'error', error: { code: 'overloaded_error', message: 'Service busy' } }));
  assert.equal(output.capacity, true);
});

test('the editor guards Windows aliases of the same local path while respecting case for SSH', () => {
  const { createEditorGuard, editorPath } = require('../electron/features/files/editor-guard.cjs');
  const guard = createEditorGuard({ platform: 'win32' });
  const methods = new Map();
  guard.registerEditorIpc({ handle() {}, listen: (channel, fn) => methods.set(channel, fn) });
  methods.get('editor:dirty')(true, 'project', 'Folder/Original.md');
  assert.equal(guard.affectsEditor('project', ['folder\\ORIGINAL.md'], true), true);
  assert.equal(guard.affectsEditor('project', ['folder'], true), true);
  assert.equal(guard.affectsEditor('project', ['folder'], false), false);
  assert.equal(guard.affectsEditor('other', ['folder'], true), false);
  assert.equal(editorPath('Folder/Original.md', true, 'win32'), editorPath('folder\\ORIGINAL.md', true, 'win32'));
});
