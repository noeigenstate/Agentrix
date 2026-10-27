const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { parse } = require('jsonc-parser');

function normalizeSSH(input) {
  if (!input || typeof input !== 'object') throw new Error('请填写 SSH 主机和远程目录。');
  const host = String(input.host || '').trim();
  if (!host || host.length > 255 || !/^[\p{L}\p{N}_.@:[\]-]+$/u.test(host) || host.startsWith('-') || host.split('@').at(-1).startsWith('-')) throw new Error('请填写 SSH 主机别名或 user@hostname，不要填写完整命令。');
  const remotePath = String(input.path || '').trim();
  if (!remotePath || remotePath.length > 4096 || /[\x00-\x1f\x7f\\]/.test(remotePath) || !(remotePath.startsWith('/') || remotePath === '~' || remotePath.startsWith('~/'))) throw new Error('远程目录请使用 Linux 路径，例如 /home/user/project 或 ~/project。');
  const configFile = input.configFile || null;
  if (configFile !== null && (typeof configFile !== 'string' || !path.isAbsolute(configFile) || /[\0\r\n]/.test(configFile))) throw new Error('无效的 SSH 配置文件。');
  return { host, path: path.posix.normalize(remotePath), configFile };
}

function expandHome(value, home = os.homedir()) {
  return value.replace(/^~(?=$|[\\/])/, home).replace(/\$\{env:USERPROFILE\}|%USERPROFILE%|%d/g, home);
}

function readSSHSettings({ home = os.homedir(), settingsFile, platform = process.platform } = {}) {
  const defaultSshPath = platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/OpenSSH/ssh.exe') : 'ssh';
  if (process.env.AGENTRIX_DATA_DIR && process.env.AGENTRIX_TEST_SSH_CONFIG && !settingsFile) return { configFile: process.env.AGENTRIX_TEST_SSH_CONFIG, sshPath: defaultSshPath, source: 'test' };
  const preferences = settingsFile || (platform === 'win32' ? path.join(process.env.APPDATA || path.join(home, 'AppData/Roaming'), 'Code/User/settings.json') : path.join(home, '.config/Code/User/settings.json'));
  let settings = {};
  try { settings = parse(fs.readFileSync(preferences, 'utf8')) || {}; } catch { }
  const configured = typeof settings['remote.SSH.configFile'] === 'string' ? settings['remote.SSH.configFile'] : '';
  const configFile = configured ? path.resolve(expandHome(configured, home)) : path.join(home, '.ssh/config');
  const sshPath = typeof settings['remote.SSH.path'] === 'string' && settings['remote.SSH.path'] ? expandHome(settings['remote.SSH.path'], home) : defaultSshPath;
  return { configFile, sshPath, source: configured ? 'vscode' : 'default' };
}

function configWords(line) {
  return [...line.matchAll(/"((?:\\.|[^"\\])*)"|'([^']*)'|([^\s#]+)/g)].map(match => match[1] ?? match[2] ?? match[3]);
}

function listSSHHosts(filename, home = os.homedir()) {
  const hosts = new Set();
  const visited = new Set();
  const sshDirectory = path.join(home, '.ssh');
  function visit(file, depth) {
    if (depth > 8 || visited.size >= 64) return;
    let real;
    try { real = fs.realpathSync(file); if (visited.has(real) || fs.statSync(real).size > 1024 * 1024) return; } catch { return; }
    visited.add(real);
    for (const line of fs.readFileSync(real, 'utf8').split(/\r?\n/)) {
      const match = /^\s*(Host|Include)\s*(?:=\s*|\s+)(.*?)\s*$/i.exec(line);
      if (!match) continue;
      const values = configWords(match[2]);
      if (match[1].toLowerCase() === 'host') {
        for (const host of values) if (!/[*!?]/.test(host)) {
          try { hosts.add(normalizeSSH({ host, path: '~' }).host); } catch { }
        }
        continue;
      }
      for (const value of values) {
        const expanded = expandHome(value, home);
        const pattern = path.isAbsolute(expanded) ? expanded : path.resolve(sshDirectory, expanded);
        try { for (const include of fs.globSync(pattern.replace(/\\/g, '/'))) visit(include, depth + 1); } catch { }
      }
    }
  }
  visit(filename, 0);
  return [...hosts].sort((a, b) => a.localeCompare(b));
}

function getSSHInfo(options) {
  const settings = readSSHSettings(options);
  return { ...settings, configExists: fs.existsSync(settings.configFile), hosts: listSSHHosts(settings.configFile, options?.home) };
}

function sshArguments(connection) {
  const args = ['-T', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-o', 'RemoteCommand=none'];
  if (connection.configFile) args.push('-F', connection.configFile);
  // The worker comes compressed on the first line (remote-connection.cjs): a quarter of the bytes to send.
  args.push('--', connection.host, 'exec python3 -u -c \'import base64,sys,zlib;exec(compile(zlib.decompress(base64.b64decode(sys.stdin.buffer.readline())),"<agentrix>","exec"))\'');
  return args;
}

module.exports = { normalizeSSH, readSSHSettings, listSSHHosts, getSSHInfo, sshArguments };
