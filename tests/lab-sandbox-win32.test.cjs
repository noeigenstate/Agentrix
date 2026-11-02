const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { LabSession } = require('../electron/features/lab/session.cjs');
const backend = require('../electron/features/lab/sandbox-win32.cjs');
const { markedPids, command } = require('../electron/features/lab/process.cjs');
const { prepCommand, createHostPreparation, ISOLATION_ERROR, nativeSource } = require('../electron/features/lab/sandbox-win32-preparation.cjs');

const windows = { timeout: 40000, skip: process.platform !== 'win32' ? 'Windows LPAC and Job Objects are required' : false };

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lab-win32-')));
  const labRoot = path.join(root, 'lab'), workspaceRoot = path.join(labRoot, 'workspaces');
  const install = path.join(root, 'runtime-node'), nodePath = path.join(install, 'node.exe');
  await fs.mkdir(workspaceRoot, { recursive: true }); await fs.mkdir(install);
  await fs.copyFile(process.execPath, nodePath);
  const session = new LabSession({
    labRoot, workspaceRoot, directory: workspaceRoot, nodePath, runId: randomUUID(), protectedPaths: [path.join(root, 'protected')],
    hostPrompt: false,
    env: { SystemRoot: process.env.SystemRoot, PATH: install + path.delimiter + path.join(process.env.SystemRoot, 'System32'),
      CODEX_HOME: path.join(root, 'fixture-codex'), CLAUDE_CONFIG_DIR: path.join(root, 'fixture-claude') },
  });
  t.after(async () => { await session.close(); await fs.rm(root, { recursive: true, force: true }); });
  const state = await backend.hostState({ directory: labRoot });
  if (!state.elevated && !state.ready) {
    t.skip('Windows host is unprepared and the test process is not elevated; tests never request UAC.');
    return null;
  }
  await fs.mkdir(path.join(root, 'protected')); await fs.writeFile(path.join(root, 'protected', 'secret'), 'synthetic secret');
  await session.start();
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
  await assert.rejects(f.session.execute(f.nodePath, ['-e', code], { cwd: f.workspaceRoot, timeoutMs: 3000,
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

test('host preparation uses a fixed operation and no task-supplied arguments', () => {
  const command = prepCommand('C:\\isolated fixture\\launcher.exe');
  assert.deepEqual(command.args, ['elevate-host']);
  assert.equal(command.options.windowsHide, true);
  assert.equal(command.options.shell, undefined);
  assert.match(nativeSource, /Arguments="prepare-host"/);
  assert.match(nativeSource, /Verb="runas",UseShellExecute=true/);
  assert.doesNotMatch(nativeSource, /Arguments=.*(?:plan\.|args\[)/);
});

test('prepared hosts are verified on every admission without requesting elevation', async () => {
  const ensure = createHostPreparation(); let checks = 0;
  const deps = { verify: async () => { checks++; return { ready: true, elevated: false }; },
    elevate: async () => assert.fail('UAC is forbidden'), prepare: async () => assert.fail('already prepared') };
  await ensure(deps); await ensure(deps);
  assert.equal(checks, 2);
});

test('concurrent first admissions share one elevation and recheck actual permissions', async () => {
  const ensure = createHostPreparation(); let ready = false, prompts = 0, checks = 0;
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
    const ensure = createHostPreparation(); let prompts = 0;
    const deps = { verify: async () => ({ ready: false, elevated: false }), elevate: async () => {
      prompts++; if (declines) throw new Error('cancelled');
    } };
    await assert.rejects(ensure(deps), { message: ISOLATION_ERROR, infrastructure: true });
    await assert.rejects(ensure(deps), { message: ISOLATION_ERROR });
    assert.equal(prompts, 1);
  }
});

test('test admissions never elevate; an already elevated runner prepares directly', async () => {
  let ready = false, prepared = 0;
  const deps = { verify: async () => ({ ready, elevated: false }), prompt: false,
    elevate: async () => assert.fail('UAC is forbidden'), prepare: async () => { prepared++; ready = true; } };
  await assert.rejects(createHostPreparation()(deps), { message: ISOLATION_ERROR });
  assert.equal(prepared, 0);
  await createHostPreparation()({ ...deps, verify: async () => ({ ready, elevated: true }) });
  assert.equal(prepared, 1);
});

test('an unreadable permission state never requests elevation or admits a worker', async () => {
  const ensure = createHostPreparation();
  await assert.rejects(ensure({ verify: async () => { throw new Error('access denied'); },
    elevate: async () => assert.fail('no unverified elevation') }), { message: ISOLATION_ERROR });
});
