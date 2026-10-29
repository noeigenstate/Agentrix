// Guards for integration/BOUNDARY.md (Dispatch) that no behaviour test covers.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { builtinModules } = require('node:module');
const { runtimeFiles } = require('../integration/dispatch.cjs');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const requires = source => [...source.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map(match => match[1]);

// Plain Node cannot read app.asar and an SSH host has only what was copied, so the helper carries these files beside it.
test("the helper's runtime modules require only Node built-ins and each other", () => {
  const carried = runtimeFiles();
  const loaded = [...read('integration/dispatch.cjs').matchAll(/require\(\s*path\.join\(\s*runtime\s*,\s*'([^']+)'\s*\)\s*\)/g)].map(match => match[1]);
  assert.ok(loaded.length > 0, 'the helper loads its runtime by path.join(runtime, …)');
  for (const file of loaded) assert.ok(file in carried, `dispatch.cjs loads ${file}, which runtimeFiles() does not carry`);
  for (const [file, source] of Object.entries(carried)) {
    for (const name of requires(source)) {
      if (name.startsWith('.')) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), name));
        assert.ok(target in carried, `${file} requires ${name}, which the helper does not carry`);
      } else assert.ok(name.startsWith('node:') || builtinModules.includes(name), `${file} requires ${name}, which plain Node beside the helper cannot load`);
    }
  }
});

// A test that runs the helper against the CLI installed on the machine passes or fails with that machine.
test('dispatch tests start workers only through an injected fake CLI', () => {
  const files = fs.readdirSync(__dirname).filter(name => name.endsWith('.cjs') && name !== path.basename(__filename))
    .filter(name => /integration\/dispatch\.cjs/.test(fs.readFileSync(path.join(__dirname, name), 'utf8')));
  let runs = 0, entrypoints = 0;
  for (const name of files) {
    const source = fs.readFileSync(path.join(__dirname, name), 'utf8');
    for (const body of source.split(/\ntest\(/)) {
      // Every call of the helper's run(...) names its launcher or executable resolver; another local `run` is not the helper's.
      const bindings = [...body.matchAll(/\{\s*run\s*\}\s*=\s*require\(([^;\n]*)|\b(?:const|let|var|function)\s+run\b/g)]
        .map(match => ({ at: match.index, helper: /dispatch\.cjs|helper/.test(match[1] || '') }));
      for (const match of body.matchAll(/(?<![\w.])run\(/g)) {
        if (!bindings.findLast(binding => binding.at < match.index)?.helper) continue;
        let depth = 0, end = match.index + 3;
        for (; end < body.length; end++) {
          if (body[end] === '(') depth++;
          else if (body[end] === ')' && depth-- === 0) break;
        }
        const call = body.slice(match.index, end);
        runs++;
        assert.match(call, /\b(?:launch|resolveExecutable)\s*:/, `${name}: ${call.slice(0, 120)}… runs the helper without an injected CLI`);
      }
      // Starting the helper's own entrypoint resolves the CLI from PATH, so that PATH must be the test's fake bin alone.
      for (const match of body.matchAll(/spawn(?:Sync)?\(\s*process\.execPath\s*,\s*\[\s*(\w+)\s*,\s*\.\.\./g)) {
        if (!/dispatch\.cjs/.test(body.slice(0, match.index)) || /runner/.test(match[1])) continue;
        entrypoints++;
        assert.match(body.slice(0, match.index), /env\[pathKey\]\s*=\s*\w+;/, `${name}: the helper entrypoint ${match[1]} runs with the machine's PATH`);
      }
    }
  }
  assert.ok(runs > 0 && entrypoints > 0, 'the guard found the helper runs it checks');
});
