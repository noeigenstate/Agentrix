const { messageText } = require('../../prompt-queue.cjs');
const { finished } = require('../completion/status.cjs');

const TURNS = new Map([
  ['task_started', { state: 'working' }], ['turn_started', { state: 'working' }],
  ['task_complete', { state: 'complete', done: true }], ['turn_completed', { state: 'complete', done: true }],
  ['turn_aborted', { state: 'interrupted', done: true }], ['turn_interrupted', { state: 'interrupted', done: true }],
]);
const turnOf = type => TURNS.get(type);
const json = value => { try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return null; } };

function completion(work, record, at) {
  const item = record.payload || {};
  if (record.type === 'event_msg') {
    if (turnOf(item.type)?.done) work.end(at);
    return;
  }
  if (record.type !== 'response_item') return;
  if (item.type === 'agent_message') {
    const text = messageText(item.content);
    if (/^Message Type: FINAL_ANSWER\s*$/m.test(text)) {
      work.finish(item.author || /^Sender:\s*(\S+)/m.exec(text)?.[1]);
      work.reviewAt = Math.max(work.reviewAt, at);
    }
    return;
  }
  if (['function_call', 'custom_tool_call'].includes(item.type)) {
    const args = json(item.arguments) || {}, name = (item.name || '').split('.').at(-1);
    // Shells and yielded code cells cannot wake an ended Codex parent; only child agents count.
    if (!['spawn_agent', 'followup_task', 'send_input', 'close_agent', 'interrupt_agent', 'list_agents', 'wait'].includes(name)) return;
    work.calls.set(item.call_id, { name, args, at });
    if (name === 'spawn_agent') work.start(item.call_id, at);
    if (name === 'followup_task' || name === 'send_input') {
      const id = args.target || args.id;
      work.start(work.find(id) || id, at, id);
    }
    return;
  }
  if (!['function_call_output', 'custom_tool_call_output'].includes(item.type)) return;
  const call = work.calls.get(item.call_id);
  if (!call) return;
  work.calls.delete(item.call_id);
  const text = typeof item.output === 'string' ? item.output : messageText(item.output);
  const output = json(text) || json(item.output);
  if (call.name === 'spawn_agent') {
    work.finish(item.call_id);
    const id = output?.agent_id || output?.task_name;
    if (id) work.start(id, call.at);
  }
  if (call.name === 'close_agent') work.finish(call.args.id);
  if (call.name === 'interrupt_agent') work.finish(call.args.target);
  if (call.name === 'list_agents') for (const entry of output?.agents || []) {
    if (finished(entry.agent_status)) work.finish(entry.agent_name);
  }
  if (call.name === 'wait' && output?.status) for (const [id, status] of Object.entries(output.status)) {
    if (finished(status)) work.finish(id);
  }
}

function nativeCompletion(work, message, at, parentThreadId) {
  const pending = work.tasks.size, reviewAt = work.reviewAt;
  const threadId = message.params?.threadId;
  if (parentThreadId && threadId && threadId !== parentThreadId) {
    if (message.method === 'turn/started') work.start(threadId, at);
    if (['turn/completed', 'turn/interrupted'].includes(message.method)) {
      if (work.finish(threadId)) work.reviewAt = Math.max(work.reviewAt, at);
    }
    if (pending !== work.tasks.size || reviewAt !== work.reviewAt) work.changed();
    return;
  }
  const item = message.params?.item;
  // Native commands, like legacy shells, cannot resume the parent after its turn ends.
  if (item?.type === 'collabAgentToolCall' && ['item/started', 'item/completed'].includes(message.method)) {
    const ended = message.method === 'item/completed';
    const key = `native:${item.id}`, startsWork = ['spawnAgent', 'sendInput', 'resumeAgent'].includes(item.tool);
    if (!ended && startsWork) work.start(key, at);
    if (ended) work.finish(key);
    for (const id of item.receiverThreadIds || []) {
      const status = item.agentsStates?.[id]?.status;
      if (item.tool === 'closeAgent' || finished(status)) {
        if (work.finish(id)) work.reviewAt = Math.max(work.reviewAt, at);
      } else if (startsWork) work.start(id, at);
    }
  }
  if (['turn/completed', 'turn/interrupted'].includes(message.method)) work.end(at);
  work.version++;
  if (pending !== work.tasks.size || reviewAt !== work.reviewAt) work.changed();
}

module.exports = { completion, nativeCompletion, turnOf };
