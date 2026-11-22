const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { createSandboxSetup, readiness, finishRefresh } = require('../electron/features/codex-sandbox-setup/index.cjs');
const { REFRESH_LIMIT, verifyRoleCwd, readRefresh } = require('../electron/features/codex-app-server/sandbox-refresh.cjs');
const { stopProcess } = require('../electron/features/codex-app-server/index.cjs');
const { runSetup } = require('../electron/features/codex-sandbox-setup/elevate.cjs');
const { translate } = require('../electron/i18n.cjs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const file = 'D:\\Program Files\\Codex\\codex.exe';
const cwd = 'C:\\agentrix-probe';
const home = 'E:\\Codex home';

function fixture({ platform = 'win32', found = file, statuses = ['notConfigured'], response = 0,
  result = 'succeeded', env = { CODEX_HOME: home }, language = 'en', finished = true } = {}) {
  const calls = [];
  const offer = createSandboxSetup({ platform, cwd, env, active: () => true, t: text => translate(language, text),
    find: async () => { calls.push(['locate']); return found; },
    check: async (...args) => {
      calls.push(['check', ...args]);
      const status = statuses.shift();
      if (status instanceof Error) throw status;
      return status;
    },
    show: async options => { calls.push(['dialog', options]); return { response }; },
    setup: async (...args) => { calls.push(['setup', ...args]); return result; },
    now: () => 123,
    progress: message => calls.push(['progress', message]),
    finish: async (executable, { home, since }) => { calls.push(['refresh', executable, home, since]); return finished; },
  });
  return { offer, calls };
}

test('only a known unready Windows installation can prompt', async () => {
  const cases = [
    [{ platform: 'darwin' }, []],
    [{ platform: 'linux' }, []],
    [{ found: null }, ['locate']],
    [{ statuses: ['ready'] }, ['locate', 'check']],
    [{ statuses: [Object.assign(new Error('Method not found'), { code: -32601 })] }, ['locate', 'check']],
    [{ statuses: [new Error('rpc_timeout')] }, ['locate', 'check']],
    [{ statuses: ['unrecognized'] }, ['locate', 'check']],
  ];
  for (const [options, expected] of cases) {
    const { offer, calls } = fixture(options);
    await offer();
    assert.deepEqual(calls.map(([event]) => event), expected);
  }
});

test('Later defers the offer until another app run', async () => {
  for (let run = 0; run < 2; run++) {
    const { offer, calls } = fixture({ statuses: ['updateRequired'], response: 1, language: 'zh' });
    await Promise.all([offer(), offer()]);
    const dialogs = calls.filter(([event]) => event === 'dialog');
    assert.equal(dialogs.length, 1);
    assert.deepEqual(dialogs[0][1].buttons, ['设置', '以后再说']);
    assert.equal(dialogs[0][1].cancelId, 1);
    await offer();
    assert.equal(calls.filter(([event]) => event === 'dialog').length, 1);
    assert.equal(calls.some(([event]) => event === 'setup'), false);
  }
});

test('acceptance runs setup and reports the fresh readiness result', async () => {
  for (const [result, after, message] of [
    ['succeeded', 'ready', /permissions are ready/],
    ['succeeded', 'updateRequired', /could not be completed.*next time/],
    ['succeeded', new Error('rpc_timeout'), /could not be completed.*next time/],
    ['failed', 'notConfigured', /could not be completed.*next time/],
    ['declined', 'notConfigured', /approval was canceled.*next time/],
    ['invalidHome', undefined, /absolute local path.*skipped/],
  ]) {
    const env = result === 'invalidHome' ? { CODEX_HOME: 'relative' } : { CODEX_HOME: home };
    const { offer, calls } = fixture({ statuses: ['notConfigured', after], result, env });
    await offer();
    const refresh = after === 'ready' && result === 'succeeded' ? ['progress', 'refresh', 'progress'] : [];
    assert.deepEqual(calls.map(([event]) => event), ['locate', 'check', 'dialog', 'setup', ...(after ? ['check'] : []), ...refresh, 'dialog']);
    assert.deepEqual(calls[2][1].buttons, ['Set up', 'Later']);
    assert.deepEqual(calls[3], ['setup', file, env.CODEX_HOME, env]);
    assert.match(calls.at(-1)[1].message, message);
  }
  const env = { USERPROFILE: 'F:\\Windows profile' };
  const { offer, calls } = fixture({ statuses: ['notConfigured', 'ready'], env });
  await offer();
  assert.deepEqual(calls[3], ['setup', file, 'F:\\Windows profile\\.codex', env]);
  assert.deepEqual(calls[6], ['refresh', file, 'F:\\Windows profile\\.codex', 123]);
});

test('the setup offer clears indeterminate progress before reporting a bounded wait', async () => {
  const { offer, calls } = fixture({ statuses: ['notConfigured', 'ready'], finished: false });
  await offer();
  assert.match(calls[5][1], /finishing sandbox permissions/);
  assert.deepEqual(calls[7], ['progress', null]);
  assert.match(calls[8][1].message, /still finishing/);
});

test('the fixed refresh command creates no model turn and progress needs the ACL completion', async () => {
  for (const completed of [true, false]) {
    let clock = 0;
    const wire = [], child = {};
    const result = await finishRefresh(file, { cwd, env: {}, home, since: 0, active: () => true }, {
      launch: (_file, args) => { assert.ok(args.includes('features.prefer_mxc=false')); return child; },
      rpcFactory: () => ({
        request: async (method, params) => { wire.push([method, params]); return {}; },
        notify: () => {}, close: () => {},
      }),
      stop: async (...args) => assert.deepEqual(args, [child, { preserveDescendants: true }]),
      read: async (_home, since) => {
        assert.equal(since, 0);
        return { status: completed && clock >= 2000 ? 'complete' : 'running' };
      },
      now: () => clock, pause: async ms => { clock += ms; },
    });
    assert.equal(result, completed);
    assert.equal(clock, completed ? 2000 : REFRESH_LIMIT);
    assert.deepEqual(wire.map(([method]) => method), ['initialize', 'command/exec']);
    assert.deepEqual(wire[1][1].sandboxPolicy, { type: 'readOnly', networkAccess: false });
    assert.equal(wire[1][1].cwd, cwd);
  }
});

test('closing the refresh app-server also closes the input inherited through a shim', async () => {
  const child = new EventEmitter(), actions = [];
  child.stdin = { end: () => actions.push('eof'), destroy: () => actions.push('release') };
  child.kill = signal => { actions.push(signal); child.emit('exit'); };
  await stopProcess(child, { preserveDescendants: true });
  assert.deepEqual(actions, ['eof', 'SIGKILL', 'release']);
});

test('ACL evidence ignores parent exits and stale completion, including across UTC midnight', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agx-sandbox-refresh-'));
  const folder = path.join(root, '.sandbox');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(folder);
  const since = Date.parse('2026-11-21T23:58:00Z'), now = Date.parse('2026-11-22T00:01:00Z');
  await fs.writeFile(path.join(folder, 'sandbox.2026-11-21.log'),
    '[2026-11-21T23:55:00Z] read ACL run completed\n[2026-11-21T23:59:00Z] read-acl-only mode: applying read ACLs\n');
  const log = path.join(folder, 'sandbox.2026-11-22.log');
  await fs.writeFile(log, '[2026-11-22 00:00:00.000 helper.exe] setup binary completed\n');
  assert.equal((await readRefresh(root, since, now)).status, 'running');
  await fs.appendFile(log, '[2026-11-22T00:00:20Z] read ACL run completed with errors: ["access denied"]\n');
  assert.equal((await readRefresh(root, since, now)).status, 'failed');
  await fs.appendFile(log, '[2026-11-22T00:00:50Z] read ACL run completed\n');
  assert.equal((await readRefresh(root, since, now)).status, 'complete');
});

