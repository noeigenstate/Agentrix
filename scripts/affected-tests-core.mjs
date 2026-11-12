import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const { parseBoundary, globRegExp } = require('./module-boundaries.cjs');
const posix = file => file.replaceAll('\\', '/');
const source = /\.(?:[cm]?js|tsx?)$/;
const patterns = new Map();
const match = (pattern, file) => {
  if (!patterns.has(pattern)) patterns.set(pattern, globRegExp(pattern));
  return patterns.get(pattern).test(file);
};
const ignored = new Set(['node_modules', '.git', '.notes', '.test-output', 'dist', 'release', '__pycache__']);
export function filesUnder(root, folder = '') {
  if (!fs.existsSync(path.join(root, folder))) return [];
  return fs.readdirSync(path.join(root, folder), { withFileTypes: true }).flatMap(entry => {
    const file = posix(path.join(folder, entry.name));
    return entry.isDirectory() ? ignored.has(entry.name) ? [] : filesUnder(root, file) : [file];
  });
}
const read = (root, file) => fs.readFileSync(path.join(root, file), 'utf8');
function resolveFile(root, file, specifier) {
  const base = specifier.startsWith('.') ? posix(path.join(path.dirname(file), specifier)) : specifier;
  if (!specifier.startsWith('.') && !/^(src|electron|integration|scripts|tests)\//.test(base)) return null;
  return ['', '.ts', '.tsx', '.js', '.cjs', '.mjs', '/index.ts', '/index.tsx', '/index.js', '/index.cjs', '/index.mjs']
    .map(suffix => base + suffix).find(candidate => fs.existsSync(path.join(root, candidate)) && fs.statSync(path.join(root, candidate)).isFile()) ?? null;
}

// Parse import/export/require, including literal dynamic imports. Nonliteral loads remain
// explicit in the manifest; module May import declarations conservatively supplement them.
function references(root, file, text) {
  const targets = new Set(), literals = [], unresolved = [], dynamic = [];
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const add = value => {
    const found = resolveFile(root, file, value.split('?')[0]);
    if (found) targets.add(found);
    else if (value.startsWith('.')) unresolved.push(value);
  };
  function visit(node) {
    if (ts.isStringLiteralLike(node)) literals.push(node.text);
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) add(node.moduleSpecifier.text);
    const load = ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || ts.isIdentifier(node.expression) && node.expression.text === 'require'
      || ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'require');
    if (load) {
      if (node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) add(node.arguments[0].text);
      else dynamic.push(node.getText(tree));
    }
    if (ts.isIdentifier(node) && node.text === 'require') {
      const parent = node.parent;
      const known = ts.isCallExpression(parent) && parent.expression === node
        || ts.isPropertyAccessExpression(parent) && (parent.expression === node && ['main', 'cache', 'resolve'].includes(parent.name.text)
          || parent.name === node && ts.isCallExpression(parent.parent) && parent.parent.expression === parent);
      if (!known) dynamic.push('indirect require');
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'createRequire') dynamic.push('createRequire alias');
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return { targets, literals, unresolved, dynamicDigest: dynamic.length ? createHash('sha256').update(text.replaceAll('\r\n', '\n')).digest('hex') : null };
}

