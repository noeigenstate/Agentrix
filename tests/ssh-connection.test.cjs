const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { SSHAuthServer } = require('../electron/ssh-auth.cjs');
const { RemoteConnection } = require('../electron/remote-connection.cjs');
const { PreviewResources, resourceResponse } = require('../electron/preview-resources.cjs');
const { FileOperations } = require('../electron/file-operations.cjs');
const { createSSHFixture } = require('./helpers/ssh-fixture.cjs');
const { ProjectGit, gitEnvironment } = require('../electron/project-git.cjs');
const execGit = require('node:util').promisify(require('node:child_process').execFile);

const integrationDir = path.resolve(__dirname, '..', 'integration');
const sshPath = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/OpenSSH/ssh.exe') : 'ssh';
const waitFor = async (callback, what = 'SSH test') => { const started = Date.now(); while (Date.now() - started < 15000) { if (await callback()) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error(`Timed out waiting for ${what}`); };

test('native OpenSSH reuses host config, authenticates once and carries terminal plus file requests', { timeout: 30000 }, async t => {
  const fixture = await createSSHFixture();
  for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'SSH Test'], ['config', 'user.email', 'test@example.invalid'], ['commit', '--allow-empty', '-m', 'SSH history']]) await execGit('git', ['-C', fixture.project, ...args], { env: gitEnvironment(), windowsHide: true });
  await fs.writeFile(path.join(fixture.project, 'git-status.txt'), 'untracked');
  const auth = await new SSHAuthServer().start();
  const events = []; let output = '';
  const project = { id: randomUUID(), kind: 'ssh', path: process.platform === 'win32' ? '/srv/fixture' : fixture.project, ssh: { host: 'fixture', configFile: fixture.configFile } };
  const connection = new RemoteConnection(project, { integrationDir, auth, sshPath, sessionKey: 'test-session-key', onEvent: event => events.push(event) });
  connection.onData(data => { output += data; });
  t.after(async () => { connection.close(); auth.close(); await fixture.close(); });
  await connection.ready;
  const gitReader = new ProjectGit(() => connection);
  assert.equal((await gitReader.read(project, 'status')).files[0].path, 'git-status.txt');
  const commits = (await gitReader.read(project, 'history', 0)).commits;
  assert.equal(commits[0].subject, 'SSH history');
  assert.equal((await gitReader.read(project, 'files', commits[0].hash)).total, 0);
  const listing = await connection.request('directory', { path: '', offset: 0 });
  assert.equal(listing.path, '');
  await waitFor(() => events.some(event => event.type === 'shell-prompt'));
  connection.write('printf "SSH_TRANSPORT_OK\\n"\r');
  await waitFor(() => output.includes('SSH_TRANSPORT_OK'));
  connection.resize(110, 34);
  const imageBytes = await fs.readFile(path.join(__dirname, '..', 'assets/icon.png'));
  await fs.writeFile(path.join(fixture.project, '图片.png'), imageBytes);
  const resources = new PreviewResources({ remote: () => connection });
  const preview = resources.open(project, '图片.png', 'image', 'image/png');
  const resource = await resources.resolve(preview.url);
  const response = resourceResponse(resource, new Request(preview.url));
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), imageBytes);
  const tail = resourceResponse(resource, new Request(preview.url, { headers: { Range: 'bytes=100-' } }));
  assert.equal(tail.status, 206);
  assert.deepEqual(Buffer.from(await tail.arrayBuffer()), imageBytes.subarray(100));
  assert.equal(auth.getPending().length, 0);
  connection.close();
  await assert.rejects(connection.request('directory', { path: '' }), /关闭|断开/);
});

