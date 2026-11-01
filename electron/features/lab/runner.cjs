const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { LabUsage, phaseEvidence } = require('./usage.cjs');
const { LabSession, recoverRuns } = require('./session.cjs');
const { dispatch } = require('./dispatch.cjs');
const { gradeTests, gradeReview } = require('./grading.cjs');
const { gradingFiles } = require('./history.cjs');
const { removePath } = require('./disk.cjs');
const { translate } = require('../../i18n.cjs');
const {
  ownerState, assertOwner, inside, prepareWorktree, verifyWorktree, captureDiff, cleanupWorktrees,
} = require('./workspace.cjs');

async function sessionOptions(options, before, workspaceRoot) {
  const { project, helper, directory, socketDirectory, run,
    t = (source, values) => translate('zh', source, values) } = options;
  const dependencies = await fs.realpath(path.join(project.path, 'node_modules')).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  const otherTrees = before.worktrees.split('\0').filter(line => line.startsWith('worktree ')).map(line => line.slice(9));
  const home = os.homedir(), env = options.env || process.env;
  const privateHistory = [
    path.join(env.CODEX_HOME || path.join(home, '.codex'), 'sessions'),
    path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'projects'),
  ];
  const protectedPaths = [project.path, before.common, ...otherTrees, ...privateHistory];
  if (dependencies) protectedPaths.push(dependencies);
  if (helper) protectedPaths.push(await fs.realpath(helper));
  if (protectedPaths.some(root => inside(root, directory))) throw new Error(t('实验数据目录必须位于原项目之外。'));
  return {
    directory, labRoot: socketDirectory, workspaceRoot, runId: run.id, helper,
    env: options.env, nodePath: options.nodePath, protectedPaths,
    allowDelegation: run.arm === 'orchestrated',
  };
}

async function validateReference({
  project, task, socketDirectory, signal, nodePath = process.execPath, env, testTimeoutMs = 120000,
  t = (source, values) => translate('zh', source, values),
}) {
  const id = randomUUID(), directory = path.join(socketDirectory, 'references', id);
  const workspaceRoot = path.join(directory, 'workspaces'), before = await ownerState(project.path);
  await fs.mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
  const session = new LabSession(await sessionOptions({
    project, directory, socketDirectory, run: { id }, env, nodePath, t,
  }, before, workspaceRoot));
  let result, failure;
  try {
    await session.start();
    session.signal = signal;
    const abort = () => session.controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      if (signal?.aborted) session.controller.abort();
      const workspace = await prepareWorktree(project.path, workspaceRoot, { base: task.commit }, signal);
      const grade = await gradeTests({
        projectPath: project.path, cwd: workspace.cwd, task, directory,
        signal, nodePath, session, timeoutMs: testTimeoutMs, restore: false,
      });
      if (grade.testsPassed !== grade.testsTotal ||
        grade.names.some(name => task.hiddenTests.some(file => name === file || name.endsWith('/' + file)))) {
        const details = await fs.readFile(path.join(directory, 'tests.log'), 'utf8');
        throw new Error(t('历史修复未通过完整参考测试：{details}', { details: details.slice(0, 2500) }));
      }
      result = { total: grade.testsTotal, names: grade.names, files: await gradingFiles(project.path, task) };
    } finally { signal?.removeEventListener('abort', abort); }
  } catch (error) { failure = error; }
  finally {
    for (const cleanup of [
      () => session.close(), () => cleanupWorktrees(directory), () => removePath(directory),
      () => assertOwner(project.path, before),
    ]) {
      try { await cleanup(); } catch (error) { if (!failure || error.ownerChanged) failure = error; }
    }
  }
  if (failure) throw failure;
  return result;
}

