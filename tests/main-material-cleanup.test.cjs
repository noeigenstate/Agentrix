const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '../scripts/material-smoke.mjs'), 'utf8');
const ast = ts.createSourceFile('material-smoke.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const closeShells = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === 'stopMaterialShells').getText(ast);

test('material teardown awaits each isolated shell exit before asking the next PTY to close', async () => {
  const terminals = ['first', 'second'].map(id => ({ id, shellReady: true, status: 'shell' }));
  terminals.push({ id: 'agent', shellReady: false, codexActive: true });
  const calls = [], context = vm.createContext({
    state: async () => ({ projects: [{ terminals }] }),
    page: { async evaluate(_fn, id) {
      assert.ok(terminals.filter(value => value.id !== id && calls.includes(value.id)).every(value => value.status === 'exited'));
      calls.push(id);
    } },
    async waitFor(check, label, timeout) {
      assert.equal(label, 'material fixture shell exits'); assert.equal(timeout, 4000);
      assert.equal(await check(), false);
      terminals.find(value => value.id === calls.at(-1)).status = 'exited';
      assert.equal(await check(), true);
    },
  });
  vm.runInContext(closeShells, context); await context.stopMaterialShells();
  assert.deepEqual(calls, ['first', 'second']);
});
