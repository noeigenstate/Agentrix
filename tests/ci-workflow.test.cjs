const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const helpers = import('../scripts/ci-preflight-core.mjs');
const source = fs.readFileSync(path.join(__dirname, '../.github/workflows/build-windows.yml'), 'utf8');
const workflow = async () => (await helpers).parseWorkflow(source);

// Exact Windows desktop steps from 9c7bd75, before introducing parallel shards.
const originalDesktopSteps = [
  {
    "name": "Verify desktop with actual terminal button clicks",
    "run": "node scripts/retry.mjs npm run test:desktop -- --packaged"
  },
  {
    "name": "Verify local terminal restarts refresh Windows PATH without restarting the app",
    "run": "node scripts/retry.mjs npm run test:path-refresh -- --packaged"
  },
  {
    "name": "Verify session recovery, clipboard and SSH desktop interaction",
    "run": "node scripts/retry.mjs npm run test:sessions -- --packaged"
  },
  {
    "name": "Verify session recovery with delayed window cursor-position answers",
    "run": "node scripts/retry.mjs npm run test:restore-slow -- --packaged"
  },
  {
    "name": "Verify animated project expansion and return",
    "run": "node scripts/verify-installer-payload.cjs\nif ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }\n$installed = Get-Content -LiteralPath .test-output/installer-payload.json -Raw -Encoding UTF8 | ConvertFrom-Json\nnode scripts/retry.mjs node scripts/focus-motion-smoke.mjs --executable $installed.executable\n"
  },
  {
    "name": "Verify completion notifications only rearm after new input",
    "run": "node scripts/retry.mjs npm run test:completion -- --packaged"
  },
  {
    "name": "Test GPU terminal renderer",
    "run": "node scripts/retry.mjs npm run test:gpu-terminal -- --packaged"
  },
  {
    "name": "Verify file operations and microphone UI with isolated test devices",
    "run": "node scripts/retry.mjs npm run test:workspace -- --packaged --slow-copy"
  },
  {
    "name": "Verify editing, path copying and independent split terminals",
    "run": "node scripts/retry.mjs npm run test:editor-terminals -- --packaged"
  },
  {
    "name": "Verify persistent themes, automatic editing and Markdown previews",
    "run": "node scripts/retry.mjs npm run test:themes-markdown -- --packaged"
  },
  {
    "name": "Verify synchronized lights, readable themes and quiet completed cards",
    "run": "node scripts/retry.mjs npm run test:visual -- --packaged"
  },
  {
    "name": "Verify internal navigation and removed external editor and manual completion actions",
    "run": "node scripts/retry.mjs npm run test:navigation -- --packaged"
  },
  {
    "name": "Verify Git status, history and explorer switching for local and SSH projects",
    "run": "node scripts/retry.mjs npm run test:git -- --packaged"
  },
  {
    "name": "Verify Command Prompt terminals report prompts, run agents and resume sessions",
    "run": "node scripts/retry.mjs npm run test:cmd -- --packaged"
  },
  {
    "name": "Verify image paths use text-only clipboard data and latest-copy ordering",
    "run": "node scripts/retry.mjs npm run test:clipboard -- --packaged"
  },
  {
    "name": "Verify liquid glass under terminal load and reduced transparency",
    "run": "node scripts/retry.mjs npm run test:material -- --packaged"
  },
  {
    "name": "Verify transparent real Codex input and bright text without model requests",
    "run": "node scripts/retry.mjs npm run test:composer -- --packaged"
  },
  {
    "name": "Verify reading commands, CLI keys and permission handoff",
    "run": "node scripts/retry.mjs npm run test:reading -- --packaged"
  },
  {
    "name": "Verify the model dashboard window, its filters, adoption and layouts",
    "run": "node scripts/retry.mjs npm run test:dashboard -- --packaged"
  },
  {
    "name": "Verify the real native question card at the minimum window, its validation and jump link",
    "run": "node scripts/retry.mjs npm run test:native-question -- --packaged"
  },
  {
    "name": "Verify agent hierarchy, queued messages, paged popups and slow autosave",
    "run": "node scripts/retry.mjs node scripts/reading-hierarchy-smoke.mjs --packaged"
  }
];

