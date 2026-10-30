const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const helpers = import('../scripts/ci-preflight-core.mjs');
const source = fs.readFileSync(path.join(__dirname, '../.github/workflows/build-windows.yml'), 'utf8');
const sha = 'a'.repeat(40);
const branch = `ci/preflight-${sha.slice(0, 12)}`;
const workflow = async () => (await helpers).parseWorkflow(source);

test('local plan reads every real Windows workflow step in order with CI environment and explicit skip reasons', async () => {
  const { localPlan } = await helpers;
  const parsed = await workflow();
  const steps = localPlan(parsed);
  assert.deepEqual(steps.map(step => step.name), parsed.jobs.windows.steps.map(step => step.name));
  assert.equal(steps.length, 31);
  assert.deepEqual(steps.map(step => step.number), Array.from({ length: 31 }, (_, index) => index + 1));
  const skipped = steps.filter(step => step.skip);
  assert.deepEqual(skipped.map(step => step.name), [
    'Check out source', 'Set up Node.js', 'Validate release version', 'Install locked dependencies',
    'Install Codex CLI for offline startup checks', 'Upload verified executable', 'Upload desktop test screenshots',
  ]);
  assert.match(skipped[0].skip, /current checkout/);
  assert.match(skipped[1].skip, /installed Node/);
  assert.match(skipped[2].skip, /release\/tag/);
  assert.match(skipped[3].skip, /no npm ci/);
  assert.match(skipped[4].skip, /no global installation/);
  assert.ok(skipped.slice(5).every(step => /no upload/.test(step.skip)));
  for (const step of steps) {
    assert.equal(step.env.CI, 'true');
    assert.equal(step.env.CSC_IDENTITY_AUTO_DISCOVERY, 'false');
    assert.equal(step.env.AGENTRIX_TEST_TIMEOUT_SCALE, '3');
  }
  assert.equal(steps.find(step => step.run === 'npm test').kind, 'unit');
  assert.equal(steps.filter(step => step.kind === 'gui').length, 19);
  assert.equal(steps.find(step => step.name === 'Build Windows installer').kind, 'command');
  assert.equal(steps.find(step => step.name === 'Create checksum and build notes').skip, null);
});

test('workflow planning refuses unsupported actions and absent commands instead of silently skipping them', async () => {
  const { parseWorkflow, localPlan } = await helpers;
  assert.throws(() => parseWorkflow('jobs: {}'), /no Windows steps/);
  const parsed = await workflow();
  parsed.jobs.windows.steps = [{ name: 'New action', uses: 'vendor/task@v1' }];
  assert.throws(() => localPlan(parsed), /Unsupported workflow action/);
  parsed.jobs.windows.steps = [{ name: 'Empty' }];
  assert.throws(() => localPlan(parsed), /Missing run command/);
});

test('--only and --from select real workflow numbers, names, commands and unique fragments without adding steps', async () => {
  const { localPlan, selectSteps } = await helpers;
  const steps = localPlan(await workflow());
  const unit = steps.find(step => step.run === 'npm test');
  for (const selector of [String(unit.number), unit.name, unit.key, 'npm test', 'unit and integration']) {
    assert.deepEqual(selectSteps(steps, { only: selector }), [unit]);
  }
  const selected = selectSteps(steps, { from: 'Build Windows installer' });
  assert.deepEqual(selected, steps.slice(steps.indexOf(steps.find(step => step.run === 'npm run dist'))));
  assert.deepEqual(selectSteps(steps), steps);
  assert.throws(() => selectSteps(steps, { only: 'Verify' }), /exactly one step/);
  assert.throws(() => selectSteps(steps, { from: 'unknown' }), /0 matches/);
  assert.throws(() => selectSteps(steps, { from: '1', only: '2' }), /cannot be combined/);
});

