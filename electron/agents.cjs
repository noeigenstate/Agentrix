const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');

const AGENT_PACKAGES = Object.freeze({ codex: '@openai/codex', claude: '@anthropic-ai/claude-code' });
// Command Prompt and agent detection must agree without running a CLI that could open a session.
// Windows finds a command by its extension; macOS and Linux by a file without one that may be executed.
function onPath(name, env, platform = process.platform) {
  const windows = platform === 'win32';
  const folders = String(Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] || '').split(windows ? ';' : ':').filter(Boolean);
  return folders.some(folder => (windows ? ['.exe', '.cmd', '.bat', '.ps1'] : ['']).some(extension => {
    try { const stat = fs.statSync(path.join(folder.replace(/"/g, ''), name + extension)); return stat.isFile() && (windows || (stat.mode & 0o111) !== 0); } catch { return false; }
  }));
}

// The agents' word on Claude Code from claude-runtime's locate: installed whenever one was found, also one that cannot
// run natively (`reason`: too old, or its check timed out, failed or printed no version) and an npm install whose native
// program is missing (`incomplete`); a version split names the copy the native path runs.
const found = candidate => ({ version: candidate.version, via: candidate.via, fileShown: candidate.fileShown });
function claudeState({ terminal, native, reason, version, failure, incomplete }) {
  const state = { installed: !!terminal || !!failure?.found || reason === 'too_old' || !!incomplete, ...(terminal ? found(terminal) : {}) };
  if (reason === 'too_old') Object.assign(state, { reason, version: state.version ?? version ?? null });
  if (failure) state.reason = failure.reason;
  if (incomplete) state.incomplete = true;
  if (reason === 'cli_split_versions') Object.assign(state, { notice: reason, native: found(native) });
  return state;
}

class AgentsManager {
  // `claude` gives claude-runtime's last locate (locator.peek()), never running a search: the program the terminal
  // runs, its version and where it was found. Before the first search the PATH check stands in. `refreshClaude`
  // searches again after Claude Code is installed.
  constructor({ env = process.env, platform = process.platform, detect = onPath, claude = () => null, refreshClaude = async () => {}, launch = spawn,
    onChange = () => {}, translate = text => text, timeout = 10 * 60 * 1000 } = {}) {
    Object.assign(this, { env, platform, detect, located: claude, refreshClaude, launch, onChange, t: translate, timeout });
    this.installing = null; this.message = ''; this.error = '';
  }
  getState() {
    // Existing isolated desktop checks should not depend on tools installed on the test host.
    const isolated = !!this.env.AGENTRIX_DATA_DIR && this.env.AGENTRIX_TEST_AGENTS !== '1';
    const located = isolated ? null : this.located();
    const claude = located ? claudeState(located) : { installed: isolated || this.detect('claude', this.env) };
    return { codex: { installed: isolated || this.detect('codex', this.env) }, claude, npm: this.detect('npm', this.env), installing: this.installing, message: this.message, error: this.error };
  }
  changed() { const state = this.getState(); this.onChange(state); return state; }
  install(agent) {
    if (typeof agent !== 'string' || !Object.hasOwn(AGENT_PACKAGES, agent)) throw new Error(this.t('无效的编码助手。'));
    if (this.installing) throw new Error(this.t('已有编码助手正在安装，请稍候。'));
    this.message = ''; this.error = '';
    if (!this.detect('npm', this.env)) { this.error = this.t('需要先安装 Node.js'); return Promise.resolve(this.changed()); }
    this.installing = agent; this.changed();
    return new Promise(resolve => {
      let child, timer, output = '', finished = false, timedOut = false;
      const finish = error => {
        if (finished) return;
        finished = true; clearTimeout(timer); this.installing = null;
        this.error = error ? `${error}${output ? '\n' + output : ''}` : '';
        this.message = error ? '' : this.t('安装完成，请重启项目的终端；新终端会识别新命令。');
        // A Claude Code just installed is searched for before the state is told, so it reads as installed.
        Promise.resolve(!error && agent === 'claude' ? this.refreshClaude() : null).catch(() => {}).then(() => resolve(this.changed()));
      };
      try {
        // Only the fixed map reaches cmd.exe; renderer input is never part of a shell command.
        child = this.platform === 'win32'
          ? this.launch('cmd.exe', ['/d', '/s', '/c', `npm install -g ${AGENT_PACKAGES[agent]}`], { env: this.env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
          : this.launch('npm', ['install', '-g', AGENT_PACKAGES[agent]], { env: this.env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
        const collect = data => { output = (output + data.toString()).slice(-2000); };
        child.stdout?.on('data', collect); child.stderr?.on('data', collect);
        child.once('error', error => finish(`${this.t('安装失败。')} ${error.message}`));
        child.once('close', code => finish(timedOut ? this.t('安装超时，请重试。') : code === 0 ? '' : this.t('安装失败。')));
        timer = setTimeout(() => {
          timedOut = true;
          const stop = () => { child.kill(); finish(this.t('安装超时，请重试。')); };
          // Killing only cmd.exe leaves npm running, so stop its process tree before releasing the lock.
          if (this.platform === 'win32' && child.pid) execFile('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }, stop);
          else stop();
        }, this.timeout);
      } catch (error) { finish(`${this.t('安装失败。')} ${error.message}`); }
    });
  }
}

module.exports = { AGENT_PACKAGES, AgentsManager, onPath };
