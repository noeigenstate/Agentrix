const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { resourceResponse } = require('../preview-resources.cjs');

function registerAppSchemes(protocol) {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'agentrix', privileges: { standard: true, secure: true, supportFetchAPI: true } },
    { scheme: 'project-preview', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  ]);
}

function registerAppProtocols({ protocol, root, electronNet, previewResources, t }) {
  const directory = path.resolve(root, 'dist');
  protocol.handle('agentrix', request => {
    const url = new URL(request.url);
    if (url.host !== 'app') return new Response('Not found', { status: 404 });
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const resolved = path.resolve(directory, relative);
    if (!resolved.startsWith(directory + path.sep)) return new Response('Forbidden', { status: 403 });
    return electronNet.fetch(pathToFileURL(resolved).toString());
  });
  protocol.handle('project-preview', async request => {
    if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405 });
    try {
      const resource = await previewResources.resolve(request.url);
      return resourceResponse(resource, request);
    } catch { return new Response(t('文件不存在、超出项目范围，或预览已关闭。'), { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } }); }
  });
}

module.exports = { registerAppSchemes, registerAppProtocols };