test('every original desktop step runs in exactly one shard with its entire command unchanged', async () => {
  const { localPlan } = await helpers;
  const parsed = await workflow();
  const actual = localPlan(parsed).filter(step => step.kind === 'gui');
  assert.equal(originalDesktopSteps.length, 21);
  assert.equal(actual.length, originalDesktopSteps.length);
  for (const original of originalDesktopSteps) {
    const matches = actual.filter(step => step.name === original.name);
    assert.equal(matches.length, 1, original.name);
    assert.equal(matches[0].run, original.run, original.name);
    assert.ok(matches[0].key.startsWith('windows-desktop/'), original.name);
  }
  for (const { shard } of parsed.jobs['windows-desktop'].strategy.matrix.include) {
    assert.equal(actual.filter(step => step.key.startsWith(`windows-desktop/${shard}/`)).length, 7);
  }
});

test('desktop shards consume the one Windows build with the same tools and environment, including the real installer payload', async () => {
  const parsed = await workflow();
  const build = parsed.jobs.windows;
  const desktop = parsed.jobs['windows-desktop'];
  assert.deepEqual(desktop.needs, ['reuse', 'windows']);
  assert.equal(desktop['runs-on'], build['runs-on']);
  assert.deepEqual(desktop.env, build.env);
  for (const name of ['Set up Node.js', 'Install locked dependencies', 'Install Codex CLI for offline startup checks']) {
    const original = build.steps.find(step => step.name === name);
    assert.deepEqual(desktop.steps.find(step => step.name === name), original);
  }
  assert.equal(build.steps.filter(step => step.run === 'npm run dist').length, 1);
  assert.equal(build.steps.filter(step => step.run === 'npm test').length, 1);
  assert.ok(build.steps.some(step => step.run === 'node scripts/verify-update-artifacts.cjs'));
  assert.ok(build.steps.some(step => step.name === 'Verify voice packaging'));
  assert.ok(!desktop.steps.some(step => /npm run dist|^npm test$/m.test(step.run || '')));
  const setup = desktop.steps.find(step => step.run === 'node scripts/build-ssh-askpass.cjs');
  assert.ok(setup, 'Fresh shards must compile file-clipboard.exe and ssh-askpass.exe for the test harness');
  assert.equal(setup.if, undefined);
  assert.ok(desktop.steps.indexOf(setup) < desktop.steps.findIndex(step => step.run?.includes('scripts/retry.mjs')));
  const upload = build.steps.find(step => step.with?.name === 'Agentrix-windows-unpacked');
  assert.equal(upload.with.path, 'release/win-unpacked/');
  assert.equal(upload.with['include-hidden-files'], true);
  const download = desktop.steps.find(step => step.with?.name === upload.with.name);
  assert.ok(download.uses.startsWith('actions/download-artifact@'));
  assert.equal(download.with.path, 'release/win-unpacked');
  const focus = desktop.steps.find(step => step.run?.includes('verify-installer-payload.cjs'));
  const installer = desktop.steps.find(step => step.with?.name === 'Agentrix-windows-x64');
  assert.equal(installer.if, focus.if);
  assert.equal(installer.with.path, 'release');
  const artifact = build.steps.find(step => step.with?.name === 'Agentrix-windows-x64');
  assert.equal(artifact.with.path, 'release/Agentrix-Setup-*.exe\nrelease/Agentrix-Setup-*.exe.blockmap\nrelease/latest.yml\nrelease/SHA256SUMS.txt\nrelease/BUILD-INFO.txt\n');
  assert.equal(artifact.with['retention-days'], 30);
  assert.ok(!Object.values(parsed.jobs).some(job => job.steps.some(step => step.uses?.startsWith('actions/cache@') && /node_modules/.test(step.with?.path || ''))));
});

