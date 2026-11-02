// The guardian holds the native launcher's lifetime outside LPAC. No private payload is put in argv or a public file.
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const modules = config.helper ? JSON.parse(fs.readFileSync(config.helper, 'utf8')) : null;
const bootstrap = process.env.AGENTRIX_BOOTSTRAP ? JSON.parse(fs.readFileSync(process.env.AGENTRIX_BOOTSTRAP, 'utf8')) : null;
const marker = '\x1e' + randomUUID() + '\x1f';
const env = { ...process.env };
delete env.AGENTRIX_BOOTSTRAP; delete env.NODE_OPTIONS; delete env.NODE_PATH;
const isolatedEnvironment = Object.fromEntries([
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR',
  'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR',
].filter(key => env[key] !== undefined).map(key => [key, env[key]]));
const child = spawn(config.windows.executable, ['run'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
process.once('disconnect', () => { child.kill(); });
process.channel?.unref();
child.stdout.pipe(process.stdout);
let tail = '', started = false;
child.stderr.setEncoding('utf8');
child.stderr.on('data', chunk => {
  tail += chunk;
  const index = tail.indexOf(marker);
  if (index !== -1) {
    tail = tail.slice(0, index) + tail.slice(index + marker.length);
    if (!started && process.connected) process.send({ type: 'lab-model-started' }, () => {});
    started = true;
  }
  const end = Math.max(0, tail.length - marker.length + 1);
  process.stderr.write(tail.slice(0, end)); tail = tail.slice(end);
});
child.stderr.once('end', () => { if (tail) process.stderr.write(tail); });
child.stdin.on('error', () => {});
child.stdin.end(JSON.stringify({
  ...config.windows, file: process.execPath, args: [config.executor], cwd: config.cwd, env,
  input: JSON.stringify({ config: { ...config, startMarker: marker, isolatedEnvironment }, bootstrap, modules }),
}));
child.once('error', () => { console.error('Windows lab launcher could not start.'); process.exitCode = 125; });
child.once('close', code => { process.exitCode = code ?? 125; });
