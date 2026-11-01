const path = require('node:path');
const { fs } = require('./disk.cjs');
const { command } = require('./process.cjs');
const { cleanEnvironment } = require('./sandbox.cjs');
const { inside } = require('./workspace.cjs');
const { translate } = require('../../i18n.cjs');

async function resolveNode({ nodePath, env = process.env, protectedPaths = [], signal,
  t = source => translate('zh', source) } = {}) {
  const search = Object.keys(env).find(key => key.toLowerCase() === 'path');
  const candidates = [
    nodePath, !process.versions.electron && process.execPath,
    ...String(env[search] || '').split(path.delimiter).filter(path.isAbsolute).map(folder => path.join(folder, 'node')),
    '/opt/homebrew/bin/node', '/usr/local/bin/node',
  ].filter(Boolean);
  const allowed = file => !protectedPaths.some(root => inside(root, file));
  const appExecutable = process.versions.electron ? await fs.realpath(process.execPath) : null;
  const checked = new Set();
  for (const candidate of candidates) {
    try {
      const file = await fs.realpath(candidate);
      if (checked.has(file) || !allowed(file) || file === appExecutable) continue;
      checked.add(file);
      // Electron's executable can depend on a framework inside the protected project. Use an independent Node runtime.
      const probe = await command(file, ['--disable-sigusr1', '-e',
        "if (process.versions.electron) process.exit(1); process.stdout.write(process.execPath);",
      ], { env: { ...cleanEnvironment(env), ELECTRON_RUN_AS_NODE: '1' }, signal, timeoutMs: 5000, maxOutput: 4096 });
      if (probe.code !== 0 || !path.isAbsolute(probe.stdout.trim())) continue;
      const runtime = await fs.realpath(probe.stdout.trim());
      if (allowed(runtime)) return runtime;
    } catch (error) {
      if (!['ENOENT', 'EACCES', 'EPERM', 'ENOEXEC', 'ENOTDIR'].includes(error.code)) {
        error.infrastructure = true; throw error;
      }
    }
  }
  throw Object.assign(new Error(t('需要先安装 Node.js')), { infrastructure: true, code: 'ERR_LAB_NODE_RUNTIME' });
}

module.exports = { resolveNode };