test('portable passes derive Python from remote-linux and deduplicate npm test against selected Windows coverage', async () => {
  const { localPlan, selectSteps, portablePlan, pythonCommand } = await helpers;
  const parsed = await workflow();
  const steps = localPlan(parsed);
  const extras = portablePlan(parsed, steps);
  assert.equal(extras.length, 1);
  assert.equal(extras[0].kind, 'python');
  assert.equal(extras[0].run, parsed.jobs['remote-linux'].steps.find(step => step.run?.startsWith('python3')).run);
  assert.deepEqual(pythonCommand(extras[0].run), ['-m', 'unittest', 'discover', '-s', 'tests', '-p', 'remote_worker_test.py', '-v']);
  const resumed = portablePlan(parsed, selectSteps(steps, { from: 'Build Windows installer' }));
  assert.deepEqual(resumed.map(step => step.kind), ['unit', 'python']);
  assert.equal(resumed.filter(step => step.run === 'npm test').length, 1);
  delete parsed.jobs.macos;
  assert.throws(() => portablePlan(parsed, steps), /one npm test command in macos/);
  for (const command of ['python3 -m unittest; echo bad', 'python3 -m unittest\nwhoami', 'python3 -p "unclosed', 'node scripts/test.mjs']) {
    assert.throws(() => pythonCommand(command), /Unsupported/);
  }
});

