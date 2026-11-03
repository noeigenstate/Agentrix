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
const { prepCommand, cleanPowerShellCommand, SOURCE_SHA256, createHostPreparation, ISOLATION_ERROR, nativeSource } = require('../electron/features/lab/sandbox-win32-preparation.cjs');

const windows = { timeout: 45000, skip: process.platform !== 'win32' ? 'Windows LPAC and Job Objects are required' :
  process.env.AGENTRIX_LAB_TEST_PREPARE_HOST !== '1' ? 'Windows sandbox tests require explicit AGENTRIX_LAB_TEST_PREPARE_HOST=1 consent on the elevated CI runner.' :
    process.env.CI !== 'true' ? 'Real Windows LPAC and Job tests run only on the elevated CI runner.' : false };

function preparationScripts(outer) {
  const args = Buffer.from(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(outer)[1], 'base64').toString();
  const loader = Buffer.from(/-EncodedCommand ([A-Za-z0-9+/=]+)/.exec(args)[1], 'base64').toString('utf16le');
  const packed = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(loader)[1];
  return { args, loader, bootstrap: require('node:zlib').gunzipSync(Buffer.from(packed, 'base64')).toString() };
}

async function loadModule(name, overrides = {}, globals = {}) {
  const file = path.join(__dirname, '../electron/features/lab', name), localRequire = createRequire(file), module = { exports: {} };
  vm.runInNewContext(await fs.readFile(file, 'utf8'), {
    module, process, Buffer, console, setTimeout, clearTimeout, AbortSignal, AbortController, queueMicrotask, __dirname: path.dirname(file),
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

async function runtimeAclSnapshot(fixture, name) {
  const target = path.join(fixture.root, name + '.acl');
  const result = await command(path.join(process.env.SystemRoot, 'System32', 'icacls.exe'),
    [fixture.install, '/save', target, '/t'], { timeoutMs: 5000 });
  assert.equal(result.code, 0, result.stderr);
  return fs.readFile(target, 'utf16le');
}

test('Windows LPAC permits the workspace, denies protected reads and outside writes', windows, async t => {
  const f = await fixture(t); if (!f) return;
  const before = await runtimeAclSnapshot(f, 'runtime-before');
  const outside = path.join(f.root, 'outside.txt');
  await fs.writeFile(outside, 'unchanged');
  const script = `const fs=require('node:fs');
    let read=false,write=false;try{fs.readFileSync(process.argv[1]);read=true}catch{}
    try{fs.writeFileSync(process.argv[2],'changed');write=true}catch{}
    fs.writeFileSync('allowed.txt','ok');console.log(JSON.stringify({read,write}));`;
  const result = await f.session.execute(f.nodePath, ['-e', script, path.join(f.root, 'protected', 'secret'), outside], { cwd: f.workspaceRoot, timeoutMs: 10000 });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { read: false, write: false });
  assert.equal(await runtimeAclSnapshot(f, 'runtime-after'), before, 'normal cleanup restores the owner runtime ACLs');
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

function brokerProbeScript() {
  return `const net=require('node:net'),diagnostics=[],waiting=new Map(),started=Date.now();let next=0,events=0;
    const own=JSON.parse(process.env.AGENTRIX_LAB_BROKER),other=JSON.parse(process.argv[1]),rpc=JSON.parse(process.argv[2]);
    function trace(request,stage,code='OK'){
      if(events++<224)console.log('[lab-broker] '+JSON.stringify({id:request.id,role:request.role,stage,
        phase:request.phase,code,ms:Date.now()-started}));
    }
    const watchdog=setTimeout(()=>{
      for(const request of waiting.values())trace(request,'wait','ETIMEDOUT');
      console.log('[lab-broker] '+JSON.stringify({stage:'deadline',pending:waiting.size,ms:Date.now()-started}));
      process.exit(1);
    },8000);watchdog.unref();
    function request(address,capability,role){return new Promise(resolve=>{
      const state={id:++next,role,phase:'connecting'};waiting.set(state.id,state);trace(state,'queue');
      const socket=net.connect(address);let body='',done=false,connected=false,response;
      const finish=(value,code='OK')=>{
        if(done)return;done=true;clearTimeout(timer);response=value;
        if(code!=='OK')diagnostics.push({id:state.id,role,stage:connected?'reply':'open',code,ms:Date.now()-started});
        trace(state,code==='OK'?'reply':'error',code);state.phase='closing';socket.destroy();
      };
      const timer=setTimeout(()=>finish({denied:true},'ETIMEDOUT'),2000);
      socket.on('error',error=>finish({denied:true},/^E[A-Z0-9_]{1,31}$/.test(error.code)?error.code:'EIO'));
      socket.on('connect',()=>{
        if(done)return;connected=true;state.phase='reply';trace(state,'start');
        socket.write(JSON.stringify({capability,argv:['probe'],timeoutMs:1000})+'\\n');
      });
      socket.on('data',chunk=>{body+=chunk;if(body.includes('\\n')){try{finish(JSON.parse(body.trim()))}catch{finish({denied:true},'EPROTO')}}});
      socket.on('end',()=>finish({denied:true},'EPIPE'));
      socket.once('close',()=>{
        if(!done)finish({denied:true},'EPIPE');waiting.delete(state.id);trace(state,'release');resolve(response);
      });
    })}
    (async()=>{const replies={own:await request(own.address,own.capability,'own'),repeated:[]};
      for(let i=0;i<8 && replies.own.code===0;i++)replies.repeated.push(await request(own.address,own.capability,'own'));
      replies.concurrent=await Promise.all(Array.from({length:24},()=>request(own.address,own.capability,'own-concurrent')));
      replies.wrongCapability=await request(own.address,other.capability,'wrong-capability');
      replies.foreignPipe=await request(other.address,own.capability,'foreign');
      replies.foreignPipeWithItsCapability=await request(other.address,other.capability,'foreign-known-capability');
      replies.rpc=await request(rpc.address,rpc.capability,'rpc');
      clearTimeout(watchdog);console.log(JSON.stringify({...replies,diagnostics}));})().catch(()=>process.exit(1));`;
}

test('Windows LPAC reaches its own broker and rejects another run pipe and capability', windows, async t => {
  const own = await fixture(t); if (!own) return;
  const other = await fixture(t); if (!other) return;
  let accepted = 0, foreign = 0;
  await own.session.broker(async () => { accepted++; return { code: 0, stdout: 'own broker', stderr: '' }; });
  await other.session.broker(async () => { foreign++; return { code: 0, stdout: 'other broker', stderr: '' }; });
  own.session.active = true; other.session.active = true;
  own.session.allowDelegation = false;
  const rpc = JSON.parse(await fs.readFile(path.join(own.session.tools, 'client.json'), 'utf8'));
  const result = await own.session.execute(own.nodePath, ['-e', brokerProbeScript(), other.session.brokerEnvironment, JSON.stringify(rpc)],
    { cwd: own.workspaceRoot, timeoutMs: 15000, onLine: line => {
      if (line.startsWith('[lab-broker] ') && line.length < 512) t.diagnostic(line);
    } });
  assert.equal(result.code, 0, result.stderr);
  const replies = JSON.parse(result.stdout.trim().split('\n').at(-1));
  for (const diagnostic of replies.diagnostics) t.diagnostic('[lab-win32] broker ' + JSON.stringify(diagnostic));
  const expected = { code: 0, stdout: 'own broker', stderr: '' };
  assert.deepEqual(replies.own, expected);
  assert.deepEqual(replies.repeated, Array(8).fill(expected));
  assert.deepEqual(replies.concurrent, Array(24).fill(expected));
  assert.equal(replies.wrongCapability.code, 125);
  assert.deepEqual(replies.foreignPipe, { denied: true });
  assert.deepEqual(replies.foreignPipeWithItsCapability, { denied: true });
  assert.equal(accepted, 33); assert.equal(foreign, 0);
  assert.equal(replies.rpc.exitCode, 1, 'RPC reaches its host handler and is denied by dispatch policy, not by pipe lookup');
  assert.match(replies.rpc.output, /Invalid lab dispatch request/);
  const { LabUsage } = require('../electron/features/lab/usage.cjs');
  const usage = new LabUsage({ directory: own.session.privateDirectory, socketDirectory: own.labRoot,
    runId: own.session.runId, project: { id: 'fixture' }, prices: {} });
  await usage.start(); own.session.usage = usage;
  try {
    own.session.trustedHelper = path.join(own.session.privateDirectory, 'trusted-fixture.json');
    await fs.writeFile(own.session.trustedHelper, JSON.stringify({ 'dispatch.cjs':
      "module.exports.run=async()=>{console.log('trusted helper reached');return 0;};" }));
    const metered = await own.session.root([], { cwd: own.workspaceRoot, network: false, timeoutMs: 10000 });
    assert.equal(metered.code, 0, metered.stderr);
    assert.match(metered.stdout, /trusted helper reached/, 'the trusted executor completed its real meter handshake');
    assert.equal(own.session.modelStarted, false);
  } finally { await usage.close(); }
});

test('Windows relay serves a child broker burst and closes every client without sandbox preparation',
  { skip: process.platform !== 'win32', timeout: 12000 }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lab-broker-burst-'));
    const session = new LabSession({ directory: root, labRoot: root, workspaceRoot: root, runId: randomUUID() });
    let relays, accepted = 0;
    t.after(async () => { await relays?.close(); await session.close(); await fs.rm(root, { recursive: true, force: true }); }, { timeout: 3000 });
    session.active = true; session.allowDelegation = false;
    await session.broker(async () => { accepted++; return { code: 0, stdout: 'own broker', stderr: '' }; });
    const net = require('node:net'), address = '\\\\.\\pipe\\LOCAL\\agentrix-lab-rpc-' + randomUUID();
    session.server = net.createServer(socket => session.connection(socket));
    await new Promise((resolve, reject) => { session.server.once('error', reject); session.server.listen(address, resolve); });
    const own = JSON.parse(session.brokerEnvironment), events = [], requests = [];
    relays = await require('../electron/features/lab/sandbox-win32-host.cjs').createPipeRelays([own.address, address],
      '\\\\.\\pipe\\Sessions\\0\\AppContainerNamedObjects\\S-1-15-2-1-2-3-4-5-6-7\\', () => {}, line => events.push(line));
    const result = await command(process.execPath, ['-e', brokerProbeScript(), JSON.stringify({
      address: '\\\\.\\pipe\\LOCAL\\agentrix-lab-missing-' + randomUUID(), capability: randomUUID(),
    }), JSON.stringify({ address: relays.pipes[1], capability: session.capability })], {
      timeoutMs: 10000, env: { ...process.env, AGENTRIX_LAB_BROKER: JSON.stringify({ ...own, address: relays.pipes[0] }) },
      onLine: line => { if (line.startsWith('[lab-broker] ')) requests.push(JSON.parse(line.slice(13))); },
    });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    const replies = JSON.parse(result.stdout.trim().split('\n').at(-1));
    assert.equal(accepted, 33);
    assert.deepEqual([replies.own, ...replies.repeated, ...replies.concurrent], Array(33).fill({ code: 0, stdout: 'own broker', stderr: '' }));
    assert.equal(replies.wrongCapability.code, 125); assert.equal(replies.rpc.exitCode, 1);
    assert.equal(requests.filter(request => request.stage === 'release').length, 37);
    assert.ok(events.some(line => /stage=release /.test(line)));
  });

test('Windows root leases serialize cleanup after launcher exit and remove inherited and protected grants', windows, async t => {
  const f = await fixture(t); if (!f) return;
  const before = await runtimeAclSnapshot(f, 'runtime-before');
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
  assert.equal(await runtimeAclSnapshot(f, 'runtime-after'), before, 'stopped-job recovery restores the owner runtime ACLs');
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

test('UAC scrubs CLR injection before PowerShell and compiles pinned source in an admin-only directory', () => {
  const input = "C:\\isolated 'fixture\\launcher.cs", hash = SOURCE_SHA256, command = prepCommand(input, hash);
  const source = require('../electron/features/lab/sandbox-win32-native.cjs') + nativeSource;
  assert.equal(require('node:crypto').createHash('sha256').update(source).digest('hex'), hash, 'the distributed source pin must match the shipped C#');
  assert.equal(command.file, path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'));
  assert.equal(command.options.windowsHide, true);
  assert.equal(command.options.shell, undefined);
  assert.deepEqual(Object.keys(command.options.env).sort(), ['PATH', 'SystemRoot']);
  const outer = command.args.at(-1);
  const { args, bootstrap } = preparationScripts(outer);
  assert.match(outer, /\$start.Verb='runas'/);
  assert.match(outer, /\[Environment\]::SystemDirectory/);
  assert.match(outer, /'cmd.exe'/);
  assert.match(args, /^\/d \/q \/v:off \/s \/c /);
  for (const prefix of ['COR_', 'CORECLR_', 'COMPlus_', 'DOTNET_', 'APPDOMAIN_']) assert.ok(args.includes(prefix));
  assert.ok(!outer.includes(input));
  assert.ok(bootstrap.includes(Buffer.from(input).toString('base64')));
  assert.equal((bootstrap.match(new RegExp(hash, 'g')) || []).length, 2, 'verify the input and the protected copy');
  assert.match(bootstrap, /O:BAG:SYD:P\(A;OICI;FA;;;SY\)\(A;OICI;FA;;;BA\)/);
  assert.match(bootstrap, /\[Environment\]::SystemDirectory,'AgentrixLabPrep-'/);
  assert.match(bootstrap, /\$start.Arguments='prepare-host'/);
  assert.match(bootstrap, /Framework64\\v4.0.30319\\csc.exe/);
  assert.match(bootstrap, /WriteAllBytes\(\$sourceCopy,\$bytes\)/);
  assert.match(bootstrap, /\$start.EnvironmentVariables.Clear\(\)/);
  assert.doesNotMatch(nativeSource, /runas|ElevateHost/);
  assert.equal(prepCommand(input, hash, { elevate: false }).args.join(' '), args);
  assert.throws(() => prepCommand(input, 'a'.repeat(64)), { infrastructure: true });
  assert.throws(() => prepCommand(input.replace('.cs', '.exe'), hash), { infrastructure: true });
});

test('native preparation entry removes synthetic profiler and CLR injection variables without elevation',
  { skip: process.platform !== 'win32', timeout: 10000 }, async () => {
    const probe = `[Console]::Write(@([Environment]::GetEnvironmentVariables('Process').Keys | Where-Object {$_ -match '^(COR_|CORECLR_|COMPlus_|DOTNET_|APPDOMAIN_|DEVPATH$)'}).Count)`;
    const call = cleanPowerShellCommand(probe);
    const result = await command(call.file, call.args, { ...call.options, timeoutMs: 5000, env: {
      ...call.options.env, COR_ENABLE_PROFILING: '1', COR_PROFILER_PATH: 'C:\\synthetic-missing.dll',
      COMPlus_Test: 'synthetic', CORECLR_ENABLE_PROFILING: '1', DOTNET_STARTUP_HOOKS: 'synthetic',
      APPDOMAIN_MANAGER_ASM: 'synthetic', DEVPATH: 'synthetic', 'COR_Test"&echo INJECTED&rem "': 'synthetic',
      ComSpec: 'C:\\synthetic-missing-cmd.exe', PSModulePath: 'C:\\synthetic-missing-modules',
    } });
    assert.equal(result.code, 0, result.stderr); assert.equal(result.stdout.trim(), '0');
    assert.doesNotMatch(result.stdout + result.stderr, /INJECTED/);
  });

test('preparation rejects a replaced source before staging or invoking a helper',
  { skip: process.platform !== 'win32', timeout: 15000 }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lab-preparation-tamper-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const input = path.join(root, 'replaced.cs'); await fs.writeFile(input, 'untrusted replacement, never executable');
    const call = prepCommand(input, SOURCE_SHA256, { elevate: false });
    const result = await command(call.file, call.args, { ...call.options, timeoutMs: 10000 });
    assert.notEqual(result.code, 0); assert.match(result.stderr, /Preparation payload changed/);
  });

test('pipe ACL passes the user and exact restricted SID checks without administrator or broad package grants',
  { skip: process.platform !== 'win32', timeout: 15000 }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lab-pipe-security-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    // This grants only a synthetic fixture pipe and checks restricted tokens in memory; no LPAC or host preparation.
    const probe = String.raw`
public partial class LabSandbox {
  [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)]static extern bool CreateHardLinkW(string file,string source,IntPtr security);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool CreateRestrictedToken(IntPtr token,uint flags,
    uint disableCount,[In] SidAttr[] disable,uint deleteCount,IntPtr deleted,uint restrictCount,[In] SidAttr[] restricted,out IntPtr result);
  [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
  [DllImport("advapi32.dll")] static extern bool IsTokenRestricted(IntPtr token);
  [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool WaitNamedPipeW(string pipe,uint timeout);
  static bool PipeAccess(IntPtr descriptor,IntPtr restriction) {
    IntPtr token=IntPtr.Zero,restricted=IntPtr.Zero,duplicate=IntPtr.Zero,admin=IntPtr.Zero,privileges=Marshal.AllocHGlobal(1024);
    try {
      Check(OpenProcessToken(Process.GetCurrentProcess().Handle,10,out token));
      Check(ConvertStringSidToSidW("S-1-5-32-544",out admin));
      if(!CreateRestrictedToken(token,0,1,new[]{new SidAttr { sid=admin }},0,IntPtr.Zero,
        1,new[]{new SidAttr { sid=restriction }},out restricted)) throw new Win32Exception(Marshal.GetLastWin32Error(),"restricted token "+Marshal.GetLastWin32Error());
      Check(DuplicateToken(restricted,2,out duplicate));
      var raw=new RawSecurityDescriptor(CopyDescriptor(descriptor),0);
      foreach(var ace in raw.DiscretionaryAcl.Cast<GenericAce>().OfType<QualifiedAce>()) ace.AccessMask=unchecked((int)FileMask(unchecked((uint)ace.AccessMask)));
      var bytes=new byte[raw.BinaryLength];raw.GetBinaryForm(bytes,0);
      IntPtr mapped=Marshal.AllocHGlobal(bytes.Length);Marshal.Copy(bytes,0,mapped,bytes.Length);
      uint length=1024,granted; bool allowed; var mapping=new Mapping {read=0x120089,write=0x120116,execute=0x1200a0,all=0x1f01ff};
      try { if(!AccessCheck(mapped,duplicate,0x12019f,ref mapping,privileges,ref length,out granted,out allowed)) throw new Win32Exception(Marshal.GetLastWin32Error(),"pipe access check"); return allowed; } finally { Marshal.FreeHGlobal(mapped); }
    } finally { if(token!=IntPtr.Zero)CloseHandle(token);if(restricted!=IntPtr.Zero)CloseHandle(restricted);
      if(duplicate!=IntPtr.Zero)CloseHandle(duplicate);if(admin!=IntPtr.Zero)LocalFree(admin);Marshal.FreeHGlobal(privileges); }
  }
  public static void TestPipeSecurity(string pipe) {
    IntPtr host;Check(OpenProcessToken(Process.GetCurrentProcess().Handle,8,out host));
    try { if(IsTokenRestricted(host)) { Console.Write("restricted-test-host");return; } } finally { CloseHandle(host); }
    IntPtr own,foreign; Check(ConvertStringSidToSidW("S-1-5-21-111-222-333-777",out own));
    Check(ConvertStringSidToSidW("S-1-5-21-111-222-333-778",out foreign));
    IntPtr descriptor=PipeDescriptor(own),old;uint size;
    try {
      PipeAcl(pipe,own);
      for(int i=0;i<8;i++) {
        Check(WaitNamedPipeW(pipe,2000));var acl=FileAcl(pipe);
        if(!Allows(acl,SidString(own),0x12019f) || Allows(acl,SidString(foreign),0x12019f)) throw new Exception("wrong installed pipe ACL");
      }
      // Model the elevated default owner: BA remains deny-only and the normal user has no write grant.
      string user=WindowsIdentity.GetCurrent().User.Value;
      Check(ConvertStringSecurityDescriptorToSecurityDescriptorW("O:BAG:SYD:(A;;GA;;;SY)(A;;GA;;;BA)(A;;GR;;;WD)(A;;0x12019f;;;"+SidString(own)+")",1,out old,out size));
      try { if(PipeAccess(old,own)) throw new Exception("old elevated ACL unexpectedly allowed writing"); } finally{LocalFree(old);}
      // AccessCheck needs owner/group even though the production call changes only DACL and label.
      Check(ConvertStringSecurityDescriptorToSecurityDescriptorW("O:"+user+"G:SY"+
        new RawSecurityDescriptor(CopyDescriptor(descriptor),0).GetSddlForm(AccessControlSections.Access|AccessControlSections.Audit),1,out old,out size));
      try { if(!PipeAccess(old,own) || PipeAccess(old,foreign)) throw new Exception("wrong pipe access"); } finally{LocalFree(old);}
      var raw=new RawSecurityDescriptor(CopyDescriptor(descriptor),0);
      if(raw.DiscretionaryAcl.Cast<GenericAce>().OfType<QualifiedAce>().Any(a=>new[]{"S-1-1-0","S-1-15-2-1","S-1-15-2-2","S-1-5-32-544"}.Contains(a.SecurityIdentifier.Value))) throw new Exception("broad grant");
      var label=new byte[raw.SystemAcl[0].BinaryLength];raw.SystemAcl[0].GetBinaryForm(label,0);
      if(label[0]!=17 || BitConverter.ToUInt32(label,4)!=1 || new SecurityIdentifier(label,8).Value!="S-1-16-4096") throw new Exception("wrong integrity");
      Console.Write("user-and-own-package-only");
    } finally { LocalFree(descriptor);LocalFree(own);LocalFree(foreign); }
  }
  static byte[] CopyDescriptor(IntPtr descriptor) { var bytes=new byte[GetSecurityDescriptorLength(descriptor)];Marshal.Copy(descriptor,bytes,0,bytes.Length);return bytes; }
  public static string TestPipeNamespace(string run,string job) { return PipeNamespace(run,job); }
  public static void TestScopedPipeAcl(string pipe,string run,string job) {
    IntPtr sid;CheckCode((uint)DeriveAppContainerSidFromAppContainerName(ProfileName(run,job),out sid));
    try { PipeAcl(pipe,sid);if(!Allows(FileAcl(pipe),SidString(sid),0x12019f))throw new Exception("scoped pipe grant missing"); }
    finally { FreeSid(sid); }
  }
  static RawSecurityDescriptor FixtureSecurity(string file) {
    IntPtr owner,group,dacl,sacl,descriptor;CheckCode(GetNamedSecurityInfoW(file,1,DACL,out owner,out group,out dacl,out sacl,out descriptor));
    try { return new RawSecurityDescriptor(CopySecurity(descriptor),0); } finally { LocalFree(descriptor); }
  }
  static string FixtureSnapshot(string file) {
    var security=FixtureSecurity(file);var acl=new byte[security.DiscretionaryAcl.BinaryLength];security.DiscretionaryAcl.GetBinaryForm(acl,0);
    return security.ControlFlags+":"+Convert.ToBase64String(acl);
  }
  static void FixtureSecurity(string file,RawSecurityDescriptor security) {
    var bytes=new byte[security.BinaryLength];security.GetBinaryForm(bytes,0);IntPtr descriptor=Marshal.AllocHGlobal(bytes.Length);
    Marshal.Copy(bytes,0,descriptor,bytes.Length);FileIdentity identity;IntPtr handle=CheckedFile(file,0x60080,out identity);
    try { Check(SetKernelObjectSecurity(handle,DACL,descriptor)); } finally { CloseHandle(handle);Marshal.FreeHGlobal(descriptor); }
  }
  static void FixturePrivateAcl(string root) {
    IntPtr arap;Check(ConvertStringSidToSidW(PackageSids[1],out arap));
    try { foreach(string file in Tree(root))Acl(file,arap,0,true); } finally { LocalFree(arap); }
  }
  public static void TestRuntimeSecurity(string root) {
    Directory.CreateDirectory(root);Directory.CreateDirectory(Path.Combine(root,"protected"));
    string stale=Path.Combine(root,"stale.txt"),guarded=Path.Combine(root,"protected","guarded.txt");
    File.WriteAllText(stale,"fixture");File.WriteAllText(guarded,"fixture");
    FixturePrivateAcl(root);
    var security=FixtureSecurity(stale);
    security.DiscretionaryAcl.InsertAce(security.DiscretionaryAcl.Count,new CommonAce(AceFlags.Inherited,
      AceQualifier.AccessAllowed,unchecked((int)RX),new SecurityIdentifier("S-1-5-21-111-222-333-999"),false,null));
    FixtureSecurity(stale,security);
    security=FixtureSecurity(guarded);security.SetFlags(security.ControlFlags|ControlFlags.DiscretionaryAclProtected);FixtureSecurity(guarded,security);
    var files=Tree(root).ToArray();var before=files.ToDictionary(file=>file,file=>FixtureSnapshot(file));
    IntPtr own,other;Check(ConvertStringSidToSidW("S-1-15-2-11-22-33-44-55-66-77",out own));
    Check(ConvertStringSidToSidW("S-1-15-2-11-22-33-44-55-66-78",out other));
    try {
      using(var lifetime=new RunLifetime()) {
        var grant=PrepareGrant(root,RX,false,lifetime);
        if(grant==null || grant.propagate || grant.objects.Count!=files.Length)throw new Exception("wrong owner runtime grant");
        string manifest=root+".acl.json";
        var records=new Dictionary<string,string[]> {{root,GrantObjects(grant)}};
        WriteLease(manifest,new Lease { sid=SidString(own),objects=records,roots=new string[0] });
        ApplyGrant(grant,own,lifetime);ApplyGrant(grant,other,lifetime);
        string added=Path.Combine(root,"new.txt");File.WriteAllText(added,"fixture");
        if(Allows(FileAcl(added),SidString(own),RX))throw new Exception("runtime grant propagated to a new file");
        // Recovery uses the real persisted write-ahead lease and must preserve another live run's ACEs.
        Clean(manifest);
        foreach(string file in files)if(!Allows(FileAcl(file),SidString(other),RX))throw new Exception("concurrent grant lost");
        WriteLease(manifest,new Lease { sid=SidString(other),objects=records,roots=new string[0] });Clean(manifest);
        foreach(string file in files)if(FixtureSnapshot(file)!=before[file])throw new Exception("owner ACL changed: "+Path.GetFileName(file));
        string lab=root+"-lab";Directory.CreateDirectory(lab);Check(CreateHardLinkW(Path.Combine(lab,"credential.txt"),stale,IntPtr.Zero));
        FixturePrivateAcl(lab);
        var linked=PrepareGrant(lab,RX,true,lifetime);
        if(linked.propagate)throw new Exception("a lab hard link allowed ACL propagation");
        WriteLease(manifest,new Lease { sid=SidString(own),roots=new[]{lab} });ApplyGrant(linked,own,lifetime);
        string fresh=Path.Combine(lab,"fresh.txt");File.WriteAllText(fresh,"fixture");
        if(!Allows(FileAcl(fresh),SidString(own),RX))throw new Exception("lab fallback did not admit a new file");
        Clean(manifest);
        if(FixtureSnapshot(stale)!=before[stale])throw new Exception("credential hard link changed the owner ACL");
        IntPtr arap;Check(ConvertStringSidToSidW(PackageSids[1],out arap));
        try { Acl(root,arap,RX,false,false,true,true); } finally { LocalFree(arap); }
        if(PrepareGrant(root,RX,false,lifetime)!=null)throw new Exception("pre-admitted runtime was walked");
      }
      Console.Write("owner-acls-restored;new-files-unchanged;concurrent-grant-preserved;hard-link-owner-acl-restored;arap-root-skipped");
    } finally { LocalFree(own);LocalFree(other); }
  }
}
class PipeSecurityProbe { public static void Main(string[] args) {
  if(args.Length==2 && args[0]=="runtime")LabSandbox.TestRuntimeSecurity(args[1]);
  else if(args.Length==4) LabSandbox.TestScopedPipeAcl(args[1],args[2],args[3]);
  else if(args.Length==3) Console.Write(LabSandbox.TestPipeNamespace(args[1],args[2])); else LabSandbox.TestPipeSecurity(args[0]);
} }
`;
    const input = path.join(root, 'probe.cs'), executable = path.join(root, 'probe.exe');
    await fs.writeFile(input, require('../electron/features/lab/sandbox-win32-native.cjs') + nativeSource + probe);
    const execute = promisify(require('node:child_process').execFile);
    await execute(path.join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
      ['/nologo', '/reference:System.Web.Extensions.dll', '/main:PipeSecurityProbe', '/out:' + executable, input], { timeout: 10000, windowsHide: true });
    const runtime = await execute(executable, ['runtime', path.join(root, 'owner-runtime')], { timeout: 5000, windowsHide: true });
    assert.equal(runtime.stdout, 'owner-acls-restored;new-files-unchanged;concurrent-grant-preserved;hard-link-owner-acl-restored;arap-root-skipped');
    const sockets = new Set(), address = '\\\\.\\pipe\\LOCAL\\agentrix-lab-security-' + randomUUID();
    const server = require('node:net').createServer(socket => {
      sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
      socket.resume(); socket.on('end', () => socket.end());
    });
    t.after(() => new Promise(resolve => { server.close(resolve); for (const socket of sockets) socket.destroy(); }), { timeout: 3000 });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(address, resolve); });
    const result = await execute(executable, [address], { timeout: 3000, windowsHide: true });
    if (result.stdout === 'restricted-test-host') return t.skip('A restricted test host cannot create independent restricting SID lists. Elevated CI exercises both access checks.');
    assert.equal(result.stdout, 'user-and-own-package-only');
    const runId = randomUUID(), job = randomUUID();
    const namespace = (await execute(executable, ['namespace', runId, job], { timeout: 3000, windowsHide: true })).stdout;
    assert.match(namespace, /^\\\\\.\\pipe\\Sessions\\\d+\\AppContainerNamedObjects\\S-1-15-2(?:-\d+){7}\\$/);
    assert.equal((await execute(executable, ['namespace', runId, job], { timeout: 3000, windowsHide: true })).stdout, namespace);
    assert.notEqual((await execute(executable, ['namespace', runId, randomUUID()], { timeout: 3000, windowsHide: true })).stdout, namespace);
    const { createPipeRelays } = require('../electron/features/lab/sandbox-win32-host.cjs');
    const local = ['rpc', 'meter', 'broker'].map(prefix => '\\\\.\\pipe\\LOCAL\\agentrix-lab-' + prefix + '-' + randomUUID());
    const servers = [], backendSockets = new Set();
    let heldRequests = 0, releaseHeld;
    const heldReply = new Promise(resolve => { releaseHeld = resolve; });
    t.after(() => releaseHeld());
    t.after(() => Promise.all(servers.map(server => new Promise(resolve => {
      server.close(resolve); for (const socket of backendSockets) socket.destroy();
    }))), { timeout: 3000 });
    for (const pipe of local) {
      const server = require('node:net').createServer({ allowHalfOpen: true }, socket => {
        backendSockets.add(socket); socket.on('close', () => backendSockets.delete(socket));
        socket.on('error', () => {}); let bytes = 0;
        socket.on('data', chunk => {
          bytes += chunk.length;
          if (bytes >= 131072) socket.end('reply:' + bytes + ':' + 'x'.repeat(262144));
          else if (chunk.toString() === 'hold\n') {
            heldRequests++;
            void heldReply.then(() => socket.end('{"code":0}\n'));
          } else if (chunk.toString() === 'reject\n') socket.end('{"code":125}\n');
          else if (chunk.includes(10)) setTimeout(() => socket.end('{"ok":true}\n'), 75);
        });
        socket.on('end', () => socket.end());
      });
      servers.push(server);
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(pipe, resolve); });
    }
    const previousInstances = process.env.NODE_PENDING_PIPE_INSTANCES, events = [];
    const relays = await createPipeRelays(local, namespace, () => {}, event => events.push(event));
    assert.equal(process.env.NODE_PENDING_PIPE_INSTANCES, previousInstances, 'the accept setting never leaks into workers');
    t.after(() => relays.close(), { timeout: 3000 });
    for (const pipe of relays.pipes) await execute(executable, ['grant', pipe, runId, job], { timeout: 3000, windowsHide: true });
    // Freeze JS accepts. With four instances, timed-out uv_connect requests keep this child alive for 30s.
    const burst = `const net=require('node:net');Promise.all(Array.from({length:24},()=>new Promise(resolve=>{
      const socket=net.connect(process.argv[1]);let done=false;
      const finish=value=>{if(done)return;done=true;clearTimeout(timer);socket.destroy();resolve(value)};
      const timer=setTimeout(()=>finish(false),1000);
      socket.once('connect',()=>finish(true));socket.once('error',()=>finish(false));
    }))).then(replies=>console.log(JSON.stringify({connected:replies.filter(Boolean).length})));`;
    const burstResult = require('node:child_process').execFileSync(process.execPath, ['-e', burst, relays.pipes[2]],
      { timeout: 3000, windowsHide: true, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(burstResult), { connected: 24 }, 'the child exits naturally after every connection closes');
    for (const [i, pipe] of relays.pipes.entries()) {
      assert.equal(pipe, namespace + local[i].split('\\').at(-1));
      for (let repeat = 0; repeat < 3; repeat++) {
        const reply = await new Promise((resolve, reject) => {
          const socket = require('node:net').connect(pipe); let body = '';
          socket.setTimeout(2000, () => socket.destroy(new Error('Scoped pipe relay timed out.')));
          socket.on('error', reject); socket.on('data', chunk => { body += chunk; });
          socket.on('end', () => resolve(body)); socket.write(Buffer.alloc(131072));
        });
        assert.equal(reply.length, 'reply:131072:'.length + 262144); assert.equal(reply.slice(0, 14), 'reply:131072:x');
      }
    }
    const { windowsMeterSink } = require('../electron/features/lab/sandbox-win32-executor.cjs');
    const send = windowsMeterSink({ pipeName: relays.pipes[1], sessionKey: 'synthetic-key', projectId: 'fixture' });
    assert.equal(await send({ type: 'lab-handshake' }), true, 'the delayed meter acknowledgement survives the namespace relay');
    const request = body => new Promise((resolve, reject) => {
      const socket = require('node:net').connect(relays.pipes[2]); let reply = '';
      socket.setTimeout(3000, () => socket.destroy(new Error('Queued pipe relay timed out.')));
      socket.on('error', reject);
      socket.on('data', chunk => {
        reply += chunk;
        if (reply.includes('\n')) { socket.destroy(); resolve(JSON.parse(reply)); }
      });
      socket.once('close', () => { if (!reply.includes('\n')) reject(new Error('Pipe relay closed before its reply.')); });
      socket.write(body);
    });
    // Match the LPAC broker client: destroy after its newline reply, without waiting for server EOF.
    for (let repeat = 0; repeat < 24; repeat++) assert.deepEqual(await request('reject\n'), { code: 125 });
    const queued = Promise.all(Array.from({ length: 24 }, () => request('hold\n')));
    // Attach immediately so an early socket failure remains a test failure, not an unhandled rejection.
    queued.catch(() => {});
    const waiting = Date.now();
    while (heldRequests < 8 && Date.now() - waiting < 2000) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(heldRequests, 8, 'eight requests occupy the relay slots');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(heldRequests, 8, 'excess clients wait without opening additional backend connections');
    releaseHeld();
    assert.deepEqual(await queued, Array.from({ length: 24 }, () => ({ code: 0 })));
    assert.equal(heldRequests, 24, 'every queued request eventually reaches the backend');
    assert.ok(events.some(event => /stage=queue .*queued=[1-9]/.test(event)));
    assert.ok(events.some(event => /stage=reply /.test(event)));
    assert.ok(events.some(event => /stage=release /.test(event)));
    assert.deepEqual(await request('reject\n'), { code: 125 }, 'the listener continues serving protocol refusals');
    const partial = '\\\\.\\pipe\\LOCAL\\agentrix-lab-partial-' + randomUUID();
    await assert.rejects(createPipeRelays([partial, local[2]], namespace), { code: 'EADDRINUSE' });
    await assert.rejects(new Promise((resolve, reject) => {
      const socket = require('node:net').connect(namespace + partial.split('\\').at(-1));
      socket.on('error', reject); socket.on('connect', () => { socket.destroy(); resolve(); });
    }), { code: 'ENOENT' }, 'a partial listener failure retires earlier namespace pipes');
    const held = require('node:net').connect(relays.pipes[0]); held.on('error', () => {});
    await new Promise(resolve => held.once('connect', resolve));
    const heldClosed = new Promise(resolve => held.once('close', resolve));
    await relays.close();
    await heldClosed;
    for (const pipe of relays.pipes) await assert.rejects(new Promise((resolve, reject) => {
      const socket = require('node:net').connect(pipe); socket.on('error', reject); socket.on('connect', () => { socket.destroy(); resolve(); });
    }), { code: 'ENOENT' });
  });

test('preparation PowerShell parses without executing either bootstrap', { skip: process.platform !== 'win32' }, () => {
  const prepare = prepCommand('C:\\fixture\\launcher.cs', SOURCE_SHA256);
  const outer = prepare.args.at(-1);
  const { bootstrap, loader } = preparationScripts(outer);
  const parse = "$text=[Console]::In.ReadToEnd();$tokens=$null;$errors=$null;$null=[System.Management.Automation.Language.Parser]::ParseInput($text,[ref]$tokens,[ref]$errors);if($errors.Count){[Console]::Error.WriteLine(($errors.Message -join '; '));exit 1}";
  for (const source of [outer, loader, bootstrap]) require('node:child_process').execFileSync(prepare.file,
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
  const messages = [], addresses = [], closed = [], calls = [];
  const host = Object.assign(new EventEmitter(), {
    argv: ['node', 'guardian', 'config'], env: {}, stdout: new PassThrough(), stderr: new PassThrough(), channel: { unref() {} },
    connected: true, send: (message, callback) => { messages.push(message); callback(); },
  });
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => assert.fail('launcher must finish'),
  });
  const namespace = '\\\\.\\pipe\\Sessions\\4\\AppContainerNamedObjects\\S-1-15-2-1-2-3-4-5-6-7\\';
  const pipes = ['rpc', 'meter', 'broker'].map(prefix => '\\\\.\\pipe\\LOCAL\\agentrix-lab-' + prefix + '-fixture');
  const config = { windows: { executable: 'not executed', runId: randomUUID(), job: randomUUID(), pipes }, executor: 'executor', cwd: 'workspace' };
  const guardian = await loadModule('sandbox-win32-host.cjs', {
    'node:fs': { readFileSync: () => JSON.stringify(config) }, 'node:child_process': {
      spawn: () => child, execFileSync: (file, args, options) => { calls.push({ file, args, options }); return namespace; },
    },
    'node:net': { createServer: () => Object.assign(new EventEmitter(), {
      listen(address, ready) { addresses.push(address); ready(); }, close(done) { closed.push(this); done(); },
    }) },
  }, { process: host });
  await guardian.runGuardian();
  assert.equal(child.stdin.writableEnded, false);
  const frame = JSON.parse(child.stdin.read().toString());
  assert.equal(frame.cwd, 'workspace');
  assert.deepEqual(frame.pipes, pipes.map(pipe => namespace + pipe.split('\\').at(-1)));
  assert.deepEqual(addresses, frame.pipes);
  assert.deepEqual(Array.from(calls[0].args), ['pipe-namespace', config.windows.runId, config.windows.job]);
  assert.equal(calls[0].options.timeout, 5000);
  assert.deepEqual(JSON.parse(frame.input).config.windows.pipes, pipes, 'worker-facing LOCAL addresses stay unchanged');
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
  child.emit('close', 0); await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed.length, 3);
  for (const stream of [host.stdout, host.stderr, child.stdin, child.stdout, child.stderr]) stream.destroy();
});

