// Reads every BOUNDARY.md and checks it against the code (the format and rules are in skills/module-boundary/SKILL.md).
// Used by tests/module-boundaries.test.cjs, and by the dispatch helper's allowed-path check.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SECTIONS = ['Owns', 'Interface', 'May import', 'Invariants', 'Not ours'];
const LIMITS = { Owns: [1, Infinity], Interface: [0, 12], 'May import': [0, 12], Invariants: [1, 8], 'Not ours': [0, 8] };
const SOURCE = /\.(?:[cm]?js|tsx?)$/;
// Generated or vendored anywhere; repository-level folders that hold no app code only at the root.
const SKIP = new Set(['node_modules', 'dist', 'release', '.git', '.test-output', '.claude']);
const SKIP_AT_ROOT = new Set(['tests', 'scripts', 'docs', 'assets', 'resources', 'skills']);
const EXCEPTION = /\bexcept\b|\bunless\b|例外|除非/i;

// One glob syntax for BOUNDARY.md and the dispatch helper's --allow.
const { posix, globRegExp, matches } = require('../electron/boundaries.cjs');

// Repo-relative paths (forward slashes) of the files under root that `wanted` accepts.
function walkFiles(root, wanted) {
  const files = [];
  const walk = folder => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (entry.isDirectory()) { if (!SKIP.has(entry.name) && !(folder === root && SKIP_AT_ROOT.has(entry.name))) walk(path.join(folder, entry.name)); }
      else if (wanted(entry.name)) files.push(posix(path.relative(root, path.join(folder, entry.name))));
    }
  };
  walk(root);
  return files;
}
// Every source file the boundaries can own, and every BOUNDARY.md.
const sourceFiles = (root = ROOT) => walkFiles(root, name => SOURCE.test(name));
const boundaryFiles = (root = ROOT) => walkFiles(root, name => name === 'BOUNDARY.md');

// A BOUNDARY.md as { file, name, sections: { Owns: [...], ... }, errors }.
function parseBoundary(file, text) {
  const errors = [], sections = {};
  const title = /^# Boundary: (.+)$/m.exec(text);
  if (!title) errors.push(`${file}: the first heading must be "# Boundary: <module name>"`);
  const headings = [...text.matchAll(/^## (.+)$/gm)].map(match => match[1].trim());
  if (headings.join('|') !== SECTIONS.join('|')) errors.push(`${file}: sections must be exactly ${SECTIONS.join(', ')} in that order (found ${headings.join(', ') || 'none'})`);
  for (const [index, heading] of SECTIONS.entries()) {
    const start = text.indexOf(`\n## ${heading}`);
    if (start < 0) { sections[heading] = []; continue; }
    const next = SECTIONS.slice(index + 1).map(name => text.indexOf(`\n## ${name}`, start + 1)).filter(at => at > start);
    const body = text.slice(start + heading.length + 4, next.length ? Math.min(...next) : undefined);
    const lines = body.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const stray = lines.filter(line => !line.startsWith('- '));
    if (stray.length) errors.push(`${file}: "${heading}" holds only "- " bullet lines (found: ${stray[0]})`);
    sections[heading] = lines.filter(line => line.startsWith('- ')).map(line => line.slice(2).trim());
    const [min, max] = LIMITS[heading];
    if (sections[heading].length < min || sections[heading].length > max) errors.push(`${file}: "${heading}" has ${sections[heading].length} entries; allowed ${min}–${max === Infinity ? 'any' : max}`);
    if (['Interface', 'May import', 'Invariants'].includes(heading)) for (const line of sections[heading]) if (EXCEPTION.test(line)) errors.push(`${file}: no exceptions in "${heading}": ${line}`);
  }
  return { file, name: title?.[1].trim() || file, sections, errors };
}

const code = entry => /`([^`]+)`/.exec(entry)?.[1] || null;

// Relative imports of a source file, resolved to repo-relative paths (unresolvable ones are skipped).
function importsOf(file, root = ROOT) {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  const specifiers = [...text.matchAll(/(?:\bimport\s+(?:[^'"`;]*?\sfrom\s+)?|\bexport\s+[^'"`;]*?\sfrom\s+|\brequire\s*\(\s*|\bimport\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)].map(match => match[1]);
  const resolved = [];
  for (const specifier of specifiers) {
    const base = path.join(root, path.dirname(file), specifier.split('?')[0]);
    const candidate = ['', '.ts', '.tsx', '.js', '.cjs', '.mjs', '/index.ts', '/index.tsx', '/index.js'].map(suffix => base + suffix).find(item => fs.existsSync(item) && fs.statSync(item).isFile());
    if (candidate && SOURCE.test(candidate)) resolved.push(posix(path.relative(root, candidate)));
  }
  return resolved;
}