test('terminals on one host share its SSH connection: one login, their own output, and each closes on its own', { timeout: 30000 }, async t => {
  const fixture = await createSSHFixture({ password: true });
  const askpassPath = process.platform === 'win32' ? path.join(fixture.directory, 'askpass.exe') : undefined;
  if (askpassPath) await fs.copyFile(path.join(integrationDir, 'ssh-askpass.exe'), askpassPath);
  const prompts = new Set();
  const auth = await new SSHAuthServer(queue => {
    const prompt = queue[0];
    if (prompt && !prompts.has(prompt.id)) { prompts.add(prompt.id); setImmediate(() => auth.answer(prompt.id, fixture.secret)); }
  }).start();
  const project = { id: randomUUID(), kind: 'ssh', path: process.platform === 'win32' ? '/srv/fixture' : fixture.project, ssh: { host: 'fixture', configFile: fixture.configFile } };
  const events = [], output = {}, opened = [];
  const open = key => {
    const connection = new RemoteConnection(project, { integrationDir, auth, sshPath, askpassPath, sessionKey: key, onEvent: event => events.push(event) });
    output[key] = ''; connection.onData(data => { output[key] += data; }); opened.push(connection);
    return connection;
  };
  t.after(async () => { for (const connection of opened) connection.close(); auth.close(); await fixture.close(); });
  const prompted = key => waitFor(() => events.some(event => event.type === 'shell-prompt' && event.sessionKey === key), `the ${key} prompt`);
  const first = open('first'), second = open('second');
  await Promise.all([first.ready, second.ready, prompted('first'), prompted('second')]);
  assert.equal(fixture.workers, 1);
  assert.equal(prompts.size, 1);
  second.write('printf "SECOND_OK\\n"\r');
  await waitFor(() => output.second.includes('SECOND_OK'), 'the second terminal');
  assert.ok(!output.first.includes('SECOND_OK'));
  first.close();
  second.write('printf "STILL_OK\\n"\r');
  await waitFor(() => output.second.includes('STILL_OK'), 'the second terminal after the first closed');
  assert.equal((await second.request('directory', { path: '', offset: 0 })).path, '');
  const third = open('third');
  await Promise.all([third.ready, prompted('third')]);
  assert.equal(fixture.workers, 1);
  const link = second.link.child;
  second.close(); third.close();
  // The connection ends with its last terminal, by itself, and the next terminal logs in again.
  await waitFor(() => link.exitCode !== null || link.signalCode !== null, 'the connection to end');
  assert.equal(link.exitCode, 0);
  const fourth = open('fourth');
  await fourth.ready;
  assert.equal(fixture.workers, 2);
  assert.equal(prompts.size, 2);
});

test('SSH sends unchanged skills by key on the same link and resends only when the bundle changes', { timeout: 30000 }, async t => {
  const fixture = await createSSHFixture(), auth = await new SSHAuthServer().start(), opened = [];
  const project = { id: randomUUID(), kind: 'ssh', path: process.platform === 'win32' ? '/srv/fixture' : fixture.project, ssh: { host: 'fixture', configFile: fixture.configFile } };
  const open = skills => {
    const connection = new RemoteConnection(project, { integrationDir, auth, sshPath, sessionKey: randomUUID(), skills });
    opened.push(connection); return connection;
  };
  t.after(async () => { for (const connection of opened) connection.close(); auth.close(); await fixture.close(); });
  const bundle = { key: 'a'.repeat(64), instructions: 'Read-only references.', files: [{ id: 'user:test', scope: 'global', name: 'test', text: '---\nname: test\ndescription: Test.\n---\nBody.' }] };
  const first = open(bundle); await first.ready;
  const sent = [], write = first.link.child.stdin.write.bind(first.link.child.stdin);
  t.mock.method(first.link.child.stdin, 'write', (data, ...args) => { sent.push(JSON.parse(data)); return write(data, ...args); });
  const second = open(bundle); await second.ready;
  const unchanged = sent.find(message => message.op === 'open');
  assert.equal(unchanged.skills, null); assert.equal(unchanged.skillsKey, bundle.key);
  assert.equal(Object.keys(unchanged)[0], 'channel');
  const changed = { ...bundle, key: 'b'.repeat(64), instructions: 'Updated read-only references.' };
  const third = open(changed); await third.ready;
  assert.deepEqual(sent.filter(message => message.op === 'open')[1].skills, changed);
  assert.equal(fixture.workers, 1);
});

