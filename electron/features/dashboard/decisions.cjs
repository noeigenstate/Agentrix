const fs = require('node:fs/promises');
const path = require('node:path');
const { modelKey } = require('./cost.cjs');
const { TASK_KINDS } = require('./records-routing.cjs');
const { readJsonl, readJsonlSync, FILE_LIMIT, LINE_LIMIT, READ_LIMIT } = require('./jsonl.cjs');

const STATES = ['open', 'adopted', 'dismissed'];
const boundedText = value => typeof value === 'string' && value.length > 0 && value.length <= 160 && !/[\x00-\x1f\x7f]/.test(value);
function validWeight(weight) {
  return weight && !Array.isArray(weight) && Object.keys(weight).sort().join(',') === 'from,kind,model,to' &&
    boundedText(weight.model) && /^[a-z0-9][a-z0-9.\-]{0,63}$/.test(weight.model) && TASK_KINDS.includes(weight.kind) && Number.isFinite(weight.from) && weight.from >= 0 &&
    Number.isFinite(weight.to) && weight.to >= 0.3 && weight.to <= 1.5;
}
function validDecision(record) {
  return boundedText(record?.id) && STATES.includes(record.state) && (record.weight === undefined || validWeight(record.weight));
}
function latestDecisions(records) {
  const latest = new Map();
  for (const record of [...records].filter(validDecision).sort((a, b) => a.at - b.at)) {
    latest.delete(record.id); latest.set(record.id, record);
  }
  return latest;
}
function currentWeights(records) {
  const weights = new Map();
  for (const record of latestDecisions(records).values()) {
    if (record.state !== 'adopted' || !record.weight) continue;
    const weight = { ...record.weight, model: modelKey(record.weight.model) };
    weights.set(JSON.stringify([weight.model, weight.kind]), weight);
  }
  return [...weights.values()].sort((a, b) => a.model.localeCompare(b.model) || a.kind.localeCompare(b.kind));
}
const filesFor = userData => ['decisions.1.jsonl', 'decisions.checkpoint.jsonl', 'decisions.jsonl'].map(name => path.join(userData, 'dashboard', name));
// One extra line allows a full checkpoint followed by an update of an existing id.
const readOptions = { limit: READ_LIMIT + 1 };

// Rotation checkpoints the latest state of each suggestion. Old, still-adopted weights must not vanish just because
// unrelated decisions filled a file. At most 10000 distinct suggestions are retained; a new id beyond that is refused.
class DashboardDecisions {
  constructor(userData, { now = Date.now, log = message => console.warn(message) } = {}) {
    this.files = filesFor(userData); this.now = now; this.log = log;
    this.pending = Promise.resolve(); this.warned = false;
  }
  async read() {
    await this.pending;
    return [...latestDecisions((await Promise.all(this.files.map(file => readJsonl(file, readOptions)))).flat()).values()];
  }
  decide(id, state, weight) {
    const record = { id, state, ...(weight ? { weight } : {}), at: this.now(), v: 1 };
    if (!validDecision(record)) return Promise.resolve(false);
    const pending = this.pending.then(async () => {
      const history = (await Promise.all(this.files.map(file => readJsonl(file, readOptions)))).flat();
      const latest = latestDecisions(history);
      if (!latest.has(id) && latest.size >= READ_LIMIT) return false;
      const filename = this.files[2], line = JSON.stringify(record) + '\n';
      if (Buffer.byteLength(line) > LINE_LIMIT) return false;
      await fs.mkdir(path.dirname(filename), { recursive: true });
      const size = await fs.stat(filename).then(value => value.size, error => { if (error.code === 'ENOENT') return 0; throw error; });
      const current = await readJsonl(filename, readOptions);
      let torn = false;
      if (size) {
        const file = await fs.open(filename, 'r');
        try { const byte = Buffer.alloc(1); await file.read(byte, 0, 1, size - 1); torn = byte[0] !== 10; }
        finally { await file.close(); }
      }
      if (torn || size + Buffer.byteLength(line) > FILE_LIMIT || current.length >= READ_LIMIT) {
        // Persist the complete old state before removing a generation. A failed rotation must neither withdraw
        // an existing adoption nor apply the requested decision. Readers also recover a checkpoint left by a crash.
        const checkpoint = [...latest.values()].map(value => JSON.stringify(value) + '\n').join('');
        if (Buffer.byteLength(checkpoint) + Buffer.byteLength(line) > FILE_LIMIT) return false;
        const temporary = this.files[1] + '.tmp';
        await fs.writeFile(temporary, checkpoint, { mode: 0o600 });
        await fs.rename(temporary, this.files[1]);
        await fs.rm(this.files[0], { force: true });
        if (size) await fs.rename(filename, this.files[0]);
        await fs.rename(this.files[1], filename);
      }
      await fs.appendFile(filename, line, { mode: 0o600 });
      return true;
    }).catch(() => {
      if (!this.warned) { this.warned = true; try { this.log('Dashboard decisions could not be written.'); } catch {} }
      return false;
    });
    this.pending = pending;
    return pending;
  }
  async flush() { await this.pending; }
}

function routingNote(userData) {
  const weights = currentWeights(filesFor(userData).flatMap(file => readJsonlSync(file, readOptions)));
  if (!weights.length) return '';
  const values = weights.map(weight => `${JSON.stringify(weight.model)} / ${weight.kind}: ${weight.to}`).join('; ');
  return `Owner-adopted routing weights (model / task kind): ${values}. Use these weights when choosing workers; other pairs keep the default weight of 1.`;
}

module.exports = { DashboardDecisions, latestDecisions, currentWeights, routingNote, validWeight };
