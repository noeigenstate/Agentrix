const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { LabSession } = require('../electron/features/lab/session.cjs');
const backend = require('../electron/features/lab/sandbox-win32.cjs');
const { markedPids, killMarked } = require('../electron/features/lab/process.cjs');

const windows = { timeout: 20000, skip: process.platform !== 'win32' ? 'Windows LPAC and Job Objects are required' : false };

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lab-win32-')));
  const labRoot = path.join(root, 'lab'), workspaceRoot = path.join(labRoot, 'workspaces');
  const install = path.join(root, 'runtime-node'), nodePath = path.join(install, 'node.exe');
  await fs.mkdir(workspaceRoot, { recursive: true }); await fs.mkdir(install);
  await fs.copyFile(process.execPath, nodePath);
  const session = new LabSession({
    labRoot, workspaceRoot, directory: workspaceRoot, nodePath, runId: randomUUID(), protectedPaths: [path.join(root, 'protected')],
    env: { SystemRoot: process.env.SystemRoot, PATH: install + path.delimiter + path.join(process.env.SystemRoot, 'System32'),
      CODEX_HOME: path.join(root, 'fixture-codex'), CLAUDE_CONFIG_DIR: path.join(root, 'fixture-claude') },
  });
  t.after(async () => { await session.close(); await fs.rm(root, { recursive: true, force: true }); });
  await fs.mkdir(path.join(root, 'protected')); await fs.writeFile(path.join(root, 'protected', 'secret'), 'synthetic secret');
  await session.start();
  return { root, labRoot, workspaceRoot, session, install, nodePath };
}

test('Windows LPAC permits the workspace, denies protected reads and outside writes', windows, async t => {
  const f = await fixture(t), outside = path.join(f.root, 'outside.txt');
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
  const script = `const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],
    {detached:true,stdio:'ignore',env:{SystemRoot:process.env.SystemRoot}});console.log(c.pid);c.unref();`;
  const result = await f.session.execute(f.nodePath, ['-e', script], { cwd: f.workspaceRoot });
  assert.equal(result.code, 0, result.stderr);
  const pid = Number(result.stdout.trim()); assert.ok(pid > 0);
  assert.deepEqual(await markedPids(f.session.runId), []);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('Windows runtime discovery grants individual install folders without granting their parent', windows, async t => {
  const f = await fixture(t), folders = [];
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
  await assert.rejects(backend.runtimeRoots({ nodePath: f.nodePath, env: f.session.env,
    protectedPaths: [f.install] }), /overlaps a protected path/);
});
