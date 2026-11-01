const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { ZSH, macShell, shellEnvironment, zshEnvironment } = require('../electron/zsh-terminal.cjs');

const exec = promisify(execFile), integrationDir = path.resolve(__dirname, '../integration');

test('macOS defaults to system Bash and only an explicit zsh choice selects the existing zsh path', () => {
  const find = (name, { platform }) => { assert.equal(platform, 'darwin'); return `/bin/${name}`; };
  for (const choice of [undefined, 'powershell', 'cmd', 'bash']) {
    assert.deepEqual(macShell(choice, { find }), { kind: 'bash', file: '/bin/bash', zsh: true });
  }
  assert.deepEqual(macShell('zsh', { find }), { kind: 'zsh', file: ZSH, zsh: true });
  assert.deepEqual(macShell('bash', { find: () => null }), { kind: 'bash', file: '/bin/bash', zsh: false });
});

test('main caches macOS and Linux shell discovery until the choice changes or a terminal starts', () => {
  const main = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  const source = main.slice(main.indexOf('let localShells = null;'), main.indexOf('\nfunction nativeSessionEvent('));
  for (const platform of ['darwin', 'linux']) {
    const settings = { shell: 'bash' }, calls = [];
    const choose = choice => { calls.push(choice); return { kind: choice, file: `/bin/${choice}`, zsh: true }; };
    const context = vm.createContext({ process: { platform }, store: { settings }, macShell: choose, linuxShell: choose });
    vm.runInContext(source, context);
    const bash = context.localShell();
    assert.equal(context.localShell(), bash);
    assert.deepEqual(calls, ['bash']);
    settings.shell = 'zsh';
    const zsh = context.localShell();
    assert.equal(zsh.kind, 'zsh');
    assert.notEqual(zsh, bash);
    assert.equal(context.localShell(), zsh);
    assert.deepEqual(calls, ['bash', 'zsh']);
    assert.notEqual(context.localShell(true), zsh);
    assert.deepEqual(calls, ['bash', 'zsh', 'zsh']);
  }
});

test('macOS Bash requests login files and silences Apple\'s banner without changing other shell environments', () => {
  const source = { PATH: '/bin' }, options = { locale: 'en_US.UTF-8' };
  const bash = shellEnvironment(source, { ...options, loginFiles: true });
  assert.equal(bash.AGENTRIX_LOGIN_FILES, '1');
  assert.equal(bash.BASH_SILENCE_DEPRECATION_WARNING, '1');
  assert.equal(bash.LANG, 'en_US.UTF-8');
  for (const env of [source, shellEnvironment(source, options), zshEnvironment(source, options)]) {
    assert.equal(Object.hasOwn(env, 'AGENTRIX_LOGIN_FILES'), false);
    assert.equal(Object.hasOwn(env, 'BASH_SILENCE_DEPRECATION_WARNING'), false);
  }
});

test('macOS Bash sources the system profile before the first readable user login file', { skip: process.platform !== 'darwin', timeout: 30000 }, async t => {
  const cases = [
    { name: 'bash_profile wins', files: ['.bash_profile', '.bash_login', '.profile'], read: ['.bash_profile'] },
    { name: 'bash_login is next', files: ['.bash_login', '.profile'], read: ['.bash_login'] },
    { name: 'profile is last', files: ['.profile'], read: ['.profile'] },
    { name: 'no login file does not read bashrc', files: [], read: [] },
    { name: 'an empty profile still wins', files: ['.bash_profile', '.bash_login'], read: ['.bash_profile'], empty: true },
    { name: 'a profile may source bashrc once', files: ['.bash_profile', '.bash_login'], read: ['.bash_profile', '.bashrc'], bashrc: true },
    { name: 'an unreadable profile is skipped', files: ['.bash_profile', '.bash_login', '.profile'], read: ['.bash_login'], unreadable: true },
  ];
  for (const item of cases) await t.test(item.name, { skip: item.unreadable && process.getuid() === 0 }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-mac-bash-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const home = path.join(root, 'home'), project = path.join(root, "项目 'q' $x"), trace = path.join(root, 'sources');
    fs.mkdirSync(home); fs.mkdirSync(project);
    for (const file of [...item.files, '.bashrc']) {
      let contents = `PG_TEST_FILES+=${file}:\nexport PATH="$HOME/bin:$PATH"\ncd /\n`;
      if (file === '.bash_profile' && item.empty) contents = '\n';
      if (file === '.bash_profile' && item.bashrc) contents += 'builtin source ~/.bashrc\n';
      fs.writeFileSync(path.join(home, file), contents, { mode: file === '.bash_profile' && item.unreadable ? 0o000 : 0o600 });
    }
    const env = shellEnvironment({ HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', SHELL: '/bin/zsh', TMPDIR: os.tmpdir(),
      PG_TEST_TRACE: trace, PG_TEST_INTEGRATION: path.join(integrationDir, 'bash-integration.bash') }, {
      socket: '', projectId: 'project', sessionKey: 'key', node: process.execPath, helper: path.join(integrationDir, 'agent-event.cjs'),
      startDir: project, locale: 'en_US.UTF-8', loginFiles: true,
    });
    // Trace executed source files without replacing the real system profile or the integration's source command.
    const { stdout, stderr } = await exec('/bin/bash', ['--noprofile', '--norc', '-c', `
set -T
trap 'printf "%s\\n" "\${BASH_SOURCE[0]}" >> "$PG_TEST_TRACE"' DEBUG
builtin source "$PG_TEST_INTEGRATION"
trap - DEBUG
printf '__PG_STATE__%s\\n' "$PG_TEST_FILES|\${AGENTRIX_LOGIN_FILES-unset}|$PWD|$BASH_SILENCE_DEPRECATION_WARNING"
`], { cwd: root, env, timeout: 5000 });
    assert.equal(stderr, '');
    const expected = item.empty ? '' : item.read.map(file => `${file}:`).join('');
    assert.equal(stdout.split('__PG_STATE__')[1]?.trim(), `${expected}|unset|${project}|1`);
    const sources = fs.readFileSync(trace, 'utf8').split('\n');
    const system = sources.indexOf('/etc/profile');
    assert.ok(system >= 0, 'the system profile ran');
    const user = [...new Set(sources.filter(file => file.startsWith(home + path.sep)))];
    assert.deepEqual(user, item.empty ? [] : item.read.map(file => path.join(home, file)));
    if (user.length) assert.ok(system < sources.indexOf(user[0]), 'the system profile ran first');
  });
});
