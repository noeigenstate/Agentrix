const fs = require('node:fs/promises');
const path = require('node:path');
const { git, command } = require('./process.cjs');
const { safePath, testFile } = require('./history.cjs');
const { dispatch } = require('./dispatch.cjs');

async function restoreTests(projectPath, cwd, task, signal) {
  for (const file of task.hiddenTests) {
    if (!safePath(file) || !testFile(file)) throw new Error('无效的隐藏测试路径。');
    let folder = cwd;
    const parts = file.split('/');
    for (const part of parts.slice(0, -1)) {
      folder = path.join(folder, part);
      const stat = await fs.lstat(folder).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error('隐藏测试目录不能是链接。');
      if (!stat) await fs.mkdir(folder);
    }
    const destination = path.join(cwd, file);
    const stat = await fs.lstat(destination).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (stat?.isSymbolicLink() || stat && !stat.isFile()) throw new Error('隐藏测试文件不能是链接。');
    const blob = await git(projectPath, ['show', `${task.commit}:${file}`], { signal });
    // Replace the inode so a worker-created hardlink cannot redirect this write outside the worktree.
    await fs.rm(destination, { force: true });
    await fs.writeFile(destination, blob, { mode: 0o600, flag: 'wx' });
  }
}

function testResult(output, exitCode) {
  const count = name => { const found = [...output.matchAll(new RegExp(`^# ${name} (\\d+)\\s*$`, 'gm'))].at(-1); return found ? Number(found[1]) : null; };
  const total = count('tests'), passed = count('pass'), failed = count('fail'), cancelled = count('cancelled'), skipped = count('skipped'), todo = count('todo');
  const unavailable = /ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|ERR_UNKNOWN_FILE_EXTENSION|SyntaxError:|Cannot find (?:module|package)/.test(output);
  if (!Number.isInteger(total) || total < 1 || passed === null || failed === null || cancelled > 0 || skipped > 0 || todo > 0 || unavailable) {
    throw new Error('隐藏测试无法完整运行，请查看测试日志。');
  }
  if (passed + failed !== total || exitCode === 0 && failed !== 0 || exitCode !== 0 && failed === 0) throw new Error('隐藏测试结果无效。');
  return { testsPassed: passed, testsTotal: total };
}

async function gradeTests({ projectPath, cwd, task, directory, signal, nodePath, env, timeoutMs = 120000 }) {
  await restoreTests(projectPath, cwd, task, signal);
  const testEnv = { ...env, ELECTRON_RUN_AS_NODE: '1', FORCE_COLOR: '0', NODE_DISABLE_COLORS: '1' };
  delete testEnv.NODE_TEST_CONTEXT;
  const result = await command(nodePath, ['--test', '--test-reporter=tap', ...task.hiddenTests], { cwd,
    env: testEnv, signal, timeoutMs, log: path.join(directory, 'tests.log') });
  return testResult(result.stdout + '\n' + result.stderr, result.code);
}

function reviewResult(answer) {
  const json = /^\s*```(?:json)?\s*\n([\s\S]*?)\n```\s*$/.exec(answer)?.[1] || answer.trim();
  let value;
  try { value = JSON.parse(json); } catch { throw new Error('盲审未返回有效的评分。'); }
  if (!value || !Number.isInteger(value.issues) || value.issues < 0 || value.issues > 1000) throw new Error('盲审未返回有效的评分。');
  return value.issues;
}

async function gradeReview(options) {
  // A separate directory contains only the task text and patch: no arm, model, timing, logs, Git history or journals.
  const cwd = path.join(options.directory, 'blind');
  await fs.mkdir(cwd, { mode: 0o700 });
  await fs.writeFile(path.join(cwd, 'change.patch'), options.diff, { mode: 0o600 });
  const result = await dispatch({ ...options, arm: 'opus', cwd, review: true,
    briefText: `Review the proposed change in change.patch against this task. Work read-only in this directory; do not inspect its parents or any experiment files. Do not delegate or modify files.
Count concrete correctness, security, performance or maintainability defects introduced by the patch. Do not count style preferences, missing hidden test files or issues already in the starting tree. You are not told who wrote the patch.
Return only a JSON object: {"issues": <nonnegative integer>, "findings": [<short concrete findings>]}. Do not use headings or a ledger section.
\nTask:\n${options.task.text}\n` });
  return reviewResult(result.answer);
}

module.exports = { restoreTests, testResult, gradeTests, reviewResult, gradeReview };
