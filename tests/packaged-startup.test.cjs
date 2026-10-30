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

const root = path.resolve(__dirname, '..');

// Run electron-builder's real filters with POSIX paths even when this test runs on Windows.
function posixBuilderModule(name) {
  const filename = require.resolve(`app-builder-lib/out/${name}`), localRequire = createRequire(filename);
  const context = { exports: {}, require: name => name === 'path' ? path.posix
    : name === './util/filter' ? posixBuilderModule('util/filter.js') : localRequire(name) };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return context.exports;
}

for (const arch of ['x64', 'arm64']) test(`packaged Linux ${arch} retains every main-process startup dependency and the standalone dispatch runtime`, async t => {
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
  copy(main, ['package.json', 'src/shared/conversation-blocks.mjs', ...fs.readdirSync(path.join(root, 'electron'), { recursive: true }).map(name => path.join('electron', name))]);
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
