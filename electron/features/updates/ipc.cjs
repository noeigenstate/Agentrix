function registerUpdatesIpc({ handle, updateManager, openExternal, getWindow, dialog, t, allowEditorClose, liveTerminalCount, setQuitting }) {
  let installingUpdate = false;
  handle('updates:state', () => updateManager.getState());
  handle('updates:check', () => updateManager.check());
  handle('updates:download-page', () => openExternal('https://github.com/noeigenstate/Agentrix/releases/latest'));
  // The About page's links: the renderer names a page, never a URL.
  const pages = { releases: 'releases', docs: '#readme', license: 'blob/main/LICENSE', notices: 'blob/main/assets/THIRD-PARTY-NOTICES.txt', repository: '' };
  handle('updates:open-page', page => {
    if (!Object.hasOwn(pages, page)) throw new Error('未知的页面。');
    return openExternal(`https://github.com/noeigenstate/Agentrix/${pages[page]}`);
  });
  async function installUpdate() {
    if (installingUpdate) return false;
    if (!updateManager.canInstall()) throw new Error('更新尚未下载完成。');
    installingUpdate = true;
    try {
      if (!await allowEditorClose()) { installingUpdate = false; return false; }
      const count = liveTerminalCount();
      if (count) {
        const result = await dialog.showMessageBox(getWindow(), {
          type: 'question', title: t('重启并安装更新'), message: t('重启会关闭 {count} 个终端', { count }),
          detail: t('请先确认任务已经完成。取消后，下载好的更新会继续保留。'),
          buttons: [t('继续工作'), t('关闭终端并更新')], defaultId: 0, cancelId: 0,
        });
        if (result.response !== 1) { installingUpdate = false; return false; }
      }
      setQuitting(true);
      updateManager.install();
      return true;
    } catch (error) { setQuitting(false); installingUpdate = false; throw error; }
  }
  handle('updates:install', installUpdate);
  function onStateChange(state) {
    if (state.status === 'error' && installingUpdate) { installingUpdate = false; setQuitting(false); }
  }
  return { installUpdate, onStateChange };
}

module.exports = { registerUpdatesIpc };
