const fs = require('node:fs');
const path = require('node:path');

const MAX_INBOX = 4 * 1024 * 1024;
const runId = value => typeof value === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value);
const validText = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 4000 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
const withdrawalOf = control => ({ id: control.id, type: 'withdrawn', at: control.at });
const inside = (root, file) => { const relative = path.relative(root, file); return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };

function controlOf(value) {
  if (!value || typeof value !== 'object' || !runId(value.id) || !Number.isSafeInteger(value.at) || value.at < 0) throw new Error('无效的工作者消息。');
  if (value.type === 'stop') {
    if (value.reason !== undefined && !validText(value.reason) || value.noResume !== undefined && typeof value.noResume !== 'boolean') throw new Error('无效的停止请求。');
    return { id: value.id, type: 'stop', at: value.at, ...(value.reason ? { reason: value.reason } : {}), ...(value.noResume ? { noResume: true } : {}) };
  }
  if (value.type !== undefined || !validText(value.text)) throw new Error('插话须为 1 至 4000 个字符。');
  return { id: value.id, text: value.text, at: value.at };
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
  const entry = JSON.parse(fs.readFileSync(file, 'utf8')), temporary = path.join(board, id + '.tmp');
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    try { fs.writeFileSync(fd, JSON.stringify({ ...entry, ...patch })); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

// Both producers and the helper's final empty check hold the team lock. A successful receipt therefore cannot race
// past finalization. Publish to the inbox only after the original planner accepts its notification.
async function queueControl(team, id, input, notify = () => {}) {
  const control = controlOf(input);
  return team.locked(async () => {
    const worker = team.live().find(entry => entry.id === id);
    if (!worker?.controls || worker.closing) throw new Error('工作者已结束或收件箱不可用。');
    const file = inboxFile(team, id), size = fs.statSync(file).size;
    const bytes = Buffer.byteLength(JSON.stringify(control)) + 1, rollbackBytes = Buffer.byteLength(JSON.stringify(withdrawalOf(control))) + 2;
    if (size + bytes + rollbackBytes > MAX_INBOX) throw new Error('工作者收件箱已满，请稍后再试。');
    if (control.noResume) updateWorker(team, id, { closing: true });
    try { return await recordControl(team, id, worker.title, control, notify, file); }
    catch (error) { if (control.noResume) updateWorker(team, id, { closing: false }); throw error; }
  });
}

async function recordControl(team, id, title, control, notify = () => {}, inbox) {
  const files = [inbox, team.memory, team.journal].filter(Boolean);
  const root = fs.realpathSync(team.directory);
  for (const file of files) {
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (stat && (!stat.isFile() || stat.nlink !== 1 || !inside(root, fs.realpathSync(file)))) throw new Error('工作者收件箱不可用。');
  }
  const kind = control.type === 'stop' ? 'stop' : 'intervention';
  let inboxAttempted = false;
  try {
    fs.appendFileSync(team.memory, `\n\n### ${new Date(control.at).toISOString()} · owner ${kind} · ${String(title).replace(/[\r\n]/g, ' ')}\n\n${JSON.stringify({ ...control, id, messageId: control.id })}\n`);
    team.append({ ...control, type: kind, id, messageId: control.id });
    await notify();
    if (inbox) { inboxAttempted = true; fs.appendFileSync(inbox, JSON.stringify(control) + '\n'); }
    return control;
  } catch (error) {
    // Memory has unlocked writers, and a helper may already hold an offset. Never truncate their appends.
    const withdrawn = withdrawalOf(control);
    if (inboxAttempted) {
      try { fs.appendFileSync(inbox, '\n' + JSON.stringify(withdrawn) + '\n'); } catch {}
    }
    try { fs.appendFileSync(team.memory, `\n\n### ${new Date(control.at).toISOString()} · owner ${kind} withdrawn\n\n${JSON.stringify({ ...withdrawn, id, messageId: control.id })}\n`); } catch {}
    try { fs.appendFileSync(team.journal, '\n'); team.append({ ...withdrawn, id, messageId: control.id }); } catch {}
    throw error;
  }
}

class RunInbox {
  constructor(team, id) { this.team = team; this.id = id; this.offset = 0; this.seen = new Set(); }
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
      const messages = [], withdrawn = new Set();
      if (end >= 0) {
        for (const line of data.subarray(0, end + 1).toString('utf8').split('\n').filter(Boolean)) {
          let control;
          try {
            const value = JSON.parse(line);
            if (value?.type === 'withdrawn' && runId(value.id)) { withdrawn.add(value.id); this.seen.add(value.id); continue; }
            control = controlOf(value);
          } catch { continue; }
          if (!this.seen.has(control.id)) { this.seen.add(control.id); messages.push(control); }
        }
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

module.exports = { RunInbox, queueControl, recordControl, controlOf, validText, runId, MAX_INBOX };
