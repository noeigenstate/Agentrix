const path = require('node:path');
const { pathToFileURL } = require('node:url');
function createSdkLoader({ resourcesPath = process.resourcesPath, packaged = false, load = url => import(url) } = {}) {
  // The pinned sdk.mjs entry bundles third-party code; its runtime imports are Node builtins.
  // Packaging tests load that entry without adjacent peers and exercise query against an offline CLI.
  let promise;
  return () => promise ||= load(pathToFileURL(packaged
    ? path.join(resourcesPath, 'app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs')
    : require.resolve('@anthropic-ai/claude-agent-sdk')).href);
}
module.exports = { createSdkLoader };
