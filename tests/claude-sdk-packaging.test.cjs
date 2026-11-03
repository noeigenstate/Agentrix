const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { cleanPlatformPackages, verifyInstall, verifyPackage, platformNames } = require('../scripts/claude-sdk-pack.cjs');
const { createSdkLoader } = require('../electron/features/claude-sdk/runtime.cjs');
const { build, dependencies, scripts } = require('../package.json');
function temporary(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-sdk-pack-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
test('SDK cleanup removes exactly the eight platform packages and keeps the JS runtime', t => {
  const root = temporary(t), scope = path.join(root, 'node_modules/@anthropic-ai');
  for (const name of [...platformNames, 'claude-agent-sdk', 'sdk']) fs.mkdirSync(path.join(scope, name), { recursive: true });
  assert.throws(() => verifyInstall(root)); cleanPlatformPackages(root); verifyInstall(root);
  assert.equal(platformNames.length, 8); assert.ok(fs.existsSync(path.join(scope, 'claude-agent-sdk'))); assert.ok(fs.existsSync(path.join(scope, 'sdk')));
});
test('packaged SDK imports from the unpacked filesystem and rejects an archived platform binary', async t => {
  const resources = temporary(t), entry = path.join(resources, 'app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs');
  fs.mkdirSync(path.dirname(entry), { recursive: true }); fs.writeFileSync(entry, 'export function query() { throw new Error("fake-only"); }');
  await verifyPackage(resources, { readAsar: () => [] });
  await assert.rejects(verifyPackage(resources, { readAsar: () => ['/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude'] }));
  const sdk = await createSdkLoader({ packaged: true, resourcesPath: resources })(); assert.equal(typeof sdk.query, 'function');
});
test('packaged SDK also rejects an unpacked platform binary', async t => {
  const resources = temporary(t); fs.mkdirSync(path.join(resources, 'app.asar.unpacked/node_modules/@anthropic-ai', platformNames[0]), { recursive: true });
  await assert.rejects(verifyPackage(resources, { readAsar: () => [], load: async () => ({ query() {} }) }));
});
test('platform verification also finds nested production dependencies', t => {
  const root = temporary(t);
  fs.mkdirSync(path.join(root, 'node_modules/parent/node_modules/@anthropic-ai', platformNames[0]), { recursive: true });
  assert.throws(() => verifyInstall(root));
});
test('build configuration pins the SDK, keeps its dependency graph and cleans ignored-script CI installs', () => {
  assert.equal(dependencies['@anthropic-ai/claude-agent-sdk'], '0.3.317');
  assert.ok(scripts.postinstall.includes('claude-sdk-pack.cjs --clean'));
  assert.ok(build.asarUnpack.includes('node_modules/**/*')); assert.ok(build.mac.asarUnpack.includes('node_modules/**/*'));
  assert.ok(!build.files.includes('!node_modules/argparse/**/*'));
  assert.ok(build.files.some(value => value.includes('claude-agent-sdk-*')));
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/build-windows.yml'), 'utf8');
  assert.equal((workflow.match(/run: npm ci /g) || []).length, (workflow.match(/run: node scripts\/claude-sdk-pack.cjs --clean/g) || []).length);
  require('js-yaml').load(workflow);
});
