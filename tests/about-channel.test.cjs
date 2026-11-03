const { test } = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const { hookHarness } = require('./helpers/hook-harness.cjs');

// The About channel row with its real hooks and handlers; the DOM is a few stand-in elements that only know whether they are connected and how to take focus.
const VERSION = '2026-11-03';
const SelectStub = () => null, DialogStub = () => null;
const nodes = node => Array.isArray(node) ? node.flatMap(nodes) : React.isValidElement(node) ? [node, ...nodes(node.props.children)] : [];
const textOf = node => [].concat(node.props.children).filter(child => typeof child === 'string').join('');
const stable = { supported: true, currentVersion: '1.3.27', distribution: 'installed', status: 'idle', version: null, percent: 0, error: null, channel: 'stable', agreementVersion: VERSION, agreed: false };

function setup(t, initial) {
  const saved = { document: global.document, window: global.window }, calls = [], changed = [];
  const element = () => ({ isConnected: true, focus() { global.document.activeElement = this; } });
  const trigger = element(), page = element();
  global.document = { body: page, activeElement: page };
  global.window = { agentrix: { setUpdateChannel: async (channel, version) => { calls.push([channel, version]); return { ok: true, value: { ...updates, channel, agreed: true } }; } } };
  t.after(() => { for (const [name, value] of Object.entries(saved)) value === undefined ? delete global[name] : (global[name] = value); });
  let updates = initial, tree = null;
  const i18n = { t: text => text };
  const about = hookHarness('src/features/settings/AboutSettings.tsx', {
    '@phosphor-icons/react': new Proxy({}, { get: () => () => null }), './Select': { Select: SelectStub }, './i18n': i18n, './ReleaseNotes': { ReleaseNotes: () => null },
    './BetaAgreementDialog': { BetaAgreementDialog: DialogStub }, './beta-agreement': { BETA_AGREEMENT_VERSION: VERSION },
  });
  const agreement = hookHarness('src/features/settings/BetaAgreementDialog.tsx', { './i18n': i18n, './beta-agreement': { BETA_AGREEMENT_VERSION: VERSION, betaAgreementClauses: () => ['clause'] } });
  t.after(() => { about.dispose(); agreement.dispose(); });
  const view = {
    trigger, calls, changed,
    render() {
      tree = about.render('UpdateChannel', { updates, onChanged: state => { changed.push(state); updates = state; } }).result;
      // React attaches the ref after rendering; the root answers the one query the focus return makes.
      const root = nodes(tree).find(node => node.props.className === 'about-channel');
      if (root) root.props.ref.current ={ querySelector: selector => selector === '.select-trigger' ? trigger : null };
      return tree;
    },
    find: pick => nodes(tree).find(pick),
    button: label => view.find(node => node.type === 'button' && textOf(node) === label),
    dialog: () => view.find(node => node.type === DialogStub)?.props,
    // The real dialog, rendered with the props the row gave it; its own elements are what Esc and the buttons act on.
    modal: () => agreement.render('BetaAgreementDialog', view.dialog()).result,
    // What showModal does: focus moves into the dialog.
    focusIntoDialog: () => element().focus(),
    active: () => global.document.activeElement,
    element,
  };
  return view;
}

// The select keeps focus while its menu is used, so the row sees the trigger focused when the choice arrives.
function chooseBeta(view) {
  view.render(); view.trigger.focus();
  view.find(node => node.type === SelectStub).props.onChange('beta');
  view.render(); view.focusIntoDialog();
  assert.ok(view.dialog(), 'choosing the beta channel opens the agreement dialog');
}

test('Esc in the agreement dialog closes only it and returns focus to the select', t => {
  const view = setup(t, stable);
  chooseBeta(view);
  let prevented = false, stopped = false;
  view.modal().props.onCancel({ preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
  assert.ok(prevented && stopped, 'the cancel event is handled here and does not reach the Settings dialog');
  view.render();
  assert.equal(view.dialog(), undefined);
  assert.equal(view.active(), view.trigger);
  assert.deepEqual(view.calls, []);
});

test('取消 returns focus to the select', t => {
  const view = setup(t, stable);
  chooseBeta(view);
  nodes(view.modal()).find(node => node.type === 'button' && textOf(node) === '取消').props.onClick();
  view.render();
  assert.equal(view.dialog(), undefined);
  assert.equal(view.active(), view.trigger);
});

test('a dialog opened from 阅读并同意 returns focus to that button on cancel', t => {
  const view = setup(t, { ...stable, channel: 'beta', agreed: false });
  view.render();
  const agree = view.element();
  agree.focus();
  view.button('阅读并同意').props.onClick();
  view.render(); view.focusIntoDialog();
  nodes(view.modal()).find(node => node.type === 'button' && textOf(node) === '取消').props.onClick();
  view.render();
  assert.equal(view.active(), agree);
});

test('after the switch the select takes focus when the button that opened the dialog has gone', async t => {
  const view = setup(t, { ...stable, channel: 'beta', agreed: false });
  view.render();
  const agree = view.element();
  agree.focus();
  view.button('阅读并同意').props.onClick();
  view.render(); view.focusIntoDialog();
  view.dialog().onAgree();
  await new Promise(resolve => setImmediate(resolve));
  agree.isConnected = false; // the agreement holds now, so the row no longer renders the button
  view.render();
  assert.deepEqual(view.calls, [['beta', VERSION]]);
  assert.equal(view.changed.length, 1);
  assert.equal(view.dialog(), undefined);
  assert.equal(view.button('阅读并同意'), undefined);
  assert.equal(view.active(), view.trigger);
});

test('a build that cannot update shows one line and no select', t => {
  const view = setup(t, { ...stable, supported: false, distribution: 'portable' });
  view.render();
  assert.equal(view.find(node => node.type === SelectStub), undefined);
  assert.equal(textOf(view.find(node => node.type === 'p')), '只有 Windows 安装版可以选择更新通道。');
});