test('each shard uploads screenshots under a unique name and workspace retains the release-flow artifact name', async () => {
  const parsed = await workflow();
  const desktop = parsed.jobs['windows-desktop'];
  const entries = desktop.strategy.matrix.include;
  assert.deepEqual(Object.keys(desktop.strategy.matrix), ['include']);
  assert.equal(new Set(entries.map(entry => entry.screenshots)).size, 3);
  const workspace = desktop.steps.find(step => step.run?.includes('npm run test:workspace'));
  const shard = entries.find(entry => workspace.if === `matrix.shard == '${entry.shard}'`);
  assert.equal(shard.screenshots, 'desktop-test-screenshots');
  const screenshots = desktop.steps.find(step => step.with?.name === '${{ matrix.screenshots }}');
  assert.equal(screenshots.if, 'always()');
  assert.equal(screenshots.with['retention-days'], 7);
  assert.equal(screenshots.with['include-hidden-files'], true);
  assert.match(screenshots.with.path, /workspace-\*\/\*\.png/);
  assert.match(screenshots.with.path, /focus-motion-\*\/\*\.png/);
});

function evaluate(expression, { ref = 'refs/tags/v1.3.24', event = 'push', dryRun = false, reused = false,
  builds = {}, reuse = 'success', cancelled = false } = {}) {
  const needs = Object.fromEntries(['windows', 'windows-desktop', 'macos', 'linux', 'remote-linux'].map(id => [id, { result: builds[id] || 'success' }]));
  needs.reuse = { result: reuse, outputs: { 'run-id': reused ? '1234' : '' } };
  return vm.runInNewContext(expression, {
    github: { ref, event_name: event }, inputs: { release_dry_run: dryRun }, needs,
    startsWith: (value, prefix) => value.startsWith(prefix), always: () => true, cancelled: () => cancelled,
  });
}

test('release runs only for a version tag or explicit dry run, after every build/test succeeds or verified reuse', async () => {
  const { releaseJobCondition } = await helpers;
  const parsed = await workflow();
  assert.equal(parsed.jobs.release.if.replace(/\s+/g, ' ').trim(), releaseJobCondition);
  assert.deepEqual(new Set(parsed.jobs.release.needs), new Set(['reuse', 'windows', 'windows-desktop', 'macos', 'linux', 'remote-linux']));
  assert.equal(evaluate(releaseJobCondition), true);
  for (const id of ['windows', 'windows-desktop', 'macos', 'linux', 'remote-linux']) {
    for (const result of ['failure', 'cancelled', 'skipped']) assert.equal(evaluate(releaseJobCondition, { builds: { [id]: result } }), false);
  }
  const skipped = Object.fromEntries(['windows', 'windows-desktop', 'macos', 'linux', 'remote-linux'].map(id => [id, 'skipped']));
  assert.equal(evaluate(releaseJobCondition, { reused: true, builds: skipped }), true);
  assert.equal(evaluate(releaseJobCondition, { reused: true, reuse: 'failure' }), false);
  assert.equal(evaluate(releaseJobCondition, { reused: true, cancelled: true }), false);
  for (const event of ['push', 'pull_request', 'workflow_dispatch']) {
    assert.equal(evaluate(releaseJobCondition, { ref: 'refs/heads/main', event }), false);
  }
  for (const reused of [false, true]) {
    assert.equal(evaluate(releaseJobCondition, { ref: 'refs/heads/ci/preflight-test', event: 'workflow_dispatch', dryRun: true, reused }), true);
  }
  assert.equal(evaluate(releaseJobCondition, { ref: 'refs/heads/main', event: 'pull_request', dryRun: true }), false);
});

