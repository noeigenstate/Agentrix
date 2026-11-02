const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createRequire } = require('node:module');
const assert = require('node:assert/strict');
const tools = require('../../../electron/features/lab/sources/tools.cjs');
const { sha256 } = require('../../../electron/features/lab-oss/data.cjs');
const { caseKey } = require('../../../electron/features/lab-oss/pytest.cjs');
const execute = promisify(execFile);
const GOLD = 'LAB_OSS_PRIVATE_GOLD_8b7e1', HIDDEN = 'LAB_OSS_PRIVATE_TEST_9c82f';
const BEFORE = 'def value():\n    return 0\n\ndef stable():\n    return 7\n';
const FIXED = 'def value():\n    return 42 # ' + GOLD + '\n\ndef stable():\n    return 7\n';
const INITIAL_TESTS = 'from calc import stable\n\ndef test_stable():\n    assert stable() == 7\n';
const PRIVATE_TESTS = INITIAL_TESTS + '\nfrom calc import value\n\ndef test_value():\n    assert value() == 42 # ' + HIDDEN + '\n';
const F2P = 'tests/test_calc.py::test_value', P2P = 'tests/test_calc.py::test_stable';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lab-oss-fixture-')));
  t.after(async () => {
    assert.equal(await fs.realpath(root), root);
    assert.equal(path.dirname(root), await fs.realpath(os.tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
  });
  const repo = path.join(root, 'source'), home = path.join(root, 'home');
  await fs.mkdir(path.join(repo, 'tests'), { recursive: true }); await fs.mkdir(home);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:path|systemroot|windir|comspec|pathext|temp|tmp)$/i.test(key)));
  Object.assign(env, { HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1', GIT_ALLOW_PROTOCOL: 'file', GIT_TERMINAL_PROMPT: '0' });
  const git = async (cwd, args, options = {}) => {
    const { stdout } = await execute('git', ['-c', 'core.hooksPath=' + path.join(home, 'no-hooks'), ...args], {
      cwd, env, encoding: options.raw ? 'buffer' : 'utf8', maxBuffer: 8 * 1024 * 1024,
    });
    return stdout;
  };
  await git(repo, ['init', '--initial-branch=fixture']);
  await fs.writeFile(path.join(repo, 'calc.py'), BEFORE);
  await fs.writeFile(path.join(repo, 'tests/test_calc.py'), INITIAL_TESTS);
  await git(repo, ['add', '.']);
  await git(repo, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'Synthetic base']);
  const base = (await git(repo, ['rev-parse', 'HEAD'])).trim();
  await fs.writeFile(path.join(repo, 'calc.py'), FIXED);
  const patch = await git(repo, ['diff', '--', 'calc.py']);
  await fs.writeFile(path.join(repo, 'calc.py'), BEFORE);
  await fs.writeFile(path.join(repo, 'tests/test_calc.py'), PRIVATE_TESTS);
  const test_patch = await git(repo, ['diff', '--', 'tests/test_calc.py']);
  await fs.writeFile(path.join(repo, 'tests/test_calc.py'), INITIAL_TESTS);
  const row = { instance_id: 'fixture__unit-1', repo: 'fixture/unit', base_commit: base,
    problem_statement: 'Make value() return the required value without breaking stable().', patch, test_patch,
    FAIL_TO_PASS: JSON.stringify([F2P]), PASS_TO_PASS: JSON.stringify([P2P]) };
  const raw = Buffer.from(JSON.stringify({ rows: [{ row_idx: 0, row, truncated_cells: [] }] }));
  const entry = { id: 'oss-fixture-unit-1', instance: row.instance_id, title: 'Synthetic Python task', repo: row.repo,
    url: 'https://github.com/fixture/unit.git', base, version: '1', upstream: 'https://github.com/fixture/unit/pull/1', license: 'MIT',
    row: { url: 'https://datasets-server.huggingface.co/rows?fixture=1', sha256: sha256(raw), bytes: raw.length },
    sha256: Object.fromEntries(['problem_statement', 'patch', 'test_patch'].map(key => [key, sha256(row[key])])),
    FAIL_TO_PASS: [F2P], PASS_TO_PASS: [P2P], requirements: { packages: ['pytest==8.3.5'], installEditable: false } };
  const manifest = { version: 'synthetic-1', dataset: { id: 'synthetic' }, tasks: [entry] };
  const state = { downloads: 0, fetches: 0, installs: 0, wheelBuilds: 0, activeInstalls: 0, maximumInstalls: 0, calls: [], mode: null };
  const fakeTools = { ...tools, git,
    async snapshot(source, directory, revision, { signal } = {}) {
      const cwd = path.join(directory, 'worktree'); await fs.mkdir(cwd, { recursive: true });
      const files = (await git(source, ['ls-tree', '-rz', '--name-only', revision])).split('\0').filter(Boolean);
      for (const file of files) {
        assert.ok(tools.safePath(file)); const target = path.join(cwd, file);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, await git(source, ['show', revision + ':' + file], { raw: true }));
      }
      return tools.files(cwd, { signal });
    },
    async download(url, destination, options) {
      assert.equal(url, entry.row.url); assert.deepEqual(options.hosts, ['datasets-server.huggingface.co']);
      assert.equal(options.sha256, entry.row.sha256); assert.equal(options.maxBytes, raw.length);
      state.downloads++; await fs.writeFile(destination, state.badDownload ? Buffer.from('corrupt') : raw);
      return { bytes: raw.length };
    },
    async fetchCommit(url, commit, destination, options) {
      assert.equal(url, entry.url); assert.equal(commit, base); assert.deepEqual(options.hosts, ['github.com']);
      state.fetches++;
      if (!await fs.stat(destination).catch(() => null)) await git(root, ['clone', '--bare', '--no-hardlinks', '--', repo, destination]);
    },
  };
  const cacheDirectory = path.join(root, 'cache'); await fs.mkdir(cacheDirectory);
  const controller = new AbortController();
  const ctx = { tools: fakeTools, cacheDirectory, signal: controller.signal, platform: process.platform,
    t: value => value, credential: () => { throw new Error('OSS never requests credentials.'); }, getProjects: () => [] };
  const session = {
    nodePath: process.execPath,
    async execute(file, args, options) {
      state.calls.push({ file, args, ...options });
      if (state.execute) return state.execute(file, args, options);
      if (args.includes('venv')) {
        assert.ok(args.includes('--copies')); await fs.mkdir(args.at(-1), { recursive: true });
        return { code: 0, stdout: '', stderr: '' };
      }
      if (args[2]?.includes('sys.implementation.name')) return { code: 0, stdout: 'cpython-312-x64\n', stderr: '' };
      if (args[2]?.includes('runpy.run_module')) {
        const command = args.slice(6), home = args[3];
        assert.equal(await fs.readFile(path.join(home, '.netrc'), 'utf8'), ''); assert.equal(options.network, true);
        if (command[0] === 'wheel') {
          state.wheelBuilds++;
          const destination = command[command.indexOf('--wheel-dir') + 1];
          await fs.writeFile(path.join(destination, 'pytest-8.3.5-py3-none-any.whl'), 'synthetic wheel');
        }
        if (command[0] === 'install') {
          state.installs++; state.activeInstalls++; state.maximumInstalls = Math.max(state.maximumInstalls, state.activeInstalls);
          if (state.installDelay) await new Promise(resolve => setTimeout(resolve, state.installDelay));
          state.activeInstalls--;
          if (state.failInstall) return { code: 1, stdout: '', stderr: 'synthetic install failure' };
          if (state.afterInstall) await state.afterInstall(options.cwd);
        }
        return { code: 0, stdout: '', stderr: '' };
      }
      assert.equal(options.network, false);
      const target = args.find(arg => arg.startsWith('--junitxml='))?.slice('--junitxml='.length);
      assert.ok(target, 'test job writes a JUnit report');
      assert.ok((await fs.readFile(path.join(options.cwd, 'tests/test_calc.py'), 'utf8')).includes(HIDDEN), 'hidden tests restored');
      const fixed = /return 42/.test(await fs.readFile(path.join(options.cwd, 'calc.py'), 'utf8'));
      let outcomes = [fixed ? 'passed' : 'failed', 'passed'];
      if (state.mode === 'all-pass') outcomes = ['passed', 'passed'];
      if (state.mode === 'always-fail') outcomes = ['failed', 'passed'];
      if (state.mode === 'skipped') outcomes[0] = 'skipped';
      if (state.mode === 'error') outcomes[0] = 'error';
      let cases = [F2P, P2P].map((id, index) => {
        const [classname, name] = caseKey(id).split('\0');
        return '<testcase classname="' + classname + '" name="' + name + '">' +
          (outcomes[index] === 'passed' ? '' : '<' + (outcomes[index] === 'failed' ? 'failure' : outcomes[index]) + '/>') + '</testcase>';
      });
      if (state.mode === 'missing') cases.pop();
      if (state.mode === 'duplicate') cases[1] = cases[0];
      if (state.mode === 'wrong-name') cases[0] = cases[0].replace('test_value', 'test_other');
      await fs.writeFile(target, state.mode === 'malformed' ? 'broken XML' : '<testsuite>' + cases.join('') + '</testsuite>');
      return { code: state.mode === 'bad-code' ? 2 : outcomes.every(value => value === 'passed') ? 0 : 1, stdout: '', stderr: '' };
    },
  };
  let index = 0;
  const run = async () => {
    const directory = path.join(root, 'run-' + ++index), workspaceRoot = path.join(directory, 'workspaces');
    const artifactDirectory = path.join(directory, 'artifacts');
    await fs.mkdir(workspaceRoot, { recursive: true }); await fs.mkdir(artifactDirectory);
    return { ...ctx, workspaceRoot, artifactDirectory, session, reference: null, testTimeoutMs: 1000 };
  };
  return { root, repo, row, raw, entry, manifest, ctx, state, session, controller, run, git };
}

// Conformance has its own session. Stub only dependency installation there; other tests exercise production
// environment preparation through the recording session. Snapshots and answer-leak checks remain real.
async function conformanceProvider(manifest) {
  const file = path.resolve(__dirname, '../../../electron/features/lab-oss/provider.cjs'), localRequire = createRequire(file);
  const code = await fs.readFile(file, 'utf8'), module = { exports: {} };
  new Function('require', 'module', 'exports', code)((name) => name === './environment.cjs'
    ? { ...localRequire(name), prepareEnvironment: async () => {} } : localRequire(name), module, module.exports);
  return module.exports.createProvider(manifest);
}

module.exports = { fixture, conformanceProvider, GOLD, HIDDEN, BEFORE, FIXED, F2P, P2P };
