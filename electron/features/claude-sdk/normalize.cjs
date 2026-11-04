const { commandPhrase } = require('../../command-phrase.cjs');
const { claudeText, clean: conversationClean } = require('../../conversation-record.cjs');
const LIMIT = 2000, PREVIEW = 65536;
function remember(map, key, value) {
  map.set(key, value);
  if (map.size > LIMIT) map.delete(map.keys().next().value);
}
const textOf = block => block.text ?? block.thinking ?? '';
function createNormalizer(emit, clean = value => value) {
  const records = new Map(), messages = new Map(), tools = new Map();
  let current;
  const preview = value => clean(String(value ?? '')).slice(0, PREVIEW);
  const output = value => preview(conversationClean(typeof value === 'string' ? value : Array.isArray(value)
    ? value.map(block => block.type === 'text' ? block.text : block.type === 'image' ? '[Image result]' : '').filter(Boolean).join('\n')
    : value == null ? '' : JSON.stringify(value)));
  function abandon(message, publish) {
    for (const [index, block] of message.slots) if (block.emitted && !block.matched) publish('item.upsert', {
      kind: block.type === 'thinking' ? 'reasoning-summary' : 'agent-message', status: 'interrupted', content: { text: '', discarded: true },
    }, { itemId: `${message.id}:${index}` });
  }
  return message => {
    // Task lifecycle records are counted by the session before normalization. Child content has its own feed.
    if (message.parent_tool_use_id || message.isSidechain) return;
    const timestamp = Date.parse(message.timestamp), occurredAtMs = Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : null;
    const publish = (type, payload, extra) => emit(type, payload, { occurredAtMs, ...extra, replay: message.isReplay === true });
    if (message.type === 'result') {
      for (const [itemId, payload] of tools) publish('item.upsert', { ...payload, status: 'interrupted' }, { itemId });
      tools.clear(); return;
    }
    if (message.type === 'stream_event') {
      const event = message.event;
      if (event?.type === 'message_start') {
        if (current && !current.ended) abandon(current, publish);
        const id = event.message?.id || message.uuid;
        current = { id, slots: new Map(), finals: new Map(), next: 0, ended: false }; remember(messages, id, current);
      }
      if (!current?.id) return;
      if (event?.type === 'message_stop') current.ended = true;
      if (event?.type === 'content_block_start') {
        current.slots.set(event.index, { ...event.content_block, text: textOf(event.content_block), matched: false, emitted: false });
        current.next = Math.max(current.next, event.index + 1);
      }
      if (event?.type === 'content_block_delta') {
        const delta = event.delta, text = delta?.text ?? delta?.thinking;
        let block = current.slots.get(event.index);
        if (!block) { block = { type: delta?.type === 'thinking_delta' ? 'thinking' : 'text', text: '' }; current.slots.set(event.index, block); current.next = Math.max(current.next, event.index + 1); }
        if (typeof text !== 'string' || block.matched) return;
        block.text = (block.text + text).slice(0, PREVIEW);
        if (!block.text.trim()) return;
        const visible = block.emitted ? text : block.text; block.emitted = true;
        publish('item.delta', { channel: block.type === 'thinking' ? 'reasoning-summary' : 'text', text: preview(visible), index: event.index }, { itemId: `${current.id}:${event.index}` });
      }
      return;
    }
    if (!['assistant', 'user'].includes(message.type) || message.isMeta || message.is_meta || message.isCompactSummary) return;
    const id = message.message?.id || message.uuid;
    if (!id) return;
    const signature = message.uuid || JSON.stringify([message.type, id, message.message?.content]);
    if (records.has(signature)) return;
    remember(records, signature, true);
    const content = message.message?.content;
    const blocks = Array.isArray(content) ? content : [{ type: 'text', text: content }];
    if (message.type === 'user') {
      for (const block of blocks.filter(block => block.type === 'tool_result')) {
        const previous = tools.get(block.tool_use_id);
        publish('item.upsert', { kind: previous?.kind || 'tool', status: block.is_error ? 'failed' : 'completed', content: { ...previous?.content, output: output(block.content) } }, { itemId: block.tool_use_id });
        tools.delete(block.tool_use_id);
      }
      const text = claudeText(message);
      if (text === null) return;
      const images = blocks.filter(block => block.type === 'image' && block.source?.type === 'base64' && /^image\/(?:png|jpeg|webp)$/.test(block.source.media_type)
        && typeof block.source.data === 'string' && block.source.data.length <= 4 * 1024 * 1024).slice(0, 4)
        .map(block => `data:${block.source.media_type};base64,${block.source.data}`);
      if (!text && !images.length) return;
      const clientMessageId = message.uuid || id;
      publish('item.upsert', { kind: 'user-message', status: 'completed', content: { text: preview(text), clientMessageId, ...(images.length ? { images } : {}) } }, { itemId: clientMessageId });
      return;
    }
    if (claudeText(message) === null) return;
    let state = messages.get(id);
    if (!state) { state = { id, slots: new Map(), finals: new Map(), next: 0 }; remember(messages, id, state); }
    for (const block of blocks) {
      const key = `${block.type}|${block.id || ''}|${preview(textOf(block))}`;
      const slot = [...state.slots].find(([, candidate]) => !candidate.matched && candidate.type === block.type &&
        (block.type === 'tool_use' ? candidate.id === block.id : preview(candidate.text) === preview(textOf(block))
          || candidate.text?.trim() && preview(textOf(block)).startsWith(preview(candidate.text)) || block.type === 'thinking' && !textOf(block)));
      if (!slot && state.finals.has(key)) continue;
      const index = slot ? slot[0] : state.next++;
      if (slot) slot[1].matched = true;
      if (slot || block.type === 'tool_use') state.finals.set(key, true);
      if (['text', 'thinking'].includes(block.type)) {
        const text = preview(textOf(block) || (block.type === 'thinking' ? slot?.[1].text : ''));
        if (text.trim()) publish('item.upsert', { kind: block.type === 'thinking' ? 'reasoning-summary' : 'agent-message', status: 'completed', content: { text } }, { itemId: `${id}:${index}` });
      } else if (block.type === 'tool_use') {
        const input = block.input || {}, command = typeof input.command === 'string' ? input.command : null, path = input.file_path || input.path;
        const isFile = ['Edit', 'Write', 'MultiEdit'].includes(block.name);
        const description = typeof input === 'string' ? input : JSON.stringify(input);
        const payload = { kind: block.name === 'Bash' ? 'command' : isFile ? 'file-change' : 'tool', status: 'in-progress', content: {
          name: block.name, input: preview(description), ...(command ? { command: preview(command), phrase: commandPhrase(command).phrase ?? null } : {}),
          ...(typeof path === 'string' ? { path: preview(path) } : {}),
          ...(isFile && typeof path === 'string' ? { changes: [{ path: preview(path), kind: block.name === 'Write' ? 'write' : 'edit', diff: preview(input.content ?? `${input.old_string || ''}\n->\n${input.new_string || ''}`) }] } : {}),
        } };
        remember(tools, block.id, payload); publish('item.upsert', payload, { itemId: block.id });
      }
    }
  };
}
module.exports = { createNormalizer };