test('dry runs cannot create, upload or edit a release, even when dispatched on a tag', async () => {
  const { expectedRemoteJobs, releaseMutationCondition } = await helpers;
  const parsed = await workflow();
  assert.equal(parsed.on.workflow_dispatch.inputs.release_dry_run.type, 'boolean');
  assert.equal(parsed.on.workflow_dispatch.inputs.release_dry_run.default, false);
  const mutations = parsed.jobs.release.steps.filter(step => /gh release (?:create|upload|edit)/.test(step.run || ''));
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].if, releaseMutationCondition);
  assert.equal(evaluate(mutations[0].if), true);
  assert.equal(evaluate(mutations[0].if, { event: 'workflow_dispatch', dryRun: true }), false);
  assert.equal(evaluate(mutations[0].if, { ref: 'refs/heads/main', event: 'workflow_dispatch', dryRun: true }), false);
  delete mutations[0].if;
  assert.throws(() => expectedRemoteJobs(parsed), /Every release mutation/);
  mutations[0].if = "startsWith(github.ref, 'refs/tags/v')";
  assert.throws(() => expectedRemoteJobs(parsed), /Every release mutation/);
  mutations[0].if = releaseMutationCondition;
  parsed.jobs.release.steps.push({ name: 'Unexpected mutation', run: 'gh release create unsafe' });
  assert.throws(() => expectedRemoteJobs(parsed), /Every release mutation/);
});

test('reuse is queried only for main pushes, version tags and requested dry runs, with a full-build fallback', async () => {
  const { expectedRemoteJobs } = await helpers;
  const parsed = await workflow();
  const selection = parsed.jobs.reuse.steps.find(step => step.id === 'select');
  assert.equal(evaluate(selection.if, { ref: 'refs/heads/main' }), true);
  assert.equal(evaluate(selection.if), true);
  assert.equal(evaluate(selection.if, { ref: 'refs/heads/ci/preflight-test', event: 'workflow_dispatch' }), false);
  assert.equal(evaluate(selection.if, { ref: 'refs/heads/ci/preflight-test', event: 'workflow_dispatch', dryRun: true }), true);
  assert.equal(evaluate(selection.if, { ref: 'refs/pull/1/merge', event: 'pull_request' }), false);
  assert.deepEqual(JSON.parse(selection.env.REQUIRED_JOBS), expectedRemoteJobs(parsed).filter(job => job.name !== parsed.jobs.release.name).map(job => job.name));
  assert.equal(parsed.jobs.reuse.permissions.actions, 'read');
  assert.equal(parsed.jobs.reuse.permissions.contents, 'read');
  for (const id of ['windows', 'windows-desktop', 'remote-linux', 'macos', 'linux']) {
    assert.equal(parsed.jobs[id].if, "needs.reuse.outputs['run-id'] == ''");
    assert.equal(evaluate(parsed.jobs[id].if), true);
    assert.equal(evaluate(parsed.jobs[id].if, { reused: true }), false);
  }
  assert.equal(selection.run, 'node scripts/ci-select-build.mjs');
  assert.equal(parsed.jobs.reuse.outputs['artifact-ids'], '${{ steps.select.outputs.artifact-ids }}');
});

