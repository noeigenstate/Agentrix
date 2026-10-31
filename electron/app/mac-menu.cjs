const DEFAULT_SHORTCUTS = require('../shortcuts.json');

function buildMacMenuTemplate({ appName, t, shortcuts, updateReady = false, command, quit, close }) {
  const bindings = { ...DEFAULT_SHORTCUTS, ...shortcuts };
  const action = (name, label) => ({
    label, click: () => command(name),
    // The page's capture handler calls preventDefault first, so the menu's key equivalent does not fire twice.
    ...(bindings[name] ? { accelerator: bindings[name] } : {}),
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
      // macOS keeps hidden menu accelerators active without a separate Window menu.
      { role: 'minimize', label: t('最小化'), accelerator: 'Command+M', visible: false },
      { role: 'togglefullscreen', label: t('切换全屏'), accelerator: 'Control+Command+F', visible: false },
      { label: t('关闭窗口'), accelerator: 'Command+W', visible: false, click: close },
    ] },
  ];
}

module.exports = { buildMacMenuTemplate };
