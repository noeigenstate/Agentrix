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

class AgentsManager {
  constructor({ env = process.env, platform = process.platform, detect = onPath, launch = spawn, onChange = () => {}, translate = text => text, timeout = 10 * 60 * 1000 } = {}) {
    Object.assign(this, { env, platform, detect, launch, onChange, t: translate, timeout });
    this.installing = null; this.message = ''; this.error = '';
  }
  getState() {
    // Existing isolated desktop checks should not depend on tools installed on the test host.
    const isolated = !!this.env.AGENTRIX_DATA_DIR && this.env.AGENTRIX_TEST_AGENTS !== '1';
    return { codex: { installed: isolated || this.detect('codex', this.env) }, claude: { installed: isolated || this.detect('claude', this.env) }, npm: this.detect('npm', this.env), installing: this.installing, message: this.message, error: this.error };
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
        resolve(this.changed());
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
