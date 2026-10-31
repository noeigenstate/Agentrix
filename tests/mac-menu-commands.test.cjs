const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// App.tsx is too large to render in a test, so the menu-command handler and the guard it shares with the key handler are cut out of its source (as approval-aba.test.cjs does for openDecision) and run against stubs.
const source = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf8').replace(/\r\n/g, '\n');
const guard = source.slice(source.indexOf('const dialogOpen ='), source.indexOf('\n', source.indexOf('const dialogOpen =')));
const handlerStart = source.indexOf('api.onMenuCommand(') + 'api.onMenuCommand('.length;
const handler = source.slice(handlerStart, source.indexOf('\n    });', handlerStart) + '\n    }'.length);

function menu({ open = '', readingTerminal = 'agent' } = {}) {
  const calls = [];
  const context = vm.createContext({
    document: { querySelector: selector => selector.split(', ').includes(open) ? {} : null },
    api: { settings: patch => { calls.push(['settings', { ...patch }]); return 'settings'; } },
    installUpdate: () => calls.push(['installUpdate']), perform: value => calls.push(['perform', value]),
    setReading: (...args) => calls.push(['reading', ...args]),
    runAction: action => calls.push(['action', action]), activityPane: false, readingTerminal,
  });
  vm.runInContext(ts.transpileModule(`${guard}\nglobalThis.onCommand = ${handler};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return { send: command => context.onCommand(command), calls };
}

test('menu commands run what the shortcuts run, the switch and the pane toggle act on their own state', () => {
  const { send, calls } = menu();
  for (const command of ['addProject', 'settings', 'overview', 'search', 'activityPane']) send(command);
  send('reading'); send('terminal');
  assert.deepEqual(calls, [
    ['action', 'addProject'], ['action', 'settings'], ['action', 'overview'], ['action', 'search'],
    ['settings', { activityPane: true }], ['perform', 'settings'],
    ['reading', 'agent', true], ['reading', 'agent', false],
  ]);
});

test('a dialog or the tour blocks every menu command except installUpdate', () => {
  for (const open of ['dialog[open]', '.tour-layer']) {
    const { send, calls } = menu({ open });
    for (const command of ['addProject', 'settings', 'overview', 'search', 'activityPane', 'reading', 'terminal']) send(command);
    assert.deepEqual(calls, [], `${open} blocks the commands`);
    send('installUpdate');
    assert.deepEqual(calls, [['installUpdate']], `${open} does not block installUpdate`);
  }
});

test('reading and terminal do nothing without a terminal to switch', () => {
  const { send, calls } = menu({ readingTerminal: null });
  send('reading'); send('terminal');
  assert.deepEqual(calls, []);
});
