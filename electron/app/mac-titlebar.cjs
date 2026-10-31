const DEFAULT_SHORTCUTS = require('../shortcuts.json');
const { en } = require('../i18n.cjs');
const WORKSPACE_TOOLTIP = '回到工作台 · {key}';

function registerMacTitlebar({ window, t, send, broadcast, getShortcuts = () => ({}), platform = process.platform,
  loadAddon = () => require('../../native/mac-titlebar/build/Release/mac_titlebar.node'), warn = console.warn }) {
  let addon, attached = false, warned = false, rendered;
  let state = { view: 'workspace', decisions: 0 };

  function warnOnce(error) {
    if (warned) return;
    warned = true;
    warn(`mac-titlebar unavailable; using web navigation: ${error.message}`);
  }

  function detach() {
    const native = addon;
    addon = null;
    attached = false;
    try { native?.detach(); } catch (error) { warnOnce(error); }
  }

  function updateNative() {
    const shortcuts = { ...DEFAULT_SHORTCUTS, ...getShortcuts() };
    const decisionsLabel = t('决策'), workspaceLabel = t('工作台');
    const items = [
      { id: 'decisions', label: `${decisionsLabel}${state.decisions ? ` ${state.decisions}` : ''}`, selected: state.view === 'decisions',
        toolTip: t('回到决策 · {key}', { key: shortcuts.decisions }),
        accessibilityLabel: `${decisionsLabel}, ${t('{count} 件待决定', { count: state.decisions })}` },
      { id: 'workspace', label: workspaceLabel, selected: state.view === 'workspace',
        toolTip: en[WORKSPACE_TOOLTIP] ? t(WORKSPACE_TOOLTIP, { key: shortcuts.overview }) : workspaceLabel,
        accessibilityLabel: workspaceLabel },
    ];
    const next = JSON.stringify(items);
    if (next === rendered) return;
    addon.update({ items });
    rendered = next;
  }

  function refresh() {
    if (!attached) return;
    try { updateNative(); }
    catch (error) { warnOnce(error); detach(); broadcast(); }
  }

  const controller = {
    get attached() { return attached; },
    update(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value) || !['workspace', 'decisions'].includes(value.view)
        || !Number.isSafeInteger(value.decisions) || value.decisions < 0) return;
      if (state.view === value.view && state.decisions === value.decisions) return;
      state = { view: value.view, decisions: value.decisions };
      refresh();
    },
    refresh,
  };
  if (platform !== 'darwin') return controller;
  try {
    const native = loadAddon();
    if (!native || !['attach', 'update', 'detach'].every(name => typeof native[name] === 'function')) throw new Error('Invalid addon exports');
    addon = native;
    addon.attach(window.getNativeWindowHandle(), id => {
      if (attached && !window.isDestroyed() && ['workspace', 'decisions'].includes(id)) send('titlebar:navigate', id);
    });
    updateNative();
    attached = true;
    window.once('closed', detach);
  } catch (error) { warnOnce(error); detach(); }
  return controller;
}

module.exports = { registerMacTitlebar };
