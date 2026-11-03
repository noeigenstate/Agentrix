const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { testPath, patchPaths, replaceFile, mirrorDirectory, taskDirectory, abort, safePath } = require('./data.cjs');
const { pythonPath, environmentPath } = require('./environment.cjs');
const {
  verifyEnvironment, workspaceControls, verifyControls, discardBytecode, rejectReports, logError,
  walk, subjectPlugin,
} = require('./integrity.cjs');

const cwdFor = ctx => path.join(ctx.workspaceRoot, 'worktree');
const testsFor = entry => [...entry.FAIL_TO_PASS, ...entry.PASS_TO_PASS];

function caseKey(nodeid) {
  const [file, ...names] = nodeid.split('::');
  return [file.replace(/\.py$/, '').replaceAll('/', '.'), ...names.slice(0, -1)].join('.') + '\0' + names.at(-1);
}

async function restoreTests(entry, row, ctx) {
  const cwd = cwdFor(ctx), mirror = mirrorDirectory(ctx, entry);
  const selected = [...new Set([...testsFor(entry).map(testPath), ...patchPaths(row.test_patch)])];
  const roots = new Set(selected.flatMap(file => {
    const parts = file.split('/'), index = parts.findIndex(part => /^(?:tests?|testing)$/.test(part));
    return index < 0 ? [] : [parts.slice(0, index + 1).join('/') + '/'];
  }));
  const inTests = file => [...roots].some(root => file.startsWith(root));
  const helpers = new Set(['conftest.py']);
  for (const file of selected) {
    const parts = file.split('/'); parts.pop();
    while (parts.length) { helpers.add(parts.join('/') + '/conftest.py'); parts.pop(); }
  }
  const fixes = new Set(patchPaths(row.patch));
  const baseFiles = (await ctx.tools.git(mirror, ['ls-tree', '-rz', '--name-only', entry.base], {
    signal: ctx.signal,
  })).split('\0').filter(Boolean);
  const files = new Set([...selected, ...baseFiles.filter(inTests), ...helpers]);
  await walk(cwd, ctx, async (file, record) => {
    if (record.type !== 'directory' && inTests(file)) files.add(file);
  });
  const present = new Set(baseFiles);
  for (const file of files) {
    if (fixes.has(file) && !selected.includes(file)) continue;
    abort(ctx);
    const content = present.has(file) ? await ctx.tools.git(mirror, ['show', entry.base + ':' + file], {
      signal: ctx.signal, raw: true,
    }) : null;
    await replaceFile(cwd, file, content);
  }
  await ctx.tools.git(cwd, ['apply', '--whitespace=nowarn', path.join(taskDirectory(ctx, entry), 'tests.patch')], {
    signal: ctx.signal,
  });
}

function resultOf(entry, report, code) {
  if (![0, 1].includes(code)) throw new Error('OSS tests could not run completely.');
  const expected = testsFor(entry).map(caseKey), actual = report.cases.map(item => item.classname + '\0' + item.name);
  if (new Set(actual).size !== actual.length || expected.length !== actual.length ||
    expected.some(key => !actual.includes(key)) || report.cases.some(item => !['passed', 'failed'].includes(item.outcome))) {
    throw new Error('OSS tests did not complete the validated suite.');
  }
  const outcomes = new Map(report.cases.map(item => [item.classname + '\0' + item.name, item.outcome]));
  const passed = actual.filter(key => outcomes.get(key) === 'passed').length;
  if (code === 0 && passed !== expected.length || code === 1 && passed === expected.length) {
    throw new Error('OSS test exit code disagrees with its report.');
  }
  return { testsPassed: passed, testsTotal: expected.length, outcomes };
}

