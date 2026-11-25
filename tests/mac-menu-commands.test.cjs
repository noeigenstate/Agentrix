const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rendererLoader } = require('./helpers/hook-harness.cjs');
const { handleMenuCommand } = rendererLoader({}, /\/shortcuts$/)('src/app-commands.ts');

function menu(open = '', inPopup = false) {
  const calls = [];
  const document = {
    activeElement: { closest: selector => inPopup && selector === '.reading-terminal-popup' ? {} : null },
    querySelector: selector => selector.split(', ').includes(open) ? {} : null,
  };
  return { send: command => handleMenuCommand(document, command, action => calls.push(['action', action]), () => calls.push(['installUpdate'])), calls };
}

test('menu commands run what the shortcuts run, and installUpdate installs', () => {
  const { send, calls } = menu();
  for (const command of ['addProject', 'settings', 'installUpdate']) send(command);
  assert.deepEqual(calls, [['action', 'addProject'], ['action', 'settings'], ['installUpdate']]);
});

test('a dialog or the tour blocks every menu command except installUpdate', () => {
  for (const open of ['dialog:modal', '.tour-layer']) {
    const { send, calls } = menu(open);
    for (const command of ['addProject', 'settings']) send(command);
    assert.deepEqual(calls, [], `${open} blocks the commands`);
    send('installUpdate');
    assert.deepEqual(calls, [['installUpdate']], `${open} does not block installUpdate`);
  }
});

test('a modeless terminal popup blocks menu commands only while its CLI owns focus', () => {
  for (const inPopup of [false, true]) {
    const { send, calls } = menu('dialog[open]', inPopup);
    for (const command of ['addProject', 'settings']) send(command);
    assert.deepEqual(calls, inPopup ? [] : [['action', 'addProject'], ['action', 'settings']]);
    send('installUpdate');
    assert.deepEqual(calls.at(-1), ['installUpdate']);
  }
});
