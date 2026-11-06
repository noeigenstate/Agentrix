const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function claudeExecutable({ root, prefix = root, override, platform = process.platform, arch = process.arch }) {
  if (override) {
    const file = path.resolve(override);
    if (!fs.existsSync(file)) throw new Error(`Explicit Claude CLI is missing: ${file}`);
    return { file, source: 'explicit installed CLI' };
  }
  const name = `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`;
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const expected = lock.packages[`node_modules/${name}`]?.version;
  if (!expected) throw new Error(`No locked native Claude package for ${platform}-${arch}`);
  const directory = path.join(prefix, 'node_modules', name);
  const metadata = path.join(directory, 'package.json');
  const file = path.join(directory, platform === 'win32' ? 'claude.exe' : 'claude');
  if (!fs.existsSync(metadata) || !fs.existsSync(file)) {
    throw new Error(`Locked Claude CLI is missing. Install ${name}@${expected} with npm install --ignore-scripts --no-save --prefix <private-directory>, then pass --locked-prefix <private-directory>.`);
  }
  if (JSON.parse(fs.readFileSync(metadata, 'utf8')).version !== expected) throw new Error(`Claude native package must match package-lock.json (${expected})`);
  return { file, source: `locked ${name}@${expected}` };
}

function main(args) {
  const root = path.resolve(__dirname, '..'), options = { root };
  let requested;
  for (let i = 0; i < args.length; i++) {
    const option = args[i], value = args[++i];
    if (!['--locked-prefix', '--claude', '--files'].includes(option) || !value || value.startsWith('--')) throw new Error('Usage: npm run test:real-cli -- [--locked-prefix <private-directory> | --claude <installed-executable>] [--files <test-path,...>]');
    if (option === '--files') { if (requested) throw new Error('Repeated option: --files'); requested = value.split(','); continue; }
    const key = option === '--claude' ? 'override' : 'prefix';
    if (Object.hasOwn(options, key)) throw new Error(`Repeated option: ${option}`);
    options[key] = value;
  }
  if (options.override && options.prefix) throw new Error('Choose either the locked baseline or an explicit installed CLI');
  // Ambient AGENTRIX_REAL_CLAUDE never selects the baseline accidentally.
  const allFiles = fs.readdirSync(path.join(root, 'tests')).filter(name => name.endsWith('real-cli.test.cjs') || ['native-ui-backend-real.test.cjs', 'backend-activity.test.cjs'].includes(name)).sort().map(name => `tests/${name}`);
  if (requested && (new Set(requested).size !== requested.length || requested.some(file => !allFiles.includes(file)))) throw new Error('Unknown or duplicate real CLI test file');
  const files = requested ?? allFiles;
  const selected = claudeExecutable(options);
  const version = spawnSync(selected.file, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  if (version.error || version.status !== 0 || !/^\d+\.\d+\.\d+ \(Claude Code\)/m.test(version.stdout || '')) throw new Error('Selected Claude CLI failed its version probe');
  console.log(`Real CLI baseline: ${selected.source}; ${version.stdout.trim()}; ${selected.file}`);
  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], {
    cwd: root, stdio: 'inherit', windowsHide: true,
    env: { ...process.env, AGENTRIX_REAL_CLAUDE: selected.file, AGENTRIX_REQUIRE_REAL_CLI: '1' },
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { claudeExecutable };
