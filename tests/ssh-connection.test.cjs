const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { randomUUID } = require('node:crypto');
const { SSHAuthServer } = require('../electron/ssh-auth.cjs');
const { RemoteConnection } = require('../electron/remote-connection.cjs');
const { PreviewResources, resourceResponse } = require('../electron/preview-resources.cjs');
const { FileOperations } = require('../electron/file-operations.cjs');
const { createSSHFixture, SSHWorker } = require('./helpers/ssh-fixture.cjs');
const { ProjectGit, gitEnvironment } = require('../electron/project-git.cjs');
const execGit = require('node:util').promisify(require('node:child_process').execFile);

const integrationDir = path.resolve(__dirname, '..', 'integration');
const sshPath = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/OpenSSH/ssh.exe') : 'ssh';
const waitFor = async (callback, what = 'SSH test', timeoutMs = 15000) => { const started = Date.now(); while (Date.now() - started < timeoutMs) { if (await callback()) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error(`Timed out waiting for ${what}`); };

async function fixtureFor(t, options = {}) {
  t.diagnostic('[ssh-test] begin ' + t.name);
  const value = await createSSHFixture({ ...options, diagnostic: line => t.diagnostic(line) });
  // Register before Git, askpass copies or authentication setup: a failed setup must still retire the listener.
  t.after(() => value.close(), { timeout: 12000 });
  t.signal.addEventListener('abort', () => {
    if (!t.passed) t.diagnostic('[ssh-test] aborted ' + JSON.stringify(value.snapshot()));
  }, { once: true });
  return value;
}

async function askpassFor(fixture) {
  if (process.platform !== 'win32') return undefined;
  const target = path.join(fixture.directory, 'askpass.exe');
  try { await fs.copyFile(path.join(integrationDir, 'ssh-askpass.exe'), target); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await execGit(path.join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
      ['/nologo', '/target:exe', '/reference:System.Web.Extensions.dll', '/out:' + target, path.join(integrationDir, 'ssh-askpass.cs')],
      { windowsHide: true, timeout: 10000 });
  }
  return target;
}

test('SSH fixture cleanup has a hard deadline and reports the worker without exposing its output', { timeout: 2000 }, async () => {
  const child = Object.assign(new EventEmitter(), {
    exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
    kill() {}, unref() { this.unreferenced = true; },
  });
  const messages = [], worker = new SSHWorker(child, line => messages.push(line), { graceMs: 10, timeoutMs: 20 });
  child.stdout.write('private fixture output'); child.stderr.write('private fixture error');
  await assert.rejects(worker.close(), /worker did not close: pid=0 exitCode=null signal=null stdoutBytes=22 stderrBytes=21/);
  assert.equal(child.unreferenced, true);
  assert.ok(child.stdin.destroyed && child.stdout.destroyed && child.stderr.destroyed);
  assert.ok(messages.some(message => /cleanup force pid=0/.test(message)));
  assert.doesNotMatch(messages.join('\n'), /private fixture/);
  await assert.rejects(worker.close(), /worker did not close/);
});

test('SSH fixture cleanup finds a reparented worker by process group and its separate PTY session', { timeout: 2000 }, async () => {
  const filename = path.join(__dirname, 'helpers/ssh-fixture.cjs'), localRequire = createRequire(filename);
  const module = { exports: {} }, signals = [], messages = [];
  const rows = [{ pid: 900001, parent: 1, group: 900000, name: 'python3' },
    { pid: 900002, parent: 900001, group: 900002, name: 'bash' },
    { pid: 900003, parent: 1, group: 900003, name: 'unrelated' }];
  const child = Object.assign(new EventEmitter(), { pid: 900000, exitCode: null, signalCode: null,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), unref() {} });
  const execFile = () => assert.fail('No real process may run in the fixture cleanup regression.');
  execFile[require('node:util').promisify.custom] = async (file, args, options) => {
    assert.equal(file, '/bin/ps'); assert.equal(options.timeout, 1000);
    return { stdout: rows.filter(row => !row.dead).map(row => `${row.pid} ${row.parent} ${row.group} S ${row.name}`).join('\n') };
  };
  vm.runInNewContext(await fs.readFile(filename, 'utf8'), { module, require: name => name === 'node:child_process'
    ? { execFile, spawn: () => assert.fail('No worker may spawn in this regression.') } : localRequire(name),
  setTimeout, clearTimeout, process: { platform: 'linux', pid: process.pid, kill(pid, signal) {
    signals.push([pid, signal]);
    if (signal === 'SIGKILL') for (const row of rows) if (row.pid === pid || row.group === -pid) row.dead = true;
    if (rows[0].dead && rows[1].dead) queueMicrotask(() => child.emit('close', 1, 'SIGKILL'));
  } } }, { filename });
  const worker = new module.exports.SSHWorker(child, line => messages.push(line), { graceMs: 10, timeoutMs: 50 });
  await worker.close();
  assert.ok(rows[0].dead && rows[1].dead); assert.ok(!rows[2].dead);
  for (const pid of [900001, 900002]) {
    assert.ok(signals.some(([id, signal]) => id === pid && signal === 'SIGSTOP'));
    assert.ok(signals.some(([id, signal]) => id === pid && signal === 'SIGKILL'));
  }
  assert.ok(!signals.some(([pid]) => Math.abs(pid) === 900003));
  assert.ok(messages.includes('[ssh-fixture] cleanup reap pid=900002 name=bash'));
  for (const stream of [child.stdin, child.stdout, child.stderr]) stream.destroy();
});

