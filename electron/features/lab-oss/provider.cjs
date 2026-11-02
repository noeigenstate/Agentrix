const path = require('node:path');
const { TASK_ID } = require('../lab/sources/contract.cjs');
const { sha256, validateManifest, cachedRow, patchPaths, taskDirectory, mirrorDirectory, abort, infrastructure } = require('./data.cjs');
const { fetchTask, guard } = require('./cache.cjs');
const { prepareEnvironment, finalizeWorkspace, requirementsHash } = require('./environment.cjs');
const { cwdFor, caseKey, restoreTests, runTests } = require('./pytest.cjs');

function createProvider(input, python) {
  const manifest = validateManifest(input), hash = sha256(JSON.stringify(manifest));
  const byId = new Map(manifest.tasks.map(entry => [entry.id, entry]));
  const repositories = [...new Set(manifest.tasks.map(entry => entry.repo))].sort();
  const info = { version: manifest.version, sha256: hash };
  const t = (ctx, text) => {
    try { return typeof ctx?.t === 'function' ? ctx.t(text) : text; } catch { return text; }
  };

  function reposOf(value) {
    if (value.source !== 'oss' || !Array.isArray(value.repos) || value.repos.some(repo => !repositories.includes(repo)) ||
      new Set(value.repos).size !== value.repos.length) throw new Error('Invalid OSS repository selection.');
    return value.repos.length ? [...value.repos].sort() : repositories;
  }

  function entryOf(task, scope) {
    const entry = byId.get(task?.id);
    if (!entry || task.source !== 'oss' || scope?.manifest !== hash || !scope.ids?.includes(entry.id) ||
      !scope.repos?.includes(entry.repo)) throw new Error('Invalid OSS task selection.');
    return entry;
  }

  function publicTask(entry, text, ctx) {
    return {
      id: entry.id, source: 'oss', title: entry.title,
      text: text || t(ctx, '题面将在实验开始时下载。'), kind: 'python',
      why: 'SWE-bench Verified · ' + entry.license + ' · ' + t(ctx, '可能已被训练污染'),
      repo: entry.repo, commit: entry.base, language: 'python', upstream: entry.upstream, license: entry.license,
    };
  }

  const provider = {
    id: 'oss', review: 'diff',
    async describe(ctx) {
      return {
        id: 'oss', available: true, reason: null, metric: 'resolved', review: true,
        size: { min: 1, max: Math.min(20, manifest.tasks.length), standard: Math.min(5, manifest.tasks.length) },
        options: repositories.map(repo => ({ id: repo, name: repo, detail: t(ctx, '可能已被训练污染'),
          tasks: manifest.tasks.filter(entry => entry.repo === repo).length,
          license: manifest.tasks.find(entry => entry.repo === repo).license })),
        manifest: { ...info }, published: null, downloadBytes: null, keyStored: null,
      };
    },
    async sample(query, ctx) {
      abort(ctx);
      const repos = reposOf(query);
      if (!Number.isInteger(query.size) || query.size < 1 || query.size > Math.min(20, manifest.tasks.length) ||
        query.exclude !== undefined && (!Array.isArray(query.exclude) || query.exclude.some(id => typeof id !== 'string'))) {
        throw new Error('Invalid OSS sample size or exclusions.');
      }
      const excluded = new Set(query.exclude || []);
      // Stable manifest order is independent of wall time, filesystem state and the order of selected repositories.
      return manifest.tasks.filter(entry => repos.includes(entry.repo) && !excluded.has(entry.id))
        .slice(0, query.size).map(entry => publicTask(entry, null, ctx));
    },
    async canonical(selection, ctx) {
      abort(ctx);
      const repos = reposOf(selection);
      if (!Array.isArray(selection.tasks) || !selection.tasks.length || selection.tasks.length > Math.min(20, manifest.tasks.length)) {
        throw new Error('Invalid OSS task selection.');
      }
      const ids = selection.tasks.map(task => task?.id);
      if (new Set(ids).size !== ids.length || ids.some(id => !TASK_ID.test(id) || !byId.has(id) || !repos.includes(byId.get(id).repo))) {
        throw new Error('Unknown OSS task id.');
      }
      const tasks = [];
      for (const id of ids) {
        const entry = byId.get(id), row = await cachedRow(ctx, entry, true);
        tasks.push(publicTask(entry, row?.problem_statement, ctx));
      }
      return {
        scope: { manifest: hash, repos, ids, platform: ctx.platform },
        scopeKey: hash + ':' + repos.join(','), scopeLabel: repos.join(', '), tasks,
      };
    },
    async fetch(scope, ctx) {
      if (scope?.manifest !== hash || !Array.isArray(scope.ids) || !scope.ids.length) throw new Error('Invalid OSS scope.');
      // Bounded serial downloads; the engine runs sources in parallel and cancellation is checked at every task.
      try { for (const id of scope.ids) await fetchTask(entryOf({ id, source: 'oss' }, scope), ctx); }
      catch (error) {
        if (ctx.signal?.aborted || error.fatal || error.infrastructure) throw error;
        throw infrastructure('OSS task download or cache preparation failed.');
      }
    },
    async guard(scope, ctx) {
      return guard(scope.ids.map(id => entryOf({ id, source: 'oss' }, scope)), ctx);
    },
    async prepare(task, scope, ctx) {
      const entry = entryOf(task, scope);
      await cachedRow(ctx, entry);
      try {
        const workspace = await ctx.tools.snapshot(mirrorDirectory(ctx, entry), ctx.workspaceRoot, entry.base, { signal: ctx.signal });
        if (workspace.cwd !== cwdFor(ctx)) throw new Error('Unexpected OSS snapshot location.');
        await prepareEnvironment(entry, workspace.cwd, ctx, python);
        return await finalizeWorkspace(workspace, ctx);
      }
      catch (error) {
        if (ctx.signal?.aborted || error.fatal || error.infrastructure) throw error;
        throw infrastructure('OSS workspace preparation failed.');
      }
    },
    async reference(task, scope, ctx) {
      const entry = entryOf(task, scope), row = await cachedRow(ctx, entry);
      const workspace = await provider.prepare(task, scope, ctx);
      await restoreTests(entry, row, ctx);
      const before = await runTests(entry, ctx, 'reference-before');
      if (entry.FAIL_TO_PASS.some(id => before.outcomes.get(caseKey(id)) !== 'failed') ||
        entry.PASS_TO_PASS.some(id => before.outcomes.get(caseKey(id)) !== 'passed')) {
        throw new Error('OSS reference does not reproduce the expected baseline failures.');
      }
      await ctx.tools.git(workspace.cwd, ['apply', '--whitespace=nowarn', path.join(taskDirectory(ctx, entry), 'fix.patch')], {
        signal: ctx.signal,
      });
      const after = await runTests(entry, ctx, 'reference-after');
      if (after.testsPassed !== after.testsTotal) throw new Error('OSS reference fix does not pass the complete suite.');
      return {
        taskId: entry.id, manifest: hash, requirements: requirementsHash(entry), diffFiles: patchPaths(row.patch),
        total: after.testsTotal, names: [...entry.FAIL_TO_PASS, ...entry.PASS_TO_PASS].map(caseKey),
      };
    },
    brief(task, scope) {
      entryOf(task, scope);
      const python = scope.platform === 'win32' ? '..\\.oss-venv\\Scripts\\python.exe' : '../.oss-venv/bin/python';
      return { task: task.text, rules: [
        'Use ' + python + ' for Python and pytest; dependencies are already installed. Network access is disabled.',
        'Fix the issue in this isolated repository. Do not change tests, Git metadata or the prepared Python environment.',
        'Source: SWE-bench Verified. Results may be contaminated by prior training. Attribution: ' + task.upstream + ' (' + task.license + ').',
      ] };
    },
    async grade(task, scope, ctx) {
      const entry = entryOf(task, scope), row = await cachedRow(ctx, entry);
      if (ctx.reference?.taskId !== entry.id || ctx.reference.manifest !== hash ||
        ctx.reference.requirements !== requirementsHash(entry)) throw new Error('Missing validated OSS reference.');
      await restoreTests(entry, row, ctx);
      const result = await runTests(entry, ctx, 'tests'), passed = result.testsPassed === result.testsTotal;
      return { testsPassed: result.testsPassed, testsTotal: result.testsTotal, score: passed ? 1 : 0, passed, evidence: result.evidence };
    },
  };
  return provider;
}

module.exports = { createProvider };