test('checksum command substitutes only the validated package version and rejects unknown or malformed expressions', async () => {
  const { localPlan, renderRun } = await helpers;
  const step = localPlan(await workflow()).find(step => step.name === 'Create checksum and build notes');
  const rendered = renderRun(step.run, '1.3.22-beta.1');
  assert.match(rendered, /\$version = '1\.3\.22-beta\.1'/);
  assert.match(rendered, /GITHUB_SHA/);
  assert.match(rendered, /GITHUB_STEP_SUMMARY/);
  assert.doesNotMatch(rendered, /\$\{\{/);
  assert.throws(() => renderRun('echo ${{ secrets.TOKEN }}', '1.3.22'), /Unsupported GitHub expression/);
  assert.throws(() => renderRun('echo ${{ broken', '1.3.22'), /Malformed GitHub expression/);
  assert.throws(() => renderRun(step.run, "1.2.3'; whoami"), /Invalid local package version/);
});

test('per-step environments preserve system variables and isolate profiles, CLI homes, short TEMP and GitHub context', async () => {
  const { localPlan, stepEnvironment } = await helpers;
  const steps = localPlan(await workflow());
  const base = Object.freeze({ SystemDrive: 'C:', Path: 'tools', temp: 'old temp', Tmp: 'old tmp', ci: 'false', CODEX_HOME: 'real-login', AGENTRIX_DATA_DIR: 'real-profile', AGENTRIX_TEST_HOME: '1', AGENTRIX_TEST_ZOOM: 'auto' });
  const locations = {
    root: 'C:\\source', temp: 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\PF123456',
    profile: 'C:\\scratch\\s0001\\profile', codex: 'C:\\scratch\\s0001\\codex', claude: 'C:\\scratch\\s0001\\claude',
    output: 'C:\\logs\\step.github-output', summary: 'C:\\logs\\summary.md',
  };
  const gui = stepEnvironment(base, steps.find(step => step.kind === 'gui'), locations, sha);
  assert.equal(gui.SystemDrive, 'C:');
  assert.equal(gui.Path, 'tools');
  assert.equal(gui.CI, 'true');
  assert.equal(gui.AGENTRIX_TEST_TIMEOUT_SCALE, '3');
  assert.equal(gui.CSC_IDENTITY_AUTO_DISCOVERY, 'false');
  assert.equal(gui.TEMP, locations.temp);
  assert.equal(gui.TMP, locations.temp);
  assert.equal(gui.RUNNER_TEMP, locations.temp);
  assert.equal(gui.AGENTRIX_DATA_DIR, locations.profile);
  assert.equal(gui.CODEX_HOME, locations.codex);
  assert.equal(gui.CLAUDE_CONFIG_DIR, locations.claude);
  assert.equal(gui.GITHUB_SHA, sha);
  assert.equal(gui.GITHUB_REF_TYPE, 'branch');
  assert.equal(gui.GITHUB_WORKSPACE, locations.root);
  assert.equal(gui.GITHUB_OUTPUT, locations.output);
  assert.equal(gui.GITHUB_STEP_SUMMARY, locations.summary);
  for (const key of ['temp', 'Tmp', 'ci', 'AGENTRIX_TEST_HOME', 'AGENTRIX_TEST_ZOOM']) assert.equal(Object.hasOwn(gui, key), false);
  const unit = stepEnvironment(base, steps.find(step => step.kind === 'unit'), { ...locations, profile: 'C:\\scratch\\s0002\\profile', codex: 'C:\\scratch\\s0002\\codex' }, sha);
  assert.equal(unit.AGENTRIX_TEST_HOME, '1');
  assert.equal(unit.AGENTRIX_TEST_ZOOM, 'auto');
  assert.notEqual(unit.AGENTRIX_DATA_DIR, gui.AGENTRIX_DATA_DIR);
  assert.notEqual(unit.CODEX_HOME, gui.CODEX_HOME);
  assert.equal(base.CODEX_HOME, 'real-login');
  assert.equal(stepEnvironment(base, { kind: 'unit', env: {} }, locations, sha).AGENTRIX_TEST_TIMEOUT_SCALE, '2');
  // A Linux job's step keeps this host's TEMP: the short alias reproduces the Windows runner only.
  const linux = stepEnvironment(base, { key: 'remote-linux/python-unittest', kind: 'python', env: {} }, locations, sha);
  assert.equal(linux.temp, 'old temp');
  for (const key of ['TEMP', 'TMP', 'RUNNER_TEMP']) assert.equal(Object.hasOwn(linux, key), false, key);
});

test('packaging refuses symlink/junction and absent node_modules while unit-only selection remains runnable', async () => {
  const { localPlan, assertPackagingAllowed } = await helpers;
  const steps = localPlan(await workflow());
  const dist = steps.find(step => step.run === 'npm run dist');
  assert.throws(() => assertPackagingAllowed(dist, { linked: true, directory: true }), /symlink\/junction/);
  assert.throws(() => assertPackagingAllowed(dist, { linked: false, directory: false }), /installed real directory/);
  assert.doesNotThrow(() => assertPackagingAllowed(dist, { linked: false, directory: true }));
  assert.doesNotThrow(() => assertPackagingAllowed(steps.find(step => step.run === 'npm test'), { linked: true, directory: true }));
});

test('origin parsing accepts ordinary GitHub transports and refuses credential URLs, other hosts, paths and options', async () => {
  const { parseOrigin } = await helpers;
  for (const origin of ['https://github.com/noeigenstate/Agentrix.git', 'git@github.com:noeigenstate/Agentrix.git', 'ssh://git@github.com/noeigenstate/Agentrix.git', 'https://github.com/noeigenstate/Agentrix']) {
    assert.deepEqual(parseOrigin(origin), { owner: 'noeigenstate', repo: 'Agentrix' });
  }
  for (const origin of ['https://token@github.com/owner/repo.git', 'https://github.com.evil.test/owner/repo', 'https://example.com/owner/repo', 'C:\\repo', '--all', 'https://github.com/owner/../repo', 'https://github.com/owner/repo?secret=x', 'https://github.com/owner/..']) {
    assert.throws(() => parseOrigin(origin), /Origin must/);
  }
});

test('push uses a short-SHA default or safe destination and absent/exact-full-SHA leases without tags or submodules', async () => {
  const { preflightBranch, pushArguments } = await helpers;
  assert.equal(preflightBranch(sha), branch);
  const create = pushArguments(sha, branch);
  assert.deepEqual(create.slice(-2), ['origin', `${sha}:refs/heads/${branch}`]);
  assert.ok(create.includes(`--force-with-lease=refs/heads/${branch}:`));
  assert.ok(create.includes('--no-follow-tags'));
  assert.ok(create.includes('--recurse-submodules=no'));
  const remove = pushArguments(sha, branch, true);
  assert.ok(remove.includes(`--force-with-lease=refs/heads/${branch}:${sha}`));
  assert.equal(remove.at(-1), `:refs/heads/${branch}`);
  assert.equal(preflightBranch(sha, 'ci/preflight-review-123'), 'ci/preflight-review-123');
  assert.equal(pushArguments(sha, 'ci/preflight-review-123').at(-1), `${sha}:refs/heads/ci/preflight-review-123`);
  assert.ok(pushArguments(sha, 'ci/preflight-review-123', true).includes(`--force-with-lease=refs/heads/ci/preflight-review-123:${sha}`));
  for (const unsafe of ['main', 'refs/heads/main', 'v1.3.22', 'ci/preflight-', 'ci/preflight-../main', 'ci/preflight-name.lock', 'ci/preflight-ends-', 'ci/preflight--starts', 'ci/preflight-name;whoami', `ci/preflight-${'b'.repeat(65)}`]) {
    assert.throws(() => pushArguments(sha, unsafe), /Refusing a push/);
    assert.throws(() => pushArguments(sha, unsafe, true), /Refusing a push/);
  }
  for (const invalid of ['HEAD', 'a'.repeat(12), 'a'.repeat(39) + ';', sha.toUpperCase()]) assert.throws(() => preflightBranch(invalid), /full lowercase HEAD SHA/);
});

test('remote expectations expand both real Linux architectures and require every platform plus only the tag-skipped release', async () => {
  const { expectedRemoteJobs } = await helpers;
  const parsed = await workflow();
  const expected = expectedRemoteJobs(parsed);
  assert.deepEqual(expected, [
    { name: 'Linux SSH integration', conclusion: 'success' },
    { name: 'Windows x64 build and desktop tests', conclusion: 'success' },
    { name: 'macOS Apple silicon build and desktop test', conclusion: 'success' },
    { name: 'Linux x64 build and desktop tests', conclusion: 'success' },
    { name: 'Linux arm64 build and desktop tests', conclusion: 'success' },
    { name: 'Publish GitHub Release', conclusion: 'skipped' },
  ]);
  parsed.jobs.release.if = 'always()';
  assert.throws(() => expectedRemoteJobs(parsed), /restricted to version tags/);
  parsed.jobs.release.if = "startsWith(github.ref, 'refs/tags/v')";
  parsed.jobs.linux.strategy.matrix = { arch: ['x64', 'arm64'] };
  assert.throws(() => expectedRemoteJobs(parsed), /Unsupported matrix/);
});

test('exact dispatch verification rejects stale runs, other commits, refs, events and workflows', async () => {
  const { workflowFile, verifyDispatchedRun } = await helpers;
  const expected = { runId: 1234, sha, branch };
  const run = { id: 1234, head_sha: sha, head_branch: branch, event: 'workflow_dispatch', path: workflowFile };
  assert.doesNotThrow(() => verifyDispatchedRun(run, expected));
  for (const suffix of [branch, `refs/heads/${branch}`, sha, 'main']) assert.doesNotThrow(() => verifyDispatchedRun({ ...run, path: `${workflowFile}@${suffix}` }, expected));
  for (const change of [{ id: 1233 }, { head_sha: 'b'.repeat(40) }, { head_branch: 'main' }, { event: 'push' }, { path: '.github/workflows/other.yml' }, { path: '.github/workflows/other.yml@main' }]) {
    assert.throws(() => verifyDispatchedRun({ ...run, ...change }, expected), /identity does not match/);
  }
});

test('polling bounds each request by the remaining deadline and retains 30-second intervals', async () => {
  const { pollWorkflowRun } = await helpers;
  let clock = 0;
  const timeouts = [], waits = [], inspected = [];
  const statuses = ['queued', 'in_progress', 'completed'];
  const costs = [1000, 30000, 1];
  const run = await pollWorkflowRun(async timeout => {
    timeouts.push(timeout);
    clock += costs.shift();
    return { status: statuses.shift() };
  }, {
    deadline: 95000, now: () => clock,
    wait: async duration => { waits.push(duration); clock += duration; },
    inspect: value => inspected.push(value.status),
  });
  assert.equal(run.status, 'completed');
  assert.deepEqual(timeouts, [60000, 60000, 4000]);
  assert.deepEqual(waits, [30000, 30000]);
  assert.deepEqual(inspected, ['queued', 'in_progress', 'completed']);
});

test('polling rejects late successful responses and never requests again after deadline', async () => {
  const { pollWorkflowRun } = await helpers;
  let clock = 95, inspected = false;
  await assert.rejects(pollWorkflowRun(async timeout => {
    assert.equal(timeout, 5);
    clock = 101;
    return { status: 'completed', conclusion: 'success' };
  }, {
    deadline: 100, now: () => clock,
    wait: async () => assert.fail('No wait after late completion'),
    inspect: () => { inspected = true; },
  }), /within 110 minutes/);
  assert.equal(inspected, false);
  let reads = 0;
  clock = 90;
  await assert.rejects(pollWorkflowRun(async timeout => {
    assert.equal(timeout, 10);
    reads++;
    return { status: 'in_progress' };
  }, {
    deadline: 100, now: () => clock,
    wait: async duration => { assert.equal(duration, 10); clock = 100; },
    inspect: () => {},
  }), /within 110 minutes/);
  assert.equal(reads, 1);
});

test('remote green requires completed successful workflow, every required job, and the explicit skipped release', async () => {
  const { expectedRemoteJobs, assessRemoteJobs } = await helpers;
  const expected = expectedRemoteJobs(await workflow());
  const jobs = expected.map((entry, index) => ({ id: index + 1, name: entry.name, status: 'completed', conclusion: entry.conclusion }));
  assert.deepEqual(assessRemoteJobs(jobs, expected, 'success'), { success: true, problems: [] });
  for (const conclusion of ['failure', 'cancelled', 'timed_out', null]) {
    assert.equal(assessRemoteJobs(jobs, expected, conclusion).success, false);
  }
  for (let index = 0; index < jobs.length; index++) {
    assert.equal(assessRemoteJobs(jobs.filter((_, position) => position !== index), expected, 'success').success, false);
  }
  for (const conclusion of ['failure', 'cancelled', 'skipped', 'neutral', 'timed_out', null]) {
    assert.equal(assessRemoteJobs([{ ...jobs[0], conclusion }, ...jobs.slice(1)], expected, 'success').success, false);
  }
  assert.equal(assessRemoteJobs([{ ...jobs[0], status: 'in_progress' }, ...jobs.slice(1)], expected, 'success').success, false);
  assert.equal(assessRemoteJobs([...jobs, jobs[0]], expected, 'success').success, false);
  assert.equal(assessRemoteJobs([...jobs, { name: 'Unexpected skipped job', status: 'completed', conclusion: 'skipped' }], expected, 'success').success, false);
  assert.equal(assessRemoteJobs(jobs.map(job => job.conclusion === 'skipped' ? { ...job, conclusion: 'success' } : job), expected, 'success').success, false);
});

test('CLI options make local/remote explicit and prevent a filtered remote workflow', async () => {
  const { parseArguments, tailLines } = await helpers;
  assert.deepEqual(parseArguments([]), { help: true });
  assert.deepEqual(parseArguments(['--help']), { help: true });
  assert.deepEqual(parseArguments(['local', '--only', 'npm test']), { mode: 'local', only: 'npm test' });
  assert.deepEqual(parseArguments(['local', '--from', '7']), { mode: 'local', from: '7' });
  assert.deepEqual(parseArguments(['remote']), { mode: 'remote' });
  assert.deepEqual(parseArguments(['remote', '--ref', 'ci/preflight-review']), { mode: 'remote', ref: 'ci/preflight-review' });
  for (const args of [['remote', '--only', '7'], ['remote', '--from', '7'], ['local', '--ref', branch], ['local', '--from', '7', '--only', '8'], ['local', '--only'], ['local', '--unknown'], ['local', '--only', '1', '--only', '2'], ['push']]) {
    assert.throws(() => parseArguments(args));
  }
  assert.equal(tailLines('first\r\nsecond\r\nthird\r\n', 2), 'second\nthird');
});

test('failed log excerpts preserve early error context across stream chunks as well as the final tail', async () => {
  const { collectLogExcerpt } = await helpers;
  const text = ['setup', 'before', 'Error: first failure', 'after one', 'after two', 'after three', ...Array.from({ length: 100 }, (_, index) => `noise ${index}`), 'not ok 42', 'context', 'Timed out waiting for a terminal', ...Array.from({ length: 60 }, (_, index) => `cleanup ${index}`)].join('\r\n');
  const chunks = [];
  for (let index = 0; index < text.length; index += 7) chunks.push(Buffer.from(text.slice(index, index + 7)));
  const excerpt = await collectLogExcerpt(chunks);
  assert.match(excerpt, /setup\nbefore\nError: first failure\nafter one\nafter two\nafter three/);
  assert.match(excerpt, /not ok 42/);
  assert.match(excerpt, /Timed out waiting for a terminal/);
  assert.match(excerpt, /Log tail:/);
  assert.match(excerpt, /cleanup 59$/);
  const bounded = await collectLogExcerpt(Array.from({ length: 1000 }, (_, index) => `Error: ${index}\n`));
  assert.ok(bounded.length < 10000);
});

test('importing the CLI does not start processes, open a GUI, fetch credentials or access the network', async t => {
  const childProcess = require('node:child_process');
  const { syncBuiltinESMExports } = require('node:module');
  t.mock.method(childProcess, 'spawn', () => { throw new Error('Unexpected process launch'); });
  t.mock.method(childProcess, 'spawnSync', () => { throw new Error('Unexpected process launch'); });
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected network'); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await import(pathToFileURL(path.join(__dirname, '../scripts/ci-preflight.mjs')).href);
});
