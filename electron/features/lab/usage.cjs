const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { estimateCost } = require('../dashboard/cost.cjs');
const { finite } = require('./values.cjs');
const { channelAddress } = require('./sandbox.cjs');

const sumKnown = values => values.length && values.every(finite) ? values.reduce((a, b) => a + b, 0) : null;

class LabUsage {
  constructor({
    directory, privateDirectory = directory, socketDirectory, runId, project, prices,
    changed = () => {}, onCost = () => {},
  }) {
    Object.assign(this, { directory, privateDirectory, socketDirectory, runId, prices, changed, onCost });
    this.projectId = 'lab:' + (runId || project.id);
    this.key = randomBytes(32).toString('hex');
    this.calls = new Map(); this.sockets = new Set(); this.events = [];
    this.pending = Promise.resolve(); this.closed = false;
  }
  async start() {
    await fs.mkdir(this.privateDirectory, { recursive: true, mode: 0o700 });
    this.channel = await channelAddress(this.socketDirectory, 'meter');
    this.address = this.channel.address;
    this.server = net.createServer(socket => {
      this.sockets.add(socket); socket.setEncoding('utf8'); socket.setTimeout(2000, () => socket.destroy());
      let buffer = '';
      socket.on('data', chunk => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > 256 * 1024) return socket.destroy();
        const lines = buffer.split('\n'); buffer = lines.pop();
        for (const line of lines) {
          try {
            const event = JSON.parse(line);
            const authenticated = !this.closed && event?.sessionKey === this.key && event.projectId === this.projectId;
            if (authenticated && event.type !== 'lab-handshake') this.accept(event);
            socket.write(JSON.stringify({ ok: authenticated }) + '\n');
          } catch { socket.destroy(); }
        }
      });
      socket.on('error', () => {});
      socket.on('close', () => this.sockets.delete(socket));
    });
    await new Promise((resolve, reject) => {
      this.server.once('error', reject); this.server.listen(this.address, resolve);
    });
    if (process.platform !== 'win32') await fs.chmod(this.address, 0o600);
    this.bootstrap = path.join(this.privateDirectory, 'bootstrap.json');
    await fs.writeFile(this.bootstrap, JSON.stringify({
      pipeName: this.address, sessionKey: this.key, projectId: this.projectId,
    }), { mode: 0o600 });
    return this.bootstrap;
  }
  accept(event) {
    if (this.closed || event?.sessionKey !== this.key || event.projectId !== this.projectId ||
      typeof event.id !== 'string' || event.id.length > 160 ||
      !['dispatch-start', 'dispatch-rate', 'dispatch-end'].includes(event.type) ||
      this.calls.size >= 500 && !this.calls.has(event.id)) return;
    const previous = this.calls.get(event.id);
    if (!previous && event.type !== 'dispatch-start' || previous?.endedAt != null ||
      previous?.startedAt != null && event.type === 'dispatch-start') return;
    const { sessionKey, projectId, pipeName, ...data } = event;
    const record = { ...data, source: 'lab' }, call = { ...previous, ...record };
    this.calls.set(event.id, call); this.events.push(record);
    this.pending = this.pending.then(() => fs.appendFile(
      path.join(this.directory, 'events.jsonl'), JSON.stringify(record) + '\n', { mode: 0o600 },
    )).catch(error => { this.writeError ||= error; });
    const active = [...this.calls.values()].filter(call => call.startedAt != null && call.endedAt == null).at(-1);
    this.changed(typeof active?.model === 'string' && active.model !== 'unreported' ? active.model : null);
    this.onCost(this.measurements().knownCostUsd);
  }
  // Human-readable helper lines are retained in logs, never accepted as metering evidence.
  line() {}
  measurements() {
    const calls = [...this.calls.values()], costs = calls.map(call => estimateCost(call, this.prices).usd);
    return {
      source: 'lab', costUsd: calls.every(call => call.endedAt != null) ? sumKnown(costs) : null,
      knownCostUsd: costs.filter(finite).reduce((a, b) => a + b, 0),
      outputTokens: sumKnown(calls.map(call => call.totalOutputTokens ?? call.outputTokens)),
      activeMs: sumKnown(calls.map(call => call.activeMs)), calls,
    };
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.server) {
      await new Promise(resolve => { this.server.close(resolve); for (const socket of this.sockets) socket.destroy(); });
      this.server = null;
    }
    await this.channel?.close();
    await this.pending;
    if (this.writeError) throw this.writeError;
    if (!this.events.length) await fs.writeFile(path.join(this.directory, 'events.jsonl'), '', { mode: 0o600 });
    if (this.bootstrap) await fs.rm(this.bootstrap, { force: true });
  }
}

function phaseEvidence(entries, calls) {
  const callById = new Map(calls.map(call => [call.id, call]));
  const reworkIds = new Set(entries.filter(entry => entry.type === 'skip' &&
    /review|rework|审查|返工|修复/i.test(entry.reason || '')).map(entry => entry.id));
  const buckets = new Map();
  for (const entry of entries.filter(entry => entry.type === 'end')) {
    const call = callById.get(entry.id), kind = entry.kind || call?.kind;
    const name = entry.role === '圆桌' || kind === 'roundtable' ? 'roundtable'
      : kind === 'review' || entry.role === '审查' ? 'review'
      : reworkIds.has(entry.id) ? 'rework'
      : kind === 'investigate' || /plan|规划|架构|分析/i.test(entry.title || '') ? 'plan' : 'build';
    const ms = finite(entry.activeMs) ? entry.activeMs : call && finite(call.startedAt) && finite(entry.time)
      ? entry.time - call.startedAt : null;
    if (!finite(ms)) continue;
    const phase = buckets.get(name) || { name, ms: 0, count: 0 };
    phase.ms += ms; phase.count++; buckets.set(name, phase);
  }
  const findings = entries.filter(entry => entry.type === 'finding');
  return {
    phases: ['plan', 'roundtable', 'build', 'review', 'rework'].flatMap(name => buckets.has(name) ? [buckets.get(name)] : []),
    rework: findings.length || entries.some(entry => entry.type === 'consolidate')
      ? findings.filter(entry => entry.fixed === true).length : null,
  };
}

module.exports = { LabUsage, phaseEvidence };
