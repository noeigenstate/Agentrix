const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const { copyDispatchRuntime } = require('../scripts/after-pack.cjs');
const { build } = require('../package.json');
const { fixtureProcesses } = require('./fixtures/claude-sdk-processes.cjs');

const root = path.resolve(__dirname, '..');

for (const provider of ['claude', 'codex']) test(`standalone wire fixture starts, sends, resumes and stops a fake ${provider} child`, { timeout: 15000 }, async t => {
  const readline = require('node:readline');
  const scope = fixtureProcesses(t, 'agentrix-fake-provider-'), { directory } = scope;
  const fixture = path.join(directory, 'fake-provider.cjs');
  fs.copyFileSync(path.join(__dirname, 'fixtures/claude-sdk-process.cjs'), fixture);
  const home = path.join(directory, 'home'); fs.mkdirSync(home);
  const child = scope.spawn(process.execPath, [fixture, provider], { windowsHide: true, cwd: directory,
    env: { HOME: home, USERPROFILE: home, CODEX_HOME: home, CLAUDE_CONFIG_DIR: home, AGENTRIX_DATA_DIR: directory }, stdio: ['pipe', 'pipe', 'pipe'] });
  const input = readline.createInterface({ input: child.stdout });
  scope.defer(() => input.close());
  const iterator = input[Symbol.asyncIterator]();
  child.stdin.write(JSON.stringify({ text: 'first' }) + '\n');
  const first = JSON.parse((await scope.wait(iterator.next(), `${provider} first reply`)).value);
  assert.equal(first.provider, provider); const session = first.sessionId || first.threadId;
  child.stdin.write(JSON.stringify({ resume: session, text: 'second' }) + '\n');
  const second = JSON.parse((await scope.wait(iterator.next(), `${provider} resumed reply`)).value);
  assert.equal(second.sessionId || second.threadId, session); assert.match(second.text, /second/);
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.stdin.write('{"type":"stop"}\n'); assert.equal(await scope.wait(exited, `${provider} stop`), 0);
});

// Run electron-builder's real filters with POSIX paths even when this test runs on Windows.
function posixBuilderModule(name) {
  const filename = require.resolve(`app-builder-lib/out/${name}`), localRequire = createRequire(filename);
  const context = { exports: {}, require: name => name === 'path' ? path.posix
    : name === './util/filter' ? posixBuilderModule('util/filter.js') : localRequire(name) };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return context.exports;
}

for (const [platform, arch] of [['win32', 'x64'], ['darwin', 'arm64'], ['linux', 'x64'], ['linux', 'arm64']]) {
  test(`SDK unpack closure preserves speech and native binary packaging on ${platform}-${arch}`, { timeout: 15000 }, async t => {
    const scope = fixtureProcesses(t, 'agx-unpack-'), source = path.join(scope.directory, 'source');
    const resources = path.join(scope.directory, 'resources'), destination = path.join(resources, 'app.asar');
    fs.mkdirSync(resources); fs.mkdirSync(source);
    const candidates = [
      'node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs', 'node_modules/@anthropic-ai/claude-agent-sdk/package.json',
      'node_modules/sherpa-onnx-node/sherpa-onnx.js', 'node_modules/jsonc-parser/lib/umd/main.js',
      'native/mac-titlebar/build/Release/mac_titlebar.node',
      ...['win32-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64'].map(target => `node_modules/node-pty/prebuilds/${target}/pty.node`),
      ...['win-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64'].map(target => `node_modules/sherpa-onnx-${target}/engine.node`),
      'node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude',
    ];
    for (const file of candidates) {
      const absolute = path.join(source, file); fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, file.endsWith('sdk.mjs') ? 'export function query() {}' : file.endsWith('package.json') ? '{}' : 'offline fixture');
    }
    const { FileMatcher, getFileMatchers } = posixBuilderModule('fileMatcher.js');
    const expand = value => value.replaceAll('${platform}', platform).replaceAll('${arch}', arch);
    // Production dependencies are collected separately by builder, then receive the app's exclusion rules.
    const mainFilter = new FileMatcher('/source', '/resources/app.asar', expand, ['**/*', ...build.files.filter(pattern => pattern.startsWith('!'))]).createFilter();
    const unpackFilter = getFileMatchers(build, 'asarUnpack', '/resources/app.asar', {
      defaultSrc: '/source', globalOutDir: '/source/release', customBuildOptions: build[platform === 'darwin' ? 'mac' : platform === 'win32' ? 'win' : 'linux'], macroExpander: expand,
    })[0].createFilter();
    const files = candidates.filter(file => mainFilter(`/source/${file}`, fs.statSync(path.join(source, file))))
      .filter(file => platform === 'darwin' || !file.startsWith('native/')).map(file => path.join(source, file));
    assert.ok(files.some(file => file.endsWith('sdk.mjs')), 'SDK dependency survives the production filters');
    const metadata = new Map(files.map(file => {
      const stat = fs.statSync(file), relative = path.relative(source, file).replaceAll('\\', '/');
      const packageMatch = /^node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(relative);
      if (packageMatch) Object.assign(stat, { moduleRootPath: path.join('node_modules', packageMatch[1]), moduleName: packageMatch[1], moduleFullFilePath: path.normalize(relative) });
      return [file, stat];
    }));
    const { AsarPackager } = require('app-builder-lib/out/asar/asarUtil.js');
    await new AsarPackager({ info: { getWorkspaceRoot: async () => source } }, { defaultDestination: destination, resourcePath: resources,
      options: {}, unpackPattern: (file, stat) => unpackFilter(`/source/${path.relative(source, file).replaceAll('\\', '/')}`, stat),
    }).pack([{ src: source, destination, files, metadata }]);
    const asar = require('@electron/asar'), entries = asar.listPackage(destination).map(file => file.replaceAll('\\', '/'));
    assert.ok(entries.includes('/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs'), JSON.stringify(entries));
    const stat = file => asar.statFile(destination, path.normalize(file));
    assert.equal(stat('node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs').unpacked, true);
    assert.ok(!stat('node_modules/sherpa-onnx-node/sherpa-onnx.js').unpacked);
    assert.ok(!stat('node_modules/jsonc-parser/lib/umd/main.js').unpacked);
    assert.equal(stat(`node_modules/node-pty/prebuilds/${platform}-${arch}/pty.node`).unpacked, true);
    if (platform === 'darwin') assert.equal(stat('native/mac-titlebar/build/Release/mac_titlebar.node').unpacked, true);
    assert.ok(!entries.some(file => /\/node_modules\/sherpa-onnx-(win|darwin|linux)-/.test(file)));
    assert.ok(!entries.some(file => /\/node_modules\/@anthropic-ai\/claude-agent-sdk-/.test(file)));
    const nativeFiles = entries.filter(file => file.includes('/node_modules/node-pty/prebuilds/') && file.endsWith('.node'));
    assert.deepEqual(nativeFiles, [`/node_modules/node-pty/prebuilds/${platform}-${arch}/pty.node`]);
    await require('../scripts/claude-sdk-pack.cjs').verifyPackage(resources);
  });
}

