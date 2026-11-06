const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const core = import('../scripts/affected-tests-core.mjs');
const cli = import('../scripts/affected-tests.mjs');
const ci = import('../scripts/affected-tests-ci.mjs');
const root = path.resolve(__dirname, '..');
let catalog;
const actual = async () => catalog ??= (await core).buildCatalog(root);

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-affected-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const write = (file, text) => { fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true }); fs.writeFileSync(path.join(directory, file), text); };
  const id = name => `src/${name}/BOUNDARY.md`;
  for (const name of ['a', 'b', 'c']) {
    write(id(name), `# Boundary: ${name}\n\n## Owns\n- \`src/${name}/**\`\n\n## Interface\n\n## May import\n\n## Invariants\n- One invariant\n\n## Not ours\n`);
    write(`src/${name}/index.ts`, name === 'a' ? "export * from '../bridge';" : 'export const value = 1;');
    write(`tests/${name}.test.cjs`, `require('../src/${name}/index.ts');`);
  }
  write('src/bridge.ts', "export * from './b/index';");
  write('electron/main.cjs', "require('../src/c/index.ts');");
  write('tests/global.test.cjs', '// global'); write('scripts/a-smoke.mjs', '// GUI');
  const manifest = { fullOn: ['src/shared/**', 'electron/main.cjs', 'electron/preload.cjs', 'electron/**/ipc.cjs', 'package.json', 'package-lock.json', '.github/**', 'scripts/**', 'tests/fixtures/**'],
    globalTests: ['tests/global.test.cjs'], tests: {}, gui: { a: { file: 'scripts/a-smoke.mjs', shard: 'reading', modules: [id('a')] } }, dynamicLoads: {},
    ignored: [{ glob: '.notes/**', reason: 'Local evidence only' }] };
  return { directory, write, manifest, id };
}

