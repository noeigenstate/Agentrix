const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rendererLoader } = require('./helpers/hook-harness.cjs');
const { handleTitlebarNavigate } = rendererLoader({}, /\/shortcuts$/)('src/app-commands.ts');

function titlebar(open = '', inPopup = false) {
  const views = [];
  const document = {
    activeElement: { closest: selector => inPopup && selector === '.reading-terminal-popup' ? {} : null },
    querySelector: selector => selector.split(', ').includes(open) ? {} : null,
  };
  return { navigate: target => handleTitlebarNavigate(document, target, view => views.push(view)), views };
}

test('the native title-bar buttons switch the page', () => {
  const { navigate, views } = titlebar();
  navigate('decisions'); navigate('workspace');
  assert.deepEqual(views, ['decisions', 'workspace']);
});

test('a modal dialog or the tour blocks the native title-bar buttons', () => {
  for (const open of ['dialog:modal', '.tour-layer']) {
    const { navigate, views } = titlebar(open);
    navigate('decisions'); navigate('workspace');
    assert.deepEqual(views, [], `${open} blocks the buttons`);
  }
});

test('a modeless terminal popup blocks the native title-bar buttons only while its CLI owns focus', () => {
  for (const inPopup of [false, true]) {
    const { navigate, views } = titlebar('dialog[open]', inPopup);
    navigate('decisions'); navigate('workspace');
    assert.deepEqual(views, inPopup ? [] : ['decisions', 'workspace']);
  }
});
