const { test } = require('node:test');
const assert = require('node:assert/strict');
const ts = require('typescript');
const { ROOT, moduleOfFile, walk, loadBaseline, writeBaseline } = require('./helpers/guard-baselines.cjs');
const { scan, productFindings, testFindings } = require('./helpers/self-format-scan.cjs');

const BASELINE = 'tests/fixtures/self-format-baseline';
const WRITE = 'node tests/self-format-guard.test.cjs --write';
const SOURCE = /\.(?:[cm]?[jt]sx?|py|ps1|bash|zsh|sh|cmd)$/;
const EXCLUDED = /(?:^src\/features\/cli-screens(?:\/|$)|\/(?:node_modules|tests|fixtures)(?:\/|$))/;
const ownerOf = moduleOfFile(), moduleOf = key => ownerOf(key.split(' :: ')[0]);

function counts() {
  const product = ['electron', 'integration', 'src', 'scripts'].flatMap(folder => walk(folder, (file, entry) =>
    EXCLUDED.test(file) || entry.isFile() && !SOURCE.test(file)));
  const tests = walk('tests', (file, entry) => /\/(?:fixtures|node_modules)$/.test(file) || entry.isFile() && !/\.[cm]?[jt]sx?$/.test(file));
  return scan(product, tests);
}

function differences(actual, baseline) {
  return [...new Set([...Object.keys(actual), ...Object.keys(baseline)])].sort().flatMap(key => {
    const before = baseline[key] ?? 0, after = actual[key] ?? 0;
    if (before === after) return [];
    const fix = after > before ? 'Read structured fields or import the code under test.' : `Lower the baseline with ${WRITE}.`;
    return [{ increased: after > before, message: `${key}: ${before} -> ${after}. ${fix}` }];
  });
}

const baseline = () => Object.assign({}, ...Object.values(loadBaseline(BASELINE, moduleOf)));
if (process.argv.includes('--write')) {
  const actual = counts();
  const increases = differences(actual, baseline()).filter(change => change.increased);
  assert.deepEqual(increases.map(change => change.message), [], 'The self-format baseline may only shrink');
  writeBaseline(BASELINE, actual, moduleOf);
  console.log(`Wrote ${Object.values(actual).reduce((sum, count) => sum + count, 0)} self-format matches in ${BASELINE}.`);
} else {
  test('the self-format guard recognizes heading, prefix, position and whole-word readers', () => {
    const input = [
      "data.split(/^### /m); data.indexOf('## Findings for the ledger');",
      "line.startsWith('[dispatch] started'); lines.includes('[dispatch] unknown run');",
      "/\\[dispatch\\] ended/.test(line); /exit -?\\d+ reason ([a-z]+)/.exec(line);",
      "const [a, b] = data.split(/\\r?\\n/); data.split('\\n')[2]; data.trim() === 'native';",
      'const row = JSON.parse(data); row.reason === "error";',
    ].join('\n');
    const tree = ts.createSourceFile('product.cjs', input, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    assert.deepEqual(productFindings(input, 'electron/product.cjs', { getSourceFile: () => tree, symbols: {} }).sort(), [
      'dispatch-text', 'dispatch-text', 'dispatch-text', 'dispatch-text', 'heading-text', 'heading-text', 'positional-lines', 'positional-lines', 'whole-word',
    ]);
    assert.deepEqual(productFindings('IFS= read -r a && IFS= read -r b\n[[ $(cat "$mode_file") == native ]]', 'integration/example.bash', {}).sort(),
      ['ordered-shell-lines', 'whole-word']);
    assert.deepEqual(productFindings('$rows = [IO.File]::ReadAllLines($file)\n$mode = $rows[1]', 'integration/example.ps1', {}), ['positional-lines']);
  });

  test('the self-format guard traces tests back to the source they read', () => {
    const file = 'tests/example.cjs', full = ROOT + '/tests/example.cjs';
    const input = [
      "const from = '../electron/features/agents/dispatch-events.cjs'; const text = fs.readFileSync(path.join(__dirname, from), 'utf8');",
      "const part = text.slice(text.indexOf('function first')); const code = ts.transpileModule(part).outputText;",
      'vm.runInNewContext(code); assert.match(text, /name/); assert.doesNotMatch(answer, /name/);',
      "const unrelated = fs.readFileSync('tests/fixtures/example.cjs'); assert.match(unrelated, /name/);",
    ].join('\n');
    const host = ts.createCompilerHost({});
    const tree = ts.createSourceFile(full, input, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    host.getSourceFile = () => tree;
    const program = ts.createProgram([full], { allowJs: true, noLib: true, noResolve: true, types: [] }, host);
    const prefix = 'electron/features/agents/dispatch-events.cjs :: tests/example.cjs :: ';
    assert.deepEqual(testFindings(tree, program.getTypeChecker(), file), ['source-slice', 'source-execution', 'source-regex'].map(rule => prefix + rule));
  });

  test('product and test text readers match the per-module self-format baseline', () => {
    assert.deepEqual(differences(counts(), baseline()).map(change => change.message), [], 'Self-format counts changed');
  });
}