async function runTask(options) {
  const {
    project, task, run, directory, socketDirectory, helper, prices, signal, changed, reference,
    nodePath = process.execPath, env = process.env, timeoutMs = 20 * 60000,
    testTimeoutMs = 120000, reviewTimeoutMs = 5 * 60000, budgetCeiling = Infinity,
    t = (source, values) => translate('zh', source, values),
  } = options;
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const artifacts = path.join(directory, 'artifacts'), workspaceRoot = path.join(directory, 'workspaces');
  await fs.mkdir(artifacts, { mode: 0o700 }); await fs.mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
  const control = new AbortController(), abort = () => control.abort(), before = await ownerState(project.path);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) control.abort();
  const deadline = setTimeout(() => control.abort(), timeoutMs);
  const session = new LabSession({
    ...await sessionOptions(options, before, workspaceRoot), signal: control.signal,
  });
  let workspace, failure = null, captured = false, budgetStopped = false;
  const result = {};
  const usage = new LabUsage({
    directory: artifacts, privateDirectory: session.privateDirectory, socketDirectory, runId: run.id,
    project, prices, changed, onCost(spent) {
      if (spent > budgetCeiling + 1e-9) { budgetStopped = true; control.abort(); }
    },
  });
  session.usage = usage;
  await fs.writeFile(path.join(artifacts, 'owner-before.json'), JSON.stringify(before), { mode: 0o600 });
  try {
    if (!reference) throw new Error(t('启动模型前必须先通过参考测试。'));
    await session.start(); await usage.start();
    workspace = await prepareWorktree(project.path, workspaceRoot, task, control.signal);
    await dispatch({
      arm: run.arm, cwd: workspace.cwd, directory: artifacts, session, usage,
      task, signal: control.signal, timeoutMs,
    });
    await verifyWorktree(workspace, control.signal);
    const diff = await captureDiff(workspace, reference.files.map(entry => entry.file), control.signal);
    await fs.writeFile(path.join(artifacts, 'change.patch'), diff, { mode: 0o600 }); captured = true;
    const grade = await gradeTests({
      projectPath: project.path, cwd: workspace.cwd, task, directory: artifacts,
      signal: control.signal, nodePath, session, reference, timeoutMs: testTimeoutMs,
    });
    result.testsPassed = grade.testsPassed; result.testsTotal = grade.testsTotal;
    result.reviewIssues = await gradeReview({
      task, diff, directory: artifacts, session, usage, signal: control.signal, timeoutMs: reviewTimeoutMs,
    });
  } catch (error) {
    failure = error;
    if (workspace && !captured) {
      try {
        await verifyWorktree(workspace);
        const diff = await captureDiff(workspace, reference?.files.map(entry => entry.file));
        await fs.writeFile(path.join(artifacts, 'change.patch'), diff, { mode: 0o600 });
      } catch {}
    }
  } finally {
    clearTimeout(deadline); signal.removeEventListener('abort', abort);
    try { await session.close(); } catch (error) { failure ||= error; }
    try {
      await usage.close();
      const measured = usage.measurements();
      result.costUsd = measured.costUsd; result.knownCostUsd = measured.knownCostUsd;
      result.outputTokens = measured.outputTokens;
      const journal = workspace && path.join(workspace.gitDirectory, 'agentrix/journal.jsonl');
      if (run.arm === 'orchestrated' && journal) {
        const text = await fs.readFile(journal, 'utf8').catch(error => {
          if (error.code === 'ENOENT') return '';
          throw error;
        });
        const entries = text.split('\n').filter(Boolean).flatMap(line => {
          try { return [JSON.parse(line)]; } catch { return []; }
        });
        Object.assign(result, phaseEvidence(entries, measured.calls));
        await fs.writeFile(path.join(artifacts, 'journal.jsonl'), text, { mode: 0o600 });
      }
      await fs.writeFile(path.join(artifacts, 'measurements.json'), JSON.stringify(measured), { mode: 0o600 });
    } catch (error) { failure ||= error; }
    try { await cleanupWorktrees(directory); } catch (error) { failure ||= error; }
    try {
      const after = await assertOwner(project.path, before);
      await fs.writeFile(path.join(artifacts, 'owner-after.json'), JSON.stringify(after), { mode: 0o600 });
    } catch (error) {
      failure = error; result.ownerChanged = true;
      if (error.ownerAfter) {
        await fs.writeFile(path.join(artifacts, 'owner-after.json'), JSON.stringify(error.ownerAfter), { mode: 0o600 });
      }
    }
  }
  if (result.ownerChanged) { result.state = 'error'; result.error = failure.message; }
  else if (budgetStopped) {
    result.state = 'stopped'; result.budgetStopped = true;
    result.error = t('本次运行已超过剩余预算，模型已停止。');
  } else if (signal.aborted) result.state = 'stopped';
  else if (failure) {
    result.state = 'error';
    result.error = control.signal.aborted ? '实验运行超时。' : String(failure.message || failure).slice(0, 1000);
  } else result.state = result.testsTotal > 0 && result.testsPassed === result.testsTotal ? 'passed' : 'failed';
  return result;
}

module.exports = {
  runTask, validateReference, recoverRuns, prepareWorktree, verifyWorktree, captureDiff, cleanupWorktrees,
};
