function createNormalizer(emit, clean = value => value) {
  const completed = new Set();
  let messageId = null;
  const blocks = new Map();
  const preview = value => clean(typeof value === 'string' ? value : JSON.stringify(value) || '').slice(0, 65536);
  return message => {
    const publish = (type, payload, extra) => emit(type, payload, { ...extra, replay: message.isReplay === true });
    if (message.type === 'stream_event') {
      const event = message.event;
      if (event?.type === 'message_start') { messageId = event.message?.id || message.uuid; blocks.clear(); }
      if (event?.type === 'content_block_start') blocks.set(event.index, event.content_block);
      if (event?.type === 'content_block_delta' && messageId && !completed.has(messageId)) {
        const delta = event.delta;
        const text = delta?.text || delta?.thinking;
        if (typeof text === 'string') publish('item.delta', { channel: delta.type === 'thinking_delta' ? 'reasoning-summary' : 'text', text: preview(text), index: event.index }, { itemId: `${messageId}:${event.index}` });
      }
      return;
    }
    if (!['assistant', 'user'].includes(message.type)) return;
    const id = message.message?.id || message.uuid;
    if (!id || completed.has(id)) return;
    completed.add(id); if (completed.size > 2000) completed.delete(completed.values().next().value);
    const content = message.message?.content;
    if (typeof content === 'string') return publish('item.upsert', { kind: message.type === 'user' ? 'user-message' : 'agent-message', status: 'completed', content: { text: preview(content) } }, { itemId: id });
    for (const [index, block] of (Array.isArray(content) ? content : []).entries()) {
      const itemId = `${id}:${index}`;
      if (block.type === 'text' || block.type === 'thinking') publish('item.upsert', { kind: block.type === 'thinking' ? 'reasoning-summary' : message.type === 'user' ? 'user-message' : 'agent-message', status: 'completed', content: { text: preview(block.text || block.thinking || '') } }, { itemId });
      if (block.type === 'tool_use') publish('item.upsert', { kind: block.name === 'Bash' ? 'command' : /Edit|Write/.test(block.name) ? 'file-change' : 'tool', status: 'in-progress', content: { name: block.name, input: preview(block.input) } }, { itemId: block.id });
      if (block.type === 'tool_result') publish('item.upsert', { kind: 'tool', status: block.is_error ? 'failed' : 'completed', content: { output: preview(block.content) } }, { itemId: block.tool_use_id });
    }
  };
}
module.exports = { createNormalizer };
