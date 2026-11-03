const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { promisify } = require('node:util');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { randomUUID } = require('node:crypto');
const { LabSession } = require('../electron/features/lab/session.cjs');
const backend = require('../electron/features/lab/sandbox-win32.cjs');
const { markedPids, command } = require('../electron/features/lab/process.cjs');
const { prepCommand, createHostPreparation, ISOLATION_ERROR, nativeSource } = require('../electron/features/lab/sandbox-win32-preparation.cjs');

const windows = { timeout: 45000, skip: process.platform !== 'win32' ? 'Windows LPAC and Job Objects are required' :
  process.env.AGENTRIX_LAB_TEST_PREPARE_HOST !== '1' ? 'Windows sandbox tests require explicit AGENTRIX_LAB_TEST_PREPARE_HOST=1 consent on the elevated CI runner.' :
    process.env.CI !== 'true' ? 'Real Windows LPAC and Job tests run only on the elevated CI runner.' : false };

async function loadModule(name, overrides = {}, globals = {}) {
  const file = path.join(__dirname, '../electron/features/lab', name), localRequire = createRequire(file), module = { exports: {} };
  vm.runInNewContext(await fs.readFile(file, 'utf8'), {
    module, process, Buffer, console, setTimeout, clearTimeout, AbortSignal, __dirname: path.dirname(file),
    require: name => overrides[name] || localRequire(name), ...globals,
  }, { filename: file });
  return module.exports;
}

async function mockedBackend(t, rename) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lab-launcher-unit-')), calls = [], compiled = Buffer.from('fresh compiled payload');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const execFile = () => assert.fail('No real process may start in launcher unit tests.');
  execFile[promisify.custom] = async (file, args, options) => {
    calls.push({ file, args, options });
    if (path.basename(file) === 'csc.exe') await fs.writeFile(args.find(arg => arg.startsWith('/out:')).slice(5), compiled);
    return { stdout: args[0] === 'host-ready' ? JSON.stringify({ ready: true, elevated: false }) : '[]', stderr: '' };
  };
  const sandbox = await loadModule('sandbox-win32.cjs', {
    'node:child_process': { execFile },
    'node:fs/promises': { ...fs, ...(rename ? { rename: (from, to) => rename(from, to, compiled) } : {}) },
  });
  return { sandbox, root, calls, compiled };
}

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lab-win32-')));
  const labRoot = path.join(root, 'lab'), workspaceRoot = path.join(labRoot, 'workspaces');
  const install = path.join(root, 'runtime-node'), nodePath = path.join(install, 'node.exe');
  await fs.mkdir(workspaceRoot, { recursive: true }); await fs.mkdir(install);
  await fs.copyFile(process.execPath, nodePath);
  const session = new LabSession({
    labRoot, workspaceRoot, directory: workspaceRoot, nodePath, runId: randomUUID(), protectedPaths: [path.join(root, 'protected')],
    hostPrompt: false, signal: t.signal,
    env: { SystemRoot: process.env.SystemRoot, PATH: install + path.delimiter + path.join(process.env.SystemRoot, 'System32'),
      CODEX_HOME: path.join(root, 'fixture-codex'), CLAUDE_CONFIG_DIR: path.join(root, 'fixture-claude') },
  });
  t.after(async () => {
    if (session.started && !session.closed) await backend.initialize({ directory: labRoot });
    await session.close(); await fs.rm(root, { recursive: true, force: true });
  });
  const state = await backend.hostState({ directory: labRoot });
  t.diagnostic(`[lab-win32] fixture host ready=${Number(state.ready)} elevated=${Number(state.elevated)}`);
  if (!state.elevated && !state.ready) {
    t.skip('Windows host is unprepared and the test process is not elevated; tests never request UAC.');
    return null;
  }
  await fs.mkdir(path.join(root, 'protected')); await fs.writeFile(path.join(root, 'protected', 'secret'), 'synthetic secret');
  await session.start();
  t.diagnostic('[lab-win32] fixture session started');
  const execute = session.execute.bind(session);
  session.execute = (file, args, options = {}) => execute(file, args, { timeoutMs: 15000, ...options });
  return { root, labRoot, workspaceRoot, session, install, nodePath };
}

