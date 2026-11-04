// The CLI writes one record per content block, all under the same message id (thinking, then text, then each tool),
// so what has been shown is tracked per block: a whole message counted as done would lose everything after its first block.
const LIMIT = 2000;
function remember(collection, key, value) {
  if (collection instanceof Map) collection.set(key, value); else collection.add(key);
  if (collection.size > LIMIT) collection.delete(collection.keys().next().value);
}
const blockKey = (id, block) => `${block.type}|${block.id ?? block.tool_use_id ?? `${id}|${block.text ?? block.thinking ?? ''}`}`;

const { commandPhrase } = require('../../agent-actions.cjs');
function createNormalizer(emit, clean = value => value) {
  const completed = new Set();
  const positions = new Map();
  const tools = new Map();
  let messageId = null;
  const blocks = new Map();
  const preview = value => clean(typeof value === 'string' ? value : JSON.stringify(value) || '').slice(0, 65536);
  return message => {
    const publish = (type, payload, extra) => emit(type, payload, { ...extra, replay: message.isReplay === true });
    if (message.type === 'stream_event') {
      const event = message.event;
      if (event?.type === 'message_start') { messageId = event.message?.id || message.uuid; blocks.clear(); }
      if (event?.type === 'content_block_start') blocks.set(event.index, event.content_block);
      if (event?.type === 'content_block_delta' && messageId && !completed.has(`${messageId}:${event.index}`)) {
        const delta = event.delta;
        const text = delta?.text || delta?.thinking;
        if (typeof text === 'string') publish('item.delta', { channel: delta.type === 'thinking_delta' ? 'reasoning-summary' : 'text', text: preview(text), index: event.index }, { itemId: `${messageId}:${event.index}` });
      }
      return;
    }
    if (!['assistant', 'user'].includes(message.type)) return;
    const id = message.message?.id || message.uuid;
    if (!id) return;
    const content = message.message?.content;
    if (typeof content === 'string' && completed.has(id)) return;
    if (typeof content === 'string') remember(completed, id);
    if (typeof content === 'string') return publish('item.upsert', { kind: message.type === 'user' ? 'user-message' : 'agent-message', status: 'completed', content: { text: preview(content) } }, { itemId: id });
    for (const block of Array.isArray(content) ? content : []) {
      const key = blockKey(id, block);
      if (completed.has(key)) continue;
      remember(completed, key);
      // Its place in the message, which is the index its stream deltas carry, so the snapshot replaces them.
      const position = positions.get(id) ?? 0, itemId = `${id}:${position}`;
      remember(positions, id, position + 1); remember(completed, itemId);
      if (block.type === 'text' || block.type === 'thinking') publish('item.upsert', { kind: block.type === 'thinking' ? 'reasoning-summary' : message.type === 'user' ? 'user-message' : 'agent-message', status: 'completed', content: { text: preview(block.text || block.thinking || '') } }, { itemId });
      if (block.type === 'tool_use') {
        const payload = { kind: block.name === 'Bash' ? 'command' : /Edit|Write/.test(block.name) ? 'file-change' : 'tool', status: 'in-progress', content: { name: block.name, input: preview(block.input), ...(block.name === 'Bash' && typeof block.input?.command === 'string' ? { phrase: commandPhrase(block.input.command).phrase ?? null } : {}) } };
        tools.set(block.id, payload);
        if (tools.size > 1000) tools.delete(tools.keys().next().value);
        publish('item.upsert', payload, { itemId: block.id });
      }
      if (block.type === 'tool_result') {
        const previous = tools.get(block.tool_use_id);
        publish('item.upsert', { kind: previous?.kind || 'tool', status: block.is_error ? 'failed' : 'completed', content: { ...previous?.content, output: preview(block.content) } }, { itemId: block.tool_use_id });
        tools.delete(block.tool_use_id);
      }
    }
  };
}
module.exports = { createNormalizer };
