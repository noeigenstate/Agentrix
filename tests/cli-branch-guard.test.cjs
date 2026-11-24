const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const BASELINE = 'tests/fixtures/cli-branch-baseline.json';
const WRITE = 'node tests/cli-branch-guard.test.cjs --write';
const SOURCE = /\.(?:cjs|mjs|ts|tsx|py|ps1|bash|zsh)$/;
const SKIP = /^(?:electron\/features\/(?:cli-adapters|claude-runtime|claude-sdk|codex-app-server|codex-runtime|codex-sandbox-setup)|src\/features\/cli-screens)$/;
const literal = id => `(?:'${id}'|"${id}"|\x60${id}\x60)`;
const cli = literal('(?:claude|codex)');
const operator = String.raw`(?:(?<![=!])[!=]={1,2}(?!=)|(?<![\w-])-(?:i|c)?(?:eq|ne)\b)`;
const comparisons = new RegExp(`(?<=${cli}\\s*)${operator}|${operator}(?=\\s*${cli})`, 'g');
const cases = new RegExp(`\\bcase\\s+${cli}\\s*:`, 'g');
const pair = (first, second) => `${literal(first)}\\s*,\\s*${literal(second)}`;
const lists = new RegExp(`\\[\\s*(?:${pair('claude', 'codex')}|${pair('codex', 'claude')})\\s*,?\\s*\\]`, 'g');
const families = /(?<!\bfunction\s+)\bfamilyOf\s*\(/g;

function branchCount(source) {
  return [comparisons, cases, lists, families].reduce((total, pattern) => total + (source.match(pattern)?.length ?? 0), 0);
}

function files(folder) {
  return fs.readdirSync(path.join(ROOT, folder), { withFileTypes: true }).flatMap(entry => {
    const file = `${folder}/${entry.name}`;
    if (entry.isDirectory() && !['tests', 'node_modules'].includes(entry.name) && !SKIP.test(file)) return files(file);
    return entry.isFile() && SOURCE.test(file) ? [file] : [];
  });
}

function counts() {
  const all = ['electron', 'src', 'integration'].flatMap(files).sort();
  return Object.fromEntries(all.map(file => [file, branchCount(fs.readFileSync(path.join(ROOT, file), 'utf8'))]).filter(([, count]) => count));
}

function differences(actual, baseline) {
  return [...new Set([...Object.keys(actual), ...Object.keys(baseline)])].sort().flatMap(file => {
    const before = baseline[file] ?? 0, after = actual[file] ?? 0;
    if (before === after) return [];
    const fix = after > before ? 'Use support() / adapterOf() through the CLI adapter registry.' : `Lower the baseline in the same change with ${WRITE}.`;
    return [{ increased: after > before, message: `${file}: ${before} -> ${after}. ${fix}` }];
  });
}

if (process.argv.includes('--write')) {
  const target = path.join(ROOT, BASELINE), actual = counts();
  if (fs.existsSync(target)) {
    const increases = differences(actual, JSON.parse(fs.readFileSync(target, 'utf8'))).filter(change => change.increased);
    assert.deepEqual(increases.map(change => change.message), [], 'The CLI branch baseline may only shrink');
  }
  fs.writeFileSync(target, JSON.stringify(actual, null, 2) + '\n');
  console.log(`Wrote ${Object.values(actual).reduce((sum, count) => sum + count, 0)} CLI branch matches; review ${BASELINE}.`);
} else {
  test('the CLI branch guard recognizes comparisons, cases, two-CLI lists and model family calls', () => {
    assert.equal(branchCount(`id === 'claude' || "codex" !== id; if agent == "claude": pass`), 3);
    assert.equal(branchCount(`$agent -eq 'claude'; "codex" -ne $agent; case 'claude': break`), 3);
    assert.equal(branchCount(`['claude', 'codex']; ["codex",\n'claude',]; familyOf (model);`), 3);
    assert.equal(branchCount(`id => 'claude'; ['claude', 'codex', 'other']; function familyOf(model) {}`), 0);
  });

  test('generic code matches its per-file CLI branch baseline', () => {
    const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, BASELINE), 'utf8'));
    const changes = differences(counts(), baseline);
    assert.deepEqual(changes.map(change => change.message), [], 'CLI branch counts changed');
  });
}
