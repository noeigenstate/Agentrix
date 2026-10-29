const { promptText } = require('../../prompt-queue.cjs');

const emptyRate = partial => ({ outputTokens: 0, activeMs: 0, samples: 0, updatedAt: 0, partial });
const outputOf = usage => Number.isFinite(usage?.output_tokens) && usage.output_tokens >= 0 ? usage.output_tokens : null;
const modelOf = value => typeof value === 'string' && value && value !== '<synthetic>' ? value : null;
const LIMIT = 256;
const sameRate = (a, b) => a === b || !!a && !!b && a.model === b.model && a.outputTokens === b.outputTokens &&
  a.activeMs === b.activeMs && a.samples === b.samples && a.updatedAt === b.updatedAt;

// Binary-search indexes keep timestamp corrections and legacy records without UUIDs local.
class TimeIndex {
  constructor() { this.entries = []; this.order = 0; }
  position(at, after = false) {
    let lo = 0, hi = this.entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.entries[mid].at < at || after && this.entries[mid].at === at) lo = mid + 1; else hi = mid;
    }
    return lo;
  }
  entryPosition(entry) {
    let lo = this.position(entry.at), hi = this.position(entry.at, true);
    while (lo < hi) {
      const mid = (lo + hi) >>> 1, other = this.entries[mid];
      if (other.priority < entry.priority || other.priority === entry.priority && other.order < entry.order) lo = mid + 1; else hi = mid;
    }
    return lo;
  }
  add(value, at, priority = 0, order = ++this.order) {
    const entry = { value, at, priority, order };
    this.entries.splice(this.entryPosition(entry), 0, entry);
    return entry;
  }
  remove(entry) { if (entry) this.entries.splice(this.entryPosition(entry), 1); }
  before(at) {
    const previous = this.entries[this.position(at) - 1];
    return previous && this.entries[this.position(previous.at)].value;
  }
  get latest() { return this.entries.at(-1)?.at; }
}

// Each segment holds the counter fallbacks covering (previous endpoint, endpoint].
// Lookups preserve insertion order even when late records create overlapping intervals.
class FallbackIndex {
  constructor() { this.times = new TimeIndex(); this.ends = new Map(); }
  endpoint(at) {
    const index = this.times.position(at), entry = this.times.entries[index];
    if (entry?.at !== at) this.times.add(new Set(entry?.value), at);
    this.ends.set(at, (this.ends.get(at) || 0) + 1);
  }
  add(reply) {
    if (!Number.isFinite(reply.start) || !(reply.at > reply.start)) return;
    this.endpoint(reply.start); this.endpoint(reply.at);
    for (let i = this.times.position(reply.start, true); i < this.times.entries.length && this.times.entries[i].at <= reply.at; i++) {
      this.times.entries[i].value.add(reply);
    }
    reply.interval = { start: reply.start, at: reply.at };
  }
  remove(reply) {
    if (!reply.interval) return;
    const { start, at } = reply.interval;
    for (let i = this.times.position(start, true); i < this.times.entries.length && this.times.entries[i].at <= at; i++) {
      this.times.entries[i].value.delete(reply);
    }
    for (const time of [start, at]) {
      const count = this.ends.get(time) - 1;
      if (count) this.ends.set(time, count);
      else { this.ends.delete(time); this.times.entries.splice(this.times.position(time), 1); }
    }
    delete reply.interval;
  }
  find(at) { return this.times.entries[this.times.position(at)]?.value.values().next().value; }
}

