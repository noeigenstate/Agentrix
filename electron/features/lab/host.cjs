// The guardian stays outside the model sandbox so an app crash can still sweep re-parented processes.
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { killMarked } = require('./process.cjs');
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));

let disconnected = false;
process.once('disconnect', () => {
  if (disconnected) return;
  disconnected = true;
  void killMarked(config.runId).finally(() => {
    try { process.kill(-process.pid, 'SIGKILL'); } catch {}
    process.exit(1);
  });
});
process.channel?.unref();

const modules = config.helper ? JSON.parse(fs.readFileSync(config.helper, 'utf8')) : null;
const bootstrap = process.env.AGENTRIX_BOOTSTRAP
  ? JSON.parse(fs.readFileSync(process.env.AGENTRIX_BOOTSTRAP, 'utf8')) : null;
const child = spawn('/usr/bin/sandbox-exec', [
  '-p', config.profile, process.execPath, '--disable-sigusr1', config.executor,
], { cwd: config.cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
child.stdio[3].on('error', () => {});
child.stdio[3].end(JSON.stringify({ config, bootstrap, modules }));
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('close', code => { process.exitCode = code ?? 1; });