test('native SSH prompts for a first host key and password without writing credentials to project config',{ timeout: 30000 }, async t => {
  const fixture = await createSSHFixture({ password: true, unknownHost: true, nativeWorker: false });
  const askpassPath = process.platform === 'win32' ? path.join(fixture.directory, 'askpass.exe') : undefined;
  if (askpassPath) await fs.copyFile(path.join(integrationDir, 'ssh-askpass.exe'), askpassPath);
  const prompts = [];
  const auth = await new SSHAuthServer(queue => {
    const prompt = queue[0];
    if (!prompt) return;
    prompts.push(prompt.kind);
    setImmediate(() => auth.answer(prompt.id, prompt.kind === 'confirm' ? 'yes' : fixture.secret));
  }).start();
  const connection = new RemoteConnection({ id: randomUUID(), kind: 'ssh', path: '/srv/fixture', ssh: { host: 'fixture', configFile: fixture.configFile } }, { integrationDir, auth, sshPath, askpassPath, sessionKey: 'test-auth-key' });
  t.after(async () => { connection.close(); auth.close(); await fixture.close(); });
  await connection.ready;
  assert.ok(prompts.includes('confirm'));
  assert.ok(prompts.includes('secret'));
  assert.ok(!(await fs.readFile(fixture.configFile, 'utf8')).includes(fixture.secret));
  assert.ok((await fs.readFile(fixture.knownHosts, 'utf8')).trim().length > 0);
});

test('untrusted askpass requests are rejected without displaying a credential prompt', async t => {
  const auth = await new SSHAuthServer().start();
  t.after(() => auth.close());
  auth.register('test-project', 'fixture', () => {});
  const response = await fetch(auth.url, { method: 'POST', headers: { Authorization: 'Bearer wrong', 'Content-Type': 'application/json' }, body: JSON.stringify({ connectionId: 'test-project', prompt: 'password' }) });
  assert.equal(response.status, 403);
  assert.equal(auth.getPending().length, 0);
});

test('Linux SSH Claude wrapper forwards hooks and reads compacted transcripts over the worker', { timeout: 40000, skip: process.platform === 'win32' }, async t => {
  const fixture = await createSSHFixture({ nativeWorker: true });
  const auth = await new SSHAuthServer().start(), events = [];
  const project = { id: randomUUID(), kind: 'ssh', path: fixture.project, ssh: { host: 'fixture', configFile: fixture.configFile } };
  const stub = `#!/usr/bin/env python3
import json,os,subprocess,sys
args=sys.argv[1:]
if "--version" in args: sys.exit(7)
assert args[args.index("--append-system-prompt")+1]=="SSH reading note"
settings=json.loads(args[args.index("--settings")+1])
folder=os.path.join(os.path.expanduser("~/.claude"),"projects","fixture")
os.makedirs(folder,exist_ok=True)
filename=os.path.join(folder,"session.jsonl")
def write(record):
    with open(filename,"a") as output: output.write(json.dumps(record)+"\\n")
def hook(name,**values):
    payload=dict(session_id="session",transcript_path=filename,**values)
    command=settings["hooks"][name][0]["hooks"][0]["command"]
    subprocess.run(command,shell=True,input=json.dumps(payload).encode(),check=True)
write({"type":"user","uuid":"prompt","message":{"content":"Remote work"}})
write({"type":"assistant","uuid":"reply","effort":"high","message":{"model":"claude-test","usage":{"speed":"fast"},"content":[{"type":"tool_use","id":"read","name":"Read","input":{"file_path":"/srv/project/a.py"}}]}})
hook("SessionStart")
hook("UserPromptSubmit",prompt="Remote work")
hook("Notification",notification_type="idle_prompt",message="Idle")
hook("Notification",notification_type="permission_prompt",message="Permission")
write({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"read","is_error":True,"content":"hidden output"}]}})
hook("Stop")
`;
  await fs.writeFile(path.join(fixture.home, 'bin', 'claude'), stub, { mode: 0o755 });
  const connection = new RemoteConnection(project, { integrationDir, auth, sshPath, sessionKey: 'test-claude-key', readingNote: 'SSH reading note', onEvent: event => events.push(event) });
  t.after(async () => { connection.close(); auth.close(); await fixture.close(); });
  await connection.ready;
  await waitFor(() => events.some(event => event.type === 'shell-prompt' && event.claudeAvailable));
  connection.write('claude\r');
  await waitFor(() => events.some(event => event.type === 'codex-exited' && event.agent === 'claude'));
  const started = events.find(event => event.type === 'codex-started');
  assert.equal(started.agent, 'claude'); assert.equal(started.command, undefined);
  const hooks = events.filter(event => event.type === 'agent-activity');
  assert.deepEqual(hooks.map(event => event.state), ['session', 'working', 'attention', 'complete']);
  assert.equal(hooks[1].prompt, 'Remote work'); assert.equal(hooks[2].message, 'Permission');
  assert.ok(hooks.every(event => event.projectId === project.id && event.sessionKey === 'test-claude-key'));
  const args = { path: hooks[0].transcriptPath, since: started.sentAt };
  const status = await connection.request('claude-status', args);
  assert.equal(status.reset, true); assert.equal(status.historyDone, true);
  assert.deepEqual(status.records.map(record => record.type), ['user', 'assistant', 'user']);
  assert.equal(status.records[1].message.model, 'claude-test');
  assert.equal(status.records[2].message.content[0].is_error, true); assert.equal(status.records[2].message.content[0].content, '');
  assert.deepEqual((await connection.request('claude-status', args)).records, []);
  await assert.rejects(connection.request('claude-status', { ...args, path: path.join(fixture.project, 'outside.jsonl') }));
  connection.write('claude --version\r');
  await waitFor(() => events.some(event => event.type === 'codex-exited' && event.agent === 'claude' && event.exitCode === 7));
  assert.ok(events.some(event => event.type === 'codex-started' && event.command === '--version' && event.agent === 'claude'));
});

