import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const dev = process.argv.includes('--dev');
let server;
if (dev) {
  const { createServer } = await import('vite');
  server = await createServer({ root });
  await server.listen();
  env.AGENTRIX_DEV_URL = 'http://127.0.0.1:5178';
} else {
  const build = spawnSync(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'build'], { cwd: root, stdio: 'inherit' });
  if (build.status !== 0) process.exit(build.status ?? 1);
}
const electron = require('electron');
if (process.platform === 'darwin') {
  try {
    const plist = path.join(path.dirname(electron), '..', 'Info.plist');
    const { productName } = require('../package.json');
    for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
      const current = spawnSync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist], { encoding: 'utf8' });
      if (current.status === 0 && current.stdout.trim() === productName) continue;
      const updated = spawnSync('/usr/bin/plutil', ['-replace', key, '-string', productName, plist], { encoding: 'utf8' });
      if (updated.status !== 0) throw updated.error || new Error(updated.stderr || `plutil exited ${updated.status}`);
    }
  } catch (error) { console.warn('macOS development app name:', error.message); }
}
const child = spawn(electron, [root], { cwd: root, env, stdio: 'inherit', windowsHide: false });
child.on('error', (error) => { console.error(error.message); process.exitCode = 1; server?.close(); });
child.on('exit', async (code) => { await server?.close(); process.exit(code ?? 0); });
