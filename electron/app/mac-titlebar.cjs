const DEFAULT_SHORTCUTS = require('../shortcuts.json');
const { en } = require('../i18n.cjs');
const WORKSPACE_TOOLTIP = '回到工作台 · {key}';
const PNG_PREFIX = 'data:image/png;base64,';
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function dimensions(value, names) {
  if (!record(value)) return;
  const result = {};
  for (const name of names) {
    const number = value[name];
    if (!Number.isFinite(number) || number < 0 || number > 64) return;
    result[name] = number;
  }
  return result;
}

function fontWeight(value) {
  return Number.isFinite(value) && value >= 100 && value <= 900;
}

function validIcon(value) {
  if (typeof value !== 'string' || value.length > 64 * 1024 || !value.startsWith(PNG_PREFIX)) return false;
  const encoded = value.slice(PNG_PREFIX.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4) return false;
  const data = Buffer.from(encoded, 'base64');
  return data.length >= 33 && data.subarray(0, 8).equals(PNG_SIGNATURE)
    && data.readUInt32BE(8) === 13 && data.toString('ascii', 12, 16) === 'IHDR'
    && [data.readUInt32BE(16), data.readUInt32BE(20)].every(size => size > 0 && size <= 256)
    && data.toString('base64') === encoded;
}

function titlebarStyle(value) {
  if (!record(value) || !Number.isFinite(value.scale) || value.scale < 0.5 || value.scale > 2) return;
  const font = dimensions(value.font, ['size']);
  const family = value.font?.family, weight = value.font?.weight, badgeWeight = value.metrics?.badge?.fontWeight;
  const metrics = dimensions(value.metrics,
    ['height', 'paddingX', 'gap', 'itemGap', 'radius', 'iconSize', 'focusWidth', 'focusOffset']);
  const badge = dimensions(value.metrics?.badge, ['minWidth', 'paddingX', 'height', 'fontSize']);
  if (!font || font.size <= 0 || typeof family !== 'string' || !family.trim() || family.length > 1024
    || !fontWeight(weight) || !fontWeight(badgeWeight) || !metrics || metrics.height <= 0
    || metrics.iconSize <= 0 || !badge || badge.minWidth <= 0 || badge.height <= 0 || badge.fontSize <= 0
    || !record(value.colors) || !record(value.icons)) return;
  const colors = {};
  for (const name of ['text', 'textSelected', 'hover', 'selected', 'badge', 'badgeText', 'focus']) {
    const color = value.colors[name];
    if (typeof color !== 'string' || !/^#(?:[\da-f]{6}|[\da-f]{8})$/i.test(color)) return;
    colors[name] = color.toLowerCase();
  }
  const { decisions, workspace } = value.icons;
  if (!validIcon(decisions) || !validIcon(workspace)) return;
  return { scale: value.scale, font: { ...font, weight, family: family.trim() },
    metrics: { ...metrics, badge: { ...badge, fontWeight: badgeWeight } }, colors,
    icons: { decisions, workspace } };
}

function registerMacTitlebar({ window, t, send, broadcast, getShortcuts = () => ({}), platform = process.platform,
  loadAddon = () => require('../../native/mac-titlebar/build/Release/mac_titlebar.node'), warn = console.warn }) {
  let addon, attached = false, warned = false, rendered, style, styleKey, renderedStyle;
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
      { id: 'decisions', label: decisionsLabel, count: state.decisions, selected: state.view === 'decisions',
        toolTip: t('回到决策 · {key}', { key: shortcuts.decisions }),
        accessibilityLabel: `${decisionsLabel}, ${t('{count} 件待决定', { count: state.decisions })}` },
      { id: 'workspace', label: workspaceLabel, selected: state.view === 'workspace',
        toolTip: en[WORKSPACE_TOOLTIP] ? t(WORKSPACE_TOOLTIP, { key: shortcuts.overview }) : workspaceLabel,
        accessibilityLabel: workspaceLabel },
    ];
    const next = JSON.stringify(items);
    if (next === rendered && style === renderedStyle) return;
    const result = addon.update(style !== renderedStyle ? { items, style } : { items });
    if (result === false) {
      style = renderedStyle;
      styleKey = style ? JSON.stringify(style) : undefined;
    }
    rendered = next;
    renderedStyle = style;
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
      state = { view: value.view, decisions: value.decisions };
      const candidate = titlebarStyle(value.style);
      if (candidate) {
        const key = JSON.stringify(candidate);
        if (key !== styleKey) { style = candidate; styleKey = key; }
      }
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
