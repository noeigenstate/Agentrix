const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { LabStore, MAX_EXPERIMENTS } = require('./store.cjs');
const { sampleHistory, profileTask } = require('./history.cjs');
const { experimentInput, sampleRequest, text, validId, finite, armEstimate, estimateExperiment } = require('./values.cjs');
const { runTask } = require('./runner.cjs');

class LabEngine {
  constructor({ userData, getProjects, helper, prices, records, now = Date.now, store = new LabStore(userData), runner = runTask,
    nodePath, env, timeoutMs, testTimeoutMs, reviewTimeoutMs, t }) {
    Object.assign(this, { store, getProjects, helper, prices, records, now, runner, nodePath, env, timeoutMs, testTimeoutMs, reviewTimeoutMs, t });
    this.experiments = []; this.listeners = new Set(); this.active = null; this.starting = false; this.closed = false; this.quitWaited = false;
    this.ready = this.load();
  }
  async load() {
    this.experiments = await this.store.list();
    for (const experiment of this.experiments) if (experiment.state === 'running') {
      experiment.state = 'stopped';
      for (const run of experiment.runs) if (['queued', 'running'].includes(run.state)) { run.state = 'stopped'; run.activeModel = null; run.endedAt = this.now(); }
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
    const request = sampleRequest(input), project = await this.project(request.projectId);
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
  async history() { return this.records ? this.records.read('runs') : []; }
  async estimate(input) {
    const checked = await this.canonical(input, true);
    return estimateExperiment(checked.input, await this.history(), this.prices);
  }
  async start(value) {
    if (this.closed || this.active || this.starting) throw new Error('已有实验正在运行。');
    this.starting = true;
    try {
      await this.ready;
      if (this.experiments.length >= MAX_EXPERIMENTS) throw new Error('实验记录已满，请先删除旧实验。');
      const { input, project } = await this.canonical(value), id = randomUUID(), createdAt = this.now();
      const experiment = { ...input, id, name: input.name || `${project.name} · ${new Date(createdAt).toLocaleDateString('sv-SE')}`,
        projectName: project.name, createdAt, state: 'running', runs: [], spentUsd: 0 };
      for (let repeat = 1; repeat <= input.repeats; repeat++) for (const task of input.tasks) for (const arm of input.arms) {
        experiment.runs.push({ id: randomUUID(), taskId: task.id, arm, repeat, state: 'queued', startedAt: null, endedAt: null,
          activeModel: null, testsPassed: null, testsTotal: null, reviewIssues: null, costUsd: null, outputTokens: null, rework: null });
      }
      const history = await this.history();
      const estimates = new Map(input.arms.map(arm => [arm, armEstimate(arm, history, this.prices)]));
      if (this.closed) throw new Error('实验室已关闭。');
      await this.store.save(experiment); this.experiments.unshift(experiment);
      if (this.closed) {
        experiment.state = 'stopped';
        for (const run of experiment.runs) { run.state = 'stopped'; run.endedAt = this.now(); }
        await this.store.save(experiment);
        throw new Error('实验室已关闭。');
      }
      const active = { id, controller: new AbortController(), done: null };
      this.active = active;
      active.done = this.execute(experiment, project, estimates, active.controller.signal).catch(async error => {
        experiment.state = active.controller.signal.aborted ? 'stopped' : 'error';
        for (const run of experiment.runs) if (['queued', 'running'].includes(run.state)) {
          run.state = active.controller.signal.aborted ? 'stopped' : 'error'; run.activeModel = null; run.endedAt = this.now();
          run.error = String(error.message || error).slice(0, 1000);
        }
        await this.store.save(experiment).catch(() => {}); this.changed();
      }).finally(() => { if (this.active === active) this.active = null; });
      this.changed();
      return id;
    } finally { this.starting = false; }
  }
  async execute(experiment, project, estimates, signal) {
    for (const run of experiment.runs) {
      const expected = estimates.get(run.arm).costUsd;
      if (signal.aborted || experiment.spentUsd + expected > experiment.budgetUsd + 1e-9) {
        experiment.state = 'stopped';
        for (const remaining of experiment.runs) if (remaining.state === 'queued') { remaining.state = 'stopped'; remaining.endedAt = this.now(); }
        break;
      }
      run.state = 'running'; run.startedAt = this.now();
      await this.store.save(experiment); this.changed();
      const task = experiment.tasks.find(task => task.id === run.taskId);
      const result = await this.runner({ project, task, run, directory: path.join(this.store.folder(experiment.id), 'runs', run.id),
        socketDirectory: this.store.directory, helper: this.helper, prices: this.prices, records: this.records, signal,
        nodePath: this.nodePath, env: this.env, timeoutMs: this.timeoutMs, testTimeoutMs: this.testTimeoutMs, reviewTimeoutMs: this.reviewTimeoutMs,
        changed: model => { run.activeModel = model; this.changed(); } });
      Object.assign(run, result, { activeModel: null, endedAt: this.now() });
      experiment.spentUsd += finite(run.costUsd) ? run.costUsd : expected;
      await this.store.save(experiment); this.changed();
    }
    if (experiment.state === 'running') experiment.state = signal.aborted ? 'stopped' : 'done';
    await this.store.save(experiment); this.changed();
  }
  async stop(id) {
    if (!validId(id)) throw new Error('无效的实验编号。');
    await this.ready;
    if (!this.experiments.some(experiment => experiment.id === id)) throw new Error('实验不存在。');
    const active = this.active;
    if (active?.id !== id) return;
    active.controller.abort(); await active.done;
  }
  async remove(id) {
    if (!validId(id)) throw new Error('无效的实验编号。');
    await this.ready;
    if (this.active?.id === id || this.starting) throw new Error('请先停止正在运行的实验。');
    await this.store.remove(id);
    this.experiments = this.experiments.filter(experiment => experiment.id !== id); this.changed();
  }
  close() { this.closed = true; this.active?.controller.abort(); }
  waitForQuit() {
    if (this.quitWaited) return null;
    this.quitWaited = true; this.close();
    return this.active?.done || null;
  }
}

module.exports = { LabEngine };
