const { claudeRecord, codexRecord } = require('../../agent-actions.cjs');

// Native transports expose the same tool reads as transcripts, but use SDK messages/app-server items.
// Feed them through the normal action log so successful results share the same usage evidence path.
function nativeSkillActions(log, message, cwd, at) {
  const timestamp = new Date(at).toISOString();
  if (['assistant', 'user'].includes(message.type)) return claudeRecord(log, { ...message, timestamp }, cwd);
  const item = message.params?.item;
  if (!item || item.type !== 'commandExecution' || !['item/started', 'item/completed'].includes(message.method)) return;
  const added = log.list.some(action => action.id === `${item.id}:0`) ? [] : codexRecord(log, { type: 'response_item', timestamp, payload: { type: 'function_call', call_id: item.id, name: 'exec_command',
    arguments: JSON.stringify({ cmd: item.command, workdir: item.cwd || cwd }) } }, cwd);
  if (message.method === 'item/completed') codexRecord(log, { type: 'response_item', timestamp,
    payload: { type: 'function_call_output', call_id: item.id, output: { exit_code: item.status === 'completed' && item.exitCode === 0 ? 0 : 1 } } }, cwd);
  return added;
}

module.exports = { nativeSkillActions };