test('release downloads the four pinned artifact IDs in one step and verifies their hashes and version', async () => {
  const parsed = await workflow();
  const release = parsed.jobs.release;
  const downloads = release.steps.filter(step => step.uses?.startsWith('actions/download-artifact@'));
  assert.equal(downloads.length, 1);
  const download = downloads[0];
  assert.equal(download.with['artifact-ids'], "${{ needs.reuse.outputs['artifact-ids'] || steps.artifacts.outputs['artifact-ids'] }}");
  assert.equal(download.with['merge-multiple'], true);
  assert.equal(download.with.name, undefined);
  assert.equal(download.with.pattern, undefined);
  assert.equal(download.with['run-id'], "${{ needs.reuse.outputs['run-id'] || github.run_id }}");
  assert.equal(download.with['github-token'], '${{ github.token }}');
  assert.equal(download.with.path, 'release-assets');
  const current = release.steps.find(step => step.id === 'artifacts');
  assert.equal(current.if, "needs.reuse.outputs['run-id'] == ''");
  assert.equal(current.run, 'node scripts/ci-select-build.mjs --current-run');
  assert.ok(release.steps.indexOf(current) < release.steps.indexOf(download));
  assert.equal(release.permissions.actions, 'read');
  const version = release.steps.find(step => step.id === 'version');
  assert.match(version.run, /require\('\.\/package\.json'\)\.version/);
  assert.match(version.run, /test "\$GITHUB_REF_NAME" = "v\$version"/);
  assert.ok(!release.steps.some(step => /npm ci/.test(step.run || '')));
  assert.ok(release.steps.some(step => step.uses?.startsWith('actions/checkout@')));
  assert.equal(release.steps.find(step => step.uses?.startsWith('actions/setup-node@')).with['node-version'], '24');
  const verify = release.steps.find(step => step.name === 'Verify release assets and prepare notes');
  assert.match(verify.run, /changes=\$\(node scripts\/release-notes\.mjs --version "\$RELEASE_VERSION"\)/);
  assert.match(verify.run, /\$changes\n/);
  assert.doesNotMatch(verify.run, /A new light theme/);
  for (const file of ['SHA256SUMS.txt', 'SHA256SUMS-mac.txt', 'SHA256SUMS-linux-x64.txt', 'SHA256SUMS-linux-arm64.txt']) assert.ok(verify.run.includes(file));
  assert.match(verify.run, /tr -d '\\r' < BUILD-INFO\.txt \| grep -Fx "Commit: \$GITHUB_SHA"/);
  assert.doesNotMatch(verify.run, /test "\$RELEASE_TAG" = "v\$RELEASE_VERSION"/);
  assert.match(verify.run, /cat release-assets.txt\n\s*cat release-notes.md/);
  assert.ok(Object.values(verify.env).every(value => !String(value).includes('needs.windows.outputs')));
  assert.equal(release.env.RELEASE_DRY_RUN, "${{ github.event_name == 'workflow_dispatch' && inputs.release_dry_run }}");
  assert.ok(release.steps.every(step => !Object.hasOwn(step.env || {}, 'RELEASE_DRY_RUN')));
});

test('release commit verification accepts Windows CRLF build notes and rejects a different commit', { skip: process.platform === 'win32' }, async () => {
  const release = (await workflow()).jobs.release;
  const verify = release.steps.find(step => step.name === 'Verify release assets and prepare notes');
  const check = verify.run.split('\n').find(line => line.includes('grep -Fx "Commit: $GITHUB_SHA"'));
  const command = check.replace(' < BUILD-INFO.txt', '');
  const sha = 'a'.repeat(40);
  const run = commit => spawnSync('bash', ['-c', command], {
    input: `Agentrix — Windows x64 installer\r\nCommit: ${commit}\r\n`, encoding: 'utf8', env: { ...process.env, GITHUB_SHA: sha },
  });
  assert.equal(run(sha).status, 0);
  assert.equal(run('b'.repeat(40)).status, 1);
});