test('SSH fixture closes an unauthenticated transport that refuses to finish its connection', { timeout: 5000 }, async t => {
  const messages = [], value = await createSSHFixture({ nativeWorker: false, diagnostic: line => messages.push(line) });
  t.after(() => value.close(), { timeout: 3000 });
  const socket = net.connect({ port: value.port, host: '127.0.0.1', allowHalfOpen: true });
  t.after(() => socket.destroy()); socket.on('error', () => {}); socket.resume();
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  await value.close();
  assert.ok(messages.includes('[ssh-fixture] cleanup force connections=1'));
  assert.equal(value.snapshot().transports, 0);
  assert.ok(messages.includes('[ssh-fixture] cleanup complete failures=0'));
});

test('SSH fixture reaps a TERM-resistant worker and a detached descendant retaining stdio',
  { timeout: 10000, skip: process.platform === 'win32' }, async t => {
    const childCode = "process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000);";
    const code = `const {spawn}=require('node:child_process');process.on('SIGTERM',()=>{});
      const child=spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{detached:true,stdio:['ignore','pipe','ignore']});
      child.stdout.once('data',()=>console.log(child.pid));setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ['-e', code], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const messages = [], worker = new SSHWorker(child, line => messages.push(line), { graceMs: 50 });
    t.after(() => worker.close(), { timeout: 7000 });
    let output = ''; child.stdout.on('data', chunk => { output += chunk; });
    await waitFor(() => /^\d+\s*$/.test(output), 'the detached SSH fixture descendant', 2000);
    const descendant = Number(output.trim());
    await worker.close();
    assert.equal(worker.didClose, true);
    assert.ok(messages.some(message => /cleanup force pid=/.test(message)));
    assert.ok(messages.some(message => message.includes('cleanup reap pid=' + descendant)));
    const state = await execGit('/bin/ps', ['-p', String(descendant), '-o', 'stat='], { timeout: 1000 }).catch(error => {
      if (error.code === 1) return { stdout: '' }; throw error;
    });
    assert.ok(!state.stdout.trim() || state.stdout.trim().startsWith('Z'), 'the descendant cannot keep running');
  });

test('native OpenSSH reuses host config, authenticates once and carries terminal plus file requests', { timeout: 30000 }, async t => {
  const fixture = await fixtureFor(t);
  for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'SSH Test'], ['config', 'user.email', 'test@example.invalid'], ['commit', '--allow-empty', '-m', 'SSH history']]) await execGit('git', ['-C', fixture.project, ...args], { env: gitEnvironment(), windowsHide: true, timeout: 5000, signal: t.signal });
  await fs.writeFile(path.join(fixture.project, 'git-status.txt'), 'untracked');
  const auth = await new SSHAuthServer().start();
  const events = []; let output = '';
  const project = { id: randomUUID(), kind: 'ssh', path: process.platform === 'win32' ? '/srv/fixture' : fixture.project, ssh: { host: 'fixture', configFile: fixture.configFile } };
  const connection = new RemoteConnection(project, { integrationDir, auth, sshPath, sessionKey: 'test-session-key', onEvent: event => events.push(event) });
  connection.onData(data => { output += data; });
  t.after(async () => { connection.close(); auth.close(); await fixture.close(); }, { timeout: 12000 });
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
  const fixture = await fixtureFor(t, { password: true });
  const askpassPath = await askpassFor(fixture);
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
  t.after(async () => { for (const connection of opened) connection.close(); auth.close(); await fixture.close(); }, { timeout: 12000 });
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
  const fixture = await fixtureFor(t), auth = await new SSHAuthServer().start(), opened = [];
  const project = { id: randomUUID(), kind: 'ssh', path: process.platform === 'win32' ? '/srv/fixture' : fixture.project, ssh: { host: 'fixture', configFile: fixture.configFile } };
  const open = skills => {
    const connection = new RemoteConnection(project, { integrationDir, auth, sshPath, sessionKey: randomUUID(), skills });
    opened.push(connection); return connection;
  };
  t.after(async () => { for (const connection of opened) connection.close(); auth.close(); await fixture.close(); }, { timeout: 12000 });
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
  const fixture = await fixtureFor(t, { password: true, unknownHost: true, nativeWorker: false });
  const askpassPath = await askpassFor(fixture);
  const prompts = [];
  const auth = await new SSHAuthServer(queue => {
    const prompt = queue[0];
    if (!prompt) return;
    prompts.push(prompt.kind);
    setImmediate(() => auth.answer(prompt.id, prompt.kind === 'confirm' ? 'yes' : fixture.secret));
  }).start();
  const connection = new RemoteConnection({ id: randomUUID(), kind: 'ssh', path: '/srv/fixture', ssh: { host: 'fixture', configFile: fixture.configFile } }, { integrationDir, auth, sshPath, askpassPath, sessionKey: 'test-auth-key' });
  t.after(async () => { connection.close(); auth.close(); await fixture.close(); }, { timeout: 12000 });
  await connection.ready;
  assert.ok(prompts.includes('confirm'));
  assert.ok(prompts.includes('secret'));
  assert.ok(!(await fs.readFile(fixture.configFile, 'utf8')).includes(fixture.secret));
  assert.ok((await fs.readFile(fixture.knownHosts, 'utf8')).trim().length > 0);
});

test('untrusted askpass requests are rejected without displaying a credential prompt', { timeout: 10000 }, async t => {
  const auth = await new SSHAuthServer().start();
  t.after(() => auth.close());
  auth.register('test-project', 'fixture', () => {});
  const response = await fetch(auth.url, { method: 'POST', signal: AbortSignal.any([t.signal, AbortSignal.timeout(3000)]), headers: { Authorization: 'Bearer wrong', 'Content-Type': 'application/json' }, body: JSON.stringify({ connectionId: 'test-project', prompt: 'password' }) });
  assert.equal(response.status, 403);
  assert.equal(auth.getPending().length, 0);
});

test('Linux SSH Claude wrapper forwards hooks and reads compacted transcripts over the worker', { timeout: 40000, skip: process.platform === 'win32' }, async t => {
  const fixture = await fixtureFor(t, { nativeWorker: true });
  const auth = await new SSHAuthServer().start(), events = [];
  const project = { id: randomUUID(), kind: 'ssh', path: fixture.project, ssh: { host: 'fixture', configFile: fixture.configFile } };
  const stub = `#!/usr/bin/env python3
import json,os,subprocess,sys
args=sys.argv[1:]
if "--version" in args: sys.exit(7)
assert args[2]=="--append-system-prompt"
assert args[3].startswith("You run inside Agentrix. SSH reading note.")
assert args[3].endswith("Agentrix delivers skill instructions through its SessionStart hook.")
assert "SSH skill instructions." not in args[3]
assert "Agentrix skill delivery:" not in args[3]
assert args[4:]==["--resume","fixture"]
settings_file=args[args.index("--settings")+1]
assert os.path.dirname(settings_file)==os.path.dirname(os.environ["AGENTRIX_READING_NOTE_FILE"])
assert os.path.basename(settings_file).startswith("claude-settings.")
with open(settings_file,encoding="utf-8") as source: settings=json.load(source)
with open("claude-settings.json","w",encoding="utf-8") as output: json.dump({"path":settings_file,"settings":settings},output)
folder=os.path.join(os.path.expanduser("~/.claude"),"projects","fixture")
os.makedirs(folder,exist_ok=True)
filename=os.path.join(folder,"session.jsonl")
def write(record):
    with open(filename,"a") as output: output.write(json.dumps(record)+"\\n")
def hook(name,**values):
    payload=dict(session_id="session",transcript_path=filename,**values)
    command=settings["hooks"][name][0]["hooks"][0]["command"]
    result=subprocess.run(command,shell=True,input=json.dumps(payload).encode(),stdout=subprocess.PIPE,check=True)
    return result.stdout
write({"type":"user","uuid":"prompt","message":{"content":"Remote work"}})
write({"type":"assistant","uuid":"reply","effort":"high","message":{"model":"claude-test","usage":{"speed":"fast"},"content":[{"type":"tool_use","id":"read","name":"Read","input":{"file_path":"/srv/project/a.py"}}]}})
context={"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"Agentrix skill instructions:\\nSSH skill instructions."}}
assert json.loads(hook("SessionStart",source="startup"))==context
assert hook("SessionStart",source="resume")==b""
assert json.loads(hook("SessionStart",source="compact"))==context
hook("UserPromptSubmit",prompt="Remote work")
hook("Notification",notification_type="idle_prompt",message="Idle")
hook("Notification",notification_type="permission_prompt",message="Permission")
write({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"read","is_error":True,"content":"hidden output"}]}})
hook("Stop")
`;
  await fs.writeFile(path.join(fixture.home, 'bin', 'claude'), stub, { mode: 0o755 });
  const skills = { files: [], instructions: 'SSH skill instructions.', key: 'a'.repeat(64) };
  const readingNote = 'You run inside Agentrix. SSH reading note. Agentrix skill delivery: remote. SSH skill instructions.';
  const connection = new RemoteConnection(project, { integrationDir, auth, sshPath, sessionKey: 'test-claude-key', readingNote, skills, onEvent: event => events.push(event) });
  let output = '';
  connection.onData(data => { output += data; });
  t.after(async () => { connection.close(); auth.close(); await fixture.close(); }, { timeout: 12000 });
  await connection.ready;
  await waitFor(() => events.some(event => event.type === 'shell-prompt' && event.claudeAvailable));
  connection.write('claude --resume fixture\r');
  await waitFor(() => events.some(event => event.type === 'codex-exited' && event.agent === 'claude'));
  const exited = events.find(event => event.type === 'codex-exited' && event.agent === 'claude');
  assert.equal(exited.exitCode, 0, output);
  const settings = JSON.parse(await fs.readFile(path.join(fixture.project, 'claude-settings.json'), 'utf8'));
  await assert.rejects(fs.stat(settings.path), { code: 'ENOENT' }, 'the SSH wrapper removes its settings file after exit');
  const started = events.find(event => event.type === 'codex-started');
  assert.equal(started.agent, 'claude'); assert.equal(started.command, '--resume');
  const hooks = events.filter(event => event.type === 'agent-activity');
  assert.deepEqual(hooks.map(event => event.state), ['session', 'session', 'session', 'working', 'attention', 'complete']);
  assert.equal(hooks[3].prompt, 'Remote work'); assert.equal(hooks[4].message, 'Permission');
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
  const fixture = await fixtureFor(t, { nativeWorker: true });
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
  t.after(async () => { connection.close(); auth.close(); await fixture.close(); }, { timeout: 12000 });
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
