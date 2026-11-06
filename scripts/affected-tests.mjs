import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';
import { buildCatalog, selectTests } from './affected-tests-core.mjs';
import { clipboardSuites } from './gui-suites.mjs';
import policy from './clipboard-policy.cjs';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const git = (args, cwd = root) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }).trimEnd();
export function changedFiles(base, head = null, cwd = root) {
  const resolved = git(['rev-parse', '--verify', `${base}^{commit}`], cwd);
  const target = head ? git(['rev-parse', '--verify', `${head}^{commit}`], cwd) : null;
  const changed = git(['diff', '--name-only', '-z', '--no-renames', resolved, ...(target ? [target] : []), '--'], cwd).split('\0').filter(Boolean);
  if (!target) changed.push(...git(['ls-files', '--others', '--exclude-standard', '-z'], cwd).split('\0').filter(Boolean));
  return { base: resolved, head: target ?? git(['rev-parse', 'HEAD'], cwd), changed: [...new Set(changed)].sort() };
}
export function planFor({ base, head = null, full = null, cwd = root }) {
  const catalog = buildCatalog(cwd);
  let diff;
  try { diff = base ? changedFiles(base, head, cwd) : { changed: [], base: null, head: git(['rev-parse', 'HEAD'], cwd) }; }
  catch { diff = { changed: [], base: null, head: null }; full = 'Base/head unavailable; cannot prove the diff'; }
  const plan = selectTests(catalog, diff.changed, { base: diff.base, head: diff.head, forceFull: full ?? (!base ? 'No verified baseline' : null) });
  return { plan, catalog };
}
export function printPlan(plan) {
  console.log(`${plan.full ? 'FULL' : 'AFFECTED'} tests: base=${plan.base ?? 'unknown'} head=${plan.head ?? 'unknown'}`);
  for (const reason of plan.fullReasons) console.log(`  Full: ${reason}`);
  for (const kind of ['unit', 'real', 'python', 'gui']) {
    console.log(`${kind}: ${plan[kind].length}`);
    for (const item of plan[kind]) console.log(`  ${item}: ${(plan.reasons[kind === 'gui' ? `gui:${item}` : item] ?? []).join('; ')}`);
  }
  console.log(`GUI shards: ${plan.shards.join(', ') || 'none (no affected suites)'}`);
}

// Commands are returned as argv, never shell-built. --run is explicit for live CLI/GUI.
export function runCommands(plan, catalog, { kind = 'all', packaged = false, lockedPrefix = null, env = process.env } = {}) {
  const commands = [], add = (args, extraEnv = {}) => commands.push({ args, env: extraEnv });
  if (['all', 'unit'].includes(kind) && plan.unit.length) {
    add(['scripts/build-ssh-askpass.cjs']); add(['scripts/build-mac-titlebar.cjs', '--optional']);
    add(['--test', '--test-concurrency=4', ...plan.unit]);
  }
  if (['all', 'real'].includes(kind) && plan.real.length) add(['scripts/real-cli-tests.cjs', '--files', plan.real.join(','), ...(lockedPrefix ? ['--locked-prefix', lockedPrefix] : [])]);
  if (['all', 'python'].includes(kind)) for (const file of plan.python) commands.push({ executable: env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3'), args: ['-m', 'unittest', 'discover', '-s', 'tests', '-p', path.posix.basename(file), '-v'], env: {} });
  if (['all', 'gui'].includes(kind)) {
    const allowed = plan.gui.filter(name => !clipboardSuites.includes(name) || policy.githubActions(env));
    for (const name of plan.gui.filter(name => !allowed.includes(name))) console.log(`SKIP ${name}: ${policy.reason}`);
    // focus-motion is deliberately a separate suite; its installed-payload verification
    // stays in CI. All other selected suites use the existing lock/profile runner.
    const regular = allowed.filter(name => name !== 'focus-motion');
    if (regular.length) add(['scripts/windows-gui-smoke.mjs', '--only', regular.join(','), ...(packaged ? ['--packaged'] : [])]);
    if (allowed.includes('focus-motion')) add(['scripts/focus-motion-smoke.mjs', ...(packaged ? ['--packaged'] : [])]);
  }
  return commands;
}

export function parseOptions(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i].slice(2);
    if (!args[i].startsWith('--') || !['base', 'head', 'output', 'plan', 'kind', 'locked-prefix', 'full', 'run', 'packaged', 'catalog'].includes(key) || Object.hasOwn(options, key)) throw new Error(`Invalid option: ${args[i]}`);
    options[key] = ['full', 'run', 'packaged', 'catalog'].includes(key) ? true : args[++i];
    if (options[key] === undefined || typeof options[key] === 'string' && options[key].startsWith('--')) throw new Error(`Missing value: --${key}`);
  }
  if (options.kind && !['all', 'unit', 'real', 'python', 'gui'].includes(options.kind)) throw new Error('Unknown test kind');
  if (options.plan && (options.base || options.head || options.full)) throw new Error('--plan cannot select another diff');
  return options;
}

export function main(args = process.argv.slice(2), execute = spawnSync) {
  const options = parseOptions(args);
  let { plan, catalog } = options.plan ? { plan: JSON.parse(fs.readFileSync(options.plan, 'utf8')), catalog: buildCatalog(root) }
    : planFor({ base: options.base, head: options.head, full: options.full ? 'Explicit full matrix' : null });
  if (options.catalog) console.log(JSON.stringify({ modules: catalog.modules, globals: [...catalog.globalTests], errors: catalog.errors }, null, 2));
  else printPlan(plan);
  if (options.output) { fs.mkdirSync(path.dirname(options.output), { recursive: true }); fs.writeFileSync(options.output, JSON.stringify(plan, null, 2) + '\n'); }
  if (!options.run) return 0;
  // Persisted plans are untrusted input: only the current catalog's names may execute.
  for (const kind of ['unit', 'real', 'python']) if (!Array.isArray(plan[kind]) || plan[kind].some(file => !catalog.tests.includes(file))) throw new Error('Plan contains unknown tests');
  if (!Array.isArray(plan.gui) || plan.gui.some(name => !catalog.manifest.gui[name])) throw new Error('Plan contains unknown GUI suite');
  if (catalog.errors.length) throw new Error('Fix the catalog before executing a persisted plan');
  for (const command of runCommands(plan, catalog, { kind: options.kind, packaged: options.packaged, lockedPrefix: options['locked-prefix'] })) {
    const result = execute(command.executable ?? process.execPath, command.args, { cwd: root, stdio: 'inherit', windowsHide: true, env: { ...process.env, ...command.env } });
    if (result.error) throw result.error;
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
