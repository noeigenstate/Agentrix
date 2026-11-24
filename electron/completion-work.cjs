const { adapterOf } = require('./features/cli-adapters/registry.cjs');

// Jobs with missing end receipts expire from launch, without success; services are excluded.
const LOST_WORK_TIMEOUT = 12 * 60 * 60 * 1000;
const transcriptOf = agent => adapterOf(agent)?.transcript ?? adapterOf('codex').transcript;
const { isServiceCommand } = adapterOf('claude').transcript;

class CompletionWork {
  constructor({ now = Date.now, changed = () => {}, timeout = LOST_WORK_TIMEOUT } = {}) {
    this.now = now; this.changed = changed; this.timeout = timeout; this.reset();
  }
  reset() {
    const pending = !!(this.tasks?.size || this.notifications?.size || this.reviewAt || this.reading);
    clearTimeout(this.timer); this.timer = null;
    this.tasks = new Map(); this.calls = new Map(); this.services = new Set(); this.notifications = new Set();
    this.deliveries = new Map();
    this.reviewAt = 0; this.endedAt = 0; this.turn = null; this.reading = false;
    this.expired = false; this.heldDeadline = null; this.version = 0;
    this.uncertain = false;
    return pending;
  }
  begin(at) {
    this.expired = false; this.heldDeadline = null;
    if (at > this.endedAt) this.reviewAt = Math.max(this.reviewAt, at);
  }
  discardBackground() {
    clearTimeout(this.timer); this.timer = null;
    this.tasks.clear(); this.notifications.clear(); this.calls.clear(); this.services.clear(); this.deliveries.clear();
    this.version++;
  }
  find(id) {
    if (typeof id !== 'string') return undefined;
    for (const [key, task] of this.tasks) {
      if (key === id || task.id === id || task.id?.endsWith(`/${id}`) || id.endsWith(`/${task.id}`)) return key;
    }
  }
  start(key, at, id = key, description = this.tasks.get(key)?.description) {
    if (key) this.tasks.set(key, { id, startedAt: this.tasks.get(key)?.startedAt ?? at, ...(description ? { description } : {}) });
  }
  finish(id) {
    const key = this.find(id), task = this.tasks.get(key);
    if (key) this.tasks.delete(key);
    return task && { key, ...task };
  }
  end(at) {
    this.endedAt = Math.max(this.endedAt, at);
    if (at >= this.reviewAt) this.reviewAt = 0;
  }
  record(record, agent, clockOffset = 0) {
    if (!record || record.isSidechain || record.type === 'api-request-blob') return;
    const timestamp = Date.parse(record.timestamp), at = Number.isFinite(timestamp) ? timestamp + clockOffset : this.now();
    transcriptOf(agent).completion(this, record, at);
    this.version++;
  }
  // Publish the main round before the project-completion gate folds in workers and queued receipts.
  mainTurn(snapshot = this.turn) {
    const state = snapshot?.state || 'unknown';
    const background = this.turn?.state === state && this.turn.updatedAt >= (snapshot?.updatedAt || 0) ? this.turn.background : null;
    return { state, updatedAt: snapshot?.updatedAt || 0, background: background || null };
  }
  native(message, agent, at, parentThreadId) {
    transcriptOf(agent).nativeCompletion(this, message, at, parentThreadId);
  }
  state(snapshot, { queued = false, held = null } = {}) {
    const ended = ['complete', 'interrupted'].includes(snapshot.state), now = this.now();
    // Expire only a round that waited on this deadline. The board has already stopped counting lapsed runs.
    if (ended && this.heldDeadline !== null && this.heldDeadline <= now) this.expired = true;
    const heldPending = held?.count && (!Number.isFinite(held.deadline) || held.deadline > now);
    this.heldDeadline = ended && heldPending && Number.isFinite(held.deadline) ? held.deadline : null;
    const pending = this.tasks.size || this.notifications.size || this.reviewAt || this.reading || queued || heldPending;
    if (this.uncertain) this.expired = true;
    clearTimeout(this.timer); this.timer = null;
    if (this.tasks.size && ['complete', 'interrupted'].includes(snapshot.state) && !this.expired) {
      const deadline = Math.min(...[...this.tasks.values()].map(task => task.startedAt + this.timeout));
      const remaining = deadline - this.now();
      if (remaining <= 0) {
        for (const [key, task] of this.tasks) if (task.startedAt + this.timeout <= this.now()) {
          this.tasks.delete(key);
        }
        this.expired = true;
      } else {
        this.timer = setTimeout(() => { this.timer = null; this.changed(); }, remaining);
        this.timer.unref?.();
      }
    }
    if (this.expired) return 'interrupted';
    return pending && ['complete', 'interrupted'].includes(snapshot.state) ? 'working' : snapshot.state;
  }
}

module.exports = { CompletionWork, LOST_WORK_TIMEOUT, isServiceCommand };