export function buildCatalog(root, manifest = JSON.parse(read(root, 'scripts/affected-tests-map.json'))) {
  const files = ['electron', 'src', 'integration', 'scripts', 'tests'].flatMap(folder => filesUnder(root, folder));
  const boundaries = files.filter(file => file.endsWith('/BOUNDARY.md')).map(file => {
    const boundary = parseBoundary(file, read(root, file));
    return { id: file, name: boundary.name, errors: boundary.errors, owns: boundary.sections.Owns.flatMap(line => [...line.matchAll(/`([^`]+)`/g)].map(match => match[1])),
      imports: boundary.sections['May import'].flatMap(line => [...line.matchAll(/`([^`]+)`/g)].map(match => match[1])), text: read(root, file) };
  });
  const matches = (patterns, file) => patterns.some(pattern => match(pattern, file));
  // A test helper one module's tests share (manifest.helpers) belongs to that module, not to every test.
  const owners = file => [...boundaries.filter(boundary => boundary.id === file || matches(boundary.owns, file)).map(boundary => boundary.id), ...(manifest.helpers?.[file] ?? [])];
  const modules = Object.fromEntries(boundaries.map(boundary => [boundary.id, { name: boundary.name, unit: [], real: [], python: [], gui: [] }]));
  const errors = boundaries.flatMap(boundary => boundary.errors), dependencies = new Map(), referencesByFile = new Map();
  for (const file of files.filter(file => source.test(file))) {
    const refs = references(root, file, read(root, file));
    const product = /^(electron|src|integration)\//.test(file) && !globalChange(file, manifest);
    if (product && refs.unresolved.length) {
      const declared = manifest.unresolvedImports?.[file];
      if (!declared?.reason || refs.unresolved.some(target => !declared.targets.includes(target))) errors.push(`Unresolved relative import: ${file}: ${refs.unresolved.join(', ')}`);
    }
    if (product && refs.dynamicDigest) {
      const declared = manifest.dynamicLoads?.[file];
      if (!declared || declared.digest !== refs.dynamicDigest || !declared.reason || declared.targets.some(target => !files.includes(target))) errors.push(`Unclassified dynamic load: ${file}`);
      else declared.targets.forEach(target => refs.targets.add(target));
    }
    referencesByFile.set(file, refs);
    dependencies.set(file, referencesByFile.get(file).targets);
  }
  const tests = files.filter(file => /^tests\/.*(?:\.test\.[cm]?[jt]sx?|_test\.py)$/.test(file)).sort();
  for (const file of tests) if (!/^tests\/(?:[^/]+\.test\.cjs|[^/]+_test\.py)$/.test(file)) errors.push(`Test is outside the full runner's discovery contract: ${file}`);
  const real = new Set(tests.filter(file => file.endsWith('real-cli.test.cjs') || ['tests/native-ui-backend-real.test.cjs', 'tests/backend-activity.test.cjs'].includes(file)));
  const memberships = new Map(), globalTests = new Set(manifest.globalTests);
  for (const file of globalTests) if (!tests.includes(file)) errors.push(`Stale global test: ${file}`);
  for (const file of Object.keys(manifest.tests)) if (!tests.includes(file)) errors.push(`Stale test mapping: ${file}`);
  const validModules = ids => ids.every(id => Object.hasOwn(modules, id));
  for (const test of tests) {
    const ids = new Set(manifest.tests[test] ?? []), seen = new Set();
    const walk = file => {
      if (seen.has(file)) return;
      seen.add(file);
      owners(file).forEach(id => ids.add(id));
      for (const target of dependencies.get(file) ?? []) walk(target);
    };
    walk(test);
    // Test harnesses name modules through load()/VM and fs reads as often as require().
    for (const literal of referencesByFile.get(test)?.literals ?? []) {
      if (!/^(?:\.{1,2}\/)?(?:src\/|electron\/|integration\/|scripts\/|tests\/|features\/|shared\/)/.test(literal)
        || !/\.(?:[cm]?js|tsx?|css|json)$/.test(literal)) continue;
      for (const candidate of [literal, `src/${literal}`]) {
        const resolved = resolveFile(root, test, candidate);
        if (resolved) walk(resolved);
      }
    }
    for (const boundary of boundaries) if (boundary.text.includes(`\`${test}\``)) ids.add(boundary.id);
    if (!ids.size && !globalTests.has(test)) errors.push(`Test has no module or explicit global designation: ${test}`);
    if (!validModules([...ids])) errors.push(`Unknown module in test mapping: ${test}`);
    memberships.set(test, [...ids].sort());
    for (const id of ids) if (modules[id]) modules[id][real.has(test) ? 'real' : test.endsWith('.py') ? 'python' : 'unit'].push(test);
  }
  for (const [suite, spec] of Object.entries(manifest.gui)) {
    if (!fs.existsSync(path.join(root, spec.file)) || !validModules(spec.modules) || !spec.modules.length || !['interaction', 'terminals', 'reading'].includes(spec.shard)) errors.push(`Invalid GUI mapping: ${suite}`);
    for (const id of spec.modules) if (modules[id]) modules[id].gui.push(suite);
  }
  for (const file of Object.keys(manifest.dynamicLoads ?? {})) if (!referencesByFile.get(file)?.dynamicDigest) errors.push(`Stale dynamic-load mapping: ${file}`);
  for (const [file, ids] of Object.entries(manifest.helpers ?? {})) if (!files.includes(file) || !ids.length || !validModules(ids)) errors.push(`Invalid helper mapping: ${file}`);
  // File graph is retained through unowned intermediate files; modules are the stable unit
  // of selection. Main/shared are composition sinks, not reverse edges between all providers.
  const reverse = new Map();
  const edge = (target, from) => { if (!reverse.has(target)) reverse.set(target, new Set()); reverse.get(target).add(from); };
  for (const [from, targets] of dependencies) if (!globalChange(from, manifest)) for (const target of targets) edge(target, from);
  return { root, manifest, files, boundaries, modules, owners, tests, real, memberships, globalTests, dependencies, reverse, errors };
}

