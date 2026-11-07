const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
beforeEach(t => t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 4) }));

async function fixture(windowsOnly) {
  const core = await import('../scripts/ci-preflight-core.mjs');
  const workflow = core.parseWorkflow(fs.readFileSync(path.join(__dirname, '../.github/workflows/build-windows.yml'), 'utf8'));
  const expression = workflow.jobs.reuse.steps.find(step => step.id === 'select').env.REQUIRED_JOBS;
  const requiredJobs = JSON.parse(vm.runInNewContext(expression.replace(/^\$\{\{\s*|\s*\}\}$/g, ''), {
    env: { WINDOWS_ONLY: String(windowsOnly) },
  }));
  const sha = 'a'.repeat(40), repository = 'owner/Agentrix';
  const run = { id: 101, run_attempt: 1, workflow_id: 7, path: core.workflowFile, head_sha: sha,
    repository: { full_name: repository }, head_repository: { full_name: repository },
    status: 'completed', conclusion: 'success', event: 'workflow_dispatch' };
  const jobs = core.expectedRemoteJobs(workflow, { windowsOnly }).map(job => ({ ...job, status: 'completed' }));
  const artifacts = (windowsOnly ? core.installerArtifacts.slice(0, 1) : core.installerArtifacts).map((name, index) => ({
    name, id: 1001 + index, expired: false, expires_at: '2099-01-01T00:00:00Z', size_in_bytes: 128,
    workflow_run: { id: 101, head_sha: sha },
  }));
  const read = async endpoint => {
    if (endpoint.includes('/workflows/')) return { total_count: 1, workflow_runs: [run] };
    if (endpoint.includes('/jobs?')) return { total_count: jobs.length, jobs };
    if (endpoint.includes('/artifacts?')) return { total_count: artifacts.length, artifacts };
    if (endpoint.endsWith('/101')) return run;
    if (endpoint.endsWith('/500')) return { ...run, id: 500 };
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };
  return { core, run, jobs, artifacts, read, env: { GITHUB_REPOSITORY: repository, GITHUB_SHA: sha,
    GITHUB_RUN_ID: '500', REQUIRED_JOBS: JSON.stringify(requiredJobs), WINDOWS_ONLY: String(windowsOnly) } };
}

test('beta selects only Windows artifacts from a green dispatch on the exact commit; stable cannot reuse it', async () => {
  const { selectBuild } = await import('../scripts/ci-select-build.mjs');
  const beta = await fixture(true);
  assert.equal(JSON.parse(beta.env.REQUIRED_JOBS).length, 5);
  assert.deepEqual(await selectBuild(beta), { runId: 101, artifactIds: [1001] });
  const stable = await fixture(false);
  assert.equal(JSON.parse(stable.env.REQUIRED_JOBS).length, 9);
  assert.equal(await selectBuild({ read: beta.read, env: stable.env }), null);
  // Even with all four artifacts present, skipped non-Windows tests disqualify a stable release.
  beta.artifacts.push(...stable.artifacts.slice(1));
  assert.equal(await selectBuild({ read: beta.read, env: stable.env }), null);
  assert.deepEqual(await selectBuild(stable), { runId: 101, artifactIds: [1001, 1002, 1003, 1004] });
  // A beta may reuse a full-matrix build, but publishes only its Windows artifact ID.
  assert.deepEqual(await selectBuild({ read: stable.read, env: beta.env }), { runId: 101, artifactIds: [1001] });
});

test('a beta exact-commit green build can contain skipped unaffected suite steps, while required jobs must still succeed', async () => {
  const { selectBuild } = await import('../scripts/ci-select-build.mjs');
  const f = await fixture(true);
  f.jobs.find(job => job.name === 'Windows desktop terminals').steps = [{ name: 'Unaffected suite', conclusion: 'skipped' }];
  assert.deepEqual(await selectBuild(f), { runId: 101, artifactIds: [1001] });
  f.jobs.find(job => job.name === 'Windows desktop terminals').conclusion = 'skipped';
  assert.equal(await selectBuild(f), null, 'the logging/gating job itself must complete successfully');
});

