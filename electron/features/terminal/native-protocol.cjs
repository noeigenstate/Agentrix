const { TextDecoder } = require('node:util');
const { MAX_BYTES, object, validId, fingerprint } = require('./native-approvals.cjs');
const { codexQuestion, claudeQuestion } = require('./native-questions.cjs');
const validRpc = m => object(m) && (m.jsonrpc === undefined || m.jsonrpc === '2.0') && (Object.hasOwn(m, 'method')
  ? typeof m.method === 'string' && m.method.length > 0 && m.method.length <= 256 && (!Object.hasOwn(m, 'id') || validId(m.id))
  : validId(m.id) && Object.hasOwn(m, 'result') !== Object.hasOwn(m, 'error'));
const keysOnly = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
function permissionProfile(value) {
  if (!keysOnly(value, ['network', 'fileSystem'])) return false;
  if (value.network != null && (!keysOnly(value.network, ['enabled']) || value.network.enabled != null && typeof value.network.enabled !== 'boolean')) return false;
  const files = value.fileSystem;
  if (files == null) return true;
  if (!keysOnly(files, ['read', 'write', 'entries', 'globScanMaxDepth'])) return false;
  if (['read', 'write'].some(key => files[key] != null && (!Array.isArray(files[key]) || !files[key].every(path => typeof path === 'string')))) return false;
  if (files.globScanMaxDepth != null && (!Number.isSafeInteger(files.globScanMaxDepth) || files.globScanMaxDepth < 1)) return false;
  if (files.entries == null) return true;
  return Array.isArray(files.entries) && files.entries.every(entry => {
    if (!keysOnly(entry, ['access', 'path']) || !['read', 'write', 'deny'].includes(entry.access)) return false;
    const path = entry.path;
    if (path?.type === 'path') return keysOnly(path, ['type', 'path']) && typeof path.path === 'string';
    if (path?.type === 'glob_pattern') return keysOnly(path, ['type', 'pattern']) && typeof path.pattern === 'string';
    if (path?.type !== 'special' || !keysOnly(path, ['type', 'value'])) return false;
    const special = path.value;
    return keysOnly(special, ['kind', 'path', 'subpath']) && ['root', 'minimal', 'project_roots', 'tmpdir', 'slash_tmp', 'unknown'].includes(special.kind)
      && (special.kind !== 'unknown' || typeof special.path === 'string') && (special.subpath == null || typeof special.subpath === 'string');
  });
}

// CLI stdout is newline-delimited JSON, never a terminal/text parser. Fatal UTF-8 and bounded partial records.
class JsonLines {
  constructor(message, fail, limit = MAX_BYTES) { Object.assign(this, { message, fail, limit }); this.decoder = new TextDecoder('utf-8', { fatal: true }); this.buffer = ''; this.closed = false; }
  push(bytes) {
    if (this.closed) return;
    try {
      const text = this.decoder.decode(bytes, { stream: true });
      for (const piece of text.split(/(?<=\n)/)) {
        this.buffer += piece;
        if (Buffer.byteLength(this.buffer) > this.limit) throw new Error('oversized-json');
        if (!this.buffer.endsWith('\n')) continue;
        const line = this.buffer.trim(); this.buffer = '';
        if (!line) continue;
        const value = JSON.parse(line);
        if (!object(value)) throw new Error('invalid-json-envelope');
        this.message(value);
        if (this.closed) return;
      }
    } catch { this.closed = true; this.fail('malformed-native-stream'); }
  }
  end() {
    if (this.closed) return;
    try { this.buffer += this.decoder.decode(); if (this.buffer.trim()) throw new Error(); }
    catch { this.fail('truncated-native-stream'); }
    this.closed = true;
  }
}

