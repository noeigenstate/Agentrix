const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { git } = require('./process.cjs');
const { safePath, testFile } = require('./history.cjs');
const { dispatch } = require('./dispatch.cjs');

async function restoreTests(projectPath, cwd, task, signal, files = task.hiddenTests.map(file => ({ file }))) {
  for (const { file, deleted } of files) {
    if (!safePath(file) || !file.startsWith('tests/')) throw new Error('无效的隐藏测试路径。');
    let folder = cwd;
    for (const part of file.split('/').slice(0, -1)) {
      folder = path.join(folder, part);
      const stat = await fs.lstat(folder).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error('隐藏测试目录不能是链接。');
      if (!stat) await fs.mkdir(folder);
    }
    const destination = path.join(cwd, file);
    const stat = await fs.lstat(destination).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (stat?.isSymbolicLink() || stat && !stat.isFile()) throw new Error('隐藏测试文件不能是链接。');
    const blob = deleted ? null : await git(projectPath, ['show', task.commit + ':' + file], { signal, raw: true });
    await fs.rm(destination, { force: true });
    if (blob !== null) await fs.writeFile(destination, blob, { mode: 0o600, flag: 'wx' });
  }
}

function testResult(output, exitCode, reference) {
  const count = name => {
    const found = [...output.matchAll(new RegExp('^# ' + name + ' (\\d+)\\s*$', 'gm'))].at(-1);
    return found ? Number(found[1]) : null;
  };
  const total = count('tests'), passed = count('pass'), failed = count('fail');
  const cancelled = count('cancelled'), skipped = count('skipped'), todo = count('todo');
  const unavailable = /ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|ERR_UNKNOWN_FILE_EXTENSION|SyntaxError:|Cannot find (?:module|package)/;
  const names = [...output.matchAll(/^\s*# Subtest: (.+)$/gm)].map(match => match[1]).sort();
  if (!Number.isInteger(total) || total < 1 || passed === null || failed === null ||
    cancelled > 0 || skipped > 0 || todo > 0 || unavailable.test(output) || !/^1\.\.\d+\s*$/m.test(output)) {
    throw new Error('隐藏测试无法完整运行，请查看测试日志。');
  }
  if (passed + failed !== total || exitCode === 0 && failed !== 0 || exitCode !== 0 && failed === 0) {
    throw new Error('隐藏测试结果无效。');
  }
  if (reference && (total !== reference.total || JSON.stringify(names) !== JSON.stringify(reference.names))) {
    throw new Error('Hidden tests did not complete the validated reference suite.');
  }
  return { testsPassed: passed, testsTotal: total, names };
}

async function gradeTests({
  projectPath, cwd, task, directory, signal, nodePath = process.execPath, session,
  timeoutMs = 120000, reference, restore = true,
}) {
  if (task.hiddenTests.some(file => !safePath(file) || !testFile(file))) throw new Error('无效的隐藏测试路径。');
  if (restore) await restoreTests(projectPath, cwd, task, signal, reference?.files);
  const result = await session.execute(nodePath, ['--test', '--test-reporter=tap', ...task.hiddenTests], {
    cwd, timeoutMs, log: path.join(directory, 'tests.log'),
  });
  return testResult(result.stdout + '\n' + result.stderr, result.code, reference);
}

function reviewResult(answer) {
  const json = /^\s*\x60{3}(?:json)?\s*\n([\s\S]*?)\n\x60{3}\s*$/.exec(answer)?.[1] || answer.trim();
  let value;
  try { value = JSON.parse(json); } catch { throw new Error('盲审未返回有效的评分。'); }
  if (!value || !Number.isInteger(value.issues) || value.issues < 0 || value.issues > 1000) {
    throw new Error('盲审未返回有效的评分。');
  }
  return value.issues;
}

async function gradeReview(options) {
  const cwd = path.join(options.session.labRoot, 'reviews', options.session.runId, randomUUID());
  await fs.mkdir(cwd, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(cwd, 'change.patch'), options.diff, { mode: 0o600 });
  const brief = [
    'Review change.patch against the task below. Work read-only in this folder. Do not delegate.',
    'Count concrete correctness, security, performance or maintainability defects introduced by the patch.',
    'Do not count style preferences, missing hidden tests or pre-existing issues. You are not told its author.',
    'Return only JSON: {"issues": <nonnegative integer>, "findings": [<short concrete findings>]}.',
    'Do not add headings or a ledger section.', '', 'Task:', options.task.text,
  ].join('\n');
  const result = await dispatch({ ...options, arm: 'opus', cwd, review: true, briefText: brief });
  return reviewResult(result.answer);
}

module.exports = { restoreTests, testResult, gradeTests, reviewResult, gradeReview };
