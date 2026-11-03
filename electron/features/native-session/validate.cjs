const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const id = value => typeof value === 'string' && /^[\w:.-]{1,160}$/.test(value);
const text = (value, limit = 262144) => typeof value === 'string' && value.length > 0 && value.length <= limit && !value.includes('\0');
const count = value => Number.isSafeInteger(value) && value >= 0;
const nullableCount = value => value === null || count(value);
const eventTypes = new Set(['session.state', 'turn.started', 'turn.completed', 'item.upsert', 'item.delta', 'turn.diff', 'plan.updated', 'request.opened', 'request.resolved', 'input.receipt', 'usage.updated', 'limits.updated', 'routing.updated', 'path.changed', 'error']);
function validEvent(event) {
  if (!object(event) || event.schemaVersion !== 1 || !eventTypes.has(event.type) || !object(event.payload) ||
    !['eventId', 'connectionEpoch', 'projectId', 'terminalId', 'runtimeSessionId'].every(key => id(event[key])) ||
    !['providerSessionId', 'runId', 'turnId', 'itemId'].every(key => event[key] === null || id(event[key])) ||
    !count(event.sequence) || !count(event.receivedAtMs) || !nullableCount(event.occurredAtMs) || typeof event.replay !== 'boolean' ||
    !['claude', 'codex'].includes(event.provider) || event.transport !== (event.provider === 'claude' ? 'claude-sdk' : 'codex-app-server')) return false;
  const value = event.payload;
  if (event.type === 'usage.updated') return ['input', 'cachedInput', 'cacheWrite', 'output', 'reasoning', 'contextWindow', 'costUsdMicros'].every(key => nullableCount(value[key])) && (value.costEstimated === null || typeof value.costEstimated === 'boolean');
  if (event.type === 'session.state') return ['starting', 'idle', 'running', 'waiting', 'stopping', 'stopped', 'disconnected', 'failed'].includes(value.state);
  if (event.type === 'turn.started') return ['user', 'automatic', 'resume'].includes(value.origin) && (value.clientMessageId === null || id(value.clientMessageId));
  if (event.type === 'turn.completed') return ['completed', 'failed', 'interrupted'].includes(value.status);
  if (event.type === 'input.receipt') return id(value.clientMessageId) && ['queued', 'delivered', 'consumed', 'rejected', 'unknown'].includes(value.status);
  if (event.type === 'item.delta') return ['text', 'output', 'reasoning-summary', 'plan'].includes(value.channel) && typeof value.text === 'string' && value.text.length <= 262144;
  if (event.type === 'request.opened' || event.type === 'request.resolved') return id(value.requestId);
  return true;
}
function assert(value) { if (!value) throw new Error('无效的原生会话请求。'); }
function validImages(images) { return images === undefined || Array.isArray(images) && images.length <= 8 && images.every(value => typeof value === 'string' && value.length <= 10 * 1024 * 1024 && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value)); }
module.exports = { exact, id, text, assert, validImages, validEvent };
