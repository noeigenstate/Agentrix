const { randomUUID } = require('node:crypto');
function channel() {
  const items = []; let wake, done = false;
  return { put(value) { items.push(value); wake?.(); }, end() { done = true; wake?.(); },
    async *[Symbol.asyncIterator]() { while (!done || items.length) { if (items.length) yield items.shift(); else await new Promise(resolve => { wake = resolve; }); } } };
}
function fakeSdk({ auto = true, source = 'ANTHROPIC_API_KEY', sessionId = randomUUID() } = {}) {
  const output = channel(), calls = [], inputs = [];
  let count = 0;
  const sdk = { query(spec) {
    calls.push(spec);
    void (async () => {
      for await (const input of spec.prompt) {
        inputs.push(input);
        if (inputs.length === 1) output.put({ type: 'system', subtype: 'init', session_id: sessionId, apiKeySource: source, model: 'fake-model' });
        if (auto) {
          output.put({ type: 'assistant', uuid: randomUUID(), user_message_uuid: input.uuid, message: { id: randomUUID(), content: [{ type: 'text', text: 'fake answer' }] } });
          output.put({ type: 'result', uuid: randomUUID(), user_message_uuid: input.uuid, user_message_uuids: [input.uuid], subtype: 'success', queued_turn_count: 0,
            total_cost_usd: ++count * 0.1, modelUsage: { fake: { inputTokens: count * 10, cacheReadInputTokens: 2, cacheCreationInputTokens: 3, outputTokens: count * 4, contextWindow: 100 } } });
        }
      }
    })().catch(() => {});
    return { [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](), close: () => output.end(), async interrupt() { output.put({ type: 'result', uuid: randomUUID(), is_error: true, subtype: 'error_during_execution', total_cost_usd: count * 0.1, modelUsage: {} }); } };
  } };
  return { sdk, calls, inputs, emit: output.put, end: output.end, sessionId };
}
module.exports = { fakeSdk, channel };
