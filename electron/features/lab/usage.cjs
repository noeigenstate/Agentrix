const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { estimateCost } = require('../dashboard/cost.cjs');
const { finite } = require('./values.cjs');

const sumKnown = values => values.length && values.every(finite) ? values.reduce((a, b) => a + b, 0) : null;

class LabUsage {
  constructor({ directory, socketDirectory, project, prices, records, changed = () => {} }) {
    Object.assign(this, { directory, socketDirectory, project, prices, records, changed });
    this.key = randomUUID(); this.calls = new Map(); this.lines = new Map(); this.sockets = new Set();
    this.events = [];
  }
  async start() {
    const id = randomUUID().slice(0, 8);
    this.address = process.platform === 'win32' ? `\\\\.\\pipe\\agentrix-lab-${this.key}` : path.join(this.socketDirectory, `s-${id}`);
    if (process.platform !== 'win32' && Buffer.byteLength(this.address) > 100) {
      // macOS limits Unix socket paths to 104 bytes. The alias is temporary; the socket itself stays in userData.
      const temporary = process.platform === 'darwin' ? path.join(os.homedir(), '.ctmp') : os.tmpdir();
      await fs.mkdir(temporary, { recursive: true });
      this.socketAlias = path.join(temporary, 'lab-s-' + id);
      await fs.symlink(await fs.realpath(this.socketDirectory), this.socketAlias, 'dir');
      this.address = path.join(this.socketAlias, 'events');
    }
    this.server = net.createServer(socket => {
      this.sockets.add(socket); socket.setEncoding('utf8'); socket.setTimeout(2000, () => socket.destroy());
      let buffer = '';
      socket.on('data', chunk => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > 256 * 1024) { socket.destroy(); return; }
        const lines = buffer.split('\n'); buffer = lines.pop();
        for (const line of lines) {
          try { const event = JSON.parse(line); if (event.sessionKey === this.key && event.projectId === this.project.id) this.accept(event); } catch {}
        }
      });
      socket.on('error', () => {}); socket.on('close', () => this.sockets.delete(socket));
    });
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.address, resolve); });
    if (process.platform !== 'win32') await fs.chmod(this.address, 0o600);
    this.bootstrap = path.join(this.directory, 'bootstrap.json');
    await fs.writeFile(this.bootstrap, JSON.stringify({ pipeName: this.address, sessionKey: this.key, projectId: this.project.id }), { mode: 0o600 });
    return this.bootstrap;
  }
  accept(event) {
    if (typeof event.id !== 'string' || event.id.length > 160 || !['dispatch-start', 'dispatch-rate', 'dispatch-end'].includes(event.type) ||
      this.calls.size >= 500 && !this.calls.has(event.id)) return;
    const previous = this.calls.get(event.id) || {};
    if (previous.endedAt != null || event.type === 'dispatch-start' && previous.startedAt != null) return;
    const { sessionKey, projectId, ...record } = event;
    const call = { ...previous, ...record }; this.calls.set(event.id, call);
    this.events.push(record);
    if (event.type === 'dispatch-end' && this.records) {
      this.records.run(this.project, { sourceAgent: call.agent, role: call.role, title: call.title, kind: call.kind,
        meeting: call.meeting, startedAt: call.startedAt, declared: call.declared, unconfirmed: call.unconfirmed }, event);
    }
    const active = [...this.calls.values()].filter(call => call.startedAt != null && call.endedAt == null).at(-1);
    this.changed(typeof active?.model === 'string' && active.model !== 'unreported' ? active.model : null);
  }
  line(line) {
    const match = /^\[dispatch\] ended ([\w-]+) (codex|claude) model (\S+) effort (\S+) fast (\S+).*?(?:\(([\d,]+) output tokens in (\d+) s\))? · exit (-?\d+) reason (\w+)/.exec(line);
    if (!match) return;
    const rate = /\(([\d,]+) output tokens in (\d+) s\)/.exec(line);
    this.lines.set(match[1], { id: match[1], agent: match[2], model: match[3], fast: match[5] === 'unreported' ? null : match[5] === 'on',
      outputTokens: rate ? Number(rate[1].replace(/,/g, '')) : null, activeMs: rate ? Number(rate[2]) * 1000 : null,
      exitCode: Number(match[8]), reason: match[9] });
  }
  measurements() {
    const ids = new Set([...this.lines.keys(), ...this.calls.keys()]);
    const calls = [...ids].map(id => ({ ...this.lines.get(id), ...this.calls.get(id) }));
    return { costUsd: sumKnown(calls.map(call => estimateCost(call, this.prices).usd)),
      outputTokens: sumKnown(calls.map(call => call.totalOutputTokens ?? call.outputTokens)),
      activeMs: sumKnown(calls.map(call => call.activeMs)), calls };
  }
  async close() {
    if (this.server) {
      await new Promise(resolve => { this.server.close(resolve); for (const socket of this.sockets) socket.destroy(); });
      this.server = null;
    }
    if (this.address && process.platform !== 'win32') await fs.rm(this.address, { force: true });
    if (this.socketAlias) await fs.unlink(this.socketAlias);
    await fs.writeFile(path.join(this.directory, 'events.jsonl'), this.events.map(event => JSON.stringify(event)).join('\n'), { mode: 0o600 });
    await fs.rm(this.bootstrap || path.join(this.directory, 'bootstrap.json'), { force: true });
  }
}

// Journal roles and explicit findings are evidence; an absent phase is omitted rather than assigned a zero duration.
function phaseEvidence(entries, calls) {
  const starts = new Map(entries.filter(entry => entry.type === 'start').map(entry => [entry.id, entry]));
  const callById = new Map(calls.map(call => [call.id, call]));
  const ended = entries.filter(entry => entry.type === 'end');
  const reworkIds = new Set(entries.filter(entry => entry.type === 'skip' && /review|rework|审查|返工|修复/i.test(entry.reason || '')).map(entry => entry.id));
  const buckets = new Map();
  for (const entry of ended) {
    const call = callById.get(entry.id), start = starts.get(entry.id) || call;
    const kind = entry.kind || call?.kind;
    const name = entry.role === '圆桌' || kind === 'roundtable' ? 'roundtable' : kind === 'review' || entry.role === '审查' ? 'review'
      : reworkIds.has(entry.id) ? 'rework' : kind === 'investigate' || /plan|规划|架构|分析/i.test(entry.title || '') ? 'plan' : 'build';
    const ms = finite(entry.activeMs) ? entry.activeMs : start && finite(start.startedAt) && finite(entry.time) ? entry.time - start.startedAt : null;
    if (!finite(ms)) continue;
    const phase = buckets.get(name) || { name, ms: 0, count: 0 }; phase.ms += ms; phase.count++; buckets.set(name, phase);
  }
  const findings = entries.filter(entry => entry.type === 'finding');
  return { phases: ['plan', 'roundtable', 'build', 'review', 'rework'].flatMap(name => buckets.has(name) ? [buckets.get(name)] : []),
    rework: findings.length || entries.some(entry => entry.type === 'consolidate') ? findings.filter(entry => entry.fixed === true).length : null };
}

module.exports = { LabUsage, phaseEvidence };