test('Linux remote worker reads real files, enforces boundaries and emits Codex completion', { timeout: 40000, skip: process.platform === 'win32' }, async t => {
  const fixture = await createSSHFixture({ nativeWorker: true });
  const auth = await new SSHAuthServer().start();
  const project = { id: randomUUID(), kind: 'ssh', path: fixture.project, ssh: { host: 'fixture', configFile: fixture.configFile } };
  const events = []; let output = '';
  await fs.writeFile(path.join(fixture.project, 'hello.txt'), '中文 remote file');
  await fs.copyFile(path.join(__dirname, '..', 'assets', 'icon.png'), path.join(fixture.project, 'image.png'));
  await fs.writeFile(path.join(fixture.project, 'page.html'), '<h1>Remote preview</h1>');
  await fs.writeFile(path.join(fixture.project, 'README.md'), '# SSH Markdown');
  const stub = '#!/usr/bin/env python3\nimport json,subprocess,sys\ncommand=json.loads(sys.argv[2][7:])\nsubprocess.run(command+[json.dumps({"type":"agent-turn-complete","thread-id":"test","turn-id":"1"})])\nprint("REMOTE_CODEX_DONE")\n';
  await fs.writeFile(path.join(fixture.home, 'bin', 'codex'), stub, { mode: 0o755 });
  const connection = new RemoteConnection(project, { integrationDir, auth, sshPath, sessionKey: 'test-linux-key', onEvent: event => events.push(event) });
  connection.onData(data => { output += data; });
  t.after(async () => { connection.close(); auth.close(); await fixture.close(); });
  await connection.ready;
  assert.equal((await connection.request('preview', { path: 'hello.txt', page: 0 })).content, '中文 remote file');
  assert.equal((await connection.request('preview', { path: 'image.png', page: 0 })).kind, 'image');
  assert.equal((await connection.request('preview', { path: 'page.html', page: 0 })).kind, 'html');
  assert.equal((await connection.request('preview', { path: 'README.md', page: 0 })).kind, 'markdown');
  assert.equal(Buffer.from(await connection.request('read', { path: 'hello.txt', offset: 0, length: 6 }), 'base64').toString(), '中文');
  const editable = await connection.request('preview', { path: 'hello.txt', page: 0 });
  const edited = await connection.request('save-file', { path: 'hello.txt', page: 0, revision: editable.revision, data: Buffer.from('通过 SSH 保存\n第二行', 'utf8').toString('base64') });
  assert.equal(edited.content, '通过 SSH 保存\n第二行');
  assert.equal(await fs.readFile(path.join(fixture.project, 'hello.txt'), 'utf8'), edited.content);
  await assert.rejects(connection.request('save-file', { path: 'hello.txt', page: 0, revision: editable.revision, data: Buffer.from('stale').toString('base64') }), /其他程序修改/);
  await assert.rejects(connection.request('read', { path: '../outside', offset: 0, length: 10 }));
  await waitFor(() => events.some(event => event.type === 'shell-prompt' && event.codexAvailable));
  connection.write('printf FIRST > shift-first.txt');
  connection.write('\x1b[13;2u');
  connection.write('printf SECOND > shift-second.txt');
  await new Promise(resolve => setTimeout(resolve, 150));
  await assert.rejects(fs.stat(path.join(fixture.project, 'shift-first.txt')), 'modified Enter must not execute the first complete Bash command');
  connection.write('\r');
  await waitFor(async () => fs.readFile(path.join(fixture.project, 'shift-second.txt'), 'utf8').then(value => value === 'SECOND', () => false));
  assert.equal(await fs.readFile(path.join(fixture.project, 'shift-first.txt'), 'utf8'), 'FIRST');
  connection.write('codex\r');
  await waitFor(() => events.some(event => event.type === 'turn-complete'));
  const activityThread = randomUUID(), activitySince = Date.now();
  const sessions = path.join(fixture.home, '.codex', 'sessions');
  await fs.mkdir(sessions, { recursive: true });
  const activityFile = path.join(sessions, `rollout-${activityThread}.jsonl`);
  const activityRecord = type => JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type, turn_id: 'parent-turn' } }) + '\n';
  await fs.writeFile(activityFile, JSON.stringify({ type: 'session_meta', payload: { id: activityThread, cwd: fixture.project, source: 'cli' } }) + '\n' + activityRecord('task_started'));
  // The status comes with the conversation's records, compacted, for the reading view here.
  const working = await connection.request('codex-status', { since: activitySince });
  assert.equal(working.snapshot.state, 'working');
  assert.equal(working.reset, true); assert.equal(working.historyDone, true);
  assert.deepEqual(working.records.map(record => record.type + ':' + (record.payload.type || '')), ['session_meta:', 'event_msg:task_started']);
  await fs.appendFile(activityFile, activityRecord('task_complete'));
  const complete = await connection.request('codex-status', { since: activitySince });
  assert.equal(complete.snapshot.state, 'complete');
  assert.equal(complete.reset, false);
  assert.deepEqual(complete.records.map(record => record.payload.type), ['task_complete']);
  await waitFor(() => events.some(event => event.type === 'codex-exited'));
  assert.ok(output.includes('REMOTE_CODEX_DONE'));
  let clipboard = [];
  const operations = new FileOperations({ cacheRoot: path.join(fixture.directory, 'clipboard-cache'), remote: () => connection,
    clipboard: async (action, paths) => action === 'copy' ? (clipboard = paths) : clipboard, confirmDelete: async () => true,
  });
  await operations.create(project, '', '上传目录', 'directory');
  await operations.create(project, '上传目录', 'empty.txt', 'file');
  await operations.rename(project, '上传目录/empty.txt', 'renamed.txt');
  const source = path.join(fixture.directory, 'upload.bin'); const payload = Buffer.alloc(1024 * 1024 + 11, 73);
  await fs.writeFile(source, payload); clipboard = [source];
  const pasted = await operations.paste(project, '上传目录');
  assert.deepEqual(pasted.pasted, ['上传目录/upload.bin']);
  assert.deepEqual(await fs.readFile(path.join(fixture.project, '上传目录/upload.bin')), payload);
  await operations.copy(project, ['上传目录']);
  assert.deepEqual(await fs.readFile(path.join(clipboard[0], 'upload.bin')), payload);
  await operations.remove(project, ['上传目录']);
  await assert.rejects(fs.stat(path.join(fixture.project, '上传目录')));
  assert.deepEqual(await fs.readFile(source), payload);
});
