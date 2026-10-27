const http = require('node:http');
const { randomBytes, randomUUID, timingSafeEqual } = require('node:crypto');

class SSHAuthServer {
  constructor(onChange = () => {}) { this.connections = new Map(); this.pending = new Map(); this.onChange = onChange; }
  async start() {
    this.server = http.createServer((request, response) => this.handle(request, response));
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', resolve); });
    this.url = `http://127.0.0.1:${this.server.address().port}/askpass`;
    return this;
  }
  register(id, host, cancel) {
    const token = randomBytes(32).toString('hex');
    this.connections.set(id, { host, token, cancel });
    return { AGENTRIX_ASKPASS_URL: this.url, AGENTRIX_ASKPASS_TOKEN: token, AGENTRIX_ASKPASS_ID: id };
  }
  getPending() { return [...this.pending.values()].map(({ prompt }) => prompt); }
  hasPending(connectionId) {
    for (const item of this.pending.values()) if (item.connectionId === connectionId) return true;
    return false;
  }
  notify() { this.onChange(this.getPending()); }
  handle(request, response) {
    if (request.method !== 'POST' || request.url !== '/askpass') { response.writeHead(404).end(); return; }
    let data = ''; let size = 0;
    request.setEncoding('utf8');
    request.on('data', chunk => { size += Buffer.byteLength(chunk); if (size > 32768) request.destroy(); else data += chunk; });
    request.on('end', () => {
      let input;
      try { input = JSON.parse(data); } catch { response.writeHead(400).end(); return; }
      const connection = this.connections.get(input.connectionId);
      const supplied = Buffer.from(String(request.headers.authorization || ''));
      const expected = Buffer.from(`Bearer ${connection?.token || ''}`);
      if (!connection || supplied.length !== expected.length || !timingSafeEqual(supplied, expected) || typeof input.prompt !== 'string' || input.prompt.length > 8192) { response.writeHead(403).end(); return; }
      const id = randomUUID();
      const prompt = { id, host: connection.host, message: input.prompt, kind: input.hint === 'confirm' || /yes\/no|fingerprint.*continue/i.test(input.prompt) ? 'confirm' : 'secret' };
      const timer = setTimeout(() => this.answer(id, null), 5 * 60 * 1000);
      timer.unref?.();
      this.pending.set(id, { prompt, connectionId: input.connectionId, response, timer });
      response.on('close', () => { if (this.pending.delete(id)) { clearTimeout(timer); this.notify(); } });
      this.notify();
    });
  }
  answer(id, value) {
    const item = this.pending.get(id);
    if (!item) return;
    if (value !== null && (typeof value !== 'string' || value.length > 16384 || /[\0\r\n]/.test(value))) throw new Error('无效的 SSH 认证回复。');
    this.pending.delete(id); clearTimeout(item.timer);
    item.response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    item.response.end(JSON.stringify({ canceled: value === null, response: value || '' }));
    this.notify();
    if (value === null) this.connections.get(item.connectionId)?.cancel();
  }
  unregister(id) {
    this.connections.delete(id);
    for (const [key, item] of this.pending) if (item.connectionId === id) this.answer(key, null);
  }
  close() { for (const id of [...this.connections.keys()]) this.unregister(id); this.server?.close(); this.server?.closeAllConnections(); }
}
module.exports = { SSHAuthServer };
