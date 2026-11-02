const { TASK_ID, assertProvider } = require('../lab/sources/contract.cjs');
const { fingerprint, relativePath, failure, createCache } = require('./cache.cjs');
const { createRuntime } = require('./container.cjs');
const { refreshScores, published } = require('./scores.cjs');

const BENCHMARK = 'terminal-bench-4';
const absolutePath = value => typeof value === 'string' && value.startsWith('/') && value !== '/' &&
  !/[\x00-\x1f\\:]/.test(value) && !value.split('/').some(part => part === '..' || part === '.');

function validate(manifest) {
  const ids = new Set(), names = new Set();
  if (manifest.benchmark !== BENCHMARK || !/^[a-f0-9]{40}$/.test(manifest.source?.revision) ||
    !/^[a-f0-9]{64}$/.test(manifest.source.imagesSha256) || !manifest.tasks?.length ||
    manifest.tasks.length + manifest.excluded.length !== manifest.upstreamCount) throw failure('AA 任务清单无效。');
  for (const task of manifest.tasks) {
    if (!TASK_ID.test(task.id) || task.id !== 'aa-' + task.item || ids.has(task.id) ||
      !/^[a-z0-9][a-z0-9-]*$/.test(task.item)) throw failure('AA 任务清单无效。');
    ids.add(task.id); names.add(task.item);
    for (const env of [task.environment, task.verifier]) {
      if (!/^[a-z0-9][a-z0-9./:_-]+$/.test(env?.image) || !/^sha256:[a-f0-9]{64}$/.test(env.digest) ||
        !absolutePath(env.workdir) && env.workdir !== '/') throw failure('AA 任务清单无效。');
    }
    const files = new Set();
    for (const file of task.files) {
      if (!relativePath(file.path) || files.has(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256) ||
        !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > 32 * 1024 ** 2) throw failure('AA 任务清单无效。');
      files.add(file.path);
    }
    if (!(Number.isFinite(task.verifierTimeoutSec) && task.verifierTimeoutSec > 0) ||
      !['instruction.md', 'tests/test.sh', 'solution/solve.sh'].every(file => files.has(file)) ||
      !Array.isArray(task.collect) || task.collect.some(command => typeof command !== 'string' || !command)) throw failure('AA 任务清单无效。');
    for (const entry of task.artifacts) {
      const source = typeof entry === 'string' ? entry : entry.source;
      if (!absolutePath(source) || /^\/(?:tests|solution|logs\/verifier)(?:\/|$)/.test(source) ||
        typeof entry !== 'string' && (entry.exclude || []).some(value => typeof value !== 'string' || /[\x00-\x1f]/.test(value))) {
        throw failure('AA 任务清单无效。');
      }
    }
  }
  for (const task of manifest.excluded) {
    if (names.has(task.item) || !task.reasons.length || task.reasons.some(reason => !['gpu', 'multi-service'].includes(reason))) {
      throw failure('AA 任务清单无效。');
    }
    names.add(task.item);
  }
  return manifest;
}