test('Windows namespace relays reject forged addresses and broad or foreign namespace formats', async () => {
  const { createPipeRelays } = require('../electron/features/lab/sandbox-win32-host.cjs');
  const namespace = '\\\\.\\pipe\\Sessions\\4\\AppContainerNamedObjects\\S-1-15-2-1-2-3-4-5-6-7\\';
  for (const pipes of [['tcp://host'], ['\\\\.\\pipe\\LOCAL\\agentrix-lab-x\\escape'], Array(9).fill('x'), ['same', 'same']]) {
    await assert.rejects(createPipeRelays(pipes, namespace), /Invalid Windows lab pipe/);
  }
  await assert.rejects(createPipeRelays([], '\\\\.\\pipe\\LOCAL\\'), /Invalid Windows lab pipe namespace/);
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
  trace.feed('[lab-win32] executor launch error phase=stdio code=EACCES errno=-4092\n');
  assert.match(trace.summary(), /phase=stdio code=EACCES errno=-4092/);
  trace.feed('[lab-win32] host pipes ready count=3\n[lab-win32] host pipe setup error phase=listen code=ENOENT errno=-4058\n');
  assert.match(trace.summary(), /host pipes ready count=3/);
  assert.match(trace.summary(), /phase=listen code=ENOENT errno=-4058/);
  const relay = '[lab-win32] host relay pipe=1 id=7 stage=wait phase=active code=OK active=8 queued=16 ms=2000';
  trace.feed(relay + '\n');
  assert.ok(printed.includes(relay)); assert.ok(trace.summary().includes(relay));
  trace.feed(relay.replace('code=OK', 'code=private-secret') + '\n');
  assert.doesNotMatch(trace.summary(), /private-secret/);
  const before = printed.length;
  for (let i = 0; i < 300; i++) trace.feed(relay + '\n');
  assert.equal(printed.length - before, 255, 'relay events have a separate bounded budget');
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
  if (process.platform === 'win32') for (const stage of ['stdio setup', 'stdio ready', 'spawn begin', 'spawn returned']) {
    assert.ok(result.stderr.includes('[lab-win32] executor ' + stage), stage);
  }
  assert.ok(!result.stderr.includes(root)); assert.ok(!result.stderr.includes(value));
  const malformed = await command(process.execPath, [executor], { cwd: root, stdin: 'invalid JSON', timeoutMs: 5000 });
  assert.equal(malformed.code, 1); assert.match(malformed.stderr, /Invalid trusted dispatch payload/);
  if (process.platform === 'win32') {
    const missing = await command(process.execPath, [executor], { cwd: root, timeoutMs: 5000,
      stdin: JSON.stringify({ config: { cwd: root, command: { file: path.join(root, 'missing.exe'), args: [] } } }),
      env: { ...process.env, AGENTRIX_LAB_DIAGNOSTICS: '1' } });
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /launch error phase=spawn code=ENOENT errno=-?\d+/);
    assert.ok(!missing.stderr.includes(root));
  }
});

