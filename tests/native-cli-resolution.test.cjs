const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveCli } = require('../scripts/codex-cli-resolution.cjs');

test('Windows npm Codex uses its Node console, never the packaged Electron executable', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentrix-native-resolution-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('agentrix-native-resolution-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const bin = path.join(root, 'npm bin'), runtime = path.join(root, 'node runtime');
  const script = path.join(bin, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  fs.mkdirSync(path.dirname(script), { recursive: true }); fs.mkdirSync(runtime);
  fs.writeFileSync(script, ''); fs.writeFileSync(path.join(runtime, 'node.exe'), '');
  const env = { Path: `;"${bin}";;"${runtime}";` };
  assert.deepEqual(resolveCli('codex', env, 'win32'), { file: path.join(runtime, 'node.exe'), prefix: [script], node: true });
  assert.throws(() => resolveCli('codex', { PATH: bin }, 'win32'), /requires node\.exe in PATH/);
  assert.throws(() => resolveCli('codex', { Path: ';"";;' }, 'win32'), /requires an executable in PATH/);
  // npm also supports a Node runtime beside the shim; it takes precedence over other PATH entries.
  const adjacent = path.join(bin, 'node.exe'); fs.writeFileSync(adjacent, '');
  assert.equal(resolveCli('codex', env, 'win32').file, adjacent);
  // The package's own program, where npm 10 and 11 nest it (tests/fixtures/real-cli/codex-layouts.json), runs directly.
  const vendor = path.join(bin, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
  fs.mkdirSync(path.dirname(vendor), { recursive: true }); fs.writeFileSync(vendor, '');
  assert.deepEqual(resolveCli('codex', env, 'win32', undefined, 'x64'), { file: vendor, prefix: [] });
  const executable = path.join(bin, 'codex.exe'); fs.writeFileSync(executable, '');
  assert.deepEqual(resolveCli('codex', env, 'win32'), { file: executable, prefix: [] });
  assert.throws(() => resolveCli('claude', env, 'win32'), /only available for Codex/);
});
