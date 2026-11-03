const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { LabUsage, phaseEvidence } = require('./usage.cjs');
const { LabSession, recoverRuns } = require('./session.cjs');
const { dispatch, taskBrief } = require('./dispatch.cjs');
const { gradeReview } = require('./grading.cjs');
const { safePath } = require('./history.cjs');
const { createHistorySource } = require('./sources/history.cjs');
const sourceTools = require('./sources/tools.cjs');
const { removePath, pruneCache } = require('./disk.cjs');
const { translate } = require('../../i18n.cjs');
const { recordTestFailure, testLogMessage, failureMessage } = require('./logs.cjs');
const {
  inside, prepareWorktree, verifyWorktree, captureDiff, cleanupWorktrees,
} = require('./workspace.cjs');

async function sessionOptions(options, guard, workspaceRoot) {
  const { helper, directory, socketDirectory, run,
    t = (source, values) => translate('zh', source, values) } = options;
  const home = os.homedir(), env = options.env || process.env;
  const privateHistory = [
    path.join(env.CODEX_HOME || path.join(home, '.codex'), 'sessions'),
    path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'projects'),
  ];
  const protectedPaths = [...guard.protectedPaths, ...privateHistory];
  for (const project of options.context?.getProjects() || []) if (project.kind !== 'ssh' && project.path) {
    protectedPaths.push(await fs.realpath(project.path));
  }
  if (helper) protectedPaths.push(await fs.realpath(helper));
  if (protectedPaths.some(root => inside(root, directory))) throw new Error(t('实验数据目录必须位于原项目之外。'));
  return {
    directory, labRoot: socketDirectory, workspaceRoot, runId: run.id, helper,
    env: options.env, nodePath: options.nodePath, protectedPaths, signal: options.signal, t,
    allowDelegation: run.arm === 'orchestrated',
    credentialPaths: [path.join(home, '.docker'), ...(process.platform === 'win32' ? [] : ['/var/run/docker.sock', '/run/docker.sock'])],
    deniedExecutables: (await Promise.all(String(env[Object.keys(env).find(key => key.toLowerCase() === 'path')] || '')
      .split(path.delimiter).filter(path.isAbsolute).map(folder =>
        fs.realpath(path.join(folder, process.platform === 'win32' ? 'docker.exe' : 'docker')).catch(error => {
          if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; return null;
        })))).filter(Boolean),
  };
}

async function sourceContext(options) {
  const provider = options.provider || createHistorySource(), scope = options.scope || { project: options.project };
  const context = options.context || { signal: options.signal, t: options.t || (source => translate('zh', source)),
    tools: sourceTools, platform: process.platform, getProjects: () => options.project ? [options.project] : [],
    cacheDirectory: path.join(options.socketDirectory, 'cache', provider.id), credential: () => null };
  return { provider, scope, context, guard: options.guard || await provider.guard(scope, context) };
}

const sessionFor = (options, settings) => options.sessionFactory ? options.sessionFactory(settings) : new LabSession(settings);

function runContext(source, session, workspaceRoot, artifactDirectory, options, reference) {
  return { ...source.context, signal: options.signal, session, workspaceRoot, artifactDirectory,
    testTimeoutMs: options.testTimeoutMs ?? 120000, reference };
}

function containerLease(source, id) {
  if (source.provider.id !== 'aa') return null;
  const lease = source.context.tools.docker.forRun?.(id);
  if (lease) source.context = { ...source.context, tools: { ...source.context.tools, docker: lease } };
  return lease;
}