test('Windows LPAC permits the workspace, denies protected reads and outside writes', windows, async t => {
  const f = await fixture(t); if (!f) return;
  const outside = path.join(f.root, 'outside.txt');
  await fs.writeFile(outside, 'unchanged');
  const script = `const fs=require('node:fs');
    let read=false,write=false;try{fs.readFileSync(process.argv[1]);read=true}catch{}
    try{fs.writeFileSync(process.argv[2],'changed');write=true}catch{}
    fs.writeFileSync('allowed.txt','ok');console.log(JSON.stringify({read,write}));`;
  const result = await f.session.execute(f.nodePath, ['-e', script, path.join(f.root, 'protected', 'secret'), outside], { cwd: f.workspaceRoot, timeoutMs: 10000 });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { read: false, write: false });
  assert.equal(await fs.readFile(outside, 'utf8'), 'unchanged');
  assert.equal(await fs.readFile(path.join(f.workspaceRoot, 'allowed.txt'), 'utf8'), 'ok');
});

test('Windows Job Objects reap detached descendants whose environment markers were erased', windows, async t => {
  const f = await fixture(t);
  if (!f) return;
  const script = `const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],
    {detached:true,stdio:'ignore',env:{SystemRoot:process.env.SystemRoot}});console.log(c.pid);c.unref();`;
  const result = await f.session.execute(f.nodePath, ['-e', script], { cwd: f.workspaceRoot });
  assert.equal(result.code, 0, result.stderr);
  const pid = Number(result.stdout.trim()); assert.ok(pid > 0);
  assert.deepEqual(await markedPids(f.session.runId), []);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('Windows runtime discovery grants individual install folders without granting their parent', windows, async t => {
  const f = await fixture(t); if (!f) return;
  const folders = [];
  for (const name of ['python', 'git', 'codex', 'claude']) {
    const folder = path.join(f.root, 'runtime-' + name); folders.push(folder); await fs.mkdir(folder);
    await fs.copyFile(process.execPath, path.join(folder, name + '.exe'));
    await fs.writeFile(path.join(folder, 'runtime.data'), name);
  }
  f.session.env.PATH = [f.install, ...folders, path.join(process.env.SystemRoot, 'System32')].join(path.delimiter);
  const script = `const fs=require('node:fs');const values=process.argv.slice(1).map(p=>fs.readFileSync(p+'/runtime.data','utf8'));
    let denied=false;try{fs.readFileSync(process.argv[1]+'/../protected/secret')}catch{denied=true}console.log(JSON.stringify({values,denied}));`;
  const result = await f.session.execute(f.nodePath, ['-e', script, ...folders], { cwd: f.workspaceRoot });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { values: ['python', 'git', 'codex', 'claude'], denied: true });
  for (const [index, name] of ['python', 'git', 'codex', 'claude'].entries()) {
    const executed = await f.session.execute(path.join(folders[index], name + '.exe'), ['-e', "process.stdout.write('executable')"],
      { cwd: f.workspaceRoot, timeoutMs: 10000 });
    assert.equal(executed.code, 0, executed.stderr); assert.equal(executed.stdout, 'executable');
  }
  await assert.rejects(backend.runtimeRoots({ nodePath: f.nodePath, env: f.session.env,
    protectedPaths: [f.install] }), /overlaps a protected path/);
});

test('Windows refuses a writable hard link to a protected file before starting model code', windows, async t => {
  const f = await fixture(t); if (!f) return;
  const source = path.join(f.root, 'protected', 'secret');
  await fs.link(source, path.join(f.workspaceRoot, 'linked-secret'));
  await assert.rejects(f.session.execute(f.nodePath, ['-e', "require('node:fs').writeFileSync('linked-secret','changed')"],
    { cwd: f.workspaceRoot, timeoutMs: 10000 }), { infrastructure: true });
  assert.equal(await fs.readFile(source, 'utf8'), 'synthetic secret');
  assert.equal(f.session.modelStarted, false);
});

test('Windows rejects pre-existing package read access to protected material', windows, async t => {
  const f = await fixture(t); if (!f) return;
  const secret = path.join(f.root, 'protected', 'secret');
  const acl = await command(path.join(process.env.SystemRoot, 'System32', 'icacls.exe'),
    [secret, '/grant', '*S-1-15-2-2:(R)'], { timeoutMs: 5000 });
  assert.equal(acl.code, 0, acl.stderr);
  await assert.rejects(f.session.execute(f.nodePath, ['-e', "require('node:fs').writeFileSync('should-not-run','bad')"],
    { cwd: f.workspaceRoot, timeoutMs: 10000 }), { infrastructure: true });
  assert.equal(await fs.stat(path.join(f.workspaceRoot, 'should-not-run')).catch(() => null), null);
  assert.equal(await fs.readFile(secret, 'utf8'), 'synthetic secret');
});

test('Windows timeout reaps the full job before returning to workspace cleanup', windows, async t => {
  const f = await fixture(t); if (!f) return; let pid;
  const code = `const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],
    {detached:true,stdio:'ignore',env:{SystemRoot:process.env.SystemRoot}});console.log(c.pid);c.unref();setInterval(()=>{},1000);`;
  await assert.rejects(f.session.execute(f.nodePath, ['-e', code], { cwd: f.workspaceRoot, timeoutMs: 10000,
    onLine: line => { if (/^\d+$/.test(line.trim())) pid = Number(line.trim()); } }), /超时/);
  assert.ok(pid > 0); assert.deepEqual(await markedPids(f.session.runId), []);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('Windows offline phases cannot reach a host loopback fixture', windows, async t => {
  const f = await fixture(t); if (!f) return;
  const net = require('node:net'), server = net.createServer(socket => socket.end());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const code = `const c=require('node:net').connect(${server.address().port},'127.0.0.1');
    c.setTimeout(1000,()=>{console.log('denied');c.destroy()});c.on('error',()=>console.log('denied'));c.on('connect',()=>{console.log('allowed');c.destroy()});`;
  const result = await f.session.execute(f.nodePath, ['-e', code], { cwd: f.workspaceRoot, timeoutMs: 5000 });
  assert.equal(result.code, 0, result.stderr); assert.equal(result.stdout.trim(), 'denied');
});

test('Windows LPAC reaches its own broker and rejects another run pipe and capability', windows, async t => {
  const own = await fixture(t); if (!own) return;
  const other = await fixture(t); if (!other) return;
  let accepted = 0, foreign = 0;
  await own.session.broker(async () => { accepted++; return { code: 0, stdout: 'own broker', stderr: '' }; });
  await other.session.broker(async () => { foreign++; return { code: 0, stdout: 'other broker', stderr: '' }; });
  own.session.active = true; other.session.active = true;
  const code = `const net=require('node:net');
    const own=JSON.parse(process.env.AGENTRIX_LAB_BROKER),other=JSON.parse(process.argv[1]);
    function request(address,capability){return new Promise(resolve=>{
      const socket=net.connect(address);let body='',done=false;
      const finish=value=>{if(done)return;done=true;socket.destroy();resolve(value)};
      socket.setTimeout(2000,()=>finish({denied:true}));socket.on('error',()=>finish({denied:true}));
      socket.on('connect',()=>socket.write(JSON.stringify({capability,argv:['probe'],timeoutMs:1000})+'\\n'));
      socket.on('data',chunk=>{body+=chunk;if(body.includes('\\n')){try{finish(JSON.parse(body.trim()))}catch{finish({denied:true})}}});
      socket.on('end',()=>finish({denied:true}));
    })}
    (async()=>console.log(JSON.stringify({own:await request(own.address,own.capability),
      wrongCapability:await request(own.address,other.capability),foreignPipe:await request(other.address,own.capability),
      foreignPipeWithItsCapability:await request(other.address,other.capability)})))().catch(()=>process.exit(1));`;
  const result = await own.session.execute(own.nodePath, ['-e', code, other.session.brokerEnvironment],
    { cwd: own.workspaceRoot, timeoutMs: 15000 });
  assert.equal(result.code, 0, result.stderr);
  const replies = JSON.parse(result.stdout);
  assert.deepEqual(replies.own, { code: 0, stdout: 'own broker', stderr: '' });
  assert.equal(replies.wrongCapability.code, 125);
  assert.deepEqual(replies.foreignPipe, { denied: true });
  assert.deepEqual(replies.foreignPipeWithItsCapability, { denied: true });
  assert.equal(accepted, 1); assert.equal(foreign, 0);
});

test('Windows root leases serialize cleanup after launcher exit and remove inherited and protected grants', windows, async t => {
  const f = await fixture(t); if (!f) return;
  const tree = path.join(f.workspaceRoot, 'dependencies'), special = path.join(tree, 'protected-acl');
  await fs.mkdir(special, { recursive: true });
  const aclTool = path.join(process.env.SystemRoot, 'System32', 'icacls.exe');
  const protect = await command(aclTool, [special, '/inheritance:d']); assert.equal(protect.code, 0, protect.stderr);
  for (let folder = 0; folder < 32; folder++) {
    const directory = path.join(tree, String(folder)); await fs.mkdir(directory);
    await Promise.all(Array.from({ length: 32 }, (_, i) => fs.writeFile(path.join(directory, i + '.txt'), 'fixture')));
  }
  const inherited = path.join(tree, '0', '0.txt'), protectedFile = path.join(special, 'value.txt');
  await fs.writeFile(protectedFile, 'protected ACL');
  const control = new AbortController(); t.after(() => control.abort());
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  const running = f.session.execute(f.nodePath, ['-e', `const fs=require('node:fs');
    fs.appendFileSync(process.argv[1],' writable');console.log('ready');setInterval(()=>{},1000);`, protectedFile],
  { cwd: f.workspaceRoot, signal: control.signal, timeoutMs: 15000,
    onLine: line => { if (line === 'ready') ready(); } });
  const stopped = assert.rejects(running, { name: 'AbortError' });
  await Promise.race([started, running.then(() => assert.fail('worker exited before readiness'))]);
  const [name] = (await fs.readdir(f.session.privateDirectory)).filter(name => name.endsWith('.acl.json'));
  const lease = JSON.parse(await fs.readFile(path.join(f.session.privateDirectory, name), 'utf8'));
  assert.ok(lease.launcherPid > 0); assert.ok(lease.roots.includes(f.workspaceRoot));
  assert.ok(lease.paths.length < 40, 'file count must not determine the lease size');
  assert.ok(!lease.paths.includes(inherited));
  let cleaned = false;
  const cleaning = Promise.all([backend.release(f.session.privateDirectory), backend.release(f.session.privateDirectory)])
    .then(() => { cleaned = true; });
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(cleaned, false, 'a live launcher retains its lease');
  control.abort();
  await Promise.all([stopped, cleaning]);
  assert.deepEqual(await markedPids(f.session.runId), []);
  assert.ok(!(await fs.readdir(f.session.privateDirectory)).some(name => name.endsWith('.acl.json')));
  for (const [index, file] of [f.workspaceRoot, inherited, protectedFile].entries()) {
    const snapshot = path.join(f.root, 'acl-' + index + '.txt');
    const saved = await command(aclTool, [file, '/save', snapshot]); assert.equal(saved.code, 0, saved.stderr);
    assert.ok(!(await fs.readFile(snapshot, 'utf16le')).includes(lease.sid), 'cleanup removes explicit and inherited run ACEs');
  }
  assert.match(await fs.readFile(protectedFile, 'utf8'), /writable/);
});

test('Windows recovery still removes grants from legacy per-file leases', windows, async t => {
  const f = await fixture(t); if (!f) return;
  const file = path.join(f.root, 'legacy.txt'), sid = 'S-1-15-2-1234-2345-3456-4567-5678-6789-7890', job = randomUUID();
  await fs.writeFile(file, 'legacy');
  const aclTool = path.join(process.env.SystemRoot, 'System32', 'icacls.exe');
  const grant = await command(aclTool, [file, '/grant', '*' + sid + ':(R)']); assert.equal(grant.code, 0, grant.stderr);
  await fs.writeFile(path.join(f.session.privateDirectory, job + '.acl.json'), JSON.stringify({ sid, profile: '', paths: [file] }));
  await backend.release(f.session.privateDirectory, job);
  assert.equal(await fs.stat(path.join(f.session.privateDirectory, job + '.acl.json')).catch(() => null), null);
  const snapshot = path.join(f.root, 'legacy-acl.txt');
  const saved = await command(aclTool, [file, '/save', snapshot]); assert.equal(saved.code, 0, saved.stderr);
  assert.ok(!(await fs.readFile(snapshot, 'utf16le')).includes(sid));
});

test('UAC starts Windows PowerShell and stages a verified admin-only helper with a fixed operation', () => {
  const binary = "C:\\isolated 'fixture\\launcher.exe", hash = 'a'.repeat(64), command = prepCommand(binary, hash);
  assert.equal(command.file, path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'));
  assert.equal(command.options.windowsHide, true);
  assert.equal(command.options.shell, undefined);
  assert.deepEqual(Object.keys(command.options.env).sort(), ['PATH', 'SystemRoot']);
  const outer = Buffer.from(command.args.at(-1), 'base64').toString('utf16le');
  const bootstrap = Buffer.from(/-EncodedCommand ([A-Za-z0-9+/=]+)'/.exec(outer)[1], 'base64').toString('utf16le');
  assert.match(outer, /\$start.Verb='runas'/);
  assert.match(outer, /\[Environment\]::SystemDirectory/);
  assert.ok(!outer.includes(binary));
  assert.ok(bootstrap.includes(Buffer.from(binary).toString('base64')));
  assert.equal((bootstrap.match(new RegExp(hash, 'g')) || []).length, 2, 'verify the input and the protected copy');
  assert.match(bootstrap, /O:BAG:SYD:P\(A;OICI;FA;;;SY\)\(A;OICI;FA;;;BA\)/);
  assert.match(bootstrap, /\[Environment\]::SystemDirectory,'AgentrixLabPrep-'/);
  assert.match(bootstrap, /\$start.Arguments='prepare-host'/);
  assert.match(bootstrap, /\$start.EnvironmentVariables.Clear\(\)/);
  assert.doesNotMatch(nativeSource, /runas|ElevateHost/);
  assert.equal(Buffer.from(prepCommand(binary, hash, { elevate: false }).args.at(-1), 'base64').toString('utf16le'), bootstrap);
  assert.throws(() => prepCommand(binary, 'not a hash'), { infrastructure: true });
});

test('preparation PowerShell parses without executing either bootstrap', { skip: process.platform !== 'win32' }, () => {
  const prepare = prepCommand('C:\\fixture\\launcher.exe', 'b'.repeat(64));
  const outer = Buffer.from(prepare.args.at(-1), 'base64').toString('utf16le');
  const bootstrap = Buffer.from(/-EncodedCommand ([A-Za-z0-9+/=]+)'/.exec(outer)[1], 'base64').toString('utf16le');
  const parse = "$text=[Console]::In.ReadToEnd();$tokens=$null;$errors=$null;$null=[System.Management.Automation.Language.Parser]::ParseInput($text,[ref]$tokens,[ref]$errors);if($errors.Count){[Console]::Error.WriteLine(($errors.Message -join '; '));exit 1}";
  for (const source of [outer, bootstrap]) require('node:child_process').execFileSync(prepare.file,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', parse], { ...prepare.options, input: source, timeout: 30000 });
});

test('prepared hosts are verified on every admission without requesting elevation', async () => {
  const ensure = createHostPreparation(); let checks = 0;
  const deps = { verify: async () => { checks++; return { ready: true, elevated: false }; },
    elevate: async () => assert.fail('UAC is forbidden'), prepare: async () => assert.fail('already prepared') };
  await ensure(deps); await ensure(deps);
  assert.equal(checks, 2);
});

test('concurrent first admissions share one elevation and recheck actual permissions', async () => {
  const ensure = createHostPreparation({ testing: false }); let ready = false, prompts = 0, checks = 0;
  const deps = { verify: async () => { checks++; return { ready, elevated: false }; },
    elevate: async () => { prompts++; ready = true; } };
  await Promise.all([ensure(deps), ensure(deps), ensure(deps)]);
  assert.equal(prompts, 1); assert.equal(checks, 6);
  ready = false;
  await assert.rejects(ensure(deps), { message: ISOLATION_ERROR, infrastructure: true });
  assert.equal(prompts, 1);
});

test('UAC refusal and unsuccessful preparation fail closed without repeated prompts', async () => {
  for (const declines of [true, false]) {
    const ensure = createHostPreparation({ testing: false }); let prompts = 0;
    const deps = { verify: async () => ({ ready: false, elevated: false }), elevate: async () => {
      prompts++; if (declines) throw new Error('cancelled');
    } };
    await assert.rejects(ensure(deps), { message: ISOLATION_ERROR, infrastructure: true });
    await assert.rejects(ensure(deps), { message: ISOLATION_ERROR });
    assert.equal(prompts, 1);
  }
});

test('test preparation requires both explicit consent and an already elevated runner and never requests UAC', async () => {
  for (const consent of [false, true]) for (const elevated of [false, true]) {
    let ready = false, prepared = 0;
    const deps = { verify: async () => ({ ready, elevated }), prompt: true,
      elevate: async () => assert.fail('UAC is forbidden'), prepare: async () => { prepared++; ready = true; } };
    const ensure = createHostPreparation({ testing: true, consent });
    if (consent && elevated) await ensure(deps);
    else await assert.rejects(ensure(deps), { message: ISOLATION_ERROR });
    assert.equal(prepared, consent && elevated ? 1 : 0);
  }
});

test('an unreadable permission state never requests elevation or admits a worker', async () => {
  const ensure = createHostPreparation();
  await assert.rejects(ensure({ verify: async () => { throw new Error('access denied'); },
    elevate: async () => assert.fail('no unverified elevation') }), { message: ISOLATION_ERROR });
});

for (const code of ['EPERM', 'EEXIST']) for (const matches of [false, true]) {
  test(`launcher ${code} collision ${matches ? 'accepts identical compiled bytes' : 'rejects a planted executable'}`, async t => {
    const f = await mockedBackend(t, async (from, to, compiled) => {
      await fs.writeFile(to, matches ? compiled : 'planted executable');
      throw Object.assign(new Error('held open'), { code });
    });
    if (matches) assert.deepEqual(await fs.readFile(await f.sandbox.initialize({ directory: f.root })), f.compiled);
    else {
      await assert.rejects(f.sandbox.initialize({ directory: f.root }), { infrastructure: true });
      assert.equal(f.sandbox.executable, undefined);
    }
  });
}

test('a modified cached launcher is recompiled and cleanup has no short native timeout', async t => {
  const f = await mockedBackend(t), binary = await f.sandbox.initialize({ directory: f.root });
  await f.sandbox.initialize({ directory: f.root });
  assert.equal(f.calls.length, 1);
  await fs.writeFile(binary, 'replaced between admissions');
  await f.sandbox.initialize({ directory: f.root });
  assert.equal(f.calls.length, 2);
  assert.deepEqual(await fs.readFile(binary), f.compiled);
  const runId = randomUUID(), job = randomUUID(), directory = path.join(f.root, runId);
  await fs.mkdir(directory); await fs.writeFile(path.join(directory, job + '.acl.json'), '{}');
  f.sandbox.register(runId, directory);
  await f.sandbox.killMarked(runId, { job });
  assert.deepEqual(Array.from(f.calls.at(-2).args), ['kill', runId, job]);
  assert.equal(f.calls.at(-1).args[0], 'clean');
  assert.equal(f.calls.at(-1).options.timeout, 0);
});

test('Windows lab stop signals its guardian before job recovery and never taskkills the launcher', async () => {
  const calls = [], execFile = () => assert.fail('taskkill must not race the launcher');
  execFile[promisify.custom] = execFile;
  const { stopTree } = await loadModule('process.cjs', {
    'node:child_process': { execFile }, './sandbox-win32.cjs': { killMarked: async () => { calls.push('recover'); } },
  }, { process: { platform: 'win32' } });
  await stopTree({ pid: 1, labRun: randomUUID(), labJob: randomUUID(), connected: true,
    send: (message, callback) => { calls.push(message.type); callback(); }, kill: () => assert.fail('no forced launcher kill') });
  assert.deepEqual(calls, ['lab-stop', 'recover']);
});

test('the Windows guardian keeps a control pipe open and cancellation sends EOF without killing its child', async () => {
  const messages = [];
  const host = Object.assign(new EventEmitter(), {
    argv: ['node', 'guardian', 'config'], env: {}, stdout: new PassThrough(), stderr: new PassThrough(), channel: { unref() {} },
    connected: true, send: (message, callback) => { messages.push(message); callback(); },
  });
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => assert.fail('launcher must finish'),
  });
  const config = { windows: { executable: 'not executed' }, executor: 'executor', cwd: 'workspace' };
  await loadModule('sandbox-win32-host.cjs', {
    'node:fs': { readFileSync: () => JSON.stringify(config) }, 'node:child_process': { spawn: () => child },
  }, { process: host });
  assert.equal(child.stdin.writableEnded, false);
  const frame = JSON.parse(child.stdin.read().toString());
  assert.equal(frame.cwd, 'workspace');
  let stderr = ''; host.stderr.on('data', chunk => { stderr += chunk; });
  child.stderr.emit('data', 'short error\n');
  assert.equal(stderr, 'short error\n', 'short stderr must not wait for another chunk or process exit');
  const marker = JSON.parse(frame.input).config.startMarker;
  child.stderr.emit('data', marker.slice(0, 9));
  assert.equal(stderr, 'short error\n');
  child.stderr.emit('data', marker.slice(9) + 'next stage\n');
  assert.equal(stderr, 'short error\nnext stage\n');
  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{ type: 'lab-model-started' }]);
  host.emit('message', { type: 'lab-stop' });
  assert.equal(child.stdin.writableEnded, true);
  host.emit('disconnect');
  for (const stream of [host.stdout, host.stderr, child.stdin, child.stdout, child.stderr]) stream.destroy();
});

test('Windows diagnostics are opt-in, bounded and accept only fixed events with numeric counters', async () => {
  const printed = [];
  const { windowsDiagnostics } = await loadModule('process.cjs', {}, {
    process: { platform: 'win32', env: { NODE_TEST_CONTEXT: 'child-v8', AGENTRIX_LAB_TEST_PREPARE_HOST: '1' } },
    console: { error: line => printed.push(line) },
  });
  const trace = windowsDiagnostics();
  trace.feed('[lab-win32] stage frame read ms=1\r'); trace.feed('\n');
  trace.feed('[lab-win32] private-path=C:\\private\\secret\n[lab-win32] unrecognized secret\nworker stderr\n');
  assert.deepEqual(printed, ['[lab-win32] stage frame read ms=1']);
  for (let i = 0; i < 200; i++) trace.feed(`[lab-win32] frame chars=${i} ms=${i}\n`);
  assert.equal(printed.length, 128);
  assert.equal(trace.summary().split('\n').length, 8);
  assert.match(trace.summary(), /frame chars=199/);
  assert.doesNotMatch(trace.summary(), /secret|private/);
  for (const env of [{ NODE_TEST_CONTEXT: 'child-v8' }, { AGENTRIX_LAB_TEST_PREPARE_HOST: '1' }]) {
    const disabled = await loadModule('process.cjs', {}, { process: { platform: 'win32', env } });
    assert.equal(disabled.windowsDiagnostics(), null);
  }
});

test('the Windows executor consumes a UTF-8 payload, closes stdin and reports every transport stage without LPAC', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lab-executor-transport-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const value = '\u6d4b\u8bd5-\u03bb';
  const payload = JSON.stringify({ config: { cwd: root, isolatedEnvironment: {}, padding: 'x'.repeat(32768),
    command: { file: process.execPath, args: ['-e',
      "console.log(JSON.stringify({value:process.argv[1],diagnostics:process.env.AGENTRIX_LAB_DIAGNOSTICS||null}))", value] } },
  bootstrap: null, modules: null });
  const executor = path.join(__dirname, '../electron/features/lab/sandbox-win32-executor.cjs');
  const result = await command(process.execPath, [executor], { cwd: root, stdin: payload, timeoutMs: 10000,
    env: { ...process.env, AGENTRIX_LAB_DIAGNOSTICS: '1' } });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { value, diagnostics: null });
  for (const stage of ['entry', 'input wait', 'input first bytes=', 'input end chars=', 'payload parsed',
    'child spawned pid=', 'child exit code=0', 'complete code=0']) assert.ok(result.stderr.includes('[lab-win32] executor ' + stage), stage);
  assert.ok(!result.stderr.includes(root)); assert.ok(!result.stderr.includes(value));
  const malformed = await command(process.execPath, [executor], { cwd: root, stdin: 'invalid JSON', timeoutMs: 5000 });
  assert.equal(malformed.code, 1); assert.match(malformed.stderr, /Invalid trusted dispatch payload/);
});