async function runTests(entry, ctx, label) {
  abort(ctx);
  const log = path.join(ctx.artifactDirectory, label + '.log');
  const nonce = randomUUID();
  const plugins = entry.repo === 'pytest-dev/pytest' ? ['-p', 'pytester'] : [];
  await fs.mkdir(ctx.artifactDirectory, { recursive: true });
  let temporary;
  try {
    await rejectReports(ctx);
    await verifyEnvironment(ctx, environmentPath(ctx));
    await discardBytecode(ctx);
    const controls = await workspaceControls(ctx);
    const config = await pytestConfig(ctx);
    temporary = config.temporary;
    const args = ['--rootdir=' + cwdFor(ctx), '--confcutdir=' + cwdFor(ctx), '-c', config.file,
      '-o', 'addopts=', ...plugins, '-rA', '--tb=short', '--', ...testsFor(entry)];
    const runner = await fs.readFile(path.join(__dirname, 'pytest-runner.py'), 'utf8');
    const output = await ctx.session.execute(pythonPath(ctx), ['-I', '-B', '-c', runner, nonce, ...args], {
      cwd: cwdFor(ctx), timeoutMs: ctx.testTimeoutMs, log, network: false,
    });
    await rejectReports(ctx);
    await verifyEnvironment(ctx, environmentPath(ctx));
    await verifyControls(ctx, controls);
    const report = evidenceOf(entry, output, nonce), measured = resultOf(entry, report, output.code);
    if (ctx.reference && report.plugins.some(file => !subjectPlugin(file, entry.repo) && !ctx.reference.plugins?.includes(file))) {
      throw new Error('An OSS pytest plugin was not present in the validated reference.');
    }
    // Main writes the artifact from this grading invocation's events. No model-owned report is ever read.
    await fs.writeFile(path.join(ctx.artifactDirectory, label + '.xml'), xmlOf(report), { mode: 0o600 });
    return { ...measured, evidence: log, plugins: report.plugins };
  } catch (error) {
    await logError(ctx, label, error);
    if (ctx.signal?.aborted || error.fatal || error.infrastructure) throw error;
    throw new Error('OSS tests could not be graded; see the test log.');
  } finally { if (temporary) await fs.rm(temporary, { force: true }); }
}

async function pytestConfig(ctx) {
  for (const [name, section] of [['pytest.ini'], ['.pytest.ini'], ['pyproject.toml', 'tool.pytest.ini_options'],
    ['tox.ini', 'pytest'], ['setup.cfg', 'tool:pytest']]) {
    const file = path.join(cwdFor(ctx), name);
    const content = await fs.readFile(file, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (content !== undefined && (!section || content.split(/\r?\n/).some(line => line.trim() === '[' + section + ']'))) {
      return { file };
    }
  }
  const file = path.join(ctx.workspaceRoot, '.oss-config-' + randomUUID() + '.ini');
  await fs.writeFile(file, '[pytest]\n', { flag: 'wx', mode: 0o600 });
  return { file, temporary: file };
}

function evidenceOf(entry, output, nonce) {
  const prefix = 'AGENTRIX_OSS_EVIDENCE_' + nonce + '=';
  const frames = output.stdout.split(/\r?\n/).filter(line => line.startsWith(prefix));
  if (frames.length !== 1 || frames[0].length > 8 * 1024 * 1024) throw new Error('Missing or duplicate OSS process evidence.');
  const report = JSON.parse(frames[0].slice(prefix.length));
  if (report.version !== 1 || report.code !== output.code || !Array.isArray(report.collectionErrors) || report.collectionErrors.length ||
    !Array.isArray(report.events) || !report.events.length || !Array.isArray(report.plugins) || report.plugins.some(file => !safePath(file)) ||
    new Set(report.plugins).size !== report.plugins.length) throw new Error('Incomplete OSS process evidence.');
  const cases = new Map();
  const expected = new Set(testsFor(entry));
  for (const event of report.events) {
    if (!Array.isArray(event) || event.length !== 4 || !expected.has(event[0]) ||
      !['setup', 'call', 'teardown'].includes(event[1]) || !['passed', 'failed', 'skipped'].includes(event[2]) ||
      typeof event[3] !== 'boolean') throw new Error('Invalid OSS test phase evidence.');
    const [id, phase, outcome, xfail] = event;
    if (!cases.has(id)) cases.set(id, new Map());
    const phases = cases.get(id);
    if (phases.has(phase)) throw new Error('Duplicate OSS test phase evidence.');
    phases.set(phase, xfail ? 'skipped' : outcome);
  }
  return { plugins: report.plugins, cases: [...cases].map(([id, phases]) => {
    const [classname, name] = caseKey(id).split('\0');
    const outcome = phases.size !== 3 || phases.get('setup') !== 'passed' || phases.get('teardown') !== 'passed'
      ? 'error' : phases.get('call');
    return { classname, name, outcome };
  }) };
}

function xmlOf(report) {
  const escape = value => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);
  return '<testsuite>' + report.cases.map(item => '<testcase classname="' + escape(item.classname) + '" name="' + escape(item.name) + '">' +
    (item.outcome === 'passed' ? '' : '<' + (item.outcome === 'failed' ? 'failure' : item.outcome) + '/>') + '</testcase>').join('') + '</testsuite>';
}

module.exports = { cwdFor, testsFor, caseKey, restoreTests, resultOf, runTests };