test('the role guard skips settled machines, retries a wrong folder and reports both folders on timeout', async () => {
  for (const [pending, folders, count] of [[false, [], 0], [true, ['C:\\', cwd], 2], [true, ['C:\\', 'C:\\'], 2]]) {
    let clock = 0, waits = 0, probes = 0;
    const result = verifyRoleCwd({
      cwd, home, env: {}, assertOpen() {}, translate: message => translate('en', message), onWait: () => waits++,
      rpc: { request: async () => ({ exitCode: 0, stdout: folders[probes++] }) },
    }, { pending: async () => pending, now: () => clock, pause: async ms => { clock += ms; }, limit: 3000 });
    if (pending && folders.at(-1) !== cwd) await assert.rejects(result, {
      code: 'sandbox_cwd_unverified', message: /Expected C:\\agentrix-probe\. Actual C:\\\./,
    });
    else await result;
    assert.equal(probes, count);
    assert.equal(waits, pending ? 1 : 0);
  }
});

test('the readiness probe initializes and closes its own app-server', async () => {
  for (const executable of [file, 'D:\\npm\\codex.cmd']) {
    for (const fail of [false, true]) {
      const wire = [];
      const context = { cwd, env: { CODEX_HOME: home } };
      const child = {};
      const deps = {
        launch: (...args) => { wire.push(['launch', ...args]); return child; },
        rpcFactory: process => {
          assert.equal(process, child);
          return {
            request: async (method, params) => {
              wire.push([method, params]);
              if (method === 'windowsSandbox/readiness' && fail) throw new Error('method not found');
              return { status: 'ready' };
            },
            notify: method => wire.push([method]),
            close: () => wire.push(['close']),
          };
        },
        stop: async process => { assert.equal(process, child); wire.push(['stop']); },
      };
      const pending = readiness(executable, context, deps);
      if (fail) await assert.rejects(pending, /method not found/);
      else assert.equal(await pending, 'ready');
      assert.deepEqual(wire.map(([method]) => method), ['launch', 'initialize', 'initialized', 'windowsSandbox/readiness', 'close', 'stop']);
      const [, program, args, options] = wire[0];
      assert.equal(options.cwd, cwd);
      assert.equal(options.env.CODEX_HOME, home);
      if (executable.endsWith('.cmd')) {
        assert.match(program, /\\cmd\.exe$/);
        assert.deepEqual(args, ['/d', '/v:off', '/s', '/c',
          '""%AGENTRIX_SETUP_CLI%" app-server --listen stdio:// -c windows.sandbox=elevated -c features.prefer_mxc=false"']);
        assert.equal(options.env.AGENTRIX_SETUP_CLI, executable);
        assert.equal(options.windowsVerbatimArguments, true);
      } else {
        assert.equal(program, executable);
        assert.deepEqual(args, ['app-server', '--listen', 'stdio://', '-c', 'windows.sandbox=elevated', '-c', 'features.prefer_mxc=false']);
      }
      assert.equal(wire[1][1].capabilities.experimentalApi, true);
      assert.deepEqual(wire[3][1], {});
    }
  }
});

