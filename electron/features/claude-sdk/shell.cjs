const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync, execFile } = require('node:child_process');

function shellExecutable(env) {
  if (process.platform !== 'win32') return env.SHELL || '/bin/bash';
  if (env.CLAUDE_CODE_GIT_BASH_PATH) return env.CLAUDE_CODE_GIT_BASH_PATH;
  // Use Git's Bash, as the installed CLI does on Windows; do not silently change shell syntax to cmd.
  const directory = execFileSync('git', ['--exec-path'], { env, windowsHide: true, encoding: 'utf8' }).trim();
  const executable = path.resolve(directory, '../../../bin/bash.exe');
  if (!fs.existsSync(executable)) throw new Error('找不到命令使用的 Bash。');
  return executable;
}

function runShell({ cwd, env, command, signal, output, timeout = 120000 }) {
  const safe = Object.fromEntries(Object.entries(env).filter(([key]) => !/^(?:ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|OPENAI_API_KEY)$/i.test(key)));
  return new Promise((resolve, reject) => {
    let child;
    // Keep Bash as the parent until the command exits. Its last-command exec
    // optimization can replace the Windows process id before a timeout kills it.
    try { child = spawn(shellExecutable(safe), ['-c', command + '\nexit $?'], { cwd, env: safe, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { reject(error); return; }
    let stdout = '', stderr = '', stopped = false;
    const stop = () => {
      if (stopped || child.exitCode !== null || child.signalCode !== null) return;
      stopped = true;
      if (process.platform === 'win32') execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, error => { if (error) child.kill('SIGKILL'); });
      else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    };
    const timer = setTimeout(stop, timeout);
    signal.addEventListener('abort', stop, { once: true }); if (signal.aborted) stop();
    const append = (field, value) => {
      const remaining = 30000 - stdout.length - stderr.length;
      if (field === 'stdout') stdout += value.toString().slice(0, Math.max(0, remaining));
      else stderr += value.toString().slice(0, Math.max(0, remaining));
      output({ stdout, stderr });
    };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', value => append('stdout', value)); child.stderr.on('data', value => append('stderr', value));
    child.once('error', reject);
    child.once('close', code => {
      clearTimeout(timer); signal.removeEventListener('abort', stop);
      resolve({ exitCode: stopped ? null : code, stdout, stderr });
    });
  });
}

module.exports = { runShell };
