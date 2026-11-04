const { randomUUID } = require('node:crypto');
function channel() {
  const items = []; let wake, done = false, failure;
  return { put(value) { items.push(value); wake?.(); }, end() { done = true; wake?.(); },
    fail(error) { failure = error; done = true; wake?.(); },
    async *[Symbol.asyncIterator]() {
      while (!done || items.length) { if (items.length) yield items.shift(); else await new Promise(resolve => { wake = resolve; }); }
      if (failure) throw failure;
    } };
}
function fakeSdk({ auto = true, source = 'ANTHROPIC_API_KEY', preflightSource = 'ANTHROPIC_API_KEY', sessionId = randomUUID(), closeError = false,
  init = true, interruptResult = true, uniqueSessions = false } = {}) {
  let output = channel();
  const calls = [], inputs = [], closes = [], interrupts = [];
  let count = 0;
  const sdk = { query(spec) {
    const current = output = channel(); let initialized = false;
    const currentSessionId = spec.options.resume || (uniqueSessions ? randomUUID() : sessionId);
    calls.push(spec);
    void (async () => {
      for await (const input of spec.prompt) {
        inputs.push(input);
        if (!initialized && init) { initialized = true; current.put({ type: 'system', subtype: 'init', session_id: currentSessionId, apiKeySource: source, model: 'fake-model' }); }
        if (auto) {
          current.put({ type: 'assistant', uuid: randomUUID(), user_message_uuid: input.uuid, message: { id: randomUUID(), content: [{ type: 'text', text: 'fake answer' }] } });
          current.put({ type: 'result', uuid: randomUUID(), user_message_uuid: input.uuid, user_message_uuids: [input.uuid], subtype: 'success', queued_turn_count: 0,
            total_cost_usd: ++count * 0.1, modelUsage: { fake: { inputTokens: count * 10, cacheReadInputTokens: 2, cacheCreationInputTokens: 3, outputTokens: count * 4, contextWindow: 100 } } });
        }
      }
    })().catch(() => {});
    return { [Symbol.asyncIterator]: () => current[Symbol.asyncIterator](),
      async initializationResult() { return { account: { apiKeySource: preflightSource } }; },
      close() { closes.push(spec); closeError ? current.fail(Object.assign(new Error('fake abort'), { name: 'AbortError' })) : current.end(); },
      async interrupt() {
        interrupts.push(spec);
        if (interruptResult) current.put({ type: 'result', uuid: randomUUID(), is_error: true, subtype: 'error_during_execution',
          total_cost_usd: count * 0.1, modelUsage: {}, ...(typeof interruptResult === 'object' ? interruptResult : {}) });
      } };
  } };
  return { sdk, calls, inputs, closes, interrupts, emit: value => output.put(value), fail: error => output.fail(error), end: () => output.end(), sessionId };
}
module.exports = { fakeSdk, channel };
