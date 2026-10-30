const { resourceResponse } = require('../../preview-resources.cjs');
const OFFLINE_PARTITION = 'preview-offline';
const denyRequest = (_details, callback) => callback({ cancel: true });
// Captures are serialized by file cards. Reuse one non-persistent offline session, separate from the application.
function createPageCapture(BrowserWindow, { timeout = 10000, settle = 500, fontWait = 1200 } = {}) {
  return async function capturePage(url, resources) {
    const offline = resources?.isOutsideUrl(url) === true;
    const page = new BrowserWindow({ show: false, width: 1280, height: 800, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
      ...(offline ? { partition: OFFLINE_PARTITION } : {}) } });
    const contents = page.webContents;
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', event => event.preventDefault());
    contents.on('will-redirect', event => event.preventDefault());
    contents.on('will-frame-navigate', event => { if (!resources?.hasUrl(event.url) && event.url !== 'about:blank') event.preventDefault(); });
    contents.setAudioMuted(true);
    let deadline;
    try {
      if (offline) {
        contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
        const host = new URL(url).hostname;
        contents.session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
          const local = /^(?:data:|blob:|about:blank$)/.test(details.url);
          let samePage = false;
          try { const target = new URL(details.url); samePage = target.protocol === 'project-preview:' && target.hostname === host && resources.hasUrl(details.url); } catch { }
          callback({ cancel: !local && !samePage });
        });
        contents.session.protocol.handle('project-preview', async request => {
          if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
          try { return resourceResponse(await resources.resolve(request.url), request); } catch { return new Response(null, { status: 404 }); }
        });
      }
      const render = async () => {
        // DOM-ready lets local content render even if an external asset never finishes loading.
        await new Promise((resolve, reject) => {
          contents.once('dom-ready', resolve);
          contents.once('render-process-gone', () => reject(new Error('Preview renderer exited')));
          void page.loadURL(url).catch(reject);
        });
        // Electron defers executeJavaScript until loading ends; bound the font wait in the main process.
        let fontTimer;
        try {
          await Promise.race([contents.executeJavaScript('document.fonts.ready.then(() => true)').catch(() => {}),
            new Promise(resolve => { fontTimer = setTimeout(resolve, fontWait); })]);
        } finally { clearTimeout(fontTimer); }
        await new Promise(resolve => setTimeout(resolve, settle));
        contents.invalidate();
        for (let attempt = 0; attempt < 2; attempt++) {
          const image = await contents.capturePage(undefined, { stayHidden: true, stayAwake: true });
          if (!image.isEmpty()) return `data:image/jpeg;base64,${image.resize({ width: 480, quality: 'good' }).toJPEG(82).toString('base64')}`;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        return null;
      };
      // Bound painting and capture too; one stalled page must not block all queued cards.
      return await Promise.race([render(), new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Preview capture timed out')), timeout); })]);
    } finally {
      clearTimeout(deadline);
      if (!page.isDestroyed()) page.destroy();
      if (offline) {
        contents.session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, denyRequest);
        contents.session.protocol.unhandle('project-preview');
      }
    }
  };
}

module.exports = { createPageCapture };