async function reuseFixture() {
  const { expectedRemoteJobs, installerArtifacts } = await helpers;
  const requiredJobs = expectedRemoteJobs(await workflow()).filter(job => job.conclusion === 'success').map(job => job.name);
  const repository = 'owner/Agentrix', sha = 'a'.repeat(40), runId = 500;
  const run = { id: 101, head_sha: sha, workflow_id: 7, path: '.github/workflows/build-windows.yml', run_attempt: 1,
    repository: { full_name: repository }, head_repository: { full_name: repository },
    event: 'workflow_dispatch', status: 'completed', conclusion: 'success' };
  const jobs = requiredJobs.map(name => ({ name, status: 'completed', conclusion: 'success' }));
  const artifacts = installerArtifacts.map((name, index) => ({ id: index + 1001, name, size_in_bytes: 100, expired: false,
    expires_at: '2026-11-10T00:00:00Z', workflow_run: { id: run.id, head_sha: sha } }));
  const data = { current: { ...run, id: runId }, runs: [run], byRun: { [run.id]: { jobs, artifacts } }, checked: {} };
  const reads = [];
  const read = async endpoint => {
    reads.push(endpoint);
    const url = new URL(endpoint, 'https://api.github.com');
    assert.ok(url.pathname.startsWith(`/repos/${repository}/actions/`));
    const match = /\/runs\/(\d+)(?:\/(jobs|artifacts))?$/.exec(url.pathname);
    if (match) {
      const id = Number(match[1]), key = match[2];
      if (key) {
        if (key === 'jobs') assert.equal(url.searchParams.get('filter'), 'latest');
        return structuredClone({ [key]: data.byRun[id][key], total_count: data.byRun[id][key].length });
      }
      return structuredClone(id === runId ? data.current : data.checked[id] || data.runs.find(candidate => candidate.id === id));
    }
    assert.equal(url.pathname, `/repos/${repository}/actions/workflows/build-windows.yml/runs`);
    assert.equal(url.searchParams.get('head_sha'), sha);
    assert.equal(url.searchParams.get('status'), 'success');
    return structuredClone({ workflow_runs: data.runs, total_count: data.runs.length });
  };
  return { data, reads, read, options: { repository, sha, runId, requiredJobs, now: () => Date.parse('2026-11-01T00:00:00Z') } };
}

test('reuse accepts only completed successful dispatch/push runs of this workflow, repository and exact commit', async () => {
  const { findReusableRun } = await helpers;
  for (const event of ['workflow_dispatch', 'push']) {
    const fixture = await reuseFixture();
    fixture.data.runs[0].event = event;
    fixture.data.runs[0].path += '@refs/heads/main';
    assert.deepEqual(await findReusableRun(fixture.read, fixture.options), { runId: 101, artifactIds: [1001, 1002, 1003, 1004] });
  }
  const invalid = [
    { id: 500 }, { id: '101' }, { run_attempt: undefined }, { head_sha: 'b'.repeat(40) }, { workflow_id: 8 },
    { path: '.github/workflows/other.yml' }, { event: 'pull_request' }, { event: 'pull_request_target' },
    { head_repository: { full_name: 'fork/Agentrix' } }, { repository: { full_name: 'fork/Agentrix' } },
    { head_repository: null }, { status: 'in_progress' }, { conclusion: 'failure' }, { conclusion: 'cancelled' },
  ];
  for (const change of invalid) {
    const fixture = await reuseFixture();
    Object.assign(fixture.data.runs[0], change);
    assert.equal(await findReusableRun(fixture.read, fixture.options), null, JSON.stringify(change));
    assert.ok(!fixture.reads.some(endpoint => endpoint.includes('/jobs?')));
  }
});

test('reuse rejects missing, duplicated, failed or skipped required jobs, including reuse-of-reuse runs', async () => {
  const { findReusableRun } = await helpers;
  for (let index = 0; index < 9; index++) {
    for (const result of ['missing', 'failure', 'skipped', 'cancelled', 'in_progress', 'duplicate']) {
      const fixture = await reuseFixture();
      const jobs = fixture.data.byRun[101].jobs;
      if (result === 'missing') jobs.splice(index, 1);
      else if (result === 'duplicate') jobs.push(jobs[index]);
      else if (result === 'in_progress') jobs[index].status = result;
      else jobs[index].conclusion = result;
      assert.equal(await findReusableRun(fixture.read, fixture.options), null, `${index}: ${result}`);
    }
  }
});

