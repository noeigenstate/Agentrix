const fs = require('node:fs');
const path = require('node:path');
const { matches } = require('../../boundaries.cjs');
const { commandPhrase } = require('../../agent-actions.cjs');
const { diagnosticLine } = require('../agents/start-failure.cjs');
const DENIALS = {
  unsupported_tool: '此角色不允许使用该工具。',
  read_only: '此角色是只读的，不能执行命令或编辑文件。',
  git_forbidden: '任务策略禁止此 Git 操作。',
  outside_worktree: '目标位于角色工作目录之外。',
  invalid_path: '任务策略无法验证目标路径。',
  outside_scope: '目标文件不在任务授权的编辑范围内。',
  skill_not_authorized: '修改该技能需要明确授权其文件路径。',
};
const READ = new Set(['Read', 'Glob', 'Grep', 'LS']);
const EDIT = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const workerTools = readOnly => [...READ, ...(readOnly ? [] : ['Bash', ...EDIT])];
function realTarget(file) {
  let parent = path.resolve(file), suffix = [];
  while (!fs.existsSync(parent)) {
    const next = path.dirname(parent); if (next === parent) throw new Error('Invalid path');
    suffix.unshift(path.basename(parent)); parent = next;
  }
  return path.join(fs.realpathSync.native(parent), ...suffix);
}
function toolIntent(toolName, input, cwd) {
  const operation = READ.has(toolName) ? 'read' : EDIT.has(toolName) ? 'edit' : ['Bash', 'PowerShell'].includes(toolName) ? 'command'
    : /^(?:WebFetch$|WebSearch$|mcp__)/i.test(toolName) ? 'network' : 'other';
  const paths = ['file_path', 'path', 'notebook_path'].filter(key => typeof input?.[key] === 'string').map(key => input[key]);
  if (toolName === 'Glob' && typeof input?.pattern === 'string' && /(?:^|[\\/])\.\.(?:[\\/]|$)|^(?:[A-Za-z]:|[\\/]|~)/.test(input.pattern)) paths.push(input.pattern);
  return { operation, toolName, cwd, paths, command: typeof input?.command === 'string' ? input.command : null, argv: null, requestsNetwork: operation === 'network' ? true : null };
}
function createPolicy(spec, audit = () => {}) {
  const root = realTarget(spec.worktree || spec.cwd);
  return (name, input) => {
    const intent = toolIntent(name, input, root);
    let reasonCode = 'allowed';
    if (spec.owner !== 'dispatch') return { behavior: 'defer', reasonCode: 'owner', reason: '由 Claude Code 权限规则决定。' };
    if (intent.operation === 'network' || intent.operation === 'other' || name === 'PowerShell') reasonCode = 'unsupported_tool';
    if (spec.readOnly && ['command', 'edit'].includes(intent.operation)) reasonCode = 'read_only';
    // This catches explicit forbidden Git operations; it is a policy check, not a shell sandbox.
    if (intent.command && /\bgit\b[^\n;&|]*(?:\bcommit\b|\bpush\b|\breset\b[^\n;&|]*--hard\b)/i.test(intent.command)) reasonCode = 'git_forbidden';
    for (const file of intent.paths) {
      if (file.startsWith('~') || /^[A-Za-z]:[^\\/]/.test(file)) { reasonCode = 'outside_worktree'; continue; }
      let relative;
      try { relative = path.relative(root, realTarget(path.resolve(root, file))); } catch { reasonCode = 'invalid_path'; continue; }
      if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) reasonCode = 'outside_worktree';
      if (intent.operation === 'edit') {
        const normalized = relative.replaceAll('\\', '/');
        if (!matches(spec.allow || [], normalized)) reasonCode = 'outside_scope';
        if (path.basename(file).toLowerCase() === 'skill.md' && !(spec.allow || []).includes(normalized)) reasonCode = 'skill_not_authorized';
      }
    }
    const decision = reasonCode === 'allowed' ? { behavior: 'allow', reasonCode, reason: '已按任务授权。' }
      : { behavior: 'deny', reasonCode, reason: DENIALS[reasonCode] + '请勿绕过此限制。',
        ...(intent.operation !== 'other' && { action: deniedAction(intent, spec.env) }) };
    audit({ toolName: name, operation: intent.operation, ...decision });
    return decision;
  };
}
function deniedAction(intent, env = process.env) {
  // Keep command arguments and tool inputs such as file contents out of the run record.
  const tool = /^[A-Za-z][\w-]{0,79}$/.test(intent.toolName) ? intent.toolName : 'Tool';
  if (intent.operation === 'command' && intent.command) return tool + ': ' + commandPhrase(intent.command).phrase;
  if (!['read', 'edit'].includes(intent.operation)) return tool;
  const mask = text => Object.entries(env).reduce((value, [name, secret]) =>
    /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?|AUTH)(?:_|$)/i.test(name) && typeof secret === 'string' && secret.length >= 8
      ? value.replaceAll(secret, '<secret>') : value, text);
  const target = diagnosticLine(intent.paths[0], { limit: 160 - tool.length - 2, mask });
  return target ? tool + ': ' + target : tool;
}

module.exports = { createPolicy, toolIntent, workerTools };