const decode = value => Buffer.from(value, 'base64').toString('utf16le');

test('setup encodes its arguments and bounds the elevated CLI tree', async () => {
  const shim = "D:\\Cli's &(%)!\\codex.cmd";
  for (const [executable, input, normalized] of [[file, 'E:/', 'E:\\.'], [shim, "F:\\Home's &(%)!\\", "F:\\Home's &(%)!"]]) {
    const env = { SystemRoot: 'R:\\Windows' };
    let captured;
    assert.equal(await runSetup(executable, input, env, (...args) => { captured = args; args.at(-1)(null); }), 'succeeded');
    const [powershell, args, options] = captured;
    assert.equal(powershell, 'R:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.deepEqual(options, { cwd: 'R:\\Windows\\System32', env, windowsHide: true });
    assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
    const outer = decode(args[3]);
    assert.equal(outer.includes(executable), false);
    assert.equal(outer.includes(normalized), false);
    assert.match(outer, /\[Security\.Principal\.WindowsIdentity\]::GetCurrent\(\)\.Name/);
    assert.match(outer, /\[IO\.DriveType\]::Network\) \{ exit 2 \}/);
    assert.equal([...outer.matchAll(/-Verb RunAs/g)].length, 1);
    const [homeCheck, cliArg, elevated] = [...outer.matchAll(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/g)]
      .map(([, encoded]) => decode(encoded));
    assert.deepEqual([homeCheck, cliArg], [normalized, executable]);
    assert.match(outer, /CODEX_HOME = \$homePath/);
    assert.match(elevated, /sandbox setup --elevated --user "\{0\}" --codex-home "\{1\}"/);
    assert.match(elevated, /\/d \/v:off \/s \/c ""%AGENTRIX_SETUP_CLI%" sandbox setup --elevated --user "%AGENTRIX_SETUP_USER%" --codex-home "%CODEX_HOME%""/);
    assert.match(elevated, /WaitForExit\(300000\)/);
    assert.match(elevated, /taskkill\.exe" \/PID \$process\.Id \/T \/F/);
    assert.doesNotMatch(elevated, /-Verb RunAs/);
  }
});

test('setup refuses nonlocal homes and preserves Windows refusal and failure results', async () => {
  for (const invalid of ['relative', 'C:relative', '\\relative', '\\\\server\\share', '\\\\?\\C:\\home', 'C:\\a"b']) {
    assert.equal(await runSetup(file, invalid, {}, () => assert.fail('launched with an invalid home')), 'invalidHome');
  }
  for (const [code, result] of [[2, 'invalidHome'], [3, 'declined'], [1, 'failed'], ['EPERM', 'failed']]) {
    const launch = (_file, _args, _options, done) => done({ code });
    assert.equal(await runSetup(file, home, {}, launch), result);
  }
});