// Completed-response latency, including prefill and transport. Reasoning is already in output_tokens.
// Keep only recent causal bookkeeping; older samples stay in the per-model sums.
class TokenRates {
  constructor(agent, { sidechain = false } = {}) { this.agent = agent; this.sidechain = sidechain; this.reset(); }
  reset(partial = false) {
    this.partial = partial; this.model = null; this.modelAt = -Infinity; this.rates = new Map(); this.frozenAt = new Map();
    this.rateTimes = new Map(); this.timeline = null; this.legacy = new TimeIndex(); this.fallbacks = new FallbackIndex();
    this.nodeWaiters = new Map(); this.toolWaiters = new Map(); this.replyWaiters = new Map(); this.pending = new Map();
    this.replies = new Map(); this.nodes = new Map(); this.prompts = []; this.results = new Map(); this.owners = new Map(); this.sealedAt = -Infinity;
    this.boundary = null; this.tools = new Map(); this.toolEntries = new Map(); this.clearTools();
    this.generation = null; this.counter = partial ? null : 0; this.credit = 0; this.turn = null;
  }
  snapshot(model = this.model) { return { ...(this.rates.get(model) || emptyRate(this.partial)), partial: this.partial }; }
  // Dispatch reports cumulative completed-response totals; replace, never add a repeated report.
  totals(model, outputTokens, activeMs, at) {
    this.setModel(model, at);
    this.rates.set(model, { outputTokens, activeMs, samples: activeMs > 0 ? 1 : 0, updatedAt: at, partial: false });
    return this.snapshot(model);
  }
  setModel(model, at) {
    if (Number.isFinite(at) && at < this.modelAt) return;
    this.model = model; this.modelAt = Number.isFinite(at) ? at : this.modelAt;
  }
  adjustRate(value, sign) {
    if (!value) return;
    const rate = this.rates.get(value.model) || emptyRate(this.partial);
    rate.outputTokens += sign * value.outputTokens; rate.activeMs += sign * value.activeMs; rate.samples += sign;
    this.rates.set(value.model, rate);
  }
  sample(reply, start) {
    const previous = reply.sample;
    const next = reply.model && reply.output != null && Number.isFinite(start) && reply.at > start
      ? { model: reply.model, outputTokens: reply.output, activeMs: reply.at - start, samples: 1, updatedAt: reply.at } : null;
    if (sameRate(previous, next) || !previous && !next) return;
    if (previous) this.rateTimes.get(previous.model).remove(reply.rateEntry);
    this.adjustRate(previous, -1); this.adjustRate(next, 1);
    reply.sample = next;
    if (next) {
      if (!this.rateTimes.has(next.model)) this.rateTimes.set(next.model, new TimeIndex());
      reply.rateEntry = this.rateTimes.get(next.model).add(reply, next.updatedAt);
    } else reply.rateEntry = null;
    for (const model of new Set([previous?.model, next?.model].filter(Boolean))) {
      this.rates.get(model).updatedAt = Math.max(this.frozenAt.get(model) || 0, this.rateTimes.get(model)?.latest || 0);
    }
  }
  invalidate(index, id) {
    const replies = index.get(id);
    if (replies) for (const reply of replies) this.pending.set(reply, true);
  }
  depend(reply, index, id) {
    if (!id) return;
    let replies = index.get(id);
    if (!replies) { replies = new Set(); index.set(id, replies); }
    if (replies.has(reply)) return;
    replies.add(reply); (reply.dependencies ||= []).push([index, id]);
  }
  unlink(reply) {
    if (!reply.dependencies) return;
    for (const [index, id] of reply.dependencies) {
      const replies = index.get(id);
      replies.delete(reply);
      if (!replies.size) index.delete(id);
    }
    reply.dependencies.length = 0;
  }
  remember(map, id, value, waiters) {
    if (!id) return;
    map.set(id, value);
    this.invalidate(waiters, id);
    if (map.size > LIMIT * 8) {
      const oldest = map.keys().next().value;
      map.delete(oldest);
      this.invalidate(waiters, oldest);
    }
  }
  invalidateLegacy(at) {
    const until = this.timeline.entries[this.timeline.position(at, true)]?.at ?? Infinity;
    for (let i = this.legacy.position(at, true); i < this.legacy.entries.length && this.legacy.entries[i].at <= until; i++) {
      this.pending.set(this.legacy.entries[i].value, true);
    }
  }
  moveTimeline(value, remove = false) {
    if (!this.timeline) return;
    const previous = value.timeEntry;
    if (!remove && previous?.at === value.at) return;
    if (previous) { this.timeline.remove(previous); this.invalidateLegacy(previous.at); }
    if (!remove) {
      value.timeEntry = this.timeline.add(value, value.at, value.prompt ? 0 : 1, previous?.order);
      this.invalidateLegacy(value.at);
    }
  }
  ensureTimeline() {
    if (this.timeline) return;
    // UUID-based transcripts never need the legacy timestamp index. Build it once on demand.
    this.timeline = new TimeIndex();
    for (const value of this.prompts) value.timeEntry = this.timeline.add(value, value.at);
    for (const value of this.replies.values()) value.timeEntry = this.timeline.add(value, value.at, 1);
  }
  trim() {
    if (this.replies.size <= LIMIT) return;
    const [id, reply] = this.replies.entries().next().value;
    if (reply.sample) {
      this.frozenAt.set(reply.sample.model, Math.max(this.frozenAt.get(reply.sample.model) || 0, reply.sample.updatedAt));
      this.rateTimes.get(reply.sample.model).remove(reply.rateEntry);
    }
    this.sealedAt = Math.max(this.sealedAt, reply.at); this.replies.delete(id);
    this.invalidate(this.replyWaiters, id); this.unlink(reply); this.pending.delete(reply);
    this.legacy.remove(reply.legacyEntry);
    if (reply.timeEntry) this.moveTimeline(reply, true);
    this.fallbacks.remove(reply);
  }
  apply(record) {
    if (this.agent === 'claude' && (record.isSidechain && !this.sidechain || !record.uuid && !record.message && !this.pending.size)) return false;
    const model = this.model, before = this.rates.get(model);
    const output = before?.outputTokens || 0, active = before?.activeMs || 0, samples = before?.samples || 0, updated = before?.updatedAt || 0;
    if (this.agent === 'claude') this.claude(record); else this.codex(record);
    const after = this.rates.get(this.model);
    return model !== this.model || output !== (after?.outputTokens || 0) || active !== (after?.activeMs || 0) ||
      samples !== (after?.samples || 0) || updated !== (after?.updatedAt || 0);
  }
  claudeStart(reply) {
    let parent = reply.parent;
    const seen = new Set();
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      this.depend(reply, this.nodeWaiters, parent);
      const node = this.nodes.get(parent);
      if (!node) return reply.start ?? null;
      if (node.prompt) return node.at;
      if (node.reply && node.reply !== reply.id) {
        this.depend(reply, this.replyWaiters, node.reply);
        return this.afterTools(this.replies.get(node.reply), reply);
      }
      if (node.tool) {
        this.depend(reply, this.toolWaiters, node.tool);
        const owner = this.owners.get(node.tool);
        this.depend(reply, this.replyWaiters, owner);
        return this.afterTools(this.replies.get(owner), reply);
      }
      parent = node.parent;
    }
    if (reply.parent) return null;
    // Older formats may omit UUIDs. Time can order a delivered prompt and a known tool batch,
    // but an assistant reply by itself is never a new generation boundary.
    const previous = this.timeline.before(reply.at);
    return previous?.prompt ? previous.at : this.afterTools(previous, reply);
  }
  afterTools(previous, reply) {
    if (!previous) return reply.start ?? null;
    this.depend(reply, this.replyWaiters, previous.id);
    if (!previous.tools.size) return null;
    let at = previous.at;
    for (const id of previous.tools) {
      this.depend(reply, this.toolWaiters, id);
      const result = this.results.get(id);
      if (!result) return reply.previous === previous.id && reply.toolCount === previous.tools.size ? reply.start : null;
      if (result.at < previous.at || result.at >= reply.at) return null;
      at = Math.max(at, result.at);
    }
    reply.previous = previous.id; reply.toolCount = previous.tools.size;
    return at;
  }
  claudeReply(record, at, content) {
    const message = record.message, id = message.id;
    this.setModel(modelOf(message.model), at);
    if (!id || at <= this.sealedAt) return null;
    let reply = this.replies.get(id);
    const previousAt = reply?.at;
    let changed = !reply, toolsChanged = false;
    if (!reply) {
      reply = { id, parent: record.parentUuid, at, model: null, output: null, tools: new Set(), start: null,
        previous: null, toolCount: 0, sample: null, dependencies: [], rateEntry: null, timeEntry: null, legacyEntry: null };
      this.replies.set(id, reply);
    }
    if (!(at < reply.at)) {
      const model = modelOf(message.model), output = outputOf(message.usage);
      changed ||= at !== reply.at || model !== reply.model || output !== reply.output;
      reply.at = at; reply.model = model; reply.output = output;
    }
    if (changed && !this.pending.has(reply)) this.pending.set(reply, false);
    if (!reply.parent && reply.legacyEntry?.at !== reply.at) {
      this.ensureTimeline();
      this.legacy.remove(reply.legacyEntry); reply.legacyEntry = this.legacy.add(reply, reply.at);
    }
    this.moveTimeline(reply);
    for (const block of content) if (block.type === 'tool_use' && block.id) {
      if (!reply.tools.has(block.id)) { reply.tools.add(block.id); toolsChanged = true; }
      if (this.owners.get(block.id) !== id) this.remember(this.owners, block.id, id, this.toolWaiters);
    }
    if (reply.at !== previousAt || toolsChanged) this.invalidate(this.replyWaiters, id);
    return id;
  }
  claude(record) {
    if (record.isSidechain && !this.sidechain) return;
    const at = Date.parse(record.timestamp), message = record.message;
    const assistant = record.type === 'assistant' && message && message.model !== '<synthetic>' && (typeof message.model === 'string' || message.usage);
    if (!Number.isFinite(at)) {
      if (assistant) this.setModel(modelOf(message.model), at);
      return;
    }
    const node = { at, parent: record.parentUuid, prompt: false, tool: null, reply: null };
    const content = Array.isArray(message?.content) ? message.content : [];
    const prompt = record.type === 'user' && promptText(message?.content, record.isSidechain ? { ...record, isSidechain: false } : record) !== null;
    if (prompt) {
      node.prompt = true; this.prompts.push(node); this.moveTimeline(node);
      if (this.prompts.length > LIMIT) this.moveTimeline(this.prompts.shift(), true);
    }
    for (const block of content) if (record.type === 'user' && block.type === 'tool_result' && block.tool_use_id) {
      if (at < (this.results.get(block.tool_use_id)?.at ?? Infinity)) this.remember(this.results, block.tool_use_id, { at }, this.toolWaiters);
      node.tool = block.tool_use_id;
    }
    if (assistant) node.reply = this.claudeReply(record, at, content);
    this.remember(this.nodes, record.uuid, node, this.nodeWaiters);
    // Prompts can arrive after the reply they caused; a later block can also complete a tool batch.
    if (!this.pending.size) return;
    for (const [reply, recheck] of this.pending) {
      // A later block with unchanged ancestry can reuse its already validated boundary.
      let start = reply.start;
      if (recheck || !reply.sample || !reply.parent) { this.unlink(reply); start = this.claudeStart(reply); }
      if (Number.isFinite(start)) reply.start = start;
      this.sample(reply, start);
    }
    this.pending.clear();
    this.trim();
  }
  clearTools() { this.tools.clear(); this.toolEntries.clear(); this.pendingTools = 0; this.toolTimes = new TimeIndex(); }
  completeTool(id, at) {
    if (this.tools.get(id) == null) this.pendingTools--;
    this.toolTimes.remove(this.toolEntries.get(id));
    this.tools.set(id, at); this.toolEntries.set(id, this.toolTimes.add(id, at));
  }
  codex(record) {
    const payload = record.payload || {}, at = Date.parse(record.timestamp), type = payload.type;
    if (record.type === 'turn_context') { this.setModel(modelOf(payload.model), at); return; }
    if (!Number.isFinite(at)) return;
    const event = record.type === 'event_msg';
    if (event && ['task_started', 'turn_started', 'turn_aborted', 'turn_interrupted', 'task_complete', 'turn_completed'].includes(type)) {
      this.boundary = null; this.clearTools(); this.generation = null;
      this.turn = ['task_started', 'turn_started'].includes(type) ? payload.turn_id || null : null;
      return;
    }
    const item = event && type === 'item_completed' ? payload.item : record.type === 'response_item' ? payload : null;
    const content = event && type === 'user_message' ? payload.message : item?.type === 'message' && item.role === 'user' ? item.content : item?.type === 'UserMessage' ? item.content : null;
    if (content != null && promptText(content, { ...record, ...payload, ...item }) !== null) {
      if (this.boundary == null) this.boundary = at;
      return;
    }
    const modelItem = item && (['function_call', 'custom_tool_call', 'local_shell_call', 'reasoning'].includes(item.type) || item.type === 'message' && item.role === 'assistant');
    if (modelItem && !this.generation && this.boundary != null && !this.pendingTools) this.clearTools();
    if (item && ['function_call', 'custom_tool_call', 'local_shell_call'].includes(item.type)) {
      const id = item.call_id || item.id;
      if (id && !this.tools.has(id)) { this.tools.set(id, null); this.pendingTools++; }
    }
    if (item && (['function_call_output', 'custom_tool_call_output', 'local_shell_call_output'].includes(item.type) || Number.isFinite(item.completed_at_ms))) {
      const id = item.call_id || item.id;
      if (this.tools.has(id)) {
        const completed = Number.isFinite(item.completed_at_ms) ? item.completed_at_ms : at;
        if (this.tools.get(id) == null || Number.isFinite(item.completed_at_ms)) this.completeTool(id, completed);
        this.boundary = this.pendingTools ? null : this.toolTimes.latest;
      }
      return;
    }
    if (modelItem && (this.boundary != null || this.generation)) {
      this.generation ||= { start: this.boundary, model: this.model };
      this.generation.at = Math.max(this.generation.at ?? -Infinity, at);
      if (this.tools.size) this.boundary = null;
    }
    const modern = record.type === 'token_usage_record' || event && type === 'token_usage_record';
    if (modern) {
      const output = outputOf(payload.usage), total = outputOf(payload.thread_token_usage);
      const id = payload.response_id || (total != null ? `total:${total}` : null);
      if (!id || output == null || at <= this.sealedAt) return;
      let reply = this.replies.get(id);
      const fresh = !reply;
      const fallback = total != null ? this.replies.get(`counter:${total}`) : this.fallbacks.find(at);
      if (!reply && fallback) {
        // A usage record can be appended after its counter. Replace that sample's end time,
        // retaining the model/boundary captured for that response rather than the current turn.
        reply = fallback;
        this.replies.delete(reply.key); this.fallbacks.remove(reply);
        this.replies.set(id, reply); reply.fallback = false;
      }
      if (!reply && payload.turn_id && this.turn && payload.turn_id !== this.turn) return;
      if (!reply && output > 0 && total != null && this.counter != null && total <= this.counter) return;
      if (!reply) {
        reply = { start: this.generation?.start ?? this.boundary, model: this.generation ? this.generation.model : this.model };
        this.replies.set(id, reply);
        if (total == null) this.credit += output;
      }
      reply.key = id;
      if (total != null && (this.counter == null || total >= this.counter)) { this.counter = total; this.credit = 0; }
      if (!fallback && at < reply.at) return;
      if (reply.fallback) this.fallbacks.remove(reply);
      reply.at = at; reply.output = output;
      if (reply.fallback) this.fallbacks.add(reply);
      this.sample(reply, reply.start); this.trim();
      if (!fresh || fallback) return;
      if (!this.pendingTools && (this.toolTimes.latest ?? -Infinity) <= at) this.clearTools();
      if (!this.tools.size || this.pendingTools) this.boundary = null;
      this.generation = null;
      return;
    }
    if (!event || type !== 'token_count') return;
    const total = outputOf(payload.info?.total_token_usage);
    if (total == null || this.counter != null && total <= this.counter) return;
    const delta = this.counter == null ? 0 : total - this.counter;
    const output = Math.max(0, delta - this.credit);
    this.credit = Math.max(0, this.credit - delta); this.counter = total;
    if (!output) return;
    const generation = this.generation || { start: this.tools.size ? null : this.boundary, at, model: this.model };
    const reply = { ...generation, output, fallback: true, key: `counter:${total}` };
    this.sample(reply, generation.start);
    this.replies.set(reply.key, reply); this.fallbacks.add(reply); this.trim();
    if (!this.tools.size) this.boundary = null;
    this.generation = null;
  }
}

module.exports = { TokenRates, emptyRate };
