const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { LabStore, MAX_EXPERIMENTS } = require('./store.cjs');
const { experimentInput, sampleRequest, validId, finite, armEstimate } = require('./values.cjs');
const { runTask, validateReference, recoverRuns, cleanupWorktrees, cleanupContainer } = require('./runner.cjs');
const { aborted, killMarked } = require('./process.cjs');
const { inside } = require('./workspace.cjs');
const { physicalPath } = require('./sandbox.cjs');
const { pruneCache } = require('./disk.cjs');
const { translate } = require('../../i18n.cjs');
const { failureMessage } = require('./logs.cjs');
const { assertProvider, LAB_SOURCES, TASK_ID, taskKey } = require('./sources/contract.cjs');
const tools = require('./sources/tools.cjs');
const { createHistorySource } = require('./sources/history.cjs');
const { createOssSource } = require('../lab-oss/index.cjs');
const { createAaSource } = require('../lab-aa/index.cjs');

function stopRemaining(experiment, now, error, source) {
  for (const run of experiment.runs) if ((!source || run.source === source) && ['queued', 'running'].includes(run.state)) {
    run.state = 'stopped'; run.activeModel = null; run.endedAt = now;
    if (error) run.error = error;
  }
}
const queryKey = selection => JSON.stringify([selection.source, selection.projectId ?? null,
  selection.repos ? [...selection.repos].sort() : null, selection.benchmark ?? null]);

function canonicalTasks(result, selection) {
  if (!result || typeof result.scopeKey !== 'string' || !result.scopeKey || typeof result.scopeLabel !== 'string' ||
    !Array.isArray(result.tasks) || result.tasks.length !== selection.tasks.length || result.tasks.some((task, index) =>
      !task || task.source !== selection.source || task.id !== selection.tasks[index].id || !TASK_ID.test(task.id) ||
      ['title', 'text', 'kind', 'why'].some(field => typeof task[field] !== 'string'))) {
    throw new Error('实验来源返回了无效的任务。');
  }
  return result;
}