test('beta rejects every unsuccessful Windows job and invalid Windows artifact using the shared validators', async () => {
  const { selectBuild } = await import('../scripts/ci-select-build.mjs');
  for (const name of JSON.parse((await fixture(true)).env.REQUIRED_JOBS)) {
    for (const result of ['missing', 'duplicate', 'skipped', 'failure', 'cancelled']) {
      const f = await fixture(true);
      const index = f.jobs.findIndex(job => job.name === name);
      if (result === 'missing') f.jobs.splice(index, 1);
      else if (result === 'duplicate') f.jobs.push(f.jobs[index]);
      else f.jobs[index].conclusion = result;
      assert.equal(await selectBuild(f), null, `${name}: ${result}`);
    }
  }
  for (const change of [null, { expired: true }, { size_in_bytes: 0 }, { expires_at: 'invalid' },
    { workflow_run: { id: 102, head_sha: 'a'.repeat(40) } }, { id: 0 }]) {
    const f = await fixture(true);
    if (change) Object.assign(f.artifacts[0], change);
    else f.artifacts.pop();
    assert.equal(await selectBuild(f), null);
  }
  const f = await fixture(true);
  f.run.head_sha = 'b'.repeat(40);
  assert.equal(await selectBuild(f), null);
});

test('current-run beta selection requires only Windows; the default still requires all four artifacts', async () => {
  const { selectBuild } = await import('../scripts/ci-select-build.mjs');
  const f = await fixture(true);
  for (const artifact of f.artifacts) artifact.workflow_run.id = 500;
  assert.deepEqual(await selectBuild({ ...f, currentRun: true }), { runId: 500, artifactIds: [1001] });
  await assert.rejects(selectBuild({ ...f, currentRun: true, env: { ...f.env, WINDOWS_ONLY: 'false' } }), /no complete/);
  for (const names of [[], ['unknown'], ['Agentrix-windows-x64', 'Agentrix-windows-x64']]) {
    await assert.rejects(f.core.findInstallerArtifactIds(f.read, {
      repository: f.env.GITHUB_REPOSITORY, sha: f.env.GITHUB_SHA, runId: 500, artifactNames: names,
    }), /Invalid installer artifact selection/);
  }
});

test('only beta tags reuse a marked beta build-only dispatch, never main or stable even with every artifact present', async () => {
  const { selectBuild } = await import('../scripts/ci-select-build.mjs');
  const f = await fixture(true);
  f.run.head_branch = 'beta';
  f.env.GITHUB_REF = 'refs/tags/v8.2.7-beta.1'; f.env.ALLOW_BUILD_ONLY = 'true';
  f.jobs.find(job => job.name === 'Windows x64 build').steps = [{ name: 'Record beta build-only mode', conclusion: 'success' }];
  for (const job of f.jobs.filter(job => job.name.startsWith('Windows desktop '))) job.conclusion = 'skipped';
  assert.deepEqual(await selectBuild(f), { runId: 101, artifactIds: [1001] });
  for (const name of ['Select tested build', 'Windows x64 build']) {
    const job = f.jobs.find(row => row.name === name);
    for (const conclusion of ['failure', 'cancelled', 'skipped']) {
      job.conclusion = conclusion; assert.equal(await selectBuild(f), null, `${name}: ${conclusion}`);
    }
    job.conclusion = 'success';
  }
  f.artifacts[0].expired = true; assert.equal(await selectBuild(f), null);
  f.artifacts[0].expired = false;
  for (const ref of ['refs/heads/main', 'refs/heads/beta', 'refs/tags/v8.2.7', 'refs/tags/v8.2.7-rc.1']) {
    assert.equal(await selectBuild({ ...f, env: { ...f.env, GITHUB_REF: ref } }), null, ref);
  }
  assert.equal(await selectBuild({ ...f, env: { ...f.env, ALLOW_BUILD_ONLY: 'false' } }), null);
  for (const field of ['head_branch', 'event']) {
    const before = f.run[field]; f.run[field] = field === 'event' ? 'push' : 'main';
    assert.equal(await selectBuild(f), null); f.run[field] = before;
  }
  const marker = f.jobs.find(job => job.steps).steps[0]; marker.conclusion = 'skipped';
  assert.equal(await selectBuild(f), null, 'skipped GUI jobs alone do not prove an authorized build-only run');
  marker.conclusion = 'success';
  for (const job of f.jobs) job.conclusion = 'success';
  const stable = await fixture(false); f.artifacts.push(...stable.artifacts.slice(1));
  assert.equal(await selectBuild({ ...f, env: { ...stable.env, GITHUB_REF: 'refs/heads/main', ALLOW_BUILD_ONLY: 'true' } }), null);
  assert.equal(await selectBuild({ ...f, env: { ...stable.env, GITHUB_REF: 'refs/tags/v8.2.7', ALLOW_BUILD_ONLY: 'true' } }), null);
});