async function cleanupContainer(directory, tools = sourceTools) {
  const file = path.join(directory, 'container.json');
  const stat = await fs.lstat(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (!stat) return;
  if (!stat.isFile() || stat.size > 1024) throw new Error('无效的实验容器记录。');
  const value = JSON.parse(await fs.readFile(file, 'utf8'));
  if (typeof value.id !== 'string' || !/^[a-f0-9]{12,64}$/.test(value.id)) throw new Error('无效的实验容器记录。');
  if (tools.docker.removeRecorded) await tools.docker.removeRecorded(value.id);
  else await tools.docker.remove(value.id);
  await fs.rm(file);
}

async function validateReference(options) {
  const {
    task, socketDirectory,
    t = (source, values) => translate('zh', source, values),
  } = options;
  const id = randomUUID(), directory = path.join(socketDirectory, 'references', id);
  const artifactDirectory = options.artifactDirectory || path.join(socketDirectory, 'reference-logs', id);
  const log = path.join(artifactDirectory, 'tests.log');
  const workspaceRoot = path.join(directory, 'workspaces'), source = await sourceContext(options);
  await fs.mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
  await fs.mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
  const session = sessionFor(options, await sessionOptions({ ...options, directory, run: { id }, t }, source.guard, workspaceRoot));
  const containers = containerLease(source, id);
  let result, failure;
  try {
    await session.start();
    result = await source.provider.reference(task, source.scope,
      runContext(source, session, workspaceRoot, artifactDirectory, options, null));
    if (!result || !Array.isArray(result.diffFiles) || result.diffFiles.some(file => !safePath(file))) {
      throw new Error('无效的实验参考结果。');
    }
  } catch (error) { failure = error; }
  finally {
    let stopped = true;
    for (const cleanup of [() => session.close(), () => containers?.close()]) {
      try { await cleanup(); } catch (error) { stopped = false; if (!failure || error.fatal) failure = error; }
    }
    for (const cleanup of [...(stopped ? [() => cleanupWorktrees(directory), () => removePath(directory)] : []), () => source.guard.check()]) {
      try { await cleanup(); } catch (error) { if (!failure || error.ownerChanged || error.fatal) failure = error; }
    }
  }
  if (failure) throw await recordTestFailure(failure, log);
  return result;
}

async function runTask(options) {
  const {
    project, task, run, directory, socketDirectory, prices, signal, changed, reference,
    timeoutMs = 20 * 60000, reviewTimeoutMs = 5 * 60000, budgetCeiling = Infinity,
    t = (source, values) => translate('zh', source, values),
  } = options;
  const source = await sourceContext(options), { provider, scope, guard } = source;
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const artifacts = path.join(directory, 'artifacts'), workspaceRoot = path.join(directory, 'workspaces');
  await fs.mkdir(artifacts, { mode: 0o700 }); await fs.mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
  const control = new AbortController(), abort = () => control.abort();
  const session = sessionFor(options, { ...await sessionOptions(options, guard, workspaceRoot), signal: control.signal });
  const containers = containerLease(source, run.id);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) control.abort();
  const deadline = setTimeout(() => control.abort(), timeoutMs);
  let workspace, failure = null, captured = false, budgetStopped = false;
  const result = {};
  const usage = new LabUsage({
    directory: artifacts, privateDirectory: session.privateDirectory, socketDirectory, runId: run.id,
    project, prices, changed, onCost(spent) {
      if (spent > budgetCeiling + 1e-9) { budgetStopped = true; control.abort(); }
    },
  });
  session.usage = usage;
  let removal;
  const removeContainer = () => workspace?.container ? removal ||= (async () => {
    await source.context.tools.docker.remove(workspace.container.id);
    await fs.rm(path.join(directory, 'container.json'), { force: true });
  })() : Promise.resolve();
  const stopContainer = () => { void removeContainer().catch(() => {}); };
  control.signal.addEventListener('abort', stopContainer);
  try {
    if (guard.before) await fs.writeFile(path.join(artifacts, 'owner-before.json'), JSON.stringify(guard.before), { mode: 0o600 });
    if (!reference) throw new Error(t('启动模型前必须先通过参考测试。'));
    await session.start(); await usage.start();
    const ctx = runContext(source, session, workspaceRoot, artifacts, { ...options, signal: control.signal }, reference);
    workspace = await provider.prepare(task, scope, ctx);
    if (!workspace || !inside(workspaceRoot, workspace.real) || workspace.real === workspaceRoot) {
      throw Object.assign(new Error('实验工作区越过了隔离边界。'), { fatal: true });
    }
    if (workspace.container) {
      if (typeof workspace.container.id !== 'string' || !/^[a-f0-9]{12,64}$/.test(workspace.container.id)) {
        throw Object.assign(new Error('无效的实验容器。'), { fatal: true });
      }
      await fs.writeFile(path.join(directory, 'container.json'), JSON.stringify(workspace.container), { mode: 0o600 });
      if (typeof session.broker !== 'function') throw Object.assign(new Error('容器命令通道不可用。'), { infrastructure: true });
      await session.broker(request => source.context.tools.docker.exec(workspace.container.id, request.argv,
        { stdin: request.stdin, timeoutMs: request.timeoutMs }));
    }
    await pruneCache(path.join(socketDirectory, 'cache'), { inUse: options.cacheInUse || [source.context.cacheDirectory] });
    if (control.signal.aborted) { await removeContainer(); throw new Error('实验已停止。'); }
    await dispatch({
      arm: run.arm, cwd: workspace.cwd, directory: artifacts, session, usage,
      task, signal: control.signal, timeoutMs,
      briefText: provider.brief ? taskBrief(task, run.arm, session.publicHelper,
        session.workspaceRoot, session.control, provider.brief(task, scope)) : undefined,
    });
    await verifyWorktree(workspace, control.signal);
    const diff = await captureDiff(workspace, reference.diffFiles || reference.files?.map(entry => entry.file), control.signal);
    await fs.writeFile(path.join(artifacts, 'change.patch'), diff, { mode: 0o600 }); captured = true;
    const grade = await provider.grade(task, scope, ctx);
    if (!grade || typeof grade.passed !== 'boolean' || grade.score !== null &&
      !(Number.isFinite(grade.score) && grade.score >= 0 && grade.score <= 1) ||
      ![grade.testsPassed, grade.testsTotal].every(value => value === null || Number.isInteger(value) && value >= 0) ||
      grade.testsTotal !== null && (grade.testsTotal < 1 || grade.testsPassed === null || grade.testsPassed > grade.testsTotal) ||
      grade.passed && (grade.score === null && grade.testsTotal === null || grade.score !== null && grade.score !== 1 ||
        grade.testsTotal !== null && grade.testsPassed !== grade.testsTotal)) {
      throw new Error('无效的实验评分结果。');
    }
    result.testsPassed = grade.testsPassed; result.testsTotal = grade.testsTotal; result.score = grade.score;
    result.state = grade.passed ? 'passed' : 'failed';
    if (!grade.passed) {
      result.error = testLogMessage(t('未通过'), path.join(artifacts, 'tests.log'), t);
    }
    if (provider.review === 'diff') result.reviewIssues = await gradeReview({
      task, diff, directory: artifacts, session, usage, signal: control.signal, timeoutMs: reviewTimeoutMs,
    });
  } catch (error) {
    failure = error;
    if (workspace && !captured) {
      try {
        await verifyWorktree(workspace);
        const diff = await captureDiff(workspace, reference?.diffFiles || reference?.files?.map(entry => entry.file));
        await fs.writeFile(path.join(artifacts, 'change.patch'), diff, { mode: 0o600 });
      } catch {}
    }
  } finally {
    clearTimeout(deadline); signal.removeEventListener('abort', abort);
    control.signal.removeEventListener('abort', stopContainer);
    let stopped = true;
    for (const cleanup of [removeContainer, () => session.close(), () => containers?.close()]) {
      try { await cleanup(); } catch (error) { stopped = false; failure ||= error; }
    }
    try { await usage.close(); } catch (error) { failure ||= error; }
    const measured = usage.measurements();
    result.costUsd = measured.costUsd; result.knownCostUsd = measured.knownCostUsd;
    result.modelStarted = session.modelStarted || measured.calls.some(call => call.unconfirmed !== true);
    result.outputTokens = measured.outputTokens;
    try {
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
      await fs.writeFile(path.join(artifacts, 'measurements.json'),
        JSON.stringify({ ...measured, modelStarted: result.modelStarted }), { mode: 0o600 });
    } catch (error) { failure ||= error; }
    if (stopped) try { await cleanupWorktrees(directory); } catch (error) { failure ||= error; }
    try {
      const after = await guard.check();
      if (guard.before) await fs.writeFile(path.join(artifacts, 'owner-after.json'), JSON.stringify(after), { mode: 0o600 });
    } catch (error) {
      failure = error; result.ownerChanged = !!error.ownerChanged; result.fatal = !!error.fatal;
      if (error.ownerAfter) {
        await fs.writeFile(path.join(artifacts, 'owner-after.json'), JSON.stringify(error.ownerAfter), { mode: 0o600 });
      }
    }
  }
  if (failure?.fatal || failure?.ownerChanged) { result.state = 'error'; result.fatal = true; result.error = failure.message; }
  else if (budgetStopped) {
    result.state = 'stopped'; result.budgetStopped = true;
    result.error = t('本次运行已超过剩余预算，模型已停止。');
  } else if (signal.aborted) result.state = 'stopped';
  else if (failure) {
    result.state = 'error';
    result.infrastructure = !!failure.infrastructure;
    result.error = failureMessage(control.signal.aborted ? { ...failure, message: '实验运行超时。' } : failure, t);
  }
  return result;
}

module.exports = {
  runTask, validateReference, recoverRuns, prepareWorktree, verifyWorktree, captureDiff, cleanupWorktrees,
  cleanupContainer,
};