test('reuse rejects any missing, expired, empty or mismatched installer artifact', async () => {
  const { findReusableRun } = await helpers;
  for (let index = 0; index < 4; index++) {
    for (const change of [null, { expired: true }, { expires_at: '2026-10-31T00:00:00Z' }, { expires_at: 'invalid' },
      { id: undefined }, { id: '1001' }, { id: 0 }, { size_in_bytes: 0 },
      { workflow_run: { id: 102, head_sha: 'a'.repeat(40) } }, { workflow_run: { id: 101, head_sha: 'b'.repeat(40) } }]) {
      const fixture = await reuseFixture();
      const artifacts = fixture.data.byRun[101].artifacts;
      if (change) Object.assign(artifacts[index], change);
      else artifacts.splice(index, 1);
      assert.equal(await findReusableRun(fixture.read, fixture.options), null, `${index}: ${JSON.stringify(change)}`);
    }
  }
  const fixture = await reuseFixture();
  fixture.data.byRun[101].artifacts.push(fixture.data.byRun[101].artifacts[0]);
  assert.equal(await findReusableRun(fixture.read, fixture.options), null);
});

test('reuse requires at least an hour of artifact lifetime and four distinct IDs', async () => {
  const { findReusableRun } = await helpers;
  for (let index = 0; index < 4; index++) {
    const fixture = await reuseFixture();
    fixture.data.byRun[101].artifacts[index].expires_at = new Date(fixture.options.now() + 60 * 60_000 - 1).toISOString();
    assert.equal(await findReusableRun(fixture.read, fixture.options), null);
  }
  const fixture = await reuseFixture();
  for (const artifact of fixture.data.byRun[101].artifacts) artifact.expires_at = new Date(fixture.options.now() + 60 * 60_000).toISOString();
  assert.deepEqual(await findReusableRun(fixture.read, fixture.options), { runId: 101, artifactIds: [1001, 1002, 1003, 1004] });
  fixture.data.byRun[101].artifacts[1].id = 1001;
  assert.equal(await findReusableRun(fixture.read, fixture.options), null);
});

test('selection retains the original immutable IDs when names are replaced after artifact inspection', async () => {
  const { findReusableRun } = await helpers;
  const fixture = await reuseFixture();
  const read = async endpoint => {
    const result = await fixture.read(endpoint);
    if (endpoint.endsWith('/actions/runs/101')) {
      for (const artifact of fixture.data.byRun[101].artifacts) artifact.id += 1000;
    }
    return result;
  };
  assert.deepEqual(await findReusableRun(read, fixture.options), { runId: 101, artifactIds: [1001, 1002, 1003, 1004] });
  assert.deepEqual(fixture.data.byRun[101].artifacts.map(artifact => artifact.id), [2001, 2002, 2003, 2004]);
});

test('the extracted selector returns IDs for reuse and selects only current-run artifacts after a full build', async () => {
  const { selectBuild } = await import('../scripts/ci-select-build.mjs');
  const fixture = await reuseFixture();
  for (const artifact of fixture.data.byRun[101].artifacts) artifact.expires_at = '2099-11-10T00:00:00Z';
  const env = { GITHUB_REPOSITORY: fixture.options.repository, GITHUB_SHA: fixture.options.sha,
    GITHUB_RUN_ID: String(fixture.options.runId), REQUIRED_JOBS: JSON.stringify(fixture.options.requiredJobs) };
  assert.deepEqual(await selectBuild({ read: fixture.read, env }), { runId: 101, artifactIds: [1001, 1002, 1003, 1004] });
  fixture.data.byRun[500] = { artifacts: fixture.data.byRun[101].artifacts.map(artifact => ({
    ...artifact, id: artifact.id + 1000, workflow_run: { id: 500, head_sha: fixture.options.sha },
  })) };
  fixture.reads.length = 0;
  assert.deepEqual(await selectBuild({ currentRun: true, read: fixture.read, env }), { runId: 500, artifactIds: [2001, 2002, 2003, 2004] });
  assert.equal(fixture.reads.length, 1);
  assert.match(fixture.reads[0], /\/runs\/500\/artifacts\?/);
  fixture.data.byRun[500].artifacts.pop();
  await assert.rejects(selectBuild({ currentRun: true, read: fixture.read, env }), /no complete, unexpired installer artifacts/);
  assert.equal(await selectBuild({ read: () => { throw new Error('Private credential-bearing failure'); }, env }), null);
});