test('every repository test belongs to a boundary or the explicit global list, and every GUI entry is covered exactly once', async () => {
  const c = await actual();
  assert.deepEqual(c.errors, []);
  for (const file of c.tests) assert.ok(c.memberships.get(file).length || c.globalTests.has(file), file);
  const { suites } = await import('../scripts/gui-suites.mjs');
  assert.deepEqual(Object.keys(c.manifest.gui).sort(), [...suites, 'focus-motion'].sort());
  const { parseWorkflow } = await import('../scripts/ci-preflight-core.mjs');
  const workflow = parseWorkflow(fs.readFileSync(path.join(root, '.github/workflows/build-windows.yml'), 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const { guiForStep } = await ci;
  const guiSteps = workflow.jobs['windows-desktop'].steps.filter(step => /npm run test:|scripts\/[\w-]+-smoke\.mjs|scripts\/retry\.mjs/.test(step.run ?? ''));
  const names = guiSteps.map(step => guiForStep(step.run, c.manifest, pkg));
  assert.ok(names.every(Boolean));
  assert.deepEqual(names.sort(), Object.keys(c.manifest.gui).sort());
  for (const step of guiSteps) assert.ok(step.if.endsWith(`&& contains(fromJSON(needs.windows.outputs.gui), '${guiForStep(step.run, c.manifest, pkg)}')`), step.name);
  assert.equal(workflow.jobs.windows.steps.find(step => step.id === 'affected').env.AFFECTED_FULL_MATRIX, '${{ inputs.full_matrix }}');
  assert.equal(workflow.jobs.windows.steps.find(step => step.name === 'Check out source').with['fetch-depth'], 0);
  for (const file of ['electron/features/terminal/native-ipc.cjs', 'electron/ipc-adapter.cjs']) assert.equal((await core).globalChange(file, c.manifest), true);
});

test('reverse imports propagate through unowned intermediates, without running an unrelated module', async t => {
  const f = fixture(t), { buildCatalog, selectTests } = await core;
  const c = buildCatalog(f.directory, f.manifest);
  assert.deepEqual(c.errors, []);
  const p = selectTests(c, ['src/b/index.ts']);
  assert.equal(p.full, false);
  assert.deepEqual(p.modules, [f.id('a'), f.id('b')]);
  assert.deepEqual(p.unit, ['tests/a.test.cjs', 'tests/b.test.cjs', 'tests/global.test.cjs']);
  assert.deepEqual(p.gui, ['a']);
  assert.match(p.reasons[f.id('a')].join(), /Imports affected/);
});

test('unknown files, missing ownership, dynamic-load changes and every shared trigger fail closed', async t => {
  const f = fixture(t), { buildCatalog, selectTests } = await core;
  const c = buildCatalog(f.directory, f.manifest);
  for (const file of ['new.js', 'src/bridge.ts', 'src/shared/types.ts', 'electron/main.cjs', 'electron/preload.cjs', 'electron/features/x/ipc.cjs', 'package.json', 'package-lock.json', '.github/workflows/new.yml', 'scripts/helper.mjs', 'tests/fixtures/new.cjs']) {
    const p = selectTests(c, [file]); assert.equal(p.full, true, file); assert.equal(p.unit.length, c.tests.length);
  }
  f.write('tests/unmapped.test.cjs', '// no imports');
  assert.match(buildCatalog(f.directory, f.manifest).errors.join(), /no module or explicit global/);
  f.write('tests/nested/b.test.cjs', "require('../../src/b/index.ts');");
  assert.match(buildCatalog(f.directory, f.manifest).errors.join(), /outside the full runner's discovery contract/);
  f.write('src/b/index.ts', 'require(variable);');
  const broken = buildCatalog(f.directory, f.manifest);
  assert.match(broken.errors.join(), /Unclassified dynamic load/);
  assert.equal(selectTests(broken, ['src/c/index.ts']).full, true);
  f.write('src/b/index.ts', 'const indirect = require; indirect(variable);');
  assert.match(buildCatalog(f.directory, f.manifest).errors.join(), /Unclassified dynamic load/);
});

test('a smoke-only change selects its suites and importing tests; notes do not broaden selection', async t => {
  const f = fixture(t), { buildCatalog, selectTests } = await core;
  const c = buildCatalog(f.directory, f.manifest);
  const p = selectTests(c, ['scripts/a-smoke.mjs', '.notes/r13-evidence.md']);
  assert.equal(p.full, false); assert.deepEqual(p.gui, ['a']); assert.deepEqual(p.unit, ['tests/global.test.cjs']);
  assert.deepEqual(p.modules, []);
});

test('declared and pinned dynamic dependencies propagate; a stale pin or stale explicit test mapping forces full coverage', async t => {
  const f = fixture(t), { buildCatalog, selectTests } = await core;
  f.write('src/a/index.ts', 'require(variable);');
  const { createHash } = require('node:crypto');
  f.manifest.dynamicLoads['src/a/index.ts'] = { digest: createHash('sha256').update('require(variable);').digest('hex'), targets: ['src/b/index.ts'], reason: 'Fixture runtime module binding' };
  let c = buildCatalog(f.directory, f.manifest);
  assert.deepEqual(c.errors, []);
  assert.deepEqual(selectTests(c, ['src/b/index.ts']).modules, [f.id('a'), f.id('b')]);
  f.manifest.dynamicLoads['src/a/index.ts'].digest = 'stale';
  c = buildCatalog(f.directory, f.manifest); assert.equal(selectTests(c, []).full, true);
  f.write('src/a/index.ts', 'export const value = 1;'); delete f.manifest.dynamicLoads['src/a/index.ts'];
  f.write(f.id('a'), fs.readFileSync(path.join(f.directory, f.id('a')), 'utf8').replace('## May import\n', '## May import\n- `src/b/**`\n'));
  c = buildCatalog(f.directory, f.manifest);
  assert.deepEqual(selectTests(c, ['src/b/index.ts']).modules, [f.id('a'), f.id('b')]);
  f.manifest.globalTests.push('tests/deleted.test.cjs');
  assert.match(buildCatalog(f.directory, f.manifest).errors.join(), /Stale global test/);
});

test('the Codex module skips independent Claude budget and connection tests; mixed-provider tests remain conservatively selected', async () => {
  const p = (await core).selectTests(await actual(), ['electron/features/codex-app-server/index.cjs']);
  assert.equal(p.full, false);
  assert.ok(p.unit.includes('tests/native-commands-codex.test.cjs'));
  for (const file of ['tests/claude-sdk-budget.test.cjs', 'tests/claude-sdk-connection.test.cjs', 'tests/claude-sdk-availability.test.cjs']) assert.ok(![...p.unit, ...p.real].includes(file), file);
  assert.ok(p.unit.includes('tests/claude-sdk-runtime.test.cjs'), 'this file imports Codex workerEnvironment too');
});

test('--run keeps selected file argv, rejects ambiguous options, and never permits clipboard suites with CI=true alone', async () => {
  const { runCommands, parseOptions } = await cli;
  const c = await actual(), plan = { unit: ['tests/affected-tests.test.cjs'], real: [], python: [], gui: ['clipboard', 'composer', 'session', 'gpu-terminal', 'workspace', 'editor-terminals'] };
  assert.deepEqual(runCommands(plan, c, { env: { CI: 'true' } }).at(-1).args, ['--test', '--test-concurrency=4', 'tests/affected-tests.test.cjs']);
  assert.equal(runCommands(plan, c, { kind: 'gui', env: { GITHUB_ACTIONS: 'true' } }).length, 1);
  for (const args of [['--base'], ['--base', 'a', '--base', 'b'], ['--kind', 'bad'], ['--plan', 'p', '--base', 'b'], ['--wat']]) assert.throws(() => parseOptions(args));
});

test('the --run entrypoint executes only selected unit argv and returns the first child failure', async t => {
  const { main } = await cli, f = fixture(t);
  const plan = { version: 1, full: false, fullReasons: [], base: 'base', head: 'head', unit: ['tests/affected-tests.test.cjs'], real: [], python: [], gui: [], shards: [], reasons: {} };
  f.write('plan.json', JSON.stringify(plan));
  const args = ['--plan', path.join(f.directory, 'plan.json'), '--run', '--kind', 'unit'], calls = [];
  assert.equal(main(args, (file, argv) => { calls.push([file, argv]); return { status: 0 }; }), 0);
  assert.deepEqual(calls.map(([, argv]) => argv), [['scripts/build-ssh-askpass.cjs'], ['scripts/build-mac-titlebar.cjs', '--optional'], ['--test', '--test-concurrency=4', 'tests/affected-tests.test.cjs']]);
  let count = 0;
  assert.equal(main(args, () => { count++; return { status: 7 }; }), 7);
  assert.equal(count, 1);
});

test('a CI baseline must have actually run all Windows tests; skipped groups and rerun races cannot serve as a baseline', async () => {
  const { findFullBetaBaseline } = await ci;
  const repository = 'owner/repo', sha = 'a'.repeat(40);
  const run = { id: 1, workflow_id: 7, path: '.github/workflows/build-windows.yml', run_attempt: 1, head_sha: sha, head_branch: 'beta',
    repository: { full_name: repository }, head_repository: { full_name: repository }, event: 'push', status: 'completed', conclusion: 'success' };
  const job = (name, steps = []) => ({ name, status: 'completed', conclusion: 'success', steps: steps.map(name => ({ name, conclusion: 'success' })) });
  const jobs = [job('Select tested build'), job('Windows x64 build', ['Run unit and integration tests', 'Real Claude CLI contract (offline)']), job('Windows desktop interaction', ['gui-a']), job('Windows desktop terminals', ['gui-b']), job('Windows desktop reading', ['gui-c'])];
  let checked = run;
  const read = async url => url.includes('/workflows/') ? { total_count: 1, workflow_runs: [run] } : url.includes('/jobs?') ? { total_count: jobs.length, jobs } : checked;
  const options = { read, repository, runId: 2, workflowId: 7, workflowPath: run.path, guiNames: ['gui-a', 'gui-b', 'gui-c'], ancestor: () => true };
  assert.deepEqual(await findFullBetaBaseline(options), { sha, runId: 1 });
  jobs[2].steps[0].conclusion = 'skipped'; assert.equal(await findFullBetaBaseline(options), null);
  jobs[2].steps[0].conclusion = 'success'; checked = { ...run, run_attempt: 2 }; assert.equal(await findFullBetaBaseline(options), null);
  checked = run; assert.equal(await findFullBetaBaseline({ ...options, ancestor: () => false }), null);
});
