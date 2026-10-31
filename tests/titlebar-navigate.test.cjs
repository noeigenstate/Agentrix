const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Like mac-menu-commands.test.cjs: App.tsx is too large to render here, so the title-bar navigation handler and the guard it shares with the key handler are cut out of its source and run against stubs.
const source = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf8').replace(/\r\n/g, '\n');
const guard = source.slice(source.indexOf('const dialogOpen ='), source.indexOf('\n', source.indexOf('const dialogOpen =')));
const handlerStart = source.indexOf('api.onTitlebarNavigate(') + 'api.onTitlebarNavigate('.length;
const handler = source.slice(handlerStart, source.indexOf('\n    });', handlerStart) + '\n    }'.length);

function titlebar(open = '') {
  const views = [];
  const context = vm.createContext({ document: { querySelector: selector => selector.split(', ').includes(open) ? {} : null }, setView: view => views.push(view) });
  vm.runInContext(ts.transpileModule(`${guard}\nglobalThis.navigate = ${handler};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return { navigate: context.navigate, views };
}

test('the native title-bar buttons switch the page', () => {
  const { navigate, views } = titlebar();
  navigate('decisions'); navigate('workspace');
  assert.deepEqual(views, ['decisions', 'workspace']);
});

test('a dialog or the tour blocks the native title-bar buttons', () => {
  for (const open of ['dialog[open]', '.tour-layer']) {
    const { navigate, views } = titlebar(open);
    navigate('decisions'); navigate('workspace');
    assert.deepEqual(views, [], `${open} blocks the buttons`);
  }
});
