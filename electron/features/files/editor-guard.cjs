function editorPath(value, local = true, platform = process.platform) {
  const normalized = value.replaceAll('\\', '/');
  return local && platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function createEditorGuard({ getWindow, showWindow, send, randomUUID, dialog, t, platform = process.platform }) {
  let editorDirty = false, editorCloseRequest = null, editorFile = null;
  function allowEditorClose() {
    const window = getWindow();
    if (!editorDirty || !window || window.isDestroyed()) return Promise.resolve(true);
    if (editorCloseRequest) return editorCloseRequest.promise;
    showWindow();
    const id = randomUUID();
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    const timer = setTimeout(() => { if (editorCloseRequest?.id === id) { editorCloseRequest = null; resolve(false); } }, 60000);
    editorCloseRequest = { id, promise, resolve: accepted => { clearTimeout(timer); editorCloseRequest = null; resolve(accepted); } };
    send('editor:request-close', id);
    return promise;
  }

  function affectsEditor(id, paths, local = false) {
    if (!editorDirty || editorFile?.id !== id) return false;
    const current = editorPath(editorFile.path, local, platform);
    return paths.some(value => {
      if (typeof value !== 'string') return false;
      const candidate = editorPath(value, local, platform);
      return current === candidate || current.startsWith(candidate + '/');
    });
  }

  function registerEditorIpc({ handle, listen }) {
    handle('editor:confirm-close', async filename => {
      const result = await dialog.showMessageBox(getWindow(), { type: 'question', title: t('未保存的修改'), message: t('保存对“{name}”的修改？', { name: String(filename).slice(0, 500) }),
        buttons: [t('保存'), t('不保存'), t('取消')], defaultId: 0, cancelId: 2 });
      return ['save', 'discard', 'cancel'][result.response] || 'cancel';
    });
    listen('editor:dirty', (value, id, filename) => { editorDirty = value === true; editorFile = editorDirty && typeof id === 'string' && typeof filename === 'string' ? { id, path: filename } : null; });
    listen('editor:close-result', (id, accepted) => { if (editorCloseRequest?.id === id) editorCloseRequest.resolve(accepted === true); });
  }
  return { allowEditorClose, affectsEditor, getEditorFile: () => editorFile, registerEditorIpc };
}

module.exports = { createEditorGuard, editorPath };
