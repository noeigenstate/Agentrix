const path = require('node:path');
const { pathToFileURL } = require('node:url');
function createSdkLoader({ resourcesPath = process.resourcesPath, packaged = false, load = url => import(url) } = {}) {
  let promise;
  return () => promise ||= load(pathToFileURL(packaged
    ? path.join(resourcesPath, 'app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs')
    : require.resolve('@anthropic-ai/claude-agent-sdk')).href);
}
module.exports = { createSdkLoader };
