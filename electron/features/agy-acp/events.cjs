const { createEventStream } = require('../../shared/native-events.cjs');
const { commandPhrase } = require('../../command-phrase.cjs');
const { TRANSPORT } = require('./session.cjs');
const { toolIntent } = require('./requests.cjs');

const bounded = text => text.slice(-262144);
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const STATUS = new Map([['pending', 'pending'], ['in_progress', 'in-progress'], ['completed', 'completed'], ['failed', 'failed']]);
const CHUNKS = { user_message_chunk: 'user-message', agent_message_chunk: 'agent-message', agent_thought_chunk: 'reasoning-summary' };
const toolOutput = update => typeof update.rawOutput === 'string' ? update.rawOutput
  : Array.isArray(update.content) ? update.content.flatMap(block => block?.content?.type === 'text' ? [block.content.text] : []).join('\n') : null;

function tokenCounts(usage) {
  if (!usage) return null;
  return { input: count(usage.inputTokens), cachedInput: count(usage.cachedReadTokens), cacheWrite: count(usage.cachedWriteTokens),
    output: count(usage.outputTokens), reasoning: count(usage.thoughtTokens) };
}

function createEvents(spec, emit, now) {
  const stream = createEventStream({ ...spec, transport: TRANSPORT }, emit, now);
  let contextTokens = null, contextWindow = null, total = null, round = null;
  function usage() {
    const counts = total ?? tokenCounts({});
    stream.publish('usage.updated', { ...counts, contextTokens, contextWindow, round, costUsdMicros: null, costEstimated: null });
  }
  return {
    ...stream,
    beginRound() { round = null; },
    context(update) {
      contextTokens = count(update.used);
      contextWindow = count(update.size);
      usage();
    },
    tokens(value) {
      round = tokenCounts(value);
      if (!round) return null;
      total = Object.fromEntries(Object.entries(round).map(([name, value]) => [name,
        value === null ? total?.[name] ?? null : (total?.[name] ?? 0) + value]));
      usage();
      return round;
    },
  };
}

function turnItems(events, turnId, replay = false) {
  const items = new Map();
  let textKey = null, textIndex = 0;
  function put(itemId, kind, status, content) {
    const item = { kind, status, content };
    items.set(itemId, item);
    events.publish('item.upsert', item, { itemId, replay });
  }
  function chunk(kind, text) {
    if (items.get(textKey)?.kind !== kind) {
      textKey = `${turnId}:text:${++textIndex}`;
      put(textKey, kind, 'in-progress', { text: '' });
    }
    const item = items.get(textKey);
    item.content = { text: bounded(item.content.text + text) };
    if (replay) return put(textKey, kind, 'completed', item.content);
    events.publish('item.delta', { channel: kind === 'reasoning-summary' ? 'reasoning-summary' : 'text', text: bounded(text) }, { itemId: textKey, replay });
  }
  function tool(update) {
    const id = update.toolCallId;
    if (typeof id !== 'string' || !id) return;
    const itemId = replay ? `${turnId}:${id.slice(0, 120)}` : id;
    textKey = null;
    const previous = items.get(itemId);
    const intent = toolIntent(update);
    const kind = ({ command: 'command', edit: 'file-change' })[intent.operation] || previous?.kind || 'tool';
    const output = toolOutput(update), command = typeof intent.command === 'string' ? bounded(intent.command) : null;
    const content = { ...previous?.content, ...(intent.tool && { tool: intent.tool }), ...(output !== null && { output: bounded(output) }) };
    if (kind === 'command' && command) Object.assign(content, { command, phrase: commandPhrase(command).phrase, cwd: intent.paths[0] ?? null, exitCode: null });
    if (kind === 'file-change' && intent.paths.length) content.changes = intent.paths.slice(0, 100).map(path => ({ path, kind: 'edit', diff: null }));
    put(itemId, kind, STATUS.get(update.status) || previous?.status || 'in-progress', content);
    if (items.size > 1000) items.delete(items.keys().next().value);
  }
  return {
    update(value) {
      const kind = CHUNKS[value.sessionUpdate];
      if (kind && (replay || kind !== 'user-message') && value.content?.type === 'text' && typeof value.content.text === 'string') chunk(kind, value.content.text);
      else if (['tool_call', 'tool_call_update'].includes(value.sessionUpdate)) tool(value);
    },
    finish(status) {
      for (const [itemId, { kind, status: itemStatus, content }] of items) {
        if (!['in-progress', 'pending'].includes(itemStatus)) continue;
        const text = Object.values(CHUNKS).includes(kind);
        put(itemId, kind, status === 'completed' ? text ? 'completed' : 'unknown' : status, content);
      }
    },
  };
}

module.exports = { createEvents, turnItems };