// Every rule of skills/module-boundary/SKILL.md, as a list of readable problems (empty when all boundaries hold).
function checkBoundaries(root = ROOT) {
  const problems = [], files = sourceFiles(root);
  const boundaries = boundaryFiles(root).map(file => parseBoundary(file, fs.readFileSync(path.join(root, file), 'utf8')));
  const owner = new Map();
  for (const boundary of boundaries) {
    problems.push(...boundary.errors);
    const owns = boundary.sections.Owns.map(code).filter(Boolean);
    boundary.owns = owns;
    for (const glob of owns) if (!files.some(file => globRegExp(glob).test(file))) problems.push(`${boundary.file}: Owns "${glob}" matches no source file`);
    for (const file of files) if (matches(owns, file)) {
      if (owner.has(file)) problems.push(`${file} is owned by both ${owner.get(file).name} and ${boundary.name}`);
      else owner.set(file, boundary);
    }
    boundary.interfaceFiles = [];
    for (const entry of boundary.sections.Interface) {
      const match = /^`([^`]+)`\s*\(`([^`]+)`\)/.exec(entry);
      if (!match) { problems.push(`${boundary.file}: Interface entries read "\`name\` (\`file\`) — …": ${entry}`); continue; }
      const [, name, file] = match, full = path.join(root, file);
      if (!fs.existsSync(full)) { problems.push(`${boundary.file}: Interface file ${file} does not exist`); continue; }
      if (!fs.readFileSync(full, 'utf8').includes(name)) problems.push(`${boundary.file}: Interface name ${name} is not in ${file}`);
      boundary.interfaceFiles.push(posix(file));
    }
    boundary.mayImport = boundary.sections['May import'].map(code).filter(Boolean);
    for (const entry of boundary.sections.Invariants) {
      const match = /test:\s*`([^`]+)`\s*›\s*"([^"]+)"/.exec(entry);
      if (!match) { problems.push(`${boundary.file}: each invariant ends with test: \`file\` › "name": ${entry}`); continue; }
      const [, testFile, testName] = match, full = path.join(root, testFile);
      if (!fs.existsSync(full)) problems.push(`${boundary.file}: invariant test file ${testFile} does not exist`);
      else if (!fs.readFileSync(full, 'utf8').includes(testName)) problems.push(`${boundary.file}: ${testFile} has no test named "${testName}"`);
    }
  }
  for (const file of files) {
    const from = owner.get(file);
    for (const target of importsOf(file, root)) {
      const to = owner.get(target);
      if (from && to !== from && !matches(from.mayImport, target)) problems.push(`${file} (${from.name}) imports ${target}, outside its Owns and May import`);
      if (to && to !== from && !to.interfaceFiles.includes(target)) problems.push(`${file} imports ${target}, which is internal to ${to.name} (not in its Interface)`);
    }
  }
  return { problems, boundaries: boundaries.map(({ file, name, owns, interfaceFiles, mayImport, sections }) => ({ file, name, owns, interfaceFiles, mayImport, invariants: sections.Invariants.length })) };
}

// The boundary that owns a file, for briefs and the dispatch helper (null when none does).
function ownerOf(file, root = ROOT) {
  const relative = posix(path.isAbsolute(file) ? path.relative(root, file) : file);
  return checkBoundaries(root).boundaries.find(boundary => matches(boundary.owns || [], relative)) || null;
}

module.exports = { checkBoundaries, parseBoundary, ownerOf, globRegExp, importsOf, sourceFiles };

if (require.main === module) {
  const { problems, boundaries } = checkBoundaries();
  for (const boundary of boundaries) console.log(`${boundary.name}: ${boundary.owns?.length || 0} globs, ${boundary.interfaceFiles?.length || 0} interface files, ${boundary.invariants} invariants`);
  console.log(problems.length ? problems.join('\n') : 'All module boundaries hold.');
  process.exitCode = problems.length ? 1 : 0;
}
