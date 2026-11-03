const { randomUUID } = require('node:crypto');
function createEventStream(spec, emit, now = Date.now) {
  let sequence = 0, providerSessionId = spec.providerSessionId || null, turnId = null, state = 'starting';
  const events = new Map(), epoch = randomUUID();
  const sizes = new Map(); let bytes = 0;
  function publish(type, payload, { itemId = null, replay = false, occurredAtMs = null } = {}) {
    const event = { schemaVersion: 1, eventId: randomUUID(), sequence: ++sequence, connectionEpoch: epoch,
      provider: spec.agent || 'claude', transport: spec.agent === 'codex' ? 'codex-app-server' : 'claude-sdk',
      projectId: spec.projectId, terminalId: spec.terminalId, runtimeSessionId: spec.runtimeSessionId,
      providerSessionId, runId: spec.runId || null, turnId, itemId, receivedAtMs: now(), occurredAtMs, replay, type, payload };
    if (type === 'session.state') state = payload.state;
    const key = type.startsWith('item.') ? `item:${itemId}` : type.startsWith('request.') ? `request:${payload.requestId}` : type === 'input.receipt' ? `input:${payload.clientMessageId}` : type;
    if (type === 'item.delta') {
      const previous = events.get(key);
      const content = { ...(previous?.payload.content || {}), text: ((previous?.payload.content?.text || '') + payload.text).slice(-262144) };
      events.set(key, { ...event, type: 'item.upsert', payload: { kind: previous?.payload.kind || (payload.channel === 'reasoning-summary' ? 'reasoning-summary' : 'agent-message'), status: 'in-progress', content } });
    } else events.set(key, event);
    bytes -= sizes.get(key) || 0;
    const size = Buffer.byteLength(JSON.stringify(events.get(key))); sizes.set(key, size); bytes += size;
    while (events.size > 1000 || bytes > 4 * 1024 * 1024) {
      const removable = [...events.keys()].find(key => key.startsWith('item:')) || [...events.keys()].find(key => events.get(key).type !== 'request.opened');
      if (!removable) break;
      bytes -= sizes.get(removable) || 0; sizes.delete(removable); events.delete(removable);
    }
    emit(event); return event;
  }
  return { publish, provider(id) { providerSessionId = id; }, turn(id) { turnId = id; },
    snapshot: () => ({ runtimeSessionId: spec.runtimeSessionId, lastSequence: sequence, state,
      events: [...events.values()].sort((a, b) => a.sequence - b.sequence).map(event => ({ ...event, replay: true })) }) };
}
module.exports = { createEventStream };
