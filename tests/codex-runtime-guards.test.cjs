const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createCodexLocator, VIAS } = require('../electron/features/codex-runtime/locator.cjs');
const { SHIM_MARKER } = require('../electron/shared/agentrix-shims.cjs');
const { fakeFiles, fakeProbe } = require('./helpers/claude-files.cjs');

// G9: one Codex search. The ways it can find Codex are listed once in the locator and spelled the same in the shared type
// and the settings' words; no other code looks for Codex's install layouts; and Agentrix's own shim folder is never a
// candidate.
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const sorted = list => [...list].sort();

test('every way Codex can be found is in the locator, the shared type and the words, and nowhere else', () => {
  const type = /export type CodexVia = ([^;]+);/.exec(read('src/shared/types.ts'));
  assert.ok(type, 'CodexVia is a union of string literals');
  const block = /const CODEX_VIA_WORDS: Record<string, string> = \{([\s\S]*?)\n\};/.exec(read('src/features/agents/AgentsSettings.tsx'));
  assert.ok(block, 'CODEX_VIA_WORDS is an object literal');
  const worded = [...block[1].matchAll(/(?:^|[\s,{])(?:'([a-z-]+)'|([a-z]+)):\s*'/g)].map(match => match[1] ?? match[2]);
  assert.deepEqual(sorted([...type[1].matchAll(/'([a-z-]+)'/g)].map(match => match[1])), sorted(VIAS), 'types.ts CodexVia and the locator VIAS');
  assert.deepEqual(sorted(worded), sorted(VIAS), 'AgentsSettings CODEX_VIA_WORDS and the locator VIAS');
  assert.equal(new Set(VIAS).size, VIAS.length, 'no way is listed twice');
  // Nowhere else: no other product source names Codex's npm platform packages or its program inside one, so a second
  // search cannot grow beside the locator; the probes' resolveCli takes the locator's layout table. (Test and lab
  // scripts lay those layouts out for their stand-ins; they look for nothing.)
  const layout = /codex-win32-|vendor[\\/][\w-]*windows-msvc|@openai[\\/]codex[\\/]bin[\\/]codex\.js/;
  const owners = new Set(['electron/features/codex-runtime/locator.cjs']);
  const offenders = [];
  for (const folder of ['electron', 'integration', 'src']) {
    for (const name of fs.readdirSync(path.join(root, folder), { recursive: true })) {
      const file = path.posix.join(folder, String(name).replaceAll('\\', '/'));
      if (!/\.(c|m)?[jt]sx?$/.test(file) || owners.has(file)) continue;
      if (layout.test(read(file))) offenders.push(file);
    }
  }
  assert.deepEqual(offenders, [], 'files that look for Codex outside the locator');
  // The drive scan is a generic walk: what counts as a hit comes from the locator, and the dispatch helper, which
  // needs no scan, does not carry it.
  assert.doesNotMatch(read('electron/features/codex-runtime/drive-scan.cjs'), /codex\.exe|codex\.js|@openai/i, 'the drive scan names no Codex layout');
  assert.ok(!Object.keys(require('../integration/dispatch.cjs').runtimeFiles()).some(file => file.endsWith('drive-scan.cjs')), 'the helper does not carry the drive scan');
  // Agentrix's own Codex stand-in answers --version as Codex does: its folder is marked, so a scan never takes it.
  assert.match(read('scripts/gui-codex-env.mjs'), /await writeFile\(path\.join\(bin, STAND_IN_MARKER\), ''\);[\s\S]*codex\.exe/, 'the stand-in is built beside the marker');
  const resolution = read('scripts/codex-cli-resolution.cjs');
  assert.match(resolution, /packageBinaries\(/); assert.doesNotMatch(resolution, /codex-win32-|windows-msvc/);
});

test('the Agentrix shim folder is never a locator candidate, for Claude or Codex', async t => {
  await t.test('Codex', async () => {
    const W = path.win32, shims = 'D:\\Agentrix\\runtime\\shims', real = 'D:\\Tools\\codex.exe';
    const npm = W.join(shims, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
    const entries = { [W.join(shims, SHIM_MARKER)]: { text: '' }, [W.join(shims, 'codex.exe')]: { size: 1000 }, [W.join(shims, 'codex.cmd')]: { text: '"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*' },
      [npm]: { size: 1000 }, [real]: { size: 1000 } };
    const { probe, runs } = fakeProbe({}, 'codex-cli 0.166.0');
    const locate = env => createCodexLocator({ files: fakeFiles(entries), probe, storedPath: async () => null })
      .refresh({ env: { PATH: '', ...env }, platform: 'win32', arch: 'x64' });
    assert.equal((await locate({ PATH: `${shims};D:\\Tools` })).file, real, 'the folder is passed over, wherever it is on PATH');
    assert.equal((await locate({ PATH: shims })).file, null);
    const told = await createCodexLocator({ files: fakeFiles(entries), probe, storedPath: async () => null })
      .locate({ env: { PATH: 'D:\\Tools' }, platform: 'win32', arch: 'x64', prefer: W.join(shims, 'codex.cmd') });
    assert.equal(told.file, real, 'not even when a terminal was told a shim there');
    assert.deepEqual(runs, [real, real], 'nothing there ever ran');
  });
  await t.test('Claude', { todo: 'F1 (W4) wires SHIM_MARKER into claude-runtime/locator.cjs' }, () => {});
});
