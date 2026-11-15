const fs = require('node:fs');
const path = require('node:path');
const { packageBinaries } = require('../electron/features/codex-runtime/locator.cjs');
// Resolve argv without invoking a shell or reading account files. On Windows an npm package's own program (by
// codex-runtime's layout table) runs directly; a package without one needs its JS entrypoint.
function resolveCli(provider, env = process.env, platform = process.platform, node, arch = process.arch) {
  if (provider !== 'codex') throw new Error('Native mode is only available for Codex');
  const folders = String(Object.entries(env).find(([k]) => k.toLowerCase() === 'path')?.[1] || '').split(platform === 'win32' ? ';' : ':').map(folder => folder.replace(/"/g, '')).filter(Boolean);
  for (const base of folders) {
    if (platform === 'win32') {
      const pkg = path.join(base, 'node_modules', '@openai', 'codex');
      const binaries = packageBinaries(pkg, arch, path).map(([file]) => file);
      for (const file of [path.join(base, 'codex.exe'), ...binaries, path.join(pkg, 'bin', 'codex.js')]) {
        if (!fs.existsSync(file)) continue;
        if (!file.endsWith('.js')) return { file, prefix: [] };
        // Electron-as-Node has no usable Windows stdin TTY. npm's wrapper must inherit the real Node console.
        const runtime = node ?? [base, ...folders].map(folder => path.join(folder, 'node.exe')).find(file => fs.existsSync(file));
        if (!runtime) throw new Error('Native Codex npm launch requires node.exe in PATH.');
        return { file: runtime, prefix: [file], node: true };
      }
    } else {
      const file = path.join(base, provider);
      try { fs.accessSync(file, fs.constants.X_OK); return { file, prefix: [] }; } catch { }
    }
  }
  throw new Error(`Native ${provider} launch requires an executable in PATH (or a standard npm installation). Configure a supported executable.`);
}

module.exports = { resolveCli };
