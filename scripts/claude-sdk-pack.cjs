const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const platforms = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-arm64-musl', 'linux-x64', 'linux-x64-musl', 'win32-arm64', 'win32-x64'];
const platformNames = platforms.map(platform => `claude-agent-sdk-${platform}`);
function cleanPlatformPackages(root = path.resolve(__dirname, '..')) {
  const scope = path.resolve(root, 'node_modules/@anthropic-ai');
  for (const name of platformNames) {
    const target = path.resolve(scope, name);
    if (path.dirname(target) !== scope) throw new Error('Invalid SDK cleanup target');
    fs.rmSync(target, { recursive: true, force: true });
  }
}
function verifyInstall(root = path.resolve(__dirname, '..')) {
  const visit = modules => {
    if (!fs.existsSync(modules)) return;
    for (const name of platformNames) if (fs.existsSync(path.join(modules, '@anthropic-ai', name))) throw new Error(`Unexpected SDK platform package: ${name}`);
    for (const entry of fs.readdirSync(modules, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const folder = path.join(modules, entry.name);
      if (!entry.name.startsWith('@')) { visit(path.join(folder, 'node_modules')); continue; }
      for (const pkg of fs.readdirSync(folder, { withFileTypes: true })) {
        if (pkg.isDirectory()) visit(path.join(folder, pkg.name, 'node_modules'));
      }
    }
  };
  visit(path.join(root, 'node_modules'));
}
async function verifyPackage(resources, { load = url => import(url), readAsar } = {}) {
  verifyInstall(path.join(resources, 'app.asar.unpacked'));
  const list = readAsar || (file => require('@electron/asar').listPackage(file));
  const entries = list(path.join(resources, 'app.asar'));
  if (entries.some(entry => platformNames.some(name => entry.replaceAll('\\', '/').includes(`/node_modules/@anthropic-ai/${name}/`)))) throw new Error('SDK platform package found in app.asar');
  const sdk = await load(pathToFileURL(path.join(resources, 'app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs')).href);
  if (typeof sdk.query !== 'function') throw new Error('Packaged SDK cannot be loaded');
}
if (require.main === module) {
  if (process.argv[2] === '--clean') { cleanPlatformPackages(); verifyInstall(); }
  else if (process.argv[2] === '--check-install') verifyInstall();
  else if (process.argv[2] === '--verify' && process.argv[3]) verifyPackage(path.resolve(process.argv[3])).catch(error => { console.error(error.message); process.exitCode = 1; });
  else { console.error('Usage: claude-sdk-pack.cjs --clean | --check-install | --verify <resources>'); process.exitCode = 1; }
}
module.exports = { cleanPlatformPackages, verifyInstall, verifyPackage, platformNames };
