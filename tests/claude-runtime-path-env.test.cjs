const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const exec = promisify(require('node:child_process').execFile);
const { mergePath, readStoredPath } = require('../electron/features/claude-runtime/path-env.cjs');

// The cases tests/path-refresh.test.cjs gives refresh-path.ps1, with the environment its fixture sets.
const cases = [
  { name: 'new tool', inherited: 'C:\\venv;C:\\System', Machine: 'C:\\System', User: 'C:\\Users\\测试 用户\\.mimocode\\bin' },
  { name: 'deduplicate', inherited: 'C:\\Tools\\;"C:\\With Space";C:\\;C:', Machine: 'c:\\TOOLS;C:/With Space;;C:\\', User: ' C:\\New ' },
  { name: 'expand known only', inherited: 'C:\\preferred', Machine: '%PG_PATH_ROOT%\\bin', User: '%AGENTRIX_UNDEFINED_PATH_TEST%\\bin' },
  { name: 'machine denied', inherited: 'C:\\keep', Machine: 'C:\\ignored', User: 'C:\\UserTool', fail: 'Machine' },
  { name: 'user denied', inherited: 'C:\\keep', Machine: 'C:\\MachineTool', User: 'C:\\ignored', fail: 'User' },
  { name: 'empty persistent paths', inherited: 'C:\\keep', Machine: '', User: null },
  { name: 'reread', inherited: 'C:\\keep', Machine: '', User: '', nextUser: 'C:\\Installed Later' },
  { name: 'path reference is bounded', inherited: 'C:\\keep', Machine: '', User: '%PATH%;C:\\new' },
  { name: 'quotes and slashes', inherited: '"D:\\Node js";D:/tools/', Machine: 'd:\\node js;D:\\TOOLS\\\\', User: '"D:\\x\\";D:\\' },
];
// What the Node merge gives a case: the stored scope its reader could not read is left out, as refresh-path.ps1 does.
const nodeMerge = (item, user = item.User) => mergePath(item.inherited, [item.fail === 'Machine' ? null : item.Machine, item.fail === 'User' ? null : user],
  { PG_PATH_ROOT: 'C:\\Known Root', PATH: item.inherited });

test('the Node PATH merge keeps the inherited PATH first and adds each stored folder it lacks once, as refresh-path.ps1 does', () => {
  assert.deepEqual(cases.slice(0, 8).map(item => nodeMerge(item)), ['C:\\venv;C:\\System;C:\\Users\\测试 用户\\.mimocode\\bin', 'C:\\Tools\\;"C:\\With Space";C:\\;C:;C:\\New',
    'C:\\preferred;C:\\Known Root\\bin;%AGENTRIX_UNDEFINED_PATH_TEST%\\bin', 'C:\\keep;C:\\UserTool', 'C:\\keep;C:\\MachineTool', 'C:\\keep', 'C:\\keep', 'C:\\keep;C:\\new']);
  assert.equal(nodeMerge(cases[6], cases[6].nextUser), 'C:\\keep;C:\\Installed Later');
  assert.equal(mergePath('', [], {}), '');
});

test('Windows: refresh-path.ps1 and the Node merge give the same PATH for the same stored values', { skip: process.platform !== 'win32' }, async t => {
  // The stored values come from the fixture's reader, as in tests/path-refresh.test.cjs: no registry is read or written.
  const { timeoutScale } = await import('../scripts/wait.mjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentrix-path-env-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'cases.json'); await fs.writeFile(file, JSON.stringify(cases));
  const { stdout } = await exec(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(__dirname, 'fixtures/path-refresh-check.ps1'), '-Script', path.join(__dirname, '../integration/refresh-path.ps1'), '-Cases', file], { windowsHide: true, timeout: 10000 * timeoutScale });
  const results = JSON.parse(stdout);
  assert.equal(results.length, cases.length);
  for (const [index, item] of cases.entries()) {
    assert.equal(nodeMerge(item), results[index].first, item.name);
    assert.equal(nodeMerge(item, item.nextUser ?? item.User), results[index].second, `${item.name}: read again`);
  }
});

test('the stored PATH is read with the PowerShell of the environment SystemRoot, machine then user, and a read that fails gives null', async () => {
  const calls = [], encoded = Buffer.from(['C:\\测试\\bin', 'D:\\user'].join('\0'), 'utf8').toString('base64');
  const run = answer => (file, args, options, callback) => { calls.push({ file, args, options }); callback(answer instanceof Error ? answer : null, answer instanceof Error ? '' : answer); };
  assert.deepEqual(await readStoredPath({ SystemRoot: 'C:\\Windows' }, { run: run(`${encoded}\r\n`) }), ['C:\\测试\\bin', 'D:\\user']);
  assert.equal(calls[0].file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.deepEqual(calls[0].args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']);
  assert.match(calls[0].args[4], /'Machine','User'/); assert.doesNotMatch(calls[0].args[4], /SetEnvironmentVariable|Set-Item|New-Item/);
  assert.deepEqual([calls[0].options.windowsHide, calls[0].options.timeout], [true, 5000]);
  assert.equal(await readStoredPath({ systemroot: 'C:\\Windows' }, { run: run(new Error('timed out')) }), null);
  assert.equal(await readStoredPath({}, { run: () => assert.fail('no SystemRoot, no read') }), null);
  assert.equal(await readStoredPath({ SystemRoot: 'C:\\Windows' }, { run: () => { throw new Error('spawn broke'); } }), null);
});
