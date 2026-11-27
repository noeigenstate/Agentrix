const { randomUUID } = require('node:crypto');
const { workerRefusal } = require('../cli-adapters/workers.cjs');
const { commandPhrase } = require('../../command-phrase.cjs');
const { ROLE_SERVER, ROLE_TOOL, errorWithCode } = require('./session.cjs');

const READ_TOOLS = new Set(['view_file', 'view_file_outline', 'view_code_item', 'list_dir', 'grep_search', 'find_by_name']);
const EDIT_TOOLS = new Set(['write_file', 'write_to_file', 'replace_file_content', 'multi_replace_file_content']);
const PATH_FIELDS = ['AbsolutePath', 'FilePath', 'TargetFile', 'SearchPath', 'SearchDirectory', 'DirectoryPath', 'WorkingDirectory', 'Cwd',
  'Path', 'path', 'paths', 'cwd', 'file_path'];
const kindOf = operation => ({ command: 'command', edit: 'file-change' })[operation] || 'tool';
const optionOf = (options, decision) => options.find(option => option?.kind === (decision === 'allow' ? 'allow_once' : 'reject_once'))?.optionId
  ?? options.find(option => option?.optionId === decision)?.optionId;

function toolIntent(toolCall) {
  const { name: tool, rawInput, args, locations } = toolCall;
  const input = rawInput ?? args ?? {};
  const listed = Array.isArray(locations) ? locations.map(location => location?.path) : [];
  const paths = [...new Set([...PATH_FIELDS.flatMap(key => [input[key]].flat()), ...listed]
    .filter(value => typeof value === 'string' && value))];
  if (tool === 'run_command') return { operation: 'command', command: input.CommandLine, paths, tool };
  if (EDIT_TOOLS.has(tool)) return { operation: 'edit', paths, tool };
  if (READ_TOOLS.has(tool)) return { operation: 'read', paths, tool };
  return { operation: 'tool', paths, tool };
}

function refusal(spec, intent) {
  if (intent.operation === 'tool') return 'unknown_tool';
  return workerRefusal(spec, intent);
}

function createRequests({ spec, rpc, events, providerSessionId, active, setState }) {
  const pending = new Map();
  const trustedRoleTool = spec.mcpServers?.filter(server => server.name === ROLE_SERVER).length === 1;
  const owner = spec.owner === 'gui';
  function respond(id, options, decision) {
    const optionId = decision && (owner ? optionOf(options, decision) : options.find(option => option?.optionId === decision)?.optionId);
    return rpc.respond(id, { outcome: typeof optionId === 'string' ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } });
  }

  function settle(requestId, decision, resolution, reason = null) {
    const task = pending.get(requestId);
    if (!task || task.settling) throw errorWithCode('request_expired');
    task.settling = true;
    try {
      if (!rpc.closed) respond(task.id, task.options, decision);
    } finally {
      pending.delete(requestId);
      const { operation, command, tool } = task.intent;
      const action = operation === 'command' && typeof command === 'string' ? commandPhrase(command).phrase
        : operation === 'tool' ? 'Unknown tool request' : tool;
      events.publish('request.resolved', { requestId, resolution, reason, ...(reason && { action }) }, { itemId: task.itemId });
      if (!pending.size && active()) setState('running');
    }
  }

  function open(message) {
    const { id, method, params } = message;
    if (method !== 'session/request_permission') return rpc.reject(id);
    if (params?.sessionId !== providerSessionId() || !active() || !params.toolCall || !Array.isArray(params.options) || pending.size >= 100)
      return rpc.respond(id, { outcome: { outcome: 'cancelled' } });
    const intent = toolIntent(params.toolCall), requestId = randomUUID(), itemId = params.toolCall.toolCallId || null;
    if (!owner && trustedRoleTool && intent.tool === ROLE_TOOL) return respond(id, params.options, 'allow');
    if (owner && spec.permissions !== 'ask') return respond(id, params.options, 'allow');
    const policyReason = owner ? null : refusal(spec, intent);
    const payload = { requestId, kind: kindOf(intent.operation), blocking: true, title: 'agy 工具审批',
      preview: String(intent.command || intent.paths.join('\n') || intent.tool || '').slice(0, 8000),
      actions: ['allow', 'deny'], providerData: { itemId } };
    const task = { id, itemId, options: params.options, payload, intent, authorized: owner || !policyReason && !spec.decidePermission };
    pending.set(requestId, task);
    setState('waiting');
    if (!pending.has(requestId)) return;
    events.publish('request.opened', payload, { itemId });
    if (owner || !policyReason && !spec.decidePermission) return;
    void Promise.resolve().then(() => policyReason ?? spec.decidePermission(intent)).catch(() => 'approval_check_failed').then(decision => {
      if (!pending.has(requestId)) return;
      const reason = decision === null ? null : typeof decision === 'string' && decision ? decision : 'approval_required';
      task.authorized = !reason;
      settle(requestId, task.authorized ? 'allow' : 'deny', task.authorized ? 'allowed' : 'denied', reason);
    }).catch(() => {});
  }

  return {
    open,
    answer(requestId, answer) {
      const task = pending.get(requestId);
      if (!task) throw errorWithCode('request_expired');
      if (answer?.decision === 'deny') return settle(requestId, 'deny', 'denied');
      if (answer?.decision === 'allow' && task.authorized) return settle(requestId, 'allow', 'allowed');
      throw errorWithCode('invalid_answer');
    },
    cancel: requestId => settle(requestId, 'deny', 'cancelled'),
    clear: () => { for (const [id, task] of pending) if (!task.settling) settle(id, null, 'cancelled'); },
    workerIntent: requestId => pending.get(requestId)?.intent,
    snapshot: () => [...pending.values()].map(task => task.payload),
  };
}

module.exports = { createRequests, toolIntent };