export function globalChange(file, manifest) {
  if (Object.values(manifest.gui).some(spec => spec.file === file)) return false;
  return manifest.fullOn.some(pattern => match(pattern, file));
}

export function selectTests(catalog, changed, { base = null, head = null, forceFull = null } = {}) {
  const { manifest } = catalog, reasons = {}, impacted = new Set(), visited = new Set();
  const fullReasons = [...catalog.errors.map(error => `Invalid catalog: ${error}`), ...(forceFull ? [forceFull] : [])];
  const why = (id, reason) => { if (!reasons[id]) reasons[id] = []; if (!reasons[id].includes(reason)) reasons[id].push(reason); };
  const queue = [];
  for (const file of changed) {
    const ignored = (manifest.ignored ?? []).find(item => match(item.glob, file));
    if (ignored) { why(file, ignored.reason); continue; }
    if (globalChange(file, manifest) && !manifest.helpers?.[file]) { fullReasons.push(`Shared/infrastructure change: ${file}`); continue; }
    if (catalog.tests.includes(file)) { why(file, `Test changed: ${file}`); continue; }
    const suites = Object.entries(manifest.gui).filter(([, spec]) => spec.file === file).map(([name]) => name);
    if (suites.length) { suites.forEach(name => why(`gui:${name}`, `Smoke changed: ${file}`)); queue.push(file); continue; }
    const ids = catalog.owners(file);
    if (!ids.length) { fullReasons.push(`Cannot prove ownership: ${file}`); continue; }
    queue.push(file);
    ids.forEach(id => { impacted.add(id); why(id, `Changed: ${file}`); });
  }
  // Expand every affected module, then its actual importers, to a fixed point.
  const expand = () => {
    for (const id of impacted) {
      const boundary = catalog.boundaries.find(item => item.id === id);
      for (const file of catalog.files) if (boundary.owns.some(pattern => match(pattern, file)) && !visited.has(file)) queue.push(file);
    }
  };
  expand();
  while (queue.length) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    for (const id of catalog.owners(file)) if (!impacted.has(id)) { impacted.add(id); why(id, `Imports affected code: ${file}`); expand(); }
    for (const importer of catalog.reverse.get(file) ?? []) queue.push(importer);
    // A declared module dependency also covers runtime-only dynamic imports.
    for (const boundary of catalog.boundaries) if (!impacted.has(boundary.id) && boundary.imports.some(pattern => match(pattern, file))) {
      impacted.add(boundary.id); why(boundary.id, `Declared dependency: ${file}`); expand();
    }
  }
  const full = fullReasons.length > 0;
  const selected = catalog.tests.filter(test => {
    const ids = catalog.memberships.get(test);
    const selectedIds = ids.filter(id => impacted.has(id));
    if (full) why(test, 'Full fallback');
    else if (catalog.globalTests.has(test)) why(test, 'Always-run global contract');
    else selectedIds.forEach(id => why(test, `Module: ${id}`));
    if (visited.has(test)) why(test, 'Imports affected file');
    return full || catalog.globalTests.has(test) || reasons[test]?.length;
  });
  const gui = Object.entries(manifest.gui).filter(([name, spec]) => {
    const ids = spec.modules.filter(id => impacted.has(id));
    if (full) why(`gui:${name}`, 'Full fallback');
    else ids.forEach(id => why(`gui:${name}`, `Module: ${id}`));
    return full || reasons[`gui:${name}`]?.length;
  }).map(([name]) => name);
  return { version: 1, base, head, changed: [...changed], full, fullReasons: [...new Set(fullReasons)], modules: [...impacted].sort(),
    unit: selected.filter(file => !catalog.real.has(file) && !file.endsWith('.py')), real: selected.filter(file => catalog.real.has(file)),
    python: selected.filter(file => file.endsWith('.py')), gui, shards: [...new Set(gui.map(name => manifest.gui[name].shard))].sort(), reasons };
}
