const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { transcriptWindow, LIVE_READ_LIMIT } = require('./transcript-window.cjs');
const { CompletionHistory } = require('./completion-history.cjs');
const { ClaudeImageLine, readTranscriptChunk } = require('./oversized-record.cjs');
const { messageText, ownMessage, promptText } = require('./prompt-queue.cjs');

// What an agent is doing, step by step: each tool it calls becomes one action the window can show
// ("editing src/App.tsx", "running npm test", "skill code-review", "MCP github · create_issue").
// Both agents already write this down: Claude Code in its transcript, Codex in its rollout file.
// Reading those costs the agents nothing, unlike a hook that would run before every tool.
//
// An action is { id, at, kind, tool, target, detail, description, done, failed }; an edit also lists its
// files as { path, change } with change add | update | delete | write (written whole, new or replaced).
// kind: edit | command | read | search | web | skill | mcp | agent | other.
const clip = (value, limit) => { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); return text.length > limit ? `${text.slice(0, limit - 1)}…` : text; };

// A file named by the agent, relative to the project when it lies inside it.
function projectPath(file, cwd) {
  if (typeof file !== 'string' || !file) return '';
  if (cwd && path.isAbsolute(file)) {
    const relative = path.relative(cwd, file);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return relative.split(path.sep).join('/');
  }
  return file.split('\\').join('/');
}

// SSH folders belong to the remote system, even when the app is running on Windows.
const resolvePath = (cwd, file) => (cwd?.startsWith('/') || file.startsWith('/') ? path.posix : path).resolve(cwd || '.', file);

// These records are Claude's own bookkeeping, not a prompt that starts another round.
function claudeOwnRecord(record) {
  if (record?.isCompactSummary || record?.isVisibleInTranscriptOnly) return true;
  if (record?.type !== 'user') return false;
  return ownMessage(messageText(record.message?.content));
}

// A prompt sent to Claude, which starts a round; tool results come back as user records too.
function claudePrompt(record) {
  return record?.type === 'user' && promptText(record.message?.content, record) !== null;
}

// mcp__server__tool, the name both agents give a tool that an MCP server provides.
function mcpTool(name) {
  const match = /^mcp__(.+?)__(.+)$/.exec(name);
  return match ? { server: match[1], tool: match[2] } : null;
}

