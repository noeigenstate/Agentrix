const path = require('node:path');
const { git } = require('./process.cjs');
const { hash, sampleRequest } = require('./values.cjs');
const { translate } = require('../../i18n.cjs');

const testFile = file => /^tests\/(?:[^/]+\/)*[^/]+\.test\.(?:cjs|mjs|js)$/.test(file);
const safePath = file => typeof file === 'string' && file.length <= 1024 && !/[\x00-\x1f\x7f\\:]/.test(file) &&
  !file.startsWith('/') && file.split('/').every(part => part && part !== '.' && part !== '..' && part !== '.git');
const sourceFile = file => !testFile(file) && /\.(?:[cm]?[jt]sx?|c[cp]?|cpp|h|hpp|rs|go|py|java|swift|mm|m|css|scss|html|vue|svelte)$/.test(file) &&
  !/^(?:tests|docs|resources|node_modules|vendor)\//.test(file);
const sizeBand = lines => lines <= 50 ? 'small' : lines <= 200 ? 'medium' : 'large';

async function gradingFiles(projectPath, task) {
  const changed = (await git(projectPath, [
    'diff', '--name-only', '--no-renames', '-z', task.base, task.commit, '--', 'tests/',
  ])).split('\0').filter(Boolean);
  if (changed.some(file => !safePath(file))) throw new Error('无效的隐藏测试路径。');
  const entries = (await git(projectPath, ['ls-tree', '-r', '-z', task.commit, '--', ...changed]))
    .split('\0').filter(Boolean);
  if (entries.some(entry => !/^100(?:644|755) blob /.test(entry))) throw new Error('隐藏测试文件不能是链接。');
  const present = new Set(entries.map(entry => entry.slice(entry.indexOf('\t') + 1)));
  return changed.map(file => ({ file, deleted: !present.has(file) }));
}

function category(files, subject) {
  if (/\b(?:fix|bug|regression)\b|修复|故障/i.test(subject)) return 'core';
  if (files.some(file => /\.(?:tsx|jsx|css|scss|html|vue|svelte)$/.test(file))) return 'frontend';
  return 'core';
}

async function profileTask(projectPath, commit, { signal, t = (source, values) => translate('zh', source, values) } = {}) {
  if (!hash(commit)) throw new Error('无效的实验提交。');
  const options = { signal };
  await git(projectPath, ['merge-base', '--is-ancestor', commit, 'HEAD'], options);
  const parents = (await git(projectPath, ['rev-list', '--parents', '-n', '1', commit], options)).trim().split(' ');
  if (parents.length !== 2) return null;
  const base = parents[1], stats = await git(projectPath, ['diff', '--numstat', '-z', '--no-renames', base, commit, '--'], options);
  const changes = stats.split('\0').filter(Boolean).map(row => {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(row);
    return match ? { file: match[3], lines: match[1] === '-' ? 0 : Number(match[1]) + Number(match[2]) } : null;
  }).filter(Boolean);
  if (changes.length > 200 || changes.some(change => !safePath(change.file))) return null;
  const files = changes.map(change => change.file), tests = files.filter(testFile);
  if (!tests.length || tests.length > 20 || !files.some(sourceFile)) return null;
  const tree = (await git(projectPath, ['ls-tree', '-r', '-z', commit, '--', ...tests], options)).split('\0').filter(Boolean);
  if (tree.length !== tests.length || tree.some(entry => !entry.startsWith('100644 blob ') && !entry.startsWith('100755 blob '))) return null;
  const message = (await git(projectPath, ['show', '-s', '--format=%B', commit], options)).trim();
  if (!message || message.length > 16000) return null;
  // A Node test file using a different runner is outside r1; import or syntax failures at grading still become errors.
  for (const file of tests) {
    const content = await git(projectPath, ['show', `${commit}:${file}`], options);
    if (!/['"](?:node:)?test['"]/.test(content) || /['"](?:vitest|@jest\/globals|mocha)['"]/.test(content)) return null;
  }
  const boundaries = (await git(projectPath, ['ls-tree', '-r', '--name-only', commit], options)).split('\n')
    .filter(file => file.endsWith('/BOUNDARY.md')).map(file => path.posix.dirname(file)).sort((a, b) => b.length - a.length);
  const modules = [...new Set(files.filter(sourceFile).map(file => {
    const parts = file.split('/'), depth = ['src', 'electron'].includes(parts[0]) ? parts[1] === 'features' ? 3 : 2 : 1;
    return boundaries.find(folder => file.startsWith(folder + '/')) ||
      (parts.length > 1 ? parts.slice(0, Math.min(depth, parts.length - 1)).join('/') : 'root');
  }))].sort();
  const linesChanged = changes.reduce((sum, change) => sum + change.lines, 0), title = message.split('\n')[0];
  return { id: commit, source: 'history', title, text: message, commit, base, modules, linesChanged, hiddenTests: tests, kind: category(files, title),
    why: t('跨 {modules} 个模块 · 改动 {lines} 行', { modules: modules.length, lines: linesChanged }) };
}

function selectTasks(tasks, size, preferShortComplex, exclude = []) {
  const candidates = tasks.filter(task => !exclude.includes(task.id));
  const selected = [], modules = new Set(), bands = new Set();
  while (selected.length < size && candidates.length) {
    let best = 0, score = -Infinity;
    for (const [index, task] of candidates.entries()) {
      const band = sizeBand(task.linesChanged);
      const value = Math.min(3, task.modules.filter(module => !modules.has(module)).length) * 4 + (bands.has(band) ? 0 : 3) +
        (preferShortComplex && task.modules.length >= 2 ? 10 / (1 + task.linesChanged / 50) : 0) - index / 1000;
      if (value > score) { score = value; best = index; }
    }
    const [task] = candidates.splice(best, 1); selected.push(task);
    for (const module of task.modules) modules.add(module);
    bands.add(sizeBand(task.linesChanged));
  }
  return selected;
}

async function sampleHistory(projectPath, input, { signal, t, limit = 120 } = {}) {
  const request = sampleRequest({ ...input, source: 'history' });
  const commits = (await git(projectPath, ['log', '--no-merges', `--max-count=${limit}`, '--format=%H', 'HEAD'], { signal }))
    .trim().split('\n');
  const tasks = [];
  for (const commit of commits) {
    if (!hash(commit) || request.exclude.includes(commit)) continue;
    const task = await profileTask(projectPath, commit, { signal, t });
    if (task) tasks.push(task);
  }
  return selectTasks(tasks, request.size, request.preferShortComplex, request.exclude);
}

module.exports = { sampleHistory, profileTask, selectTasks, testFile, safePath, gradingFiles };