test('selector CLI falls back with empty outputs on lookup failure but fails current-run selection without leaking errors', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentrix-ci-select-build-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'reuse-output');
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path')), PATH: '',
    GH_TOKEN: 'private-test-token', GITHUB_REPOSITORY: 'owner/Agentrix', GITHUB_SHA: 'a'.repeat(40),
    GITHUB_RUN_ID: '500', REQUIRED_JOBS: '["Required build"]', GITHUB_OUTPUT: output };
  const script = path.join(__dirname, '../scripts/ci-select-build.mjs');
  const reuse = spawnSync(process.execPath, [script], { env, encoding: 'utf8' });
  assert.equal(reuse.status, 0, reuse.stderr);
  assert.equal(fs.readFileSync(output, 'utf8'), 'run-id=\nartifact-ids=\n');
  assert.match(reuse.stdout, /Building and testing this commit/);
  const currentOutput = path.join(directory, 'current-output');
  const current = spawnSync(process.execPath, [script, '--current-run'], { env: { ...env, GITHUB_OUTPUT: currentOutput }, encoding: 'utf8' });
  assert.equal(current.status, 1);
  assert.equal(fs.existsSync(currentOutput), false);
  assert.equal(current.stderr.trim(), 'Unable to select the verified installer artifacts.');
  for (const result of [reuse, current]) assert.doesNotMatch(result.stdout + result.stderr, /private-test-token|ENOENT|execFileSync/);
});

test('reuse checks later candidates and paginates jobs before accepting a complete build', async () => {
  const { findReusableRun } = await helpers;
  const fixture = await reuseFixture();
  fixture.data.runs.unshift({ ...fixture.data.runs[0], id: 102 });
  fixture.data.byRun[102] = { jobs: [] };
  const jobs = fixture.data.byRun[101].jobs;
  const read = async endpoint => {
    const url = new URL(endpoint, 'https://api.github.com');
    if (url.pathname.endsWith('/101/jobs')) {
      const page = Number(url.searchParams.get('page'));
      return { total_count: jobs.length, jobs: page === 1 ? jobs.slice(0, 4) : jobs.slice(4) };
    }
    return fixture.read(endpoint);
  };
  assert.deepEqual(await findReusableRun(read, fixture.options), { runId: 101, artifactIds: [1001, 1002, 1003, 1004] });
});

test('reuse rejects a rerun started during inspection and fails closed on incomplete API responses', async () => {
  const { findReusableRun } = await helpers;
  for (const change of [{ status: 'in_progress' }, { run_attempt: 2 }, { id: 102 }, { conclusion: 'failure' }]) {
    const fixture = await reuseFixture();
    fixture.data.checked[101] = { ...fixture.data.runs[0], ...change };
    assert.equal(await findReusableRun(fixture.read, fixture.options), null);
  }
  const fixture = await reuseFixture();
  fixture.data.current.path = '.github/workflows/other.yml';
  await assert.rejects(findReusableRun(fixture.read, fixture.options), /Current workflow identity/);
  await assert.rejects(findReusableRun(fixture.read, { ...fixture.options, requiredJobs: [] }), /nonempty/);
  const incomplete = await reuseFixture();
  await assert.rejects(findReusableRun(endpoint => endpoint.includes('/jobs?') ? { jobs: [] } : incomplete.read(endpoint), incomplete.options), /Incomplete jobs response/);
  await assert.rejects(findReusableRun(endpoint => endpoint.includes('/jobs?') ? { jobs: [], total_count: 9 } : incomplete.read(endpoint), incomplete.options), /Incomplete jobs pagination/);
});