class CodexProtocol {
  constructor(registry) { this.registry = registry; this.issued = new Map(); }
  server(m) {
    const r = this.registry, p = m.params;
    if (!validRpc(m)) { r.fault('invalid-server-envelope'); return false; }
    if (m.method && Object.hasOwn(m, 'id')) {
      if (!validId(m.id)) { r.fault('invalid-server-id'); return false; }
      const key = `${typeof m.id}:${m.id}`, previous = this.issued.get(key), signature = fingerprint(m);
      if (previous) {
        if (previous.pending && previous.signature === signature && this.registry.records.get(key)?.pending !== false) return false;
        r.fault('native-id-reuse'); return false;
      }
      if (this.issued.size >= r.maxSeen) { r.fault('request-limit'); return false; }
      this.issued.set(key, { signature, pending: true });
    }
    if (m.method === 'serverRequest/resolved') {
      if (!object(p) || !validId(p.requestId) || typeof p.threadId !== 'string') r.fault('invalid-resolution');
      else { r.resolve(p.requestId, p.threadId); const issued = this.issued.get(`${typeof p.requestId}:${p.requestId}`); if (issued) issued.pending = false; }
    }
    if (['turn/completed', 'turn/interrupted'].includes(m.method)) {
      if (!object(p) || typeof p.threadId !== 'string' || typeof (p.turn?.id ?? p.turnId) !== 'string') r.fault('invalid-turn-end');
      else r.endTurn(p.threadId, p.turn?.id ?? p.turnId);
    }
    if (m.method === 'turn/started' && typeof p?.threadId === 'string') {
      for (const entry of r.tokens.values()) if (entry.params.threadId === p.threadId && entry.params.turnId !== p.turn?.id) r.consume(entry);
    }
    if (['item/tool/requestUserInput', 'mcpServer/elicitation/request'].includes(m.method)) {
      const names = m.method === 'item/tool/requestUserInput' ? ['threadId', 'turnId', 'itemId'] : ['threadId', 'serverName'];
      if (!validId(m.id) || !object(p) || names.some(key => typeof p[key] !== 'string' || !p[key] || p[key].length > 256)
        || p.turnId != null && (typeof p.turnId !== 'string' || !p.turnId || p.turnId.length > 256)) { r.fault('invalid-question'); return false; }
      const shape = codexQuestion(m.method, p);
      if (!shape) return true;
      const added = r.add(m.id, m.method, p, shape.decisions, shape.response, shape.question);
      return !!added && !added.duplicate;
    }
    if (!['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval'].includes(m.method)) return true;
    if (!validId(m.id) || !object(p) || !['threadId', 'turnId', 'itemId'].every(k => typeof p[k] === 'string' && p[k].length > 0 && p[k].length <= 256)) { r.fault('invalid-approval'); return false; }
    if (m.method === 'item/permissions/requestApproval') {
      if (!permissionProfile(p.permissions)) return true;
      const permissions = JSON.parse(JSON.stringify(p.permissions));
      // Exact provider-supplied grant, turn scoped only. No renderer subset or policy edits.
      const added = r.add(m.id, m.method, p, ['grant', 'deny'], (decision, id) => ({ id,
        result: { permissions: decision === 'grant' ? permissions : {}, scope: 'turn' } }));
      return !!added;
    }
    if (p.availableDecisions != null && !Array.isArray(p.availableDecisions)) { r.fault('invalid-decisions'); return false; }
    const decisions = ['accept', 'decline', 'cancel'].filter(d => !p.availableDecisions || p.availableDecisions.includes(d));
    if (!decisions.length) return true;
    const added = r.add(m.id, m.method, p, decisions, (decision, id) => ({ id, result: { decision } }));
    return !!added && !added.duplicate;
  }
  client(m) {
    if (!validRpc(m)) { this.registry.fault('invalid-client-envelope'); return false; }
    if (Object.hasOwn(m, 'id') && !m.method && (Object.hasOwn(m, 'result') || Object.hasOwn(m, 'error'))) {
      const issued = this.issued.get(`${typeof m.id}:${m.id}`);
      if (!issued) { this.registry.fault('unknown-client-response'); return false; }
      if (!issued.pending) return false;
      issued.pending = false;
      return this.registry.clientResponse(m.id);
    }
    // An explicit interruption/start cancels held host actions before it enters the provider channel.
    if (['turn/interrupt', 'turn/start'].includes(m.method) && object(m.params)) {
      for (const r of this.registry.tokens.values()) if (r.params.threadId === m.params.threadId) this.registry.consume(r);
    }
    return !this.registry.closed;
  }
}

class ClaudeProtocol {
  constructor(registry) { this.registry = registry; }
  server(m) {
    const r = this.registry;
    if (typeof m.type !== 'string') { r.fault('invalid-control-envelope'); return; }
    if (m.type === 'control_cancel_request') { if (typeof m.request_id !== 'string') r.fault('invalid-cancel'); else r.resolve(m.request_id); }
    if (m.type === 'result') for (const entry of r.tokens.values()) r.consume(entry);
    if (m.type !== 'control_request') return;
    const p = m.request;
    if (typeof m.request_id !== 'string' || !object(p)) { r.fault('unsupported-control-request'); return; }
    if (p.subtype === 'elicitation') {
      if (typeof p.mcp_server_name !== 'string' || !p.mcp_server_name || typeof p.message !== 'string') { r.fault('invalid-elicitation'); return; }
      const shape = claudeQuestion(p);
      r.add(m.request_id, p.subtype, p, shape.decisions, shape.response, shape.question); return;
    }
    if (p.subtype !== 'can_use_tool' || typeof p.tool_name !== 'string' || !object(p.input) || (p.tool_use_id !== undefined && typeof p.tool_use_id !== 'string')) { r.fault('unsupported-control-request'); return; }
    if (p.tool_name === 'AskUserQuestion') {
      const shape = claudeQuestion(p);
      r.add(m.request_id, p.subtype, p, shape.decisions, shape.response, shape.question); return;
    }
    const input = JSON.parse(JSON.stringify(p.input));
    r.add(m.request_id, p.subtype, p, ['allow', 'deny'], (decision, id) => ({ type: 'control_response', response: {
      subtype: 'success', request_id: id,
      response: decision === 'allow' ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'Denied by user in Agentrix' },
    } }));
  }
}

// A write accepted into a backed-up pipe is not retried. Close the connection rather than queue another approval.
function writeJson(stream, message, fail) {
  if (stream.destroyed || stream.writableEnded || stream.writableLength > MAX_BYTES) throw new Error('Native channel unavailable');
  const data = JSON.stringify(message) + '\n';
  if (Buffer.byteLength(data) > MAX_BYTES) throw new Error('Native response too large');
  if (!stream.write(data, error => { if (error) fail('native-write-error'); })) { fail('native-backpressure'); throw new Error('Native channel backpressure'); }
}
module.exports = { JsonLines, CodexProtocol, ClaudeProtocol, writeJson };
