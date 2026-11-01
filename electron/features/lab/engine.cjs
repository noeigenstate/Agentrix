const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { LabStore, MAX_EXPERIMENTS } = require('./store.cjs');
const { sampleHistory, profileTask } = require('./history.cjs');
const {
  experimentInput, sampleRequest, text, validId, finite, armEstimate, estimateExperiment,
} = require('./values.cjs');
const { runTask, validateReference, recoverRuns, cleanupWorktrees } = require('./runner.cjs');
const { aborted, killMarked } = require('./process.cjs');
const { inside } = require('./workspace.cjs');
const { translate } = require('../../i18n.cjs');
const { failureMessage } = require('./logs.cjs');

function stopRemaining(experiment, now, error) {
  for (const run of experiment.runs) if (['queued', 'running'].includes(run.state)) {
    run.state = 'stopped'; run.activeModel = null; run.endedAt = now;
    if (error) run.error = error;
  }
}

class LabEngine {
  constructor({
    userData, getProjects, helper, prices, records, now = Date.now, store = new LabStore(userData),
    runner = runTask, referenceRunner = validateReference, nodePath, env, timeoutMs, testTimeoutMs, reviewTimeoutMs,
    t = (source, values) => translate('zh', source, values),
  }) {
    Object.assign(this, {
      store, getProjects, helper, prices, records, now, runner, referenceRunner,
      nodePath, env, timeoutMs, testTimeoutMs, reviewTimeoutMs, t,
    });
    this.experiments = []; this.listeners = new Set(); this.active = null;
    this.starting = false; this.startingId = null; this.closed = false; this.quitWaited = false;
    this.referenceFailures = new Map(); this.ready = this.load();
  }
  async load() {
    await recoverRuns(this.store.directory);
    this.experiments = await this.store.list();
    for (const experiment of this.experiments) if (experiment.state === 'running') {
      for (const run of experiment.runs) if (['queued', 'running'].includes(run.state)) {
        if (run.state === 'running' && validId(run.id)) await killMarked(run.id);
        if (validId(run.id)) await cleanupWorktrees(path.join(this.store.folder(experiment.id), 'runs', run.id));
      }
      experiment.state = 'stopped'; stopRemaining(experiment, this.now());
      await this.store.save(experiment);
    }
  }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  changed() { for (const listener of this.listeners) { try { listener(); } catch {} } }
  async list() { await this.ready; return structuredClone(this.experiments); }
  async project(id) {
    if (!text(id)) throw new Error('无效的实验项目。');
    const project = this.getProjects().find(project => project.id === id && project.kind !== 'ssh');
    if (!project || typeof project.path !== 'string') throw new Error('实验需要本地 Git 项目。');
    return { id: project.id, name: project.name, path: await fs.realpath(project.path), kind: 'local' };
  }
  async projects() {
    return this.getProjects().filter(project => project.kind !== 'ssh' && typeof project.path === 'string')
      .map(project => ({ id: project.id, name: project.name }));
  }
  async sample(input) {
    await this.ready;
    const request = sampleRequest(input), project = await this.project(request.projectId);
    const failed = this.referenceFailures.get(project.id) || new Set();
    request.exclude = [...new Set([...request.exclude, ...failed])].slice(-100);
    return sampleHistory(project.path, request, { t: this.t });
  }
  async canonical(input, estimate = false) {
    const checked = experimentInput(input, estimate), project = await this.project(checked.projectId), tasks = [];
    for (const supplied of checked.tasks) {
      const task = await profileTask(project.path, supplied.commit, { t: this.t });
      if (!task) throw new Error('实验任务不再符合历史采样条件。');
      tasks.push(task);
    }
    return { input: { ...checked, tasks }, project };
  }
  async history() {
    return this.records ? (await this.records.read('runs')).filter(record => record.source !== 'lab') : [];
  }
  async estimate(input) {
    await this.ready;
    const checked = await this.canonical(input, true);
    return estimateExperiment(checked.input, await this.history(), this.prices, this.experiments);
  }
  async references(project, tasks, signal, directory) {
    const references = new Map(), rejected = [];
    for (const task of tasks) {
      aborted(signal);
      try {
        references.set(task.id, await this.referenceRunner({
          project, task, socketDirectory: this.store.directory, signal,
          artifactDirectory: path.join(directory, 'references', task.id),
          nodePath: this.nodePath, env: this.env, testTimeoutMs: this.testTimeoutMs, t: this.t,
        }));
      } catch (error) {
        if (signal.aborted || error.ownerChanged || error.infrastructure) throw error;
        const failed = this.referenceFailures.get(project.id) || new Set();
        failed.add(task.id); this.referenceFailures.set(project.id, failed);
        rejected.push(task.title + '：' + failureMessage(error, this.t));
      }
    }
    if (rejected.length) throw new Error(
      this.t('参考测试未通过，尚未启动模型。请换一组任务。') + '\n' + rejected.join('\n'),
    );
    return references;
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
    if (this.experiments.length >= MAX_EXPERIMENTS) throw new Error('实验记录已满，请先删除旧实验。');
    const { input, project } = await this.canonical(value), id = randomUUID(), createdAt = this.now();
    const userData = await fs.realpath(path.dirname(this.store.directory));
    if (inside(project.path, path.join(userData, path.basename(this.store.directory)))) {
      throw new Error(this.t('实验数据目录必须位于原项目之外。'));
    }
    const history = await this.history(), context = { experiments: this.experiments, projectId: project.id };
    const estimates = new Map(input.arms.map(arm => [arm, armEstimate(arm, history, this.prices, context)]));
    const experiment = {
      ...input, id, name: input.name || project.name + ' · ' + new Date(createdAt).toLocaleDateString('sv-SE'),
      projectName: project.name, createdAt, state: 'running', runs: [], spentUsd: 0,
    };
    for (let repeat = 1; repeat <= input.repeats; repeat++) for (const task of input.tasks) for (const arm of input.arms) {
      experiment.runs.push({
        id: randomUUID(), taskId: task.id, arm, repeat, state: 'queued', startedAt: null, endedAt: null,
        activeModel: null, testsPassed: null, testsTotal: null, reviewIssues: null,
        costUsd: null, outputTokens: null, rework: null,
      });
    }
    await this.store.save(experiment); this.experiments.unshift(experiment);
    this.startingId = id; this.changed();
    let references;
    try {
      references = await this.references(project, input.tasks, signal, this.store.folder(id));
      aborted(signal);
    } catch (error) {
      const message = this.closed ? this.t('实验室已关闭。') : failureMessage(error, this.t, Infinity);
      experiment.state = signal.aborted ? 'stopped' : 'error';
      stopRemaining(experiment, this.now(), message);
      await this.store.save(experiment); this.changed();
      error.message = message;
      throw error;
    }
    const active = { id, controller: new AbortController(), done: null };
    this.active = active;
    active.done = this.execute(experiment, project, estimates, references, active.controller.signal).catch(async error => {
      experiment.state = active.controller.signal.aborted ? 'stopped' : 'error';
      stopRemaining(experiment, this.now(), String(error.message || error).slice(0, 1000));
      await this.store.save(experiment).catch(() => {}); this.changed();
    }).finally(() => { if (this.active === active) this.active = null; });
    this.changed();
    return id;
  }
  async execute(experiment, project, estimates, references, signal) {
    for (const run of experiment.runs) {
      const expected = estimates.get(run.arm).costUsd;
      const remaining = experiment.budgetUsd - experiment.spentUsd;
      if (signal.aborted || expected > remaining + 1e-9) {
        experiment.state = 'stopped'; stopRemaining(experiment, this.now()); break;
      }
      run.state = 'running'; run.startedAt = this.now();
      await this.store.save(experiment); this.changed();
      const result = await this.runner({
        project, task: experiment.tasks.find(task => task.id === run.taskId), run,
        directory: path.join(this.store.folder(experiment.id), 'runs', run.id),
        socketDirectory: this.store.directory, helper: this.helper, prices: this.prices, signal,
        reference: references.get(run.taskId), budgetCeiling: remaining,
        nodePath: this.nodePath, env: this.env, timeoutMs: this.timeoutMs,
        testTimeoutMs: this.testTimeoutMs, reviewTimeoutMs: this.reviewTimeoutMs, t: this.t,
        changed: model => { run.activeModel = model; this.changed(); },
      });
      const { ownerChanged, budgetStopped, knownCostUsd = 0, modelStarted, ...measured } = result;
      Object.assign(run, measured, { activeModel: null, endedAt: this.now() });
      experiment.spentUsd += finite(run.costUsd) ? run.costUsd : Math.max(knownCostUsd, modelStarted === false ? 0 : expected);
      if (ownerChanged || budgetStopped) {
        experiment.state = ownerChanged ? 'error' : 'stopped';
        stopRemaining(experiment, this.now(), run.error);
      }
      await this.store.save(experiment); this.changed();
      if (experiment.state !== 'running') break;
    }
    if (experiment.state === 'running') experiment.state = signal.aborted ? 'stopped' : 'done';
    await this.store.save(experiment); this.changed();
  }
  async stop(id) {
    if (!validId(id)) throw new Error('无效的实验编号。');
    await this.ready;
    if (!this.experiments.some(experiment => experiment.id === id)) throw new Error('实验不存在。');
    const active = this.active;
    if (active?.id === id) { active.controller.abort(); await active.done; }
    else if (this.startingId === id) {
      this.startController.abort(); await this.startDone.catch(() => {});
    }
  }
  async remove(id) {
    if (!validId(id)) throw new Error('无效的实验编号。');
    await this.ready;
    if (this.active?.id === id || this.starting) throw new Error('请先停止正在运行的实验。');
    await this.store.remove(id);
    this.experiments = this.experiments.filter(experiment => experiment.id !== id); this.changed();
  }
  close() {
    this.closed = true; this.active?.controller.abort(); this.startController?.abort();
  }
  waitForQuit() {
    if (this.quitWaited) return null;
    this.quitWaited = true; this.close();
    const work = [this.active?.done, this.startDone].filter(Boolean);
    return work.length ? Promise.allSettled(work) : null;
  }
}

module.exports = { LabEngine };
