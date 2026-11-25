const fs = require('node:fs');
const path = require('node:path');
const { readEnvelope, WIRE_FIELDS } = require('../agents/dispatch-events.cjs');

const MAX_INBOX = 4 * 1024 * 1024;
const BOARD_FORMAT = 'agentrix.board';
const boardFields = WIRE_FIELDS.files[BOARD_FORMAT] ?? WIRE_FIELDS.files['agentrix.board-entry'];
const runId = value => typeof value === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value);
const validText = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 4000 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
const withdrawalOf = control => ({ id: control.id, type: 'withdrawn', at: control.at });
const inboxLine = control => JSON.stringify({ v: 1, ...control }) + '\n';
const inside = (root, file) => { const relative = path.relative(root, file); return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
const timestamp = value => Number.isSafeInteger(value) && value >= 0;

function controlOf(input, { withdrawal = false } = {}) {
  const { value, legacy } = readEnvelope(input, { channel: 'inbox.jsonl' });
  if (!runId(value.id) || !(timestamp(value.at) || legacy && withdrawal && value.type === 'withdrawn')) throw new Error('无效的工作者消息。');
  if (withdrawal && value.type === 'withdrawn') return withdrawalOf(value);
  if (value.type === 'stop') {
    if (value.reason !== undefined && !validText(value.reason) || value.noResume !== undefined && typeof value.noResume !== 'boolean') throw new Error('无效的停止请求。');
    return { id: value.id, type: 'stop', at: value.at, ...(value.reason ? { reason: value.reason } : {}), ...(value.noResume ? { noResume: true } : {}) };
  }
  if (value.type !== undefined && !(value.type === 'intervention' && !legacy) || !validText(value.text)) throw new Error('插话须为 1 至 4000 个字符。');
  return { id: value.id, text: value.text, at: value.at };
}

const boardEntry = entry => ({ ...entry, format: BOARD_FORMAT, version: boardFields.version });

function readBoard(input) {
  const entry = JSON.parse(input);
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const { value, legacy } = readEnvelope(entry, {
    format: BOARD_FORMAT, versions: [boardFields.version], legacy: !Object.hasOwn(entry, 'format'),
  });
  const validProcess = Number.isSafeInteger(value.pid) && value.pid > 0 && Array.isArray(value.allow) && value.allow.every(glob => typeof glob === 'string');
  if (legacy) return validProcess ? value : null;
  if (!validProcess || !timestamp(value.startedAt) || !boardFields.required.every(key => Object.hasOwn(value, key))
      || !['id', 'title', 'role', 'agent', 'model', 'cwd'].every(key => typeof value[key] === 'string')
      || !['controls', 'closing'].every(key => value[key] === undefined || typeof value[key] === 'boolean')) {
    throw Object.assign(new Error(`${BOARD_FORMAT}: invalid board entry`), { code: 'wire.invalid' });
  }
  return value;
}

function inboxFile(team, id, create = false) {
  if (!runId(id)) throw new Error('无效的工作者标识。');
  const root = fs.realpathSync(team.directory), folder = path.join(root, 'inbox');
  if (create) fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  if (!inside(root, fs.realpathSync(folder)) || fs.lstatSync(folder).isSymbolicLink()) throw new Error('工作者收件箱不可用。');
  const file = path.join(folder, id + '.jsonl');
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (stat && (!stat.isFile() || stat.nlink !== 1 || !inside(folder, fs.realpathSync(file)))) throw new Error('工作者收件箱不可用。');
  return file;
}

function updateWorker(team, id, patch) {
  const root = fs.realpathSync(team.directory), board = fs.realpathSync(team.board), file = path.join(board, id + '.json');
  if (!inside(root, board) || fs.lstatSync(team.board).isSymbolicLink() || !fs.lstatSync(file).isFile() || !inside(board, fs.realpathSync(file))) throw new Error('工作者收件箱不可用。');
  const entry = readBoard(fs.readFileSync(file, 'utf8')), temporary = path.join(board, id + '.tmp');
  if (!entry) throw new Error('工作者收件箱不可用。');
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    try { fs.writeFileSync(fd, JSON.stringify(boardEntry({ ...entry, ...patch })) + '\n'); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

// Both producers and the helper's final empty check hold the team lock. A successful receipt therefore cannot race
// past finalization. The callback validates the binding; wake-up signals happen after this transaction commits.
async function queueControl(team, id, input, notify = () => {}) {
  const control = controlOf(input);
  return team.locked(async () => {
    const worker = team.live().find(entry => entry.id === id);
    if (!worker?.controls || worker.closing) throw new Error('工作者已结束或收件箱不可用。');
    const file = inboxFile(team, id), size = fs.statSync(file).size;
    const bytes = Buffer.byteLength(inboxLine(control)), rollbackBytes = Buffer.byteLength(inboxLine(withdrawalOf(control))) + 1;
    if (size + bytes + rollbackBytes > MAX_INBOX) throw new Error('工作者收件箱已满，请稍后再试。');
    if (control.noResume) updateWorker(team, id, { closing: true });
    try { return await recordControl(team, id, worker.title, control, notify, file); }
    catch (error) { if (control.noResume) updateWorker(team, id, { closing: false }); throw error; }
  });
}

async function recordControl(team, id, title, control, notify = () => {}, inbox) {
  const files = [inbox, team.memory, team.memoryJsonl, team.journal].filter(Boolean);
  const root = fs.realpathSync(team.directory);
  for (const file of files) {
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (stat && (!stat.isFile() || stat.nlink !== 1 || !inside(root, fs.realpathSync(file)))) throw new Error('工作者收件箱不可用。');
  }
  const { id: messageId, at, type: kind = 'intervention', ...details } = control;
  const heading = `${new Date(at).toISOString()} · owner ${kind}`;
  let inboxAttempted = false;
  try {
    team.appendMemory({ at, title: heading + ' · ' + String(title).replace(/[\r\n]/g, ' '), runId: id, source: kind, text: { ...details, messageId } });
    team.append({ ...details, type: kind, id, messageId, at });
    await notify();
    if (inbox) { inboxAttempted = true; fs.appendFileSync(inbox, inboxLine(control)); }
    return control;
  } catch (error) {
    // A helper may already hold an offset. Record the compensating withdrawal in the same channels.
    const withdrawn = withdrawalOf(control);
    if (inboxAttempted) {
      try { fs.appendFileSync(inbox, '\n' + inboxLine(withdrawn)); } catch {}
    }
    try { team.appendMemory({ at, title: heading + ' withdrawn', runId: id, source: 'withdrawn', text: { messageId, kind } }); } catch {}
    try { fs.appendFileSync(team.journal, '\n'); team.append({ ...withdrawn, id, messageId }); } catch {}
    throw error;
  }
}

class RunInbox {
  constructor(team, id) { this.team = team; this.id = id; this.offset = 0; this.seen = new Set(); this.receipts = new Map(); }
  receipt(messageId) { return this.receipts.get(messageId) || null; }
  async recordReceipt(messageId, status) {
    if (!runId(messageId) || !['queued', 'delivered', 'rejected', 'unknown'].includes(status)) throw new Error('invalid_receipt');
    await this.team.locked(() => {
      if (this.receipts.has(messageId)) return;
      this.team.appendReceipt({ id: this.id, messageId, status, at: Date.now() });
      this.receipts.set(messageId, status);
    });
  }
  async open() {
    await this.team.locked(() => {
      this.file = inboxFile(this.team, this.id, true);
      fs.closeSync(fs.openSync(this.file, 'wx', 0o600));
      const stat = fs.statSync(this.file, { bigint: true }); this.identity = `${stat.dev}:${stat.ino}`;
      updateWorker(this.team, this.id, { controls: true });
    });
  }
  async take(finishIfEmpty = false) {
    return this.team.locked(() => {
      const file = inboxFile(this.team, this.id), fd = fs.openSync(file, 'r');
      let data;
      try {
        const stat = fs.fstatSync(fd, { bigint: true }), size = Number(stat.size);
        if (`${stat.dev}:${stat.ino}` !== this.identity || size > MAX_INBOX || size < this.offset) throw new Error('工作者收件箱不可用。');
        data = Buffer.alloc(size - this.offset);
        const bytes = fs.readSync(fd, data, 0, data.length, this.offset);
        data = data.subarray(0, bytes);
      } finally { fs.closeSync(fd); }
      const end = data.lastIndexOf(10);
      const messages = [], withdrawn = new Set(), seen = new Set();
      if (end >= 0) {
        for (const line of data.subarray(0, end + 1).toString('utf8').split('\n').filter(Boolean)) {
          let control;
          try { control = controlOf(line, { withdrawal: true }); }
          catch (error) { if (error.code === 'wire.unsupported_version') throw error; continue; }
          if (control.type === 'withdrawn') withdrawn.add(control.id);
          else if (!this.seen.has(control.id) && !seen.has(control.id)) messages.push(control);
          seen.add(control.id);
        }
        for (const id of seen) this.seen.add(id);
        this.offset += end + 1;
      }
      const accepted = messages.filter(control => !withdrawn.has(control.id));
      if (finishIfEmpty && !accepted.length) {
        // A partial external write is not an accepted API message; do not silently close over it.
        if (data.length !== end + 1) throw new Error('工作者收件箱含有未完成的消息。');
        updateWorker(this.team, this.id, { closing: true });
      }
      return accepted;
    });
  }
  async close() {
    await this.team.locked(() => updateWorker(this.team, this.id, { closing: true }));
  }
}

module.exports = { RunInbox, queueControl, recordControl, controlOf, readBoard, boardEntry, validText, runId, MAX_INBOX };
