const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkBoundaries, parseBoundary, globRegExp } = require('../scripts/module-boundaries.cjs');

test('every BOUNDARY.md holds against the code', () => {
  const { problems } = checkBoundaries();
  assert.deepEqual(problems, []);
});

test('globs: * stays within a name, ** crosses folders', () => {
  assert.ok(globRegExp('src/features/terminal/**').test('src/features/terminal/TerminalPane.tsx'));
  assert.ok(globRegExp('src/features/terminal/**').test('src/features/terminal/a/b.ts'));
  assert.ok(globRegExp('electron/terminal-*.cjs').test('electron/terminal-env.cjs'));
  assert.ok(!globRegExp('electron/terminal-*.cjs').test('electron/features/terminal-env.cjs'));
});

test('the parser rejects missing sections, prose, exceptions and too many invariants', () => {
  const good = '# Boundary: X\n\nWhat.\n\n## Owns\n- `a/**`\n\n## Interface\n\n## May import\n\n## Invariants\n- r — why — test: `t.cjs` › "n"\n\n## Not ours\n';
  assert.deepEqual(parseBoundary('B', good).errors, []);
  assert.match(parseBoundary('B', good.replace('## Not ours\n', '')).errors.join(), /sections must be exactly/);
  assert.match(parseBoundary('B', good.replace('- `a/**`', 'prose here')).errors.join(), /bullet lines|has 0 entries/);
  assert.match(parseBoundary('B', good.replace('- r — why', '- r unless x — why')).errors.join(), /no exceptions/);
  const many = Array.from({ length: 9 }, (_, i) => `- r${i} — why — test: \`t.cjs\` › "n"`).join('\n');
  assert.match(parseBoundary('B', good.replace(/- r — why — test: `t.cjs` › "n"/, many)).errors.join(), /Invariants" has 9 entries/);
});

test('imports across a boundary must go through its Interface, and out of one only to May import', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'boundaries-'));
  const write = (file, text) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text); };
  write('a/index.cjs', 'module.exports = { api: 1 };');
  write('a/inner.cjs', 'module.exports = 2;');
  write('a/t.cjs', 'test("n", () => {});');
  write('b/use.cjs', "require('../a/index.cjs'); require('../a/inner.cjs');");
  write('a/BOUNDARY.md', '# Boundary: A\n\nA.\n\n## Owns\n- `a/**`\n\n## Interface\n- `api` (`a/index.cjs`) — the API\n\n## May import\n\n## Invariants\n- r — why — test: `a/t.cjs` › "n"\n\n## Not ours\n');
  write('b/BOUNDARY.md', '# Boundary: B\n\nB.\n\n## Owns\n- `b/**`\n\n## Interface\n\n## May import\n\n## Invariants\n- r — why — test: `a/t.cjs` › "n"\n\n## Not ours\n');
  const { problems } = checkBoundaries(root);
  assert.ok(problems.some(problem => problem.includes('b/use.cjs (B) imports a/index.cjs, outside its Owns and May import')));
  assert.ok(problems.some(problem => problem.includes('a/inner.cjs, which is internal to A')));
  assert.ok(!problems.some(problem => problem.includes('a/index.cjs, which is internal')));
  fs.rmSync(root, { recursive: true, force: true });
});
