const DEFAULT_SHORTCUTS = require('../shortcuts.json');

const DEFAULT_MENU_STATE = Object.freeze({
  view: 'workspace', decisions: 0, canReturn: false, focused: false, activityPane: false, reading: null,
});

function parseMenuState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)
    || !['workspace', 'decisions'].includes(state.view)
    || !Number.isSafeInteger(state.decisions) || state.decisions < 0
    || ['canReturn', 'focused', 'activityPane'].some(key => typeof state[key] !== 'boolean')
    || state.reading !== null && typeof state.reading !== 'boolean') return null;
  return Object.fromEntries(Object.keys(DEFAULT_MENU_STATE).map(key => [key, state[key]]));
}

function buildMacMenuTemplate({ appName, t, shortcuts, state = DEFAULT_MENU_STATE, updateReady = false, command, quit, close }) {
  const bindings = { ...DEFAULT_SHORTCUTS, ...shortcuts };
  const action = (name, label, options = {}) => ({
    label, ...options, click: () => command(name),
    // registerAccelerator only affects Linux/Windows; macOS accelerators remain native key equivalents.
    // The page gets the key first; App.tsx's capture handler calls preventDefault to avoid double firing.
    ...(bindings[name] ? { accelerator: bindings[name], registerAccelerator: false } : {}),
  });
  return [
    { label: appName, submenu: [
      { role: 'about', label: t('关于 Agentrix') }, { type: 'separator' },
      action('addProject', t('新建项目')),
      action('settings', t('设置…')),
      ...(updateReady ? [action('installUpdate', t('重启并安装更新'))] : []),
      { type: 'separator' },
      { role: 'hide', label: t('隐藏 Agentrix') }, { role: 'hideOthers', label: t('隐藏其他') }, { role: 'unhide', label: t('全部显示') }, { type: 'separator' },
      { label: t('退出 Agentrix'), accelerator: 'Command+Q', click: quit },
    ] },
    { label: t('前往'), submenu: [
      action('workspace', t('工作台'), { type: 'radio', checked: state.view === 'workspace' }),
      action('decisions', state.decisions > 0 ? t('决策 ({count})', { count: state.decisions }) : t('决策'),
        { type: 'radio', checked: state.view === 'decisions' }),
      { type: 'separator' },
      action('overview', t('返回项目'), { enabled: state.canReturn }),
      action('search', t('搜索项目'), { enabled: !state.focused }),
    ] },
    { label: t('显示'), submenu: [
      action('activityPane', t('显示活动栏'), { type: 'checkbox', enabled: state.focused, checked: state.activityPane }),
      ...(state.reading === null ? [] : [
        { type: 'separator' },
        action('reading', t('阅读视图'), { type: 'radio', checked: state.reading }),
        action('terminal', t('终端'), { type: 'radio', checked: !state.reading }),
      ]),
    ] },
    { label: t('窗口'), submenu: [
      { role: 'minimize', label: t('最小化') }, { role: 'zoom', label: t('缩放') }, { role: 'togglefullscreen', label: t('切换全屏') },
      { type: 'separator' }, { label: t('关闭窗口'), accelerator: 'Command+W', click: close },
    ] },
  ];
}

module.exports = { DEFAULT_MENU_STATE, parseMenuState, buildMacMenuTemplate };
