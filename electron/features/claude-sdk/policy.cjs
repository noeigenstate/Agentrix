const fs = require('node:fs');
const path = require('node:path');
const { matches } = require('../../boundaries.cjs');
const READ = new Set(['Read', 'Glob', 'Grep', 'LS']);
const EDIT = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
function realTarget(file) {
  let parent = path.resolve(file), suffix = [];
  while (!fs.existsSync(parent)) {
    const next = path.dirname(parent); if (next === parent) throw new Error('Invalid path');
    suffix.unshift(path.basename(parent)); parent = next;
  }
  return path.join(fs.realpathSync.native(parent), ...suffix);
}
function toolIntent(toolName, input, cwd) {
  const operation = READ.has(toolName) ? 'read' : EDIT.has(toolName) ? 'edit' : toolName === 'Bash' ? 'command' : /Web|Fetch|Search|mcp__/i.test(toolName) ? 'network' : 'other';
  const paths = ['file_path', 'path', 'notebook_path'].filter(key => typeof input?.[key] === 'string').map(key => input[key]);
  if (toolName === 'Glob' && typeof input?.pattern === 'string' && /(?:^|[\\/])\.\.(?:[\\/]|$)|^(?:[A-Za-z]:|[\\/]|~)/.test(input.pattern)) paths.push(input.pattern);
  return { operation, toolName, cwd, paths, command: typeof input?.command === 'string' ? input.command : null, argv: null, requestsNetwork: operation === 'network' ? true : null };
}
function createPolicy(spec, audit = () => {}) {
  const root = realTarget(spec.worktree || spec.cwd);
  return (name, input) => {
    const intent = toolIntent(name, input, root);
    let reasonCode = 'allowed';
    if (spec.owner !== 'dispatch') return { behavior: 'ask', reasonCode: 'owner', reason: '需要确认。' };
    if (intent.operation === 'network' || intent.operation === 'other') reasonCode = 'unsupported_tool';
    if ((spec.readOnly || spec.roundtable) && ['command', 'edit'].includes(intent.operation)) reasonCode = 'read_only';
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
    const decision = { behavior: reasonCode === 'allowed' ? 'allow' : 'deny', reasonCode, reason: reasonCode === 'allowed' ? '已按任务授权。' : '任务策略拒绝此操作。' };
    audit({ toolName: name, operation: intent.operation, ...decision });
    return decision;
  };
}
module.exports = { createPolicy, toolIntent };
