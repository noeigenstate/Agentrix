// The guardian holds the native launcher's lifetime outside LPAC. No private payload is put in argv or a public file.
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const modules = config.helper ? JSON.parse(fs.readFileSync(config.helper, 'utf8')) : null;
const bootstrap = process.env.AGENTRIX_BOOTSTRAP ? JSON.parse(fs.readFileSync(process.env.AGENTRIX_BOOTSTRAP, 'utf8')) : null;
const marker = '\x1e' + randomUUID() + '\x1f';
const diagnostic = process.env.AGENTRIX_LAB_DIAGNOSTICS === '1';
const trace = message => { if (diagnostic) process.stderr.write('[lab-win32] host ' + message + '\n'); };
const env = { ...process.env };
delete env.AGENTRIX_BOOTSTRAP; delete env.NODE_OPTIONS; delete env.NODE_PATH;
const isolatedEnvironment = Object.fromEntries([
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR',
  'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR',
].filter(key => env[key] !== undefined).map(key => [key, env[key]]));
const child = spawn(config.windows.executable, ['run'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
child.once('spawn', () => trace('spawned pid=' + child.pid));
// EOF cancels even a launcher that has not created its Job yet. Let it release handles before ACL recovery.
const stop = () => { trace('cancel EOF'); child.stdin.end(); };
process.once('disconnect', stop);
process.on('message', message => { if (message?.type === 'lab-stop') stop(); });
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
  // Keep only an actual marker prefix; retaining an arbitrary tail delays short errors and stage lines.
  let held = Math.min(tail.length, marker.length - 1);
  while (held && !marker.startsWith(tail.slice(-held))) held--;
  const end = tail.length - held;
  process.stderr.write(tail.slice(0, end)); tail = tail.slice(end);
});
child.stderr.once('end', () => { if (tail) process.stderr.write(tail); });
child.stdin.on('error', () => {});
const frame = JSON.stringify({
  ...config.windows, file: process.execPath, args: [config.executor], cwd: config.cwd, env,
  input: JSON.stringify({ config: { ...config, startMarker: marker, isolatedEnvironment }, bootstrap, modules }),
}) + '\n';
trace('frame queued bytes=' + Buffer.byteLength(frame));
child.stdin.write(frame, 'utf8', () => trace('frame written'));
child.once('error', () => { console.error('Windows lab launcher could not start.'); process.exitCode = 125; });
child.once('close', code => { trace('closed code=' + code); process.exitCode = code ?? 125; });
