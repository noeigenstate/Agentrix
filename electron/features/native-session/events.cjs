const { adapterOf, defaultNativeAgent } = require('../cli-adapters/registry.cjs');
const { createEventStream: createStream } = require('../../shared/native-events.cjs');

function createEventStream(spec, emit, now) {
  const agent = spec.agent || defaultNativeAgent;
  return createStream({ ...spec, agent, transport: adapterOf(agent)?.nativePolicy?.transport }, emit, now);
}
module.exports = { createEventStream };