function createAaSource({ manifest = require('./manifest.json') } = {}) {
  const catalog = validate(structuredClone(manifest)), cache = createCache(catalog), runtime = createRuntime(cache);
  const tasks = new Map(catalog.tasks.map(task => [task.id, task]));
  const scopes = new WeakSet();
  const scoped = scope => {
    if (!scope || !scopes.has(scope)) throw failure('AA 任务选择无效。');
    return scope.ids.map(id => tasks.get(id));
  };
  const selected = (task, scope) => {
    const entry = scoped(scope).find(entry => entry.id === task.id);
    if (!entry) throw failure('AA 任务选择无效。');
    return entry;
  };
  const publicTask = (entry, text, ctx) => ({
    id: entry.id, source: 'aa', benchmark: BENCHMARK, item: entry.item, category: entry.category,
    title: entry.item.replace(/-/g, ' '), text: text || ctx.t('题面将在启动时下载。'), kind: 'core',
    why: ctx.t('Terminal-Bench 4.0 单容器、无 GPU 任务；由任务自身验证器评分。'),
  });
  return assertProvider({
    id: 'aa', review: 'none',
    async describe(ctx) {
      const info = {
        id: 'aa', available: false, reason: 'AA 来源暂不可用。', metric: 'tests', review: false,
        size: { min: 1, max: tasks.size, standard: Math.min(10, tasks.size) },
        options: [{ id: BENCHMARK, name: 'Terminal-Bench 4.0 · AA 同款',
          detail: null, tasks: tasks.size, license: catalog.source.license }],
        manifest: { version: catalog.version, sha256: cache.hash }, published: null, downloadBytes: null, keyStored: null,
      };
      try {
        info.options[0].name = ctx.t('Terminal-Bench 4.0 · AA 同款');
        info.options[0].detail = ctx.t('仅含单容器、无 GPU 任务：{included}/{total} 题。', { included: tasks.size, total: catalog.upstreamCount });
        const probe = await ctx.tools.docker.probe({ signal: ctx.signal });
        info.available = probe.available === true;
        info.reason = info.available ? null : ctx.t(probe.reason || 'Docker 不可用，请先安装并启动 Docker。');
      } catch { info.available = false; info.reason = ctx.t('AA 来源暂不可用。'); }
      try { info.keyStored = !!ctx.credential(); info.published = await published(ctx); } catch {}
      return info;
    },
    async sample(query, ctx) {
      if (query?.source !== 'aa' || query.benchmark !== BENCHMARK || !Number.isInteger(query.size) || query.size < 1 || query.size > tasks.size ||
        query.exclude !== undefined && (!Array.isArray(query.exclude) || query.exclude.some(id => typeof id !== 'string'))) {
        throw failure('AA 任务选择无效。');
      }
      const excluded = new Set(query.exclude || []);
      return [...tasks.values()].filter(task => !excluded.has(task.id))
        .sort((a, b) => fingerprint(catalog.version + a.id).localeCompare(fingerprint(catalog.version + b.id)))
        .slice(0, query.size).map(entry => publicTask(entry, null, ctx));
    },
    async canonical(selection, ctx) {
      if (selection?.source !== 'aa' || selection.benchmark !== BENCHMARK || !Array.isArray(selection.tasks) ||
        !selection.tasks.length || selection.tasks.length > tasks.size) throw failure('AA 任务选择无效。');
      const ids = selection.tasks.map(task => task?.id);
      if (new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !tasks.has(id))) throw failure('AA 任务选择无效。');
      const scope = Object.freeze({ ids: Object.freeze(ids) }); scopes.add(scope);
      const canonical = [];
      for (const id of ids) {
        const entry = tasks.get(id), file = entry.files.find(file => file.path === 'instruction.md');
        let text;
        try { text = (await cache.read(ctx, entry, file)).toString('utf8'); }
        catch (error) { if (error.fatal) throw error; }
        canonical.push(publicTask(entry, text, ctx));
      }
      return { scope, scopeKey: cache.hash, scopeLabel: 'Terminal-Bench 4.0 · ' + tasks.size + '/' + catalog.upstreamCount, tasks: canonical };
    },
    async fetch(scope, ctx) { await cache.fetch(ctx, scoped(scope)); await refreshScores(ctx); },
    guard: (scope, ctx) => cache.guard(ctx, scoped(scope)),
    reference: (task, scope, ctx) => runtime.reference(selected(task, scope), ctx),
    prepare: (task, scope, ctx) => runtime.prepare(selected(task, scope), ctx),
    brief(task, scope) {
      const entry = selected(task, scope);
      return { task: task.text, rules: [
        'Run every command inside the task with tb <command>. Use ./bin/tb (POSIX) or .\\bin\\tb.cmd (Windows).',
        'The host workspace contains the command client only. Edit task files inside the container, not on the host.',
        'For shell syntax use tb /bin/bash -lc "...". Commands start in ' + entry.environment.workdir + '.',
        'Do not modify bin/tb, bin/tb.cmd or bin/tb.cjs. Never access Docker, hidden tests, reference data or the broker configuration.',
        'Task attribution: ' + catalog.source.repository + '/tree/' + catalog.source.revision + '/tasks/' + entry.item + ' (' + catalog.source.license + ').',
      ] };
    },
    grade: (task, scope, ctx) => runtime.grade(selected(task, scope), ctx),
  });
}

module.exports = { createAaSource };
