const { deniedAction } = require('../agents/start-failure.cjs');
const { READ_TOOLS, EDIT_TOOLS, workerPolicy } = require('../claude-runtime/decide.cjs');
const FINISH_ROLE_TOOL = 'mcp__agentrix_role__finish_role';
const DENIALS = {
  unsupported_tool: '此角色不允许使用该工具。',
  read_only: '此角色是只读的，不能使用编辑工具。',
  git_forbidden: '任务策略禁止此 Git 操作。',
  outside_worktree: '目标位于角色工作目录之外。',
  invalid_path: '任务策略无法验证目标路径。',
  invalid_command: '任务策略无法验证命令。',
  outside_scope: '目标文件不在任务授权的编辑范围内。',
};
const READ = new Set(READ_TOOLS);
const EDIT = new Set(EDIT_TOOLS);
const workerTools = readOnly => [...READ_TOOLS, 'Bash', ...(readOnly ? [] : EDIT_TOOLS)];
function toolIntent(toolName, input, cwd) {
  const operation = READ.has(toolName) ? 'read' : EDIT.has(toolName) ? 'edit' : ['Bash', 'PowerShell'].includes(toolName) ? 'command'
    : /^(?:WebFetch$|WebSearch$|mcp__)/i.test(toolName) ? 'network' : 'other';
  const paths = ['file_path', 'path', 'notebook_path'].filter(key => typeof input?.[key] === 'string').map(key => input[key]);
  if (toolName === 'Glob' && typeof input?.pattern === 'string' && /(?:^|[\\/])\.\.(?:[\\/]|$)|^(?:[A-Za-z]:|[\\/]|~)/.test(input.pattern)) paths.push(input.pattern);
  return { operation, toolName, cwd, paths, command: typeof input?.command === 'string' ? input.command : null, argv: null, requestsNetwork: operation === 'network' ? true : null };
}
function createPolicy(spec, audit = () => {}) {
  const cwd = spec.worktree || spec.cwd;
  const { refusal: check } = workerPolicy(spec.readOnly);
  return (name, input) => {
    if (spec.owner === 'dispatch' && spec.roleServer && name === FINISH_ROLE_TOOL) {
      const decision = { behavior: 'allow', reasonCode: 'allowed', reason: 'The role can submit its result.' };
      audit({ toolName: name, operation: 'report', ...decision });
      return decision;
    }
    const intent = toolIntent(name, input, cwd);
    if (spec.owner !== 'dispatch') return { behavior: 'defer', reasonCode: 'owner', reason: '由 Claude Code 权限规则决定。' };
    const refusal = check({ cwd, allow: spec.allow }, intent);
    const reasonCode = refusal === 'git_forbidden' ? refusal
      : intent.operation === 'network' || intent.operation === 'other' || name === 'PowerShell' ? 'unsupported_tool' : refusal || 'allowed';
    const decision = reasonCode === 'allowed' ? { behavior: 'allow', reasonCode, reason: '已按任务授权。' }
      : { behavior: 'deny', reasonCode, reason: DENIALS[reasonCode] + '请勿绕过此限制。',
        ...(intent.operation !== 'other' && { action: deniedAction({ ...intent, command: intent.operation === 'command' ? intent.command : null,
          paths: ['read', 'edit'].includes(intent.operation) ? intent.paths : [] }, spec.env) }) };
    audit({ toolName: name, operation: intent.operation, ...decision });
    return decision;
  };
}
module.exports = { createPolicy, toolIntent, workerTools, FINISH_ROLE_TOOL };
