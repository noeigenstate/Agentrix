const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

// Built-in commands as the installed CLIs answer them (checked live with scripts/slash-live.mjs against Claude Code
// 2.1.294, which no longer knows /agents, /todos, /vim or /pr-comments; /fast and /effort as 2.1.296 draws them).
const BUILTINS = {
  claude: {
    terminal: [
      ['help', '帮助与快捷键'], ['model', '切换模型'], ['fast', '切换快速模式'], ['effort', '推理强度'], ['resume', '恢复之前的对话'], ['status', '版本、账号与连接状态'],
      ['config', '设置'], ['permissions', '工具权限'], ['mcp', 'MCP 服务器'], ['hooks', 'Hook 设置'],
      ['memory', '编辑记忆文件'], ['context', '上下文占用'], ['cost', '用量与费用'], ['usage', '套餐用量'], ['doctor', '检查安装'],
      ['clear', '清空对话'], ['compact', '压缩对话'], ['rewind', '回退到之前的位置'], ['export', '导出对话'], ['add-dir', '添加工作目录'],
      ['login', '登录'], ['logout', '退出登录'], ['bashes', '后台命令'], ['plugin', '插件'],
      ['output-style', '输出风格'], ['statusline', '状态栏'], ['terminal-setup', '终端设置'], ['release-notes', '更新说明'], ['exit', '退出 Claude Code'],
    ],
    reading: [['init', '生成 CLAUDE.md'], ['review', '审查代码'], ['security-review', '安全审查'], ['btw', '顺带问一个问题']],
  },
  // Codex CLI 0.161.0: rust-v0.161.0's tui/src/slash_command.rs and bottom_pane/command_popup.rs.
  // Use canonical popup names; omit hidden/debug commands, Daybreak (under development), the recovery-only
  // Windows sandbox setup and exit/logout actions. Stable feature/account-gated commands are included;
  // /fast comes from the model's service tiers, and may be absent for models without that tier.
  codex: {
    terminal: [
      ['model', '切换模型与推理强度'], ['fast', '切换快速模式'], ['ide', '切换 IDE 上下文'], ['permissions', '工具权限'],
      ['keymap', '快捷键设置'], ['vim', '切换 Vim 模式'], ['experimental', '实验功能设置'], ['approve', '批准自动审查拒绝后的重试'],
      ['memories', '记忆设置'], ['skills', '选择技能'], ['import', '导入 Claude Code 配置与对话'], ['hooks', 'Hook 设置'],
      ['rename', '重命名对话'], ['new', '新对话'], ['archive', '归档对话'], ['delete', '永久删除对话'], ['resume', '恢复对话'],
      ['fork', '分支对话'], ['worktree', '工作树对话'], ['app', '在桌面应用中继续'], ['compact', '压缩对话'], ['recap', '生成对话摘要'],
      ['voice', '语音对话与设置'], ['agents', '代理指挥中心'], ['subagents', '切换子代理'],
      ['copy', '复制回复'], ['export', '导出对话'], ['raw', '切换原始终端输出'], ['tui', '下次启动的终端界面'],
      ['diff', '查看改动'], ['mention', '引用文件'], ['status', '会话状态与用量'], ['daemon', '管理后台服务'], ['warnings', '警告与诊断'],
      ['cd', '切换工作目录'], ['pwd', '查看工作目录'], ['usage', '账号用量与额度重置'], ['title', '终端标题设置'], ['statusline', '状态栏设置'],
      ['theme', '语法高亮主题'], ['pets', '选择或隐藏终端宠物'], ['mcp', 'MCP 工具与登录'], ['plugins', '浏览插件'],
      ['feedback', '反馈与日志'], ['ps', '后台终端'], ['stop', '停止后台终端'], ['clear', '清空终端并新建对话'],
    ],
    reading: [['init', '生成 AGENTS.md'], ['review', '审查改动'], ['plan', '规划任务'], ['goal', '设置长期任务目标'], ['side', '临时分支对话']],
  },
};
const byName = (a, b) => a.name.localeCompare(b.name);
const short = value => String(value || '').trim().slice(0, 80);

