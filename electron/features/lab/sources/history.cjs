const path = require('node:path');
const { fs, removePath } = require('../disk.cjs');
const { hash } = require('../values.cjs');
const { sampleHistory, profileTask, gradingFiles } = require('../history.cjs');
const { ownerState, assertOwner } = require('../workspace.cjs');
const { gradeTests } = require('../grading.cjs');

async function projectFor(id, ctx) {
  const project = ctx.getProjects().find(project => project.id === id && project.kind !== 'ssh' && typeof project.path === 'string');
  if (!project) throw new Error('实验需要本地 Git 项目。');
  return { id: project.id, name: project.name, path: await fs.realpath(project.path), kind: 'local' };
}

function createHistorySource() {
  return {
    id: 'history', review: 'diff',
    async describe(ctx) {
      try {
        const options = ctx.getProjects().filter(project => project.kind !== 'ssh' && typeof project.path === 'string')
          .map(project => ({ id: project.id, name: project.name, detail: null, tasks: null, license: null }));
        return { id: 'history', available: options.length > 0, reason: options.length ? null : ctx.t('实验需要本地 Git 项目。'),
          metric: 'hidden-tests', review: true, size: { min: 1, max: 10, standard: 3 }, options,
          manifest: null, published: null, downloadBytes: null, keyStored: null };
      } catch {
        return { id: 'history', available: false, reason: ctx.t('实验来源暂时不可用。'), metric: 'hidden-tests', review: true,
          size: { min: 1, max: 10, standard: 3 }, options: [], manifest: null, published: null, downloadBytes: null, keyStored: null };
      }
    },
    async sample(query, ctx) {
      const project = await projectFor(query.projectId, ctx);
      return sampleHistory(project.path, query, { signal: ctx.signal, t: ctx.t });
    },
    async canonical(selection, ctx) {
      const project = await projectFor(selection.projectId, ctx), tasks = [];
      for (const item of selection.tasks) {
        if (!hash(item.id)) throw new Error('无效的实验提交。');
        const task = await profileTask(project.path, item.id, { signal: ctx.signal, t: ctx.t });
        if (!task) throw new Error('实验任务不再符合历史采样条件。');
        tasks.push(task);
      }
      return { scope: { project }, scopeKey: project.id, scopeLabel: project.name, tasks };
    },
    async guard({ project }) {
      const before = await ownerState(project.path);
      const trees = before.worktrees.split('\0').filter(line => line.startsWith('worktree ')).map(line => line.slice(9));
      const dependencies = await fs.realpath(path.join(project.path, 'node_modules')).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      return { before, protectedPaths: [project.path, before.common, ...trees, ...(dependencies ? [dependencies] : [])],
        async check() {
          try { return await assertOwner(project.path, before); }
          catch (error) { error.fatal = true; throw error; }
        } };
    },
    async reference(task, { project }, ctx) {
      let workspace = await ctx.tools.snapshot(project.path, ctx.workspaceRoot, task.commit, { signal: ctx.signal });
      const check = async () => {
        const grade = await gradeTests({ projectPath: project.path, cwd: workspace.cwd, task,
          directory: ctx.artifactDirectory, signal: ctx.signal, session: ctx.session, timeoutMs: ctx.testTimeoutMs, restore: false });
        if (grade.testsPassed !== grade.testsTotal ||
          grade.names.some(name => task.hiddenTests.some(file => name === file || name.endsWith('/' + file)))) {
          throw new Error(ctx.t('未通过'));
        }
        return grade;
      };
      let grade, electronDist = false;
      try { grade = await check(); }
      catch (error) {
        if (ctx.signal?.aborted || error.infrastructure ||
          !await fs.stat(path.join(project.path, 'node_modules/electron/dist')).catch(() => null)) throw error;
        await fs.rename(path.join(ctx.artifactDirectory, 'tests.log'), path.join(ctx.artifactDirectory, 'tests-compact.log'));
        try {
          await removePath(workspace.cwd);
          workspace = await ctx.tools.snapshot(project.path, ctx.workspaceRoot, task.commit, { signal: ctx.signal, electronDist: true });
        } catch (copyError) { copyError.infrastructure = true; throw copyError; }
        electronDist = true; grade = await check();
      }
      const files = await gradingFiles(project.path, task);
      return { total: grade.testsTotal, names: grade.names, files, diffFiles: files.map(entry => entry.file), electronDist };
    },
    prepare(task, { project }, ctx) {
      return ctx.tools.snapshot(project.path, ctx.workspaceRoot, task.base,
        { signal: ctx.signal, electronDist: ctx.reference?.electronDist });
    },
    async grade(task, { project }, ctx) {
      const cwd = path.join(ctx.workspaceRoot, 'worktree');
      const result = await gradeTests({ projectPath: project.path, cwd, task, directory: ctx.artifactDirectory,
        signal: ctx.signal, session: ctx.session, reference: ctx.reference, timeoutMs: ctx.testTimeoutMs });
      return { ...result, score: result.testsPassed / result.testsTotal,
        passed: result.testsPassed === result.testsTotal, evidence: path.join(ctx.artifactDirectory, 'tests.log') };
    },
  };
}

module.exports = { createHistorySource };