const CLAUDE_KINDS = { Edit: 'edit', Write: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit', Read: 'read', Bash: 'command', PowerShell: 'command', BashOutput: 'command', Grep: 'search', Glob: 'search', WebFetch: 'web', WebSearch: 'web', Skill: 'skill', Agent: 'agent', Task: 'agent' };
// One tool_use block of a Claude Code transcript.
function claudeAction(block, at, cwd) {
  const name = String(block.name || ''), input = block.input && typeof block.input === 'object' ? block.input : {};
  const action = { id: String(block.id || ''), at, kind: CLAUDE_KINDS[name] || 'other', tool: name, target: '', detail: '', description: '', done: false, failed: false };
  const mcp = mcpTool(name);
  if (mcp) { action.kind = 'mcp'; action.target = `${mcp.server} · ${mcp.tool}`; action.server = mcp.server; }
  else if (action.kind === 'edit' || action.kind === 'read') action.target = projectPath(input.file_path || input.notebook_path, cwd);
  else if (action.kind === 'command') { action.target = clip(input.command || input.bash_id, 240); action.detail = clip(input.description, 160); Object.assign(action, commandPhrase(input.command || '')); }
  else if (action.kind === 'search') { action.target = clip(input.pattern, 160); action.detail = projectPath(input.path, cwd); }
  else if (action.kind === 'web') action.target = clip(input.url || input.query, 240);
  else if (action.kind === 'skill') { action.target = clip(input.skill, 120); action.detail = clip(input.args, 160); }
  else if (action.kind === 'agent') { action.target = clip(input.description || input.subagent_type, 160); action.detail = clip(input.subagent_type, 80); }
  else action.target = name;
  if (action.kind === 'edit' && action.target) action.files = [{ path: action.target, change: name === 'Write' ? 'write' : 'update' }];
  return action;
}

// What a shell command does, in a few words: "运行测试", "查看改动". The first rule that matches wins, so
// specific ones come first; the window translates the phrase and shows the full command on hover.
const COMMAND_PHRASES = [
  [/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\b(?:vitest|jest|pytest|mocha)\b|\b(?:cargo|go|dotnet)\s+test\b|\bnode\s+--test\b|\bnpm\s+run\s+test:/i, '运行测试'],
  [/\b(?:npm|pnpm|yarn|bun)\s+run\s+(?:build|dist|pack)\b|\b(?:vite|webpack|cargo|dotnet|go)\s+build\b|\bmsbuild\b|\belectron-builder\b/i, '构建项目'],
  [/\b(?:eslint|prettier|ruff|flake8|stylelint)\b|\bcargo\s+clippy\b|\b(?:npm|pnpm|yarn)\s+run\s+(?:lint|format)\b/i, '检查代码格式'],
  [/\btsc\b|\b(?:npm|pnpm|yarn)\s+run\s+(?:typecheck|check)\b|\bmypy\b/i, '检查类型'],
  [/\b(?:npm|pnpm|yarn|bun)\s+(?:install|ci|add|i)\b|\bpip3?\s+install\b|\bcargo\s+add\b/i, '安装依赖'],
  [/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:start|dev|serve|preview)\b/i, '启动项目'],
  [/\bgit\s+status\b/i, '查看 Git 状态'],
  [/\bgit\s+(?:diff|show)\b/i, '查看改动'],
  [/\bgit\s+log\b/i, '查看提交历史'],
  [/\bgit\s+commit\b/i, '提交改动'],
  [/\bgit\s+(?:add|restore|reset|rm)\b/i, '整理暂存区'],
  [/\bgit\s+push\b/i, '推送到远程仓库'],
  [/\bgit\s+(?:pull|fetch|clone)\b/i, '拉取代码'],
  [/\bgit\s+(?:checkout|switch|branch|merge|rebase|stash|tag|cherry-pick)\b/i, '处理分支'],
  [/\bgit\s+grep\b/i, '搜索代码'],
  [/\bgit\b/i, '执行 Git 命令'],
  [/\bgh\s+\w/i, '操作 GitHub'],
  [/\b(?:rg|grep|findstr|Select-String|ag)\b/i, '搜索代码'],
  [/\b(?:cat|Get-Content|head|tail|nl)\b|\bsed\s+-n\b/i, '读取文件'],
  [/\b(?:ls|dir|Get-ChildItem|gci|tree|fd)\b|\bfind\s+[.\/~]/i, '查看目录'],
  [/\b(?:rm|del|Remove-Item|rmdir)\b/i, '删除文件'],
  [/\b(?:mkdir|New-Item)\b/i, '新建文件或目录'],
  [/\b(?:cp|mv|Copy-Item|Move-Item|Rename-Item)\b/i, '移动或复制文件'],
  [/\b(?:curl|wget|Invoke-WebRequest|iwr|Invoke-RestMethod)\b/i, '访问网络'],
  [/\b(?:Start-Sleep|sleep)\b/i, '等待'],
];
const SCRIPT = /\b(?:node|python3?|py|deno|bun|tsx|ts-node)\s+(?:-\S+\s+)*["']?([^\s"';&|]+)/i;
// { phrase, object }: the phrase is one of COMMAND_PHRASES (or 运行脚本 / 运行命令), the object a script or program name.
function commandPhrase(command) {
  const text = String(command || '');
  for (const [pattern, phrase] of COMMAND_PHRASES) if (pattern.test(text)) return { phrase, object: '' };
  const script = SCRIPT.exec(text);
  if (script) return { phrase: '运行脚本', object: script[1].split(/[\\/]/).pop() };
  const program = /^\s*(?:&\s*)?["']?([^\s"']+)/.exec(text);
  return { phrase: '运行命令', object: program ? program[1].split(/[\\/]/).pop() : '' };
}
const PHRASES = [...COMMAND_PHRASES.map(([, phrase]) => phrase), '运行脚本', '运行命令'];

const EDITING_COMMAND = /\b(apply_patch|writeFileSync|appendFileSync|Set-Content|Add-Content|Out-File|sed\s+-i|tee\s)/;
// Read literal arguments without executing the script. Interpolated templates cannot name a command reliably.
const LITERAL = `("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\x60(?:[^\x60\\\\]|\\\\.)*\x60)`;
function scriptString(input, key) {
  const match = new RegExp(`\\b${key}:\\s*${LITERAL}`).exec(input);
  return match ? literalValue(match[1]) : null;
}
// A call's first argument when it is a string: tools.apply_patch("*** Begin Patch\n*** Add File: …").
function scriptArgument(input) {
  const match = new RegExp(`^\\s*${LITERAL}`).exec(input);
  return match ? literalValue(match[1]) : null;
}
function literalValue(literal) {
  if (literal[0] === '`' && literal.includes('${')) return null;
  try {
    if (literal[0] === '"') return JSON.parse(literal);
    return literal.slice(1, -1).replace(/\\(?:\r?\n|u[\da-f]{4}|x[\da-f]{2}|.)/gi, escape => {
      const char = escape.slice(1);
      if (/^[ux][\da-f]+$/i.test(char)) return String.fromCharCode(parseInt(char.slice(1), 16));
      return ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0', '\n': '', '\r\n': '' })[char] ?? char;
    });
  } catch { return null; }
}
// A shell command Codex ran. Codex edits files through the shell too (apply_patch or a script that writes).
function codexCommand(id, at, command, cwd) {
  const action = { id, at, cwd, kind: 'command', tool: 'exec_command', target: clip(command, 240), detail: '', description: '', done: false, failed: false };
  const files = [...String(command).matchAll(/^\*\*\* (Update|Add|Delete) File: (.+)$/gm)].map(match => ({ path: projectPath(match[2].trim(), cwd), change: match[1].toLowerCase() }));
  const skill = /([^\s"'`]*[\\/]([^\\/\s"'`]+)[\\/]SKILL\.md)/.exec(String(command));
  if (files.length) { action.kind = 'edit'; action.files = files; action.target = files.slice(0, 3).map(file => file.path).join('、') + (files.length > 3 ? ` +${files.length - 3}` : ''); }
  else if (skill) { action.kind = 'skill'; action.target = skill[2]; action.skillFile = skill[1]; }
  else if (EDITING_COMMAND.test(String(command))) { action.kind = 'edit'; action.detail = action.target; action.target = ''; }
  else Object.assign(action, commandPhrase(command));
  return action;
}
// One response_item of a Codex rollout that calls a tool. Newer Codex wraps every call in a script
// for its "exec" tool (tools.exec_command({cmd: "…"})); older versions call shell and apply_patch directly.
function codexActions(payload, at, cwd) {
  const id = String(payload.call_id || payload.id || '');
  if (payload.type === 'custom_tool_call' && typeof payload.input === 'string') {
    const actions = [], input = payload.input;
    for (const match of input.matchAll(/tools\.([\w.]+)\(/g)) {
      const name = match[1], rest = input.slice(match.index + match[0].length).split(/tools\.[\w.]+\(/)[0];
      if (name === 'exec_command' || name === 'shell') {
        const text = scriptString(rest, 'cmd') || '', workdir = scriptString(rest, 'workdir');
        const directory = workdir === null ? cwd : resolvePath(cwd, workdir);
        actions.push(codexCommand(`${id}:${actions.length}`, at, text, directory));
      } else if (name === 'apply_patch') actions.push(codexCommand(`${id}:${actions.length}`, at, `apply_patch\n${scriptArgument(rest) ?? rest}`, cwd));
      else if (name === 'write_stdin') continue;
      else {
        const mcp = mcpTool(name) || (name.includes('.') ? { server: name.split('.')[0], tool: name.split('.').slice(1).join('.') } : null);
        actions.push({ id: `${id}:${actions.length}`, at, kind: mcp ? 'mcp' : 'other', tool: name, target: mcp ? `${mcp.server} · ${mcp.tool}` : name, detail: '', description: '', done: false, failed: false, ...(mcp ? { server: mcp.server } : {}) });
      }
    }
    if (!actions.length && payload.name === 'apply_patch') actions.push(codexCommand(`${id}:0`, at, `apply_patch\n${input}`, cwd));
    return actions;
  }
  if (payload.type === 'function_call' || payload.type === 'local_shell_call') {
    let args = {}; try { args = typeof payload.arguments === 'string' ? JSON.parse(payload.arguments) : payload.action || {}; } catch { }
    const name = String(payload.name || 'shell'), mcp = mcpTool(name);
    if (mcp) return [{ id: `${id}:0`, at, kind: 'mcp', tool: name, target: `${mcp.server} · ${mcp.tool}`, detail: '', description: '', done: false, failed: false, server: mcp.server }];
    const command = Array.isArray(args.command) ? args.command.join(' ') : args.command || args.cmd || args.input || '';
    if (['shell', 'exec_command', 'local_shell', 'apply_patch', 'container.exec'].includes(name)) return [codexCommand(`${id}:0`, at, name === 'apply_patch' ? `apply_patch\n${command}` : command, typeof args.workdir === 'string' ? resolvePath(cwd, args.workdir) : cwd)];
    return [{ id: `${id}:0`, at, kind: 'other', tool: name, target: name, detail: '', description: '', done: false, failed: false }];
  }
  return [];
}
// The call id a Codex output record answers, or null.
function codexFinished(payload) {
  return ['custom_tool_call_output', 'function_call_output', 'local_shell_call_output'].includes(payload.type) ? String(payload.call_id || '') : null;
}

// Outputs have used JSON metadata, plain shell status lines and text blocks. An absent exit code says nothing failed.
function codexFailed(payload) {
  const failed = (output, depth = 0) => {
    if (depth > 8 || output == null) return false;
    if (typeof output === 'string') {
      try { return failed(JSON.parse(output), depth + 1); } catch { }
      return [...output.matchAll(/^(?:Exit code:\s*|Process exited with code\s+)(-?\d+)\b/gm)].some(match => Number(match[1]) !== 0);
    }
    if (Array.isArray(output)) return output.some(item => failed(item, depth + 1));
    if (typeof output !== 'object') return false;
    const code = output.metadata?.exit_code ?? output.exit_code;
    if (typeof code === 'number' || typeof code === 'string' && /^-?\d+$/.test(code)) return Number(code) !== 0;
    return ['output', 'content', 'text'].some(key => failed(output[key], depth + 1));
  };
  return failed(payload);
}

// The steps of the current round, oldest first. changed is called with what to tell the window.
class ActionLog {
  constructor(changed = () => {}, limit = 200) { this.changed = changed; this.limit = limit; this.list = []; }
  // since: a prompt's time. Claude Code writes a session's first prompt after the steps it started, so the steps stamped
  // after the prompt stay.
  reset(since) {
    const kept = Number.isFinite(since) ? this.list.filter(action => action.at > since) : [];
    if (kept.length === this.list.length) return;
    this.list = kept; this.changed({ reset: true });
  }
  add(action) {
    if (!action.id || this.list.some(item => item.id === action.id)) return;
    this.list.push(action);
    if (this.list.length > this.limit) this.list.shift();
    this.changed({ action });
  }
  // prefix: a Codex call id covers every step its script made.
  finish(id, failed = false, prefix = false) {
    for (const action of this.list) {
      if (action.done || !(prefix ? action.id.startsWith(`${id}:`) : action.id === id)) continue;
      action.done = true; action.failed = failed; this.changed({ action });
    }
  }
  // A round that ended leaves nothing running, whatever the transcript recorded last.
  settle() { for (const action of this.list) if (!action.done) { action.done = true; this.changed({ action }); } }
  update(action) { this.changed({ action }); }
  // What the card names: the step in progress, else the latest one.
  current() { return this.list.findLast(action => !action.done) || this.list.at(-1) || null; }
}

// Follows a growing JSON-lines file from where the last read stopped, a bounded amount per call.
class TranscriptTail {
  constructor(filename, { onHistory = () => {}, onWorkRecord = null } = {}) {
    this.filename = filename; this.offset = 0; this.buffer = Buffer.alloc(0); this.skipping = false; this.oversized = null;
    this.onHistory = onHistory; this.historyPending = true; onHistory(false);
    this.onWorkRecord = onWorkRecord;
  }
  async read(onRecord) {
    let file; try { file = await fs.open(this.filename, 'r'); } catch { return; }
    try {
      // NTFS file IDs can exceed Number's exact range; keep their identity as bigint.
      const stat = await file.stat({ bigint: true }), size = Number(stat.size);
      const identity = `${stat.dev}:${stat.ino}`;
      if (this.fileIdentity !== identity || size < this.fileSize) {
        const rebinding = this.fileIdentity != null;
        Object.assign(this, transcriptWindow(size)); this.buffer = Buffer.alloc(0); this.oversized = null;
        this.workHistory = this.onWorkRecord ? new CompletionHistory(this.offset) : null;
        this.historyPending = true;
        if (rebinding) this.onHistory(false);
      }
      this.fileIdentity = identity; this.fileSize = size;
      if (this.workHistory && !await this.workHistory.read(file, this.onWorkRecord)) return;
      const end = this.historyPending ? size : Math.min(size, this.offset + LIVE_READ_LIMIT);
      while (this.offset < end) {
        const chunk = Buffer.alloc(Math.min(65536, end - this.offset));
        const { bytesRead } = await file.read(chunk, 0, chunk.length, this.offset);
        if (!bytesRead) break;
        this.offset += bytesRead;
        readTranscriptChunk(this, chunk.subarray(0, bytesRead), onRecord, ClaudeImageLine);
      }
      if (this.historyPending && this.offset >= size) { this.historyPending = false; this.onHistory(true); }
    } finally { await file.close(); }
  }
}

// One record of a Claude Code transcript, applied to the log: a prompt starts a new round, a tool_use
// block is a step, its tool_result ends it. Child agents (sidechains) are part of their parent's step.
function claudeRecord(log, record, cwd) {
  if (!record || record.isSidechain || !record.message || claudeOwnRecord(record)) return;
  const content = record.message.content, at = Date.parse(record.timestamp) || Date.now();
  if (claudePrompt(record)) { log.reset(Date.parse(record.timestamp)); return; }
  if (!Array.isArray(content)) return;
  const added = [];
  for (const block of content) {
    if (record.type === 'assistant' && block.type === 'tool_use') { const action = claudeAction(block, at, cwd || record.cwd); log.add(action); added.push(action); }
    else if (record.type === 'user' && block.type === 'tool_result') log.finish(String(block.tool_use_id || ''), block.is_error === true);
  }
  return added;
}
// One record of a Codex rollout, applied to the log.
function codexRecord(log, record, cwd) {
  if (!record?.payload) return;
  const at = Date.parse(record.timestamp) || Date.now();
  // A different conversation (the reader moved to another rollout file) or a new round starts over.
  if (record.type === 'session_meta' || record.type === 'event_msg' && ['task_started', 'turn_started'].includes(record.payload.type)) { log.reset(); return; }
  if (record.type === 'event_msg' && ['task_complete', 'turn_completed', 'turn_aborted', 'turn_interrupted'].includes(record.payload.type)) { log.settle(); return; }
  if (record.type !== 'response_item') return;
  const finished = codexFinished(record.payload);
  if (finished) { log.finish(finished, codexFailed(record.payload), true); return; }
  const added = codexActions(record.payload, at, cwd);
  for (const action of added) log.add(action);
  return added;
}

// What a skill is for: the description at the top of its SKILL.md. Skills live in the project, in the
// user's Claude and Codex folders, and inside installed plugins; the folders are indexed once in a while.
const SKILL_ROOTS = () => [path.join(os.homedir(), '.claude', 'skills'), path.join(os.homedir(), '.claude', 'plugins'), path.join(os.homedir(), '.codex', 'skills')];
const skillIndexes = new Map();
async function skillIndex(root) {
  const known = skillIndexes.get(root);
  if (known && Date.now() - known.at < 5 * 60000) return known.files;
  const files = new Map();
  const visit = async (folder, depth) => {
    let entries; try { entries = await fs.readdir(folder, { withFileTypes: true }); } catch { return; }
    if (entries.some(entry => entry.isFile() && entry.name === 'SKILL.md') && !files.has(path.basename(folder))) files.set(path.basename(folder), path.join(folder, 'SKILL.md'));
    if (depth < 8) await Promise.all(entries.filter(entry => entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git').map(entry => visit(path.join(folder, entry.name), depth + 1)));
  };
  await visit(root, 0);
  skillIndexes.set(root, { at: Date.now(), files });
  return files;
}
async function readSkillDescription(file) {
  let handle; try { handle = await fs.open(file, 'r'); } catch { return ''; }
  try {
    const buffer = Buffer.alloc(8192), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(buffer.toString('utf8', 0, bytesRead));
    const line = front && /^description:\s*(.*(?:\r?\n[ \t]+.*)*)$/m.exec(front[1]);
    return line ? clip(line[1].replace(/^[>|][+-]?\s*/, '').replace(/^["']|["']$/g, ''), 400) : '';
  } finally { await handle.close(); }
}
// name: "skill" or "plugin:skill". file: a SKILL.md the agent itself read (Codex), relative to cwd.
async function skillDescription(name, cwd, file) {
  if (file) { const direct = await readSkillDescription(path.resolve(cwd || '.', file)); if (direct) return direct; }
  const skill = String(name || '').split(':').at(-1);
  if (!/^[\w.-]{1,120}$/.test(skill)) return '';
  for (const root of [...(cwd ? [path.join(cwd, '.claude', 'skills'), path.join(cwd, '.codex', 'skills')] : []), ...SKILL_ROOTS()]) {
    const found = (await skillIndex(root)).get(skill);
    if (found) { const description = await readSkillDescription(found); if (description) return description; }
  }
  return '';
}

module.exports = { ActionLog, TranscriptTail, claudeAction, claudeRecord, claudeOwnRecord, claudePrompt, codexActions, codexRecord, codexFailed, commandPhrase, PHRASES, skillDescription, projectPath, resolvePath };