test('LOCAL stdio preserves queued input, complete output, exit code and the synchronous child interface',
  { skip: process.platform !== 'win32', timeout: 15000 }, async t => {
    const cp = require('node:child_process'), nativeSpawn = cp.spawn;
    const { spawnWithLocalPipes } = require('../electron/features/lab/sandbox-win32-executor.cjs');
    let launches = 0;
    t.mock.method(cp, 'spawn', (file, args, options) => {
      launches++;
      assert.ok(options.stdio.every(value => value !== 'pipe' && value !== 'overlapped'));
      assert.equal(options.windowsHide, true); assert.equal(options.detached, false);
      return nativeSpawn(file, args, options);
    });
    const script = `let bytes=0;process.stdin.on('data',data=>bytes+=data.length);process.stdin.on('end',()=>{
      process.stdout.write('x'.repeat(262144)+':'+bytes);process.stderr.write('e'.repeat(131072));process.exitCode=7;});`;
    const child = spawnWithLocalPipes(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', spawns = 0;
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    child.once('spawn', () => { spawns++; assert.ok(child.pid > 0); });
    const result = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
    child.stdin.end(Buffer.alloc(262144, 97));
    assert.deepEqual(await result, { code: 7, signal: null });
    assert.equal(stdout, 'x'.repeat(262144) + ':262144'); assert.equal(stderr, 'e'.repeat(131072));
    assert.equal(child.exitCode, 7); assert.equal(spawns, 1); assert.equal(launches, 1);
  });

test('LOCAL stdio setup failures report a sanitized errno and close without attempting spawn', async () => {
  let launches = 0, listenersClosed = 0;
  const trace = [];
  const { spawnWithLocalPipes } = await loadModule('sandbox-win32-executor.cjs', {
    'node:net': { createServer: () => Object.assign(new EventEmitter(), {
      listen(address) {
        assert.match(address, /^\\\\\.\\pipe\\LOCAL\\agentrix-lab-stdio-/);
        queueMicrotask(() => this.emit('error', Object.assign(new Error('private path and secret'), { code: 'EACCES', errno: -4092 })));
      }, close() { listenersClosed++; },
    }) },
    'node:child_process': { spawn: () => { launches++; assert.fail('a failed pipe must prevent spawn'); } },
  }, { process: { platform: 'win32' } });
  const child = spawnWithLocalPipes('unused', [], { stdio: ['pipe', 'pipe', 'pipe'] }, line => trace.push(line));
  let failure;
  child.once('error', error => { failure = error; });
  await new Promise(resolve => child.once('close', resolve));
  assert.equal(failure.code, 'EACCES'); assert.equal(failure.errno, -4092); assert.equal(failure.phase, 'stdio');
  assert.doesNotMatch(failure.message, /private|secret/);
  assert.ok(trace.includes('launch error phase=stdio code=EACCES errno=-4092'));
  assert.equal(launches, 0); assert.ok(listenersClosed >= 3);
});

test('LOCAL stdio cancellation before connection admits no worker and closes every pending listener', async () => {
  let listenersClosed = 0;
  const { spawnWithLocalPipes } = await loadModule('sandbox-win32-executor.cjs', {
    'node:net': { createServer: () => Object.assign(new EventEmitter(), { listen() {}, close() { listenersClosed++; } }) },
    'node:child_process': { spawn: () => assert.fail('cancelled preparation must never spawn') },
  }, { process: { platform: 'win32' } });
  const child = spawnWithLocalPipes('unused', [], { stdio: 'pipe' });
  let failure; child.once('error', error => { failure = error; });
  const closed = new Promise(resolve => child.once('close', resolve));
  assert.equal(child.kill(), true); await closed;
  assert.equal(failure.code, 'ECANCELED'); assert.equal(child.killed, true); assert.ok(listenersClosed >= 3);
});

test('a missing executable reports the spawn phase immediately with LOCAL stdio',
  { skip: process.platform !== 'win32', timeout: 10000 }, async t => {
    const { spawnWithLocalPipes } = require('../electron/features/lab/sandbox-win32-executor.cjs');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lab-missing-executable-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const trace = [], child = spawnWithLocalPipes(path.join(root, 'missing.exe'), [], { stdio: 'pipe' }, line => trace.push(line));
    let failure; child.once('error', error => { failure = error; });
    await new Promise(resolve => child.once('close', resolve));
    assert.equal(failure.code, 'ENOENT'); assert.equal(failure.phase, 'spawn');
    assert.ok(trace.some(line => line.startsWith('launch error phase=spawn code=ENOENT errno=')));
    assert.ok(trace.every(line => !line.includes(root)));
  });