function metadata(text) {
  const match = /^\uFEFF?---\s*\r?\n([\s\S]*?)\r?\n---[^\S\r\n]*(?:\r?\n|$)/.exec(text);
  const fields = {}, body = match ? text.slice(match[0].length) : text;
  const lines = (match?.[1] || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const field = /^(name|description):\s*(.*)$/.exec(lines[i]);
    if (!field) continue;
    let value = field[2].trim();
    if (/^[>|][-+]?\s*(?:#.*)?$/.test(value)) {
      const block = [];
      while (i + 1 < lines.length && /^(\s+|$)/.test(lines[i + 1])) block.push(lines[++i].trim());
      value = block.join(' ');
    } else if (value.startsWith('"') && value.endsWith('"')) {
      try { value = JSON.parse(value); } catch { value = value.slice(1, -1); }
    } else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1).replace(/''/g, "'");
    else value = value.replace(/\s+#.*$/, '');
    fields[field[1]] = value;
  }
  return { ...fields, bodyDescription: body.split(/\r?\n/).find(line => line.trim())?.replace(/^\s*#+\s*/, '').trim() || '' };
}

// A scan root may itself be a link (dotfile managers link ~/.claude), so it is read normally;
// linked folders found while walking it are skipped, which keeps a link loop from recursing.
async function* commandFiles(directory, depth = Infinity) {
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return; }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink() && depth > 0) yield* commandFiles(file, depth - 1);
    else if (entry.isFile() && entry.name.endsWith('.md')) yield file;
  }
}

async function listAgentCommands({ agent, projectPath, home = os.homedir(), claudeHome = path.join(home, '.claude'), codexHome = path.join(home, '.codex') }) {
  const builtin = BUILTINS[agent] || BUILTINS.claude;
  const groups = { builtin: Object.entries(builtin).flatMap(([view, commands]) => commands.map(([name, description]) => ({ name: '/' + name, description, source: 'builtin', view }))), project: [], user: [], skill: [] };
  let reads = 0;
  async function scan(directory, source, kind, depth) {
    if (reads >= 300) return;
    for await (const file of commandFiles(directory, depth)) {
      if (reads >= 300) break;
      const relative = path.relative(directory, file), parts = relative.split(path.sep);
      if (kind === 'skill' && (parts.length !== 2 || parts[1] !== 'SKILL.md')) continue;
      try {
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.size > 64 * 1024) continue;
        reads++;
        const text = await fs.readFile(file, 'utf8');
        if (Buffer.byteLength(text, 'utf8') > 64 * 1024) continue;
        const info = metadata(text);
        const name = kind === 'skill' ? String(info.name || parts[0]).replace(/^\/+/, '') : relative.slice(0, -3).split(path.sep).join(':');
        groups[source].push({ name: '/' + (kind === 'prompt' ? 'prompts:' : '') + name, description: short(kind === 'skill' ? info.description : info.description ?? info.bodyDescription), source, view: 'reading' });
      } catch { }
    }
  }
  // SSH and missing projects must never expose this machine's user commands.
  if (projectPath) {
    if (agent === 'codex') await scan(path.join(codexHome, 'prompts'), 'user', 'prompt', 0);
    else {
      await scan(path.join(projectPath, '.claude', 'commands'), 'project', 'command', Infinity);
      await scan(path.join(claudeHome, 'commands'), 'user', 'command', Infinity);
      await scan(path.join(projectPath, '.claude', 'skills'), 'skill', 'skill', 1);
      await scan(path.join(claudeHome, 'skills'), 'skill', 'skill', 1);
    }
  }
  const seen = new Set();
  return Object.values(groups).flatMap(group => group.sort(byName)).filter(command => { if (seen.has(command.name)) return false; seen.add(command.name); return true; });
}

// A built-in command that only opens the CLI's own screen or prints a line (the terminal view above), with no model
// turn. Claude Code still runs its prompt hooks for some of these, and no Stop follows.
function isLocalAgentCommand(agent, text) {
  const name = /^\/([\w:-]+)(?:\s|$)/.exec(String(text || '').trim())?.[1];
  return !!name && (BUILTINS[agent]?.terminal || []).some(([command]) => command === name);
}

module.exports = { listAgentCommands, isLocalAgentCommand };
