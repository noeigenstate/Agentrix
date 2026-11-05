const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync, execFile } = require('node:child_process');

function shellExecutable(env) {
  if (process.platform !== 'win32') return '/bin/bash';
  if (env.CLAUDE_CODE_GIT_BASH_PATH) return env.CLAUDE_CODE_GIT_BASH_PATH;
  // Use Git's Bash, as the installed CLI does on Windows; do not silently change shell syntax to cmd.
  const directory = execFileSync('git', ['--exec-path'], { env, windowsHide: true, encoding: 'utf8' }).trim();
  const executable = path.resolve(directory, '../../../bin/bash.exe');
  if (!fs.existsSync(executable)) throw new Error('找不到命令使用的 Bash。');
  return executable;
}

function runShell({ cwd, env, command, signal, output, timeout = 120000 }) {
  const safe = Object.fromEntries(Object.entries(env).filter(([key]) => !/^(?:ANTHROPIC_|OPENAI_|CLAUDE_CODE_(?:OAUTH|API_KEY|AUTH|SESSION_ACCESS_TOKEN)|CLAUDE_(?:OAUTH|API_KEY|AUTH)|CODEX_(?:API_KEY|AUTH|ACCESS_TOKEN)|AWS_|AZURE_|GOOGLE_APPLICATION_CREDENTIALS$)|(?:^|_)(?:API_KEY|API_TOKEN|AUTH_TOKEN|ACCESS_TOKEN|SECRET_ACCESS_KEY)$/i.test(key)));
  return new Promise((resolve, reject) => {
    // Keep the parent alive while background jobs own the pipes. Cancellation can then
    // reap its whole Windows tree even after the submitted command itself has returned.
    const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'agentrix-shell-'));
    const receipt = path.join(directory, 'exit').replaceAll('\\', '/');
    const quoted = "'" + receipt.replaceAll("'", "'\\''") + "'";
    let finishClose; const closed = new Promise(resolve => { finishClose = resolve; });
    let child, stdout = '', stderr = '', stopped = false, settled = false, truncated = false, drain, timer, poll;
    const cleanup = () => {
      clearTimeout(timer); clearTimeout(drain); clearInterval(poll);
      signal.removeEventListener('abort', stop);
      fs.rmSync(directory, { recursive: true, force: true }); finishClose();
    };
    const result = code => {
      if (settled) return;
      settled = true; clearTimeout(drain); clearInterval(poll);
      resolve({ exitCode: stopped ? null : code, stdout, stderr, closed });
    };
    const stop = () => {
      if (stopped) return;
      stopped = true;
      const done = () => { child.stdout.destroy(); child.stderr.destroy(); result(null); };
      if (process.platform === 'win32' && child.exitCode === null && child.signalCode === null) {
        execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'],
          { windowsHide: true, timeout: 5000 }, error => { if (error) child.kill('SIGKILL'); done(); });
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        done();
      }
    };
    try {
      child = spawn(shellExecutable(safe), ['-c', command + '\n__agentrix_exit=$?\nprintf "%s" "$__agentrix_exit" > ' + quoted + '\nwait\nexit "$__agentrix_exit"'],
        { cwd, env: safe, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) { cleanup(); reject(error); return; }
    timer = setTimeout(stop, timeout); timer.unref?.();
    signal.addEventListener('abort', stop, { once: true }); if (signal.aborted) stop();
    const append = (field, value) => {
      if (truncated || settled) return;
      const remaining = 30000 - stdout.length - stderr.length, text = value.toString();
      const clipped = text.slice(0, Math.max(0, remaining));
      if (field === 'stdout') stdout += clipped; else stderr += clipped;
      if (text.length > remaining) {
        truncated = true;
        const marker = '\n[输出已截断]';
        if (stderr.length >= marker.length) stderr = stderr.slice(0, -marker.length) + marker;
        else { stdout = stdout.slice(0, 30000 - stderr.length - marker.length); stderr += marker; }
      }
      output({ stdout, stderr });
    };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', value => append('stdout', value)); child.stderr.on('data', value => append('stderr', value));
    poll = setInterval(() => {
      let code; try { code = fs.readFileSync(receipt, 'utf8'); } catch { return; }
      if (!/^-?\d+$/.test(code) || drain) return;
      // Finite commands usually close immediately. Services return after a bounded drain,
      // while the owned parent remains cancellable until timeout or session close.
      drain = setTimeout(() => result(Number(code)), 100);
    }, 20); poll.unref?.();
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', code => { result(code); cleanup(); });
  });
}

module.exports = { runShell };
