const path = require('node:path');
const { TranscriptTail } = require('../../agent-actions.cjs');
const { ConversationLog, claudeConversation, codexConversation } = require('../../conversation.cjs');
const { containedFile, sessionHeader, findRolloutSession, sameDirectory } = require('../../session-files.cjs');
const { findClaudeSession } = require('../../claude-sessions.cjs');

const ENTRY_LIMIT = 400, FINAL_LIMIT = 20, FINAL_TTL = 30 * 60000, PUSH_INTERVAL = 250;
const time = value => Number.isFinite(value) && value >= 0 ? value : null;
const stateOf = call => call.done ? call.dispatch && !call.failure ? 'done' : 'reviewing' : call.preparing ? 'preparing' : 'running';
const rootValue = value => typeof value === 'function' ? value() : value;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const ownsRecord = (call, record) => call.agent === 'Codex'
  ? record?.type !== 'session_meta' || record.payload?.id === call.sessionId && typeof record.payload.cwd === 'string' &&
    path.isAbsolute(record.payload.cwd) && sameDirectory(record.payload.cwd, call.cwd)
  : record?.sessionId == null || record.sessionId === call.sessionId;

// Logs stay separate from the parent conversation. Task records share its existing tail; dispatches
// get their own read-only tail, bound to a registered call and the terminal's explicitly supplied CLI root.
class SubagentFeeds {
  constructor({ changed = () => {}, retired = () => {}, read = async () => {}, local = true, codexHome = null, claudeHome = null, now = Date.now } = {}) {
    Object.assign(this, { changed, retired, read, local, codexHome, claudeHome, now });
    this.entries = new Map(); this.notifications = new Set();
  }
  track(call) {
    const home = this.local && call.dispatch ? rootValue(call.agent === 'Codex' ? this.codexHome : this.claudeHome) : null;
    const entry = { call, home, revision: 0, sentAt: -Infinity, dirty: true, replies: new Map() };
    // Keep one extra entry to detect truncation without retaining an unbounded set of message identities.
    entry.log = new ConversationLog(() => { entry.dirty = true; }, ENTRY_LIMIT + 1);
    this.entries.set(call.id, entry);
    this.update(call);
  }
  owned(call) {
    const entry = this.entries.get(call.id);
    return entry?.call === call ? entry : null;
  }
  resetLog(call, partial) {
    const entry = this.owned(call);
    if (!entry) return;
    entry.log.reset(); entry.log.cwd = call.cwd || null;
    entry.partial = partial; entry.omitted = partial; entry.replies.clear(); entry.usageUnknown = false; entry.dirty = true;
  }
  consume(call, record) {
    const entry = this.owned(call);
    if (!entry) return;
    if (call.agent === 'Codex') { codexConversation(entry.log, record, call.cwd); return; }
    const own = call.dispatch ? record : { ...record, isSidechain: false };
    claudeConversation(entry.log, own, call.cwd);
    if (call.startedAt !== null && Date.parse(own.timestamp) < call.startedAt) return;
    if (own.type !== 'assistant' || own.message?.model === '<synthetic>') return;
    const usage = own.message?.usage;
    const id = own.message?.id || own.uuid;
    if (entry.usageUnknown || !usage && (!id || entry.replies.has(id))) return;
    if (!id || entry.replies.size >= 4096 && !entry.replies.has(id)) { entry.usageUnknown = true; entry.replies.clear(); return; }
    const input = count(usage?.input_tokens), output = count(usage?.output_tokens);
    const cached = usage ? count(usage.cache_read_input_tokens ?? 0) : null, written = usage ? count(usage.cache_creation_input_tokens ?? 0) : null;
    entry.replies.set(id, { input: input === null || cached === null || written === null ? null : input + cached + written, cached, output });
  }
  totals(call) {
    const entry = this.owned(call), result = { inputTokens: null, cachedTokens: null, totalOutputTokens: null };
    if (!entry || call.startedAt === null || entry.partial || entry.usageUnknown || !entry.replies.size) return result;
    for (const [key, name] of [['inputTokens', 'input'], ['cachedTokens', 'cached'], ['totalOutputTokens', 'output']]) {
      const values = [...entry.replies.values()].map(value => value[name]);
      if (values.every(value => value !== null)) result[key] = count(values.reduce((sum, value) => sum + value, 0));
    }
    return result;
  }
  update(call, readable = call.viewable || false) {
    const entry = this.owned(call);
    if (!entry) return;
    entry.everReadable ||= readable;
    call.viewable = this.local && (readable || entry.completedAt != null && entry.everReadable);
    const header = { id: call.id, agent: call.agent, model: call.model, effort: call.effort ?? null, fast: call.fast ?? null,
      title: call.title, role: call.role, state: stateOf(call), failure: call.failure || null,
      startedAt: time(call.startedAt), endedAt: time(call.finishedAt), rate: call.rate ? { ...call.rate } : null };
    const signature = JSON.stringify([header, call.viewable]);
    if (!entry.dirty && entry.signature === signature) return;
    entry.signature = signature; entry.dirty = false; entry.revision++;
    entry.omitted ||= entry.log.list.length > ENTRY_LIMIT;
    const entries = entry.log.snapshot().slice(-ENTRY_LIMIT);
    if (entry.omitted && entries.length) entries[0] = { ...entries[0], omitted: true };
    entry.snapshot = { ...header, entries, revision: entry.revision };
    this.notify(entry);
  }
  notify(entry) {
    if (entry.timer) return;
    const remaining = PUSH_INTERVAL - (this.now() - entry.sentAt);
    if (remaining > 0) {
      this.notifications.add(entry);
      entry.timer = setTimeout(() => { this.notifications.delete(entry); entry.timer = null; this.send(entry); }, remaining);
      entry.timer.unref?.();
    } else this.send(entry);
  }
  send(entry) {
    entry.sentAt = this.now();
    try { this.changed({ callId: entry.call.id, revision: entry.revision }); } catch {}
  }
  finish(call) {
    const entry = this.owned(call);
    if (!entry || entry.completedAt != null) return;
    entry.completedAt = call.completedAt ?? this.now();
    this.update(call);
    this.prune();
  }
  retire(entry, updateActivity = true) {
    clearTimeout(entry.timer); entry.timer = null; this.notifications.delete(entry);
    this.entries.delete(entry.call.id); entry.call.viewable = false; entry.call.feedExpired = true;
    entry.revision++; this.notify(entry);
    if (updateActivity) this.retired();
  }
  prune() {
    clearTimeout(this.expiry); this.expiry = null;
    const completed = [...this.entries.values()].filter(entry => entry.completedAt != null).sort((a, b) => a.completedAt - b.completedAt);
    while (completed.length && (completed.length > FINAL_LIMIT || this.now() - completed[0].completedAt >= FINAL_TTL)) this.retire(completed.shift());
    if (completed.length) {
      this.expiry = setTimeout(() => this.prune(), Math.max(1, completed[0].completedAt + FINAL_TTL - this.now()));
      this.expiry.unref?.();
    }
  }
  reset(keep = null) {
    for (const entry of this.entries.values()) {
      if (keep && (keep.has(entry.call) || entry.completedAt != null)) continue;
      // The reset's caller replaces activity state; open splits still need the retirement revision.
      this.retire(entry, false);
    }
    this.prune();
  }
  async get(id) {
    this.prune();
    const entry = this.entries.get(id);
    if (!entry) throw new Error('gone');
    if (!this.local) throw new Error('unavailable');
    if (entry.completedAt == null) await this.read(entry.call);
    if (this.entries.get(id) !== entry) throw new Error('gone');
    if (!entry.call.viewable) throw new Error('unavailable');
    return structuredClone(entry.snapshot);
  }
  async location(call) {
    if (!this.local || !call.dispatch || !call.cwd || !/^[\w-]{1,160}$/.test(call.sessionId || '')) return null;
    const entry = this.owned(call);
    if (!entry) return null;
    entry.home ||= rootValue(call.agent === 'Codex' ? this.codexHome : this.claudeHome);
    const home = entry.home;
    if (!home || !path.isAbsolute(home)) return null;
    if (entry.location && await containedFile(entry.location.root, entry.location.filename)) return entry.location;
    if (call.agent === 'Codex') {
      const root = path.join(home, 'sessions'), filename = await findRolloutSession(root, call.sessionId, call.cwd);
      return entry.location = filename ? { root, filename } : null;
    }
    if (!path.isAbsolute(call.cwd)) return null;
    const filename = await findClaudeSession(call.cwd, call.sessionId, home, { strict: true });
    return entry.location = filename ? { root: path.join(home, 'projects'), filename } : null;
  }
  async readDispatch(call) {
    const entry = this.owned(call);
    if (!entry || !this.local || entry.completedAt != null) return;
    let readable = false;
    try {
      const location = await this.location(call);
      if (!location || this.entries.get(call.id) !== entry) return;
      if (entry.reader?.filename !== location.filename) {
        entry.reader = new TranscriptTail(location.filename, { onReset: async (partial, file) => {
          if (!await containedFile(location.root, location.filename, { file })) throw new Error('unavailable');
          const first = await sessionHeader(file);
          if (call.agent === 'Codex' && first?.type !== 'session_meta' || !ownsRecord(call, first)) throw new Error('unavailable');
          this.resetLog(call, partial);
        } });
      }
      readable = await entry.reader.read(record => {
        if (this.entries.get(call.id) !== entry) return;
        if (!ownsRecord(call, record)) throw new Error('unavailable');
        this.consume(call, record);
      });
    } catch { readable = false; entry.reader = null; entry.location = null; }
    finally {
      if (this.entries.get(call.id) === entry) {
        this.update(call, !!readable);
        call.feedDrained = !readable || entry.reader.offset >= entry.reader.fileSize;
        if (call.done && call.feedDrained) this.finish(call);
      }
    }
  }
}

module.exports = { SubagentFeeds, stateOf, time, rootValue, ENTRY_LIMIT, FINAL_LIMIT, FINAL_TTL, PUSH_INTERVAL };