class LabEngine {
  constructor({ userData, getProjects = () => [], helper, prices, records, now = Date.now, store = new LabStore(userData),
    runner = runTask, referenceRunner = validateReference, nodePath, env, timeoutMs, testTimeoutMs, reviewTimeoutMs,
    providers = [createHistorySource(), createOssSource(), createAaSource()], sourceTools = tools,
    platform = process.platform, sessionFactory, safeStorage, laneConcurrency, recovery = recoverRuns,
    t = (source, values) => translate('zh', source, values) }) {
    Object.assign(this, { store, getProjects, helper, prices, records, now, runner, referenceRunner,
      nodePath, env, timeoutMs, testTimeoutMs, reviewTimeoutMs, sourceTools, platform, sessionFactory, safeStorage, laneConcurrency, recovery, t });
    this.providers = new Map(providers.map(provider => [assertProvider(provider).id, provider]));
    if (this.providers.size !== providers.length) throw new TypeError('Duplicate lab source provider.');
    this.experiments = []; this.listeners = new Set(); this.active = null;
    this.starting = false; this.startingId = null; this.closed = false; this.quitWaited = false;
    this.referenceFailures = new Map(); this.sampleScopes = new Map(); this.key = null;
    this.pendingCleanup = []; this.recoveryFailures = []; this.cleanupTail = Promise.resolve();
    this.containerFailure = null; this.cleanupRecordFailure = null; this.installConfigured = false;
    this.keyPending = Promise.resolve(); this.ready = this.load();
  }
  async load() {
    await this.dataDirectory();
    this.key = await this.store.readAaKey(this.safeStorage);
    this.experiments = await this.store.list();
    try { this.pendingCleanup = await this.store.readCleanup(); } catch (error) { this.cleanupRecordFailure = error; }
    const pending = new Map(this.pendingCleanup.map(item => [item.runId, item]));
    for (const experiment of this.experiments) for (const run of experiment.runs) if (validId(run.id)) {
      const directory = path.join(this.store.folder(experiment.id), 'runs', run.id);
      const names = await fs.readdir(directory).catch(error => error.code === 'ENOENT' ? [] : null);
      if (!pending.has(run.id)) pending.set(run.id, { experimentId: experiment.id, runId: run.id, source: run.source,
        worktrees: ['queued', 'running'].includes(run.state) || names === null || names.some(name =>
          ['worktree', 'workers', 'workspaces', 'repository.git', 'runtime'].includes(name)) });
    }
    this.pendingCleanup = [...pending.values()];
    if (!this.cleanupRecordFailure) {
      try { await this.store.writeCleanup(this.pendingCleanup); } catch (error) { this.cleanupRecordFailure = error; }
    }
    for (const experiment of this.experiments) if (experiment.state === 'running') {
      experiment.state = 'stopped'; stopRemaining(experiment, this.now());
      for (const lane of experiment.lanes) if (['queued', 'running'].includes(lane.state)) lane.state = 'stopped';
      await this.store.save(experiment);
    }
    await this.retryCleanup(true);
  }
  cleanupReason(containers = false) {
    return this.t(containers ? '上次实验的容器尚未清理完成。请启动 Docker 后重试；如仍失败，请重启应用。'
      : '上次实验尚未清理完成。请重启应用后重试。');
  }
  retryCleanup(docker) {
    const operation = this.cleanupTail.then(() => this.cleanPending(docker));
    this.cleanupTail = operation.catch(() => {}); return operation;
  }
  async cleanPending(docker) {
    if (this.cleanupRecordFailure) {
      try {
        const recovered = await this.store.readCleanup();
        this.pendingCleanup = [...new Map([...recovered, ...this.pendingCleanup].map(item => [item.runId, item])).values()];
        this.cleanupRecordFailure = null;
      } catch {}
    }
    if (!this.installConfigured) {
      try {
        const id = await this.store.installId();
        if (this.sourceTools.docker.forInstall) this.sourceTools = { ...this.sourceTools, docker: this.sourceTools.docker.forInstall(id) };
        this.installConfigured = true;
      } catch (error) { this.containerFailure = error; }
    }
    if (docker && this.installConfigured) {
      try { await this.sourceTools.docker.sweep?.(); this.containerFailure = null; }
      catch (error) { this.containerFailure = error; }
    }
    try {
      this.recoveryFailures = await this.recovery(this.store.directory, { cleanup: async directory => {
        await cleanupContainer(directory, this.sourceTools); await cleanupWorktrees(directory);
      } }) || [];
    } catch (error) { this.recoveryFailures = [{ runId: null, error }]; }
    const pending = [], changed = new Set();
    for (const item of this.pendingCleanup) {
      if (!docker && item.source === 'aa') { pending.push(item); continue; }
      const experiment = this.experiments.find(experiment => experiment.id === item.experimentId);
      const run = experiment?.runs.find(run => run.id === item.runId);
      const lane = experiment?.lanes.find(lane => lane.source === item.source);
      try {
        if (this.recoveryFailures.some(failure => failure.runId === null || failure.runId === item.runId)) {
          throw this.recoveryFailures[0].error;
        }
        const directory = path.join(this.store.folder(item.experimentId), 'runs', item.runId);
        if (item.worktrees) await killMarked(item.runId);
        await cleanupContainer(directory, this.sourceTools);
        if (item.worktrees) await cleanupWorktrees(directory);
        if (run && [this.cleanupReason(), this.cleanupReason(true)].includes(run.error)) {
          run.error = null; changed.add(experiment);
        }
      } catch {
        pending.push(item);
        if (run) run.error = this.cleanupReason(item.source === 'aa');
        if (lane) lane.error = this.cleanupReason(item.source === 'aa');
        if (experiment) changed.add(experiment);
      }
    }
    for (const experiment of this.experiments) for (const lane of experiment.lanes) {
      if (!pending.some(item => item.experimentId === experiment.id && item.source === lane.source) &&
        [this.cleanupReason(), this.cleanupReason(true)].includes(lane.error)) {
        lane.error = null; changed.add(experiment);
      }
    }
    for (const experiment of changed) await this.store.save(experiment);
    this.pendingCleanup = pending;
    if (!this.cleanupRecordFailure) {
      try { await this.store.writeCleanup(pending); } catch (error) { this.cleanupRecordFailure = error; }
    }
  }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  changed() { for (const listener of this.listeners) { try { listener(); } catch {} } }
  async list() { await this.ready; return structuredClone(this.experiments); }
  async projects() {
    return this.getProjects().filter(project => project.kind !== 'ssh' && typeof project.path === 'string')
      .map(project => ({ id: project.id, name: project.name }));
  }
  async dataDirectory(protectedPaths = []) {
    const root = await physicalPath(this.store.directory);
    const projects = await Promise.all(this.getProjects().filter(project => project.kind !== 'ssh' && project.path)
      .map(project => physicalPath(project.path)));
    if ([...protectedPaths, ...projects].some(project => inside(project, root))) {
      throw new Error(this.t('实验数据目录必须位于原项目之外。'));
    }
    return root;
  }
  context(source, signal = new AbortController().signal) {
    return { signal, t: this.t, tools: this.sourceTools, getProjects: this.getProjects, platform: this.platform,
      cacheDirectory: path.join(this.store.directory, 'cache', source), credential: () => source === 'aa' ? this.key : null };
  }
  async describe(provider, ctx) {
    let info;
    try {
      info = await provider.describe(ctx);
      if (info.id !== provider.id || typeof info.available !== 'boolean' ||
        ![info.size.min, info.size.max, info.size.standard].every(Number.isInteger) || info.size.min < 1 ||
        info.size.min > info.size.standard || info.size.standard > info.size.max) throw new Error();
    } catch {
      info = { id: provider.id, available: false, reason: this.t('实验来源暂时不可用。'),
        metric: { history: 'hidden-tests', oss: 'resolved', aa: 'tests' }[provider.id], review: provider.review === 'diff',
        size: { min: 1, max: 1, standard: 1 }, options: [], manifest: null, published: null, downloadBytes: null,
        keyStored: provider.id === 'aa' ? !!this.key : null };
    }
    if (provider.id === 'aa' && (this.containerFailure || this.cleanupRecordFailure || this.recoveryFailures.length ||
      this.pendingCleanup.some(item => item.source === 'aa'))) {
      info = { ...info, available: false, reason: this.cleanupReason(!!this.containerFailure || this.pendingCleanup.some(item => item.source === 'aa')) };
    }
    return { ...info, keyStored: provider.id === 'aa' ? !!this.key : null };
  }
  async sources() {
    await this.ready;
    if (!this.active && !this.starting && (this.containerFailure || this.cleanupRecordFailure ||
      this.recoveryFailures.length || this.pendingCleanup.length)) await this.retryCleanup(true);
    return Promise.all(LAB_SOURCES.filter(id => this.providers.has(id))
      .map(id => this.describe(this.providers.get(id), this.context(id))));
  }
  async aaKey(value) {
    if (value !== null && (typeof value !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(value))) throw new Error('无效的实验室密钥。');
    const operation = this.keyPending.then(async () => {
      await this.ready; await this.store.writeAaKey(value, this.safeStorage); this.key = value; return value !== null;
    });
    this.keyPending = operation.catch(() => {}); return operation;
  }
  async sample(value) {
    await this.ready;
    const query = sampleRequest(value), provider = this.providers.get(query.source);
    if (!provider) throw new Error('无效的实验来源。');
    const ctx = this.context(query.source), info = await this.describe(provider, ctx);
    if (!info.available) throw new Error(info.reason);
    if (query.size < info.size.min || query.size > info.size.max) throw new Error('无效的实验采样条件。');
    const failed = this.referenceFailures.get(this.sampleScopes.get(queryKey(query))) || new Set();
    query.exclude = [...new Set([...query.exclude, ...failed])].slice(-100);
    const tasks = await provider.sample(query, ctx);
    canonicalTasks({ scopeKey: 'sample', scopeLabel: '', tasks }, { ...query, tasks: tasks.map(task => ({ id: task.id })) });
    if (tasks.length > query.size || new Set(tasks.map(task => task.id)).size !== tasks.length) throw new Error('实验来源返回了无效的任务。');
    return structuredClone(tasks);
  }
  async canonical(value, estimate = false, signal) {
    const input = experimentInput(value, estimate);
    const lanes = await Promise.all(input.selections.map(async selection => {
      const provider = this.providers.get(selection.source);
      if (!provider) throw new Error('无效的实验来源。');
      const ctx = this.context(provider.id, signal), info = await this.describe(provider, ctx);
      if (!info.available) throw new Error(info.reason);
      if (selection.tasks.length < info.size.min || selection.tasks.length > info.size.max) throw new Error('无效的实验任务数量。');
      const canonical = canonicalTasks(await provider.canonical(selection, ctx), selection);
      this.sampleScopes.set(queryKey(selection), provider.id + ':' + canonical.scopeKey);
      return { ...canonical, selection, provider, ctx, info };
    }));
    return { input, lanes };
  }
  async history() { return this.records ? (await this.records.read('runs')).filter(record => record.source !== 'lab') : []; }
  async estimates(input, lanes) {
    const history = await this.history(), estimates = new Map();
    const sources = lanes.map(lane => {
      const arms = new Map(input.arms.map(arm => [arm, armEstimate(arm, history, this.prices, {
        experiments: this.experiments, projectId: lane.selection.projectId, source: lane.provider.id,
        defaults: lane.provider.defaults, review: lane.provider.review === 'diff',
      })]));
      estimates.set(lane.provider.id, arms);
      const count = lane.tasks.length * input.repeats, values = [...arms.values()];
      return { source: lane.provider.id, runs: count * arms.size,
        minutes: count * values.reduce((n, value) => n + value.minutes, 0),
        costUsd: count * values.reduce((n, value) => n + value.costUsd, 0),
        basis: values.every(value => value.basis === 'history') ? 'history' : 'default', share: 0 };
    });
    const costUsd = sources.reduce((n, source) => n + source.costUsd, 0), runs = sources.reduce((n, source) => n + source.runs, 0);
    let assigned = 0;
    for (const [index, source] of sources.entries()) {
      source.share = index === sources.length - 1 ? 1 - assigned : costUsd ? source.costUsd / costUsd : source.runs / runs;
      assigned += source.share;
    }
    return { estimates, estimate: { runs, costUsd, minutes: sources.reduce((n, source) => n + source.minutes, 0),
      basis: sources.every(source => source.basis === 'history') ? 'history' : 'default', sources } };
  }
  async estimate(value) {
    await this.ready;
    const { input, lanes } = await this.canonical(value, true);
    return (await this.estimates(input, lanes)).estimate;
  }
  async references(lane, signal, directory) {
    const references = new Map(), rejected = [];
    for (const task of lane.tasks) {
      aborted(signal);
      try {
        references.set(taskKey(task), await this.referenceRunner({ ...this.runnerOptions(lane, signal), task,
          artifactDirectory: path.join(directory, 'references', ...(task.source === 'history' ? [] : [task.source]), task.id) }));
      } catch (error) {
        if (signal.aborted || error.ownerChanged || error.fatal || error.infrastructure) throw error;
        const key = lane.provider.id + ':' + lane.scopeKey, failed = this.referenceFailures.get(key) || new Set();
        failed.add(task.id); this.referenceFailures.set(key, failed);
        rejected.push(task.title + '：' + failureMessage(error, this.t));
      }
    }
    if (rejected.length) throw new Error(this.t('参考测试未通过，尚未启动模型。请换一组任务。') + '\n' + rejected.join('\n'));
    return references;
  }
  runnerOptions(lane, signal) {
    return { provider: lane.provider, scope: lane.scope, guard: lane.guard, context: { ...lane.ctx, signal },
      project: lane.scope?.project, socketDirectory: this.store.directory, signal, helper: this.helper, prices: this.prices,
      nodePath: this.nodePath, env: this.env, timeoutMs: this.timeoutMs, testTimeoutMs: this.testTimeoutMs,
      reviewTimeoutMs: this.reviewTimeoutMs, sessionFactory: this.sessionFactory,
      cacheInUse: this.active?.cacheInUse || [lane.ctx.cacheDirectory], t: this.t };
  }
  start(value) {
    if (this.closed || this.active || this.starting) return Promise.reject(new Error('已有实验正在运行。'));
    this.starting = true; this.startController = new AbortController();
    this.startDone = this.prepareStart(value, this.startController.signal).finally(() => {
      this.starting = false; this.startingId = null; this.startController = null; this.startDone = null;
    });
    return this.startDone;
  }
  async prepareStart(value, signal) {
    await this.ready; aborted(signal);
    await this.retryCleanup(Array.isArray(value?.selections) && value.selections.some(selection => selection.source === 'aa'));
    aborted(signal);
    if (this.experiments.length >= MAX_EXPERIMENTS) throw new Error('实验记录已满，请先删除旧实验。');
    const { input, lanes } = await this.canonical(value, false, signal), id = randomUUID(), createdAt = this.now();
    for (const lane of lanes) {
      lane.guard = await lane.provider.guard(lane.scope, lane.ctx);
    }
    await this.dataDirectory(lanes.flatMap(lane => lane.guard.protectedPaths));
    await fs.mkdir(this.store.directory, { recursive: true, mode: 0o700 });
    const { estimates, estimate } = await this.estimates(input, lanes), history = lanes.find(lane => lane.provider.id === 'history');
    let assigned = 0;
    const experiment = { id, name: input.name || (history?.scopeLabel || lanes.map(lane => lane.scopeLabel).join(' · ')) +
      ' · ' + new Date(createdAt).toLocaleDateString('sv-SE'), createdAt, projectId: history?.selection.projectId ?? null,
      projectName: history?.scopeLabel ?? null, sources: lanes.map(lane => lane.provider.id),
      tasks: lanes.flatMap(lane => lane.tasks), arms: input.arms, repeats: input.repeats, budgetUsd: input.budgetUsd,
      state: 'running', runs: [], spentUsd: 0, lanes: lanes.map((lane, index) => {
        const budgetUsd = index === lanes.length - 1 ? input.budgetUsd - assigned : input.budgetUsd * estimate.sources[index].share;
        assigned += budgetUsd;
        return { source: lane.provider.id, state: 'queued', scope: lane.scopeLabel, metric: lane.info.metric,
          review: lane.provider.review === 'diff', budgetUsd, spentUsd: 0, error: null, manifest: lane.info.manifest, published: null };
      }) };
    for (let repeat = 1; repeat <= input.repeats; repeat++) for (const task of experiment.tasks) for (const arm of input.arms) {
      experiment.runs.push({ id: randomUUID(), taskId: task.id, source: task.source, arm, repeat, state: 'queued',
        startedAt: null, endedAt: null, activeModel: null, testsPassed: null, testsTotal: null, score: null,
        reviewIssues: null, costUsd: null, outputTokens: null, rework: null });
    }
    await this.store.save(experiment); this.experiments.unshift(experiment); this.startingId = id; this.changed();
    const cache = path.join(this.store.directory, 'cache'), inUse = lanes.map(lane => lane.ctx.cacheDirectory);
    const preflight = new AbortController(), phaseSignal = AbortSignal.any([signal, preflight.signal]);
    for (const lane of lanes) lane.ctx = { ...lane.ctx, signal: phaseSignal };
    const checking = action => async (lane, index) => {
      try { return await action(lane, index); }
      catch (error) { if (error.fatal || error.ownerChanged) preflight.abort(); throw error; }
    };
    try {
      await pruneCache(cache); aborted(signal);
      const preparation = await Promise.allSettled(lanes.map(checking(async (lane, index) => {
        await lane.provider.fetch?.(lane.scope, lane.ctx); aborted(phaseSignal);
        const rebuilt = canonicalTasks(await lane.provider.canonical(lane.selection, lane.ctx), lane.selection);
        if (rebuilt.scopeKey !== lane.scopeKey) throw new Error('实验来源改变了任务范围。');
        Object.assign(lane, rebuilt); lane.info = await this.describe(lane.provider, lane.ctx);
        experiment.lanes[index].manifest = structuredClone(lane.info.manifest);
        experiment.lanes[index].published = structuredClone(lane.info.published);
        if (lane.provider.id === 'aa' && !this.key) experiment.lanes[index].published = null;
        await lane.guard.check();
      })));
      this.preflightResults(preparation, lanes); await pruneCache(cache, { inUse });
      experiment.tasks = lanes.flatMap(lane => lane.tasks); await this.store.save(experiment); aborted(signal);
      const references = await Promise.allSettled(lanes.map(checking(lane => this.references(lane, phaseSignal, this.store.folder(id)))));
      this.preflightResults(references, lanes); await pruneCache(cache, { inUse }); aborted(signal);
      const active = { id, controller: new AbortController(), done: null, fatal: false, cacheInUse: inUse };
      this.active = active;
      active.done = this.execute(experiment, lanes, estimates, references.map(result => result.value), active)
        .catch(async error => {
          experiment.state = active.fatal || !active.controller.signal.aborted ? 'error' : 'stopped';
          stopRemaining(experiment, this.now(), failureMessage(error, this.t));
          for (const lane of experiment.lanes) if (['queued', 'running'].includes(lane.state)) lane.state = experiment.state;
          await this.store.save(experiment).catch(() => {}); this.changed();
        }).finally(async () => {
          await pruneCache(cache).catch(() => {});
          if (this.active === active) this.active = null;
        });
      this.changed(); return id;
    } catch (error) {
      const message = this.closed ? this.t('实验室已关闭。') : failureMessage(error, this.t, Infinity);
      experiment.state = signal.aborted ? 'stopped' : 'error'; stopRemaining(experiment, this.now(), message);
      for (const lane of experiment.lanes) { lane.state = experiment.state; lane.error = message; }
      await this.store.save(experiment); this.changed(); await pruneCache(cache).catch(() => {});
      error.message = message; throw error;
    }
  }
  preflightResults(results, lanes) {
    const failures = results.flatMap((result, index) => result.status === 'rejected'
      ? [{ error: result.reason, source: lanes[index].provider.id }] : []);
    if (!failures.length) return;
    const fatal = failures.find(item => item.error.fatal || item.error.ownerChanged);
    if (fatal || failures.length === 1) {
      const failure = fatal || failures[0];
      if (lanes.length > 1) failure.error.message = failure.source + ': ' + failureMessage(failure.error, this.t, Infinity);
      throw failure.error;
    }
    const error = new Error(failures.map(item => item.source + ': ' + failureMessage(item.error, this.t, Infinity)).join('\n'));
    error.fatal = failures.some(item => item.error.fatal || item.error.ownerChanged);
    error.infrastructure = failures.every(item => item.error.infrastructure); throw error;
  }
  async executeLane(experiment, lane, estimates, references, active) {
    const state = experiment.lanes.find(item => item.source === lane.provider.id), local = new AbortController();
    const signal = AbortSignal.any([active.controller.signal, local.signal]);
    state.state = 'running'; let infrastructureFailures = 0;
    for (const run of experiment.runs.filter(run => run.source === lane.provider.id)) {
      const expected = estimates.get(run.arm).costUsd, remaining = state.budgetUsd - state.spentUsd;
      if (signal.aborted || expected > remaining + 1e-9) {
        state.state = 'stopped';
        if (!signal.aborted) state.error = this.t('该来源的剩余预算不足，已停止后续运行。');
        stopRemaining(experiment, this.now(), state.error, state.source); break;
      }
      run.state = 'running'; run.startedAt = this.now(); await this.store.save(experiment); this.changed();
      let result;
      try {
        result = await this.runner({ ...this.runnerOptions(lane, signal), run,
          task: experiment.tasks.find(task => task.source === run.source && task.id === run.taskId),
          directory: path.join(this.store.folder(experiment.id), 'runs', run.id), reference: references.get(run.source + ':' + run.taskId),
          budgetCeiling: remaining, changed: model => { run.activeModel = model; this.changed(); } });
      } catch (error) {
        result = { state: signal.aborted ? 'stopped' : 'error', error: failureMessage(error, this.t),
          infrastructure: error.infrastructure, fatal: error.fatal || error.ownerChanged, modelStarted: false };
      }
      const { ownerChanged, fatal, infrastructure, budgetStopped, knownCostUsd = 0, modelStarted, ...measured } = result;
      Object.assign(run, measured, { activeModel: null, endedAt: this.now() });
      state.spentUsd += finite(run.costUsd) ? run.costUsd : Math.max(finite(knownCostUsd) ? knownCostUsd : 0, modelStarted === false ? 0 : expected);
      experiment.spentUsd = experiment.lanes.reduce((n, item) => n + item.spentUsd, 0);
      infrastructureFailures = infrastructure ? infrastructureFailures + 1 : 0;
      if (fatal || ownerChanged) { active.fatal = true; active.controller.abort(); state.state = 'error'; state.error = run.error; }
      else if (budgetStopped || signal.aborted) { state.state = 'stopped'; state.error = run.error ?? null; }
      else if (infrastructureFailures >= 2) { state.state = 'error'; state.error = run.error; local.abort(); }
      if (state.state !== 'running') stopRemaining(experiment, this.now(), state.error, state.source);
      await this.store.save(experiment); this.changed();
      if (state.state !== 'running') break;
    }
    if (state.state === 'running') state.state = signal.aborted ? 'stopped' : 'done';
  }
  async execute(experiment, lanes, estimates, references, active) {
    let next = 0;
    const count = Math.min(lanes.length, Math.max(1, this.laneConcurrency || lanes.length));
    const results = await Promise.allSettled(Array.from({ length: count }, async () => {
      while (next < lanes.length) {
        const index = next++;
        await this.executeLane(experiment, lanes[index], estimates.get(lanes[index].provider.id), references[index], active);
      }
    }));
    for (const lane of lanes) {
      try { await lane.guard.check(); }
      catch (error) { active.fatal = true; active.controller.abort(); throw error; }
    }
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    experiment.state = active.fatal || experiment.lanes.every(lane => lane.state === 'error') ? 'error'
      : active.controller.signal.aborted || experiment.lanes.some(lane => lane.state === 'stopped') ? 'stopped' : 'done';
    await this.store.save(experiment); this.changed();
  }
  async stop(id) {
    if (!validId(id)) throw new Error('无效的实验编号。');
    await this.ready;
    if (!this.experiments.some(experiment => experiment.id === id)) throw new Error('实验不存在。');
    if (this.active?.id === id) { this.active.controller.abort(); await this.active.done; }
    else if (this.startingId === id) { this.startController.abort(); await this.startDone.catch(() => {}); }
  }
  async remove(id) {
    if (!validId(id)) throw new Error('无效的实验编号。');
    await this.ready;
    if (this.active?.id === id || this.starting) throw new Error('请先停止正在运行的实验。');
    if (!this.active) await this.retryCleanup(true);
    if (this.pendingCleanup.some(item => item.experimentId === id)) throw new Error(this.cleanupReason());
    for (const run of this.experiments.find(experiment => experiment.id === id)?.runs || []) if (validId(run.id)) {
      await cleanupContainer(path.join(this.store.folder(id), 'runs', run.id), this.sourceTools);
    }
    await this.store.remove(id); this.experiments = this.experiments.filter(experiment => experiment.id !== id); this.changed();
  }
  close() { this.closed = true; this.active?.controller.abort(); this.startController?.abort(); }
  waitForQuit() {
    if (this.quitWaited) return null;
    this.quitWaited = true; this.close();
    const work = [this.active?.done, this.startDone].filter(Boolean);
    return work.length ? Promise.allSettled(work) : null;
  }
}

module.exports = { LabEngine };