for (const arch of ['x64', 'arm64']) test(`packaged Linux ${arch} retains every main-process startup dependency and the standalone dispatch runtime`, { timeout: 45000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentrix-package-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const { FileMatcher, getFileMatchers } = posixBuilderModule('fileMatcher.js');
  const expand = value => value.replaceAll('${platform}', 'linux').replaceAll('${arch}', arch);
  const extras = getFileMatchers(build, 'extraResources', '/resources', {
    defaultSrc: '/source', globalOutDir: '/source/release', customBuildOptions: build.linux, macroExpander: expand,
  });
  const exclusions = [];
  for (const matcher of extras) matcher.computeParsedPatterns(exclusions, '/source');
  const main = new FileMatcher('/source', '/resources/app.asar', expand, build.files);
  main.excludePatterns = exclusions;
  function copy(matcher, names) {
    const source = path.join(root, path.posix.relative('/source', matcher.from));
    const target = path.join(directory, path.posix.relative('/resources', matcher.to));
    const accepts = matcher.createFilter();
    for (const name of names || fs.readdirSync(source, { recursive: true })) {
      const file = path.join(source, name), stat = fs.statSync(file);
      if (!stat.isFile() || !accepts(path.posix.join(matcher.from, name.replaceAll('\\', '/')), stat)) continue;
      const destination = path.join(target, name);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(file, destination);
    }
  }
  copy(main, ['package.json', ...fs.readdirSync(path.join(root, 'electron'), { recursive: true }).map(name => path.join('electron', name))]);
  for (const matcher of extras) copy(matcher);
  await copyDispatchRuntime(path.join(directory, 'integration'));

  const mainFile = path.join(directory, 'app.asar/electron/main.cjs');
  const script = String.raw`
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const { createRequire, Module } = require('node:module');
    const load = Module._load;
    // Load the actual JS dependency graph without starting Electron or loading its native PTY ABI.
    Module._load = function(name, ...args) {
      if (name === 'electron' || name === 'node-pty') return {};
      return load.call(this, name, ...args);
    };
    const main = createRequire(process.argv[1]);
    const source = fs.readFileSync(process.argv[1], 'utf8');
    for (const match of source.matchAll(/require\(['"]([^'"]+)['"]\)/g)) main(match[1]);
    assert.equal(main('./agent-actions.cjs').TranscriptTail, main('./transcript-tail.cjs').TranscriptTail);
    main(process.argv[2]);
    const dispatch = main(process.argv[3]);
    assert.equal(typeof dispatch.run, 'function');
    assert.ok(Object.keys(dispatch.runtimeFiles()).length > 0);
    console.log('PASS: packaged startup imports and standalone dispatch runtime');
  `;
  const home = path.join(directory, 'home');
  const result = spawnSync(process.execPath, ['-e', script, mainFile, path.join(directory, 'integration/codex-account-scope.cjs'), path.join(directory, 'integration/dispatch.cjs')], {
    cwd: directory, encoding: 'utf8', timeout: 30000, windowsHide: true,
    env: { ...process.env, NODE_PATH: path.join(root, 'node_modules'), NODE_OPTIONS: '', HOME: home, USERPROFILE: home,
      CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'), AGENTRIX_DATA_DIR: path.join(directory, 'profile') },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /PASS: packaged startup imports and standalone dispatch runtime/);
});
