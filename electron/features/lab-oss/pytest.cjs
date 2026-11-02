const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { testPath, patchPaths, replaceFile, mirrorDirectory, taskDirectory, abort } = require('./data.cjs');
const { pythonPath } = require('./environment.cjs');

const cwdFor = ctx => path.join(ctx.workspaceRoot, 'worktree');
const testsFor = entry => [...entry.FAIL_TO_PASS, ...entry.PASS_TO_PASS];

function caseKey(nodeid) {
  const [file, ...names] = nodeid.split('::');
  return [file.replace(/\.py$/, '').replaceAll('/', '.'), ...names.slice(0, -1)].join('.') + '\0' + names.at(-1);
}

async function restoreTests(entry, row, ctx) {
  const cwd = cwdFor(ctx), mirror = mirrorDirectory(ctx, entry);
  const files = [...new Set([...testsFor(entry).map(testPath), ...patchPaths(row.test_patch)])];
  const helpers = new Set(['conftest.py', 'pytest.ini', 'pyproject.toml', 'setup.cfg', 'tox.ini']);
  for (const file of files) {
    const parts = file.split('/'); parts.pop();
    while (parts.length) { helpers.add(parts.join('/') + '/conftest.py'); parts.pop(); }
  }
  for (const file of helpers) if (!files.includes(file)) files.push(file);
  const present = new Set((await ctx.tools.git(mirror, ['ls-tree', '-rz', '--name-only', entry.base, '--', ...files], {
    signal: ctx.signal,
  })).split('\0').filter(Boolean));
  for (const file of files) {
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
  const report = path.join(ctx.workspaceRoot, '.oss-junit-' + randomUUID() + '.xml');
  const log = path.join(ctx.artifactDirectory, label + '.log');
  const plugins = entry.repo === 'pytest-dev/pytest' ? ['-p', 'pytester'] : [];
  const args = ['--rootdir=' + cwdFor(ctx), '-o', 'addopts=', '-o', 'junit_family=legacy', ...plugins,
    '-rA', '--tb=short', '--junitxml=' + report, '--', ...testsFor(entry)];
  const script = [
    'import os, sys',
    'os.environ["PYTEST_DISABLE_PLUGIN_AUTOLOAD"] = "1"',
    'import pytest',
    'raise SystemExit(pytest.main(sys.argv[1:]))',
  ].join('\n');
  await fs.mkdir(ctx.artifactDirectory, { recursive: true });
  let output;
  try {
    output = await ctx.session.execute(pythonPath(ctx), ['-I', '-c', script, ...args], {
      cwd: cwdFor(ctx), timeoutMs: ctx.testTimeoutMs, log, network: false,
    });
    const stat = await fs.lstat(report);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) throw new Error('Invalid OSS JUnit report.');
    const xml = await fs.readFile(report, 'utf8');
    if (!/^\s*(?:<\?xml[^>]*>\s*)?<testsuites?\b/.test(xml) || !/<\/testsuites?>\s*$/.test(xml) ||
      /<!DOCTYPE|<!ENTITY/.test(xml) || (xml.match(/<testsuite\b/g) || []).length !== (xml.match(/<\/testsuite>/g) || []).length) {
      throw new Error('Invalid OSS JUnit report.');
    }
    const measured = resultOf(entry, ctx.tools.junit(xml), output.code);
    await fs.writeFile(path.join(ctx.artifactDirectory, label + '.xml'), xml, { mode: 0o600 });
    return { ...measured, evidence: log };
  } catch (error) {
    if (ctx.signal?.aborted || error.fatal || error.infrastructure) throw error;
    throw new Error('OSS tests could not be graded; see the test log.');
  } finally { await fs.rm(report, { force: true }); }
}

module.exports = { cwdFor, testsFor, caseKey, restoreTests, resultOf, runTests };
