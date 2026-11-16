const DONE_LIMIT = 10;
const DONE_AGE = 30 * 60 * 1000;
const TAIL_LINES = 200;
const text = value => typeof value === 'string' ? value : '';
const enabled = value => value === true || value === 'true';
const terminal = value => /^(?:completed|failed|killed|stopped)$/.test(text(value));
const polls = new Set(['BashOutput', 'TaskOutput']);
const stops = new Set(['KillShell', 'TaskStop']);
const body = content => typeof content === 'string' ? content : (Array.isArray(content) ? content.filter(block => block?.type === 'text').map(block => text(block.text)).join('\n') : '');
const tag = (content, name) => new RegExp(`<${name}>\\s*([^<]+?)\\s*</${name}>`).exec(content)?.[1];

// Consume the host's existing raw transcript stream, including workOnly prefix records before its early return.
// One instance belongs to one terminal and transcript binding; reset it when that binding changes. No file reads,
// timers, completion callbacks or process checks: absent end receipts leave the last observed state running.
class BackgroundTasks {
  constructor(terminalId, { now = Date.now } = {}) {
    this.terminalId = terminalId; this.now = now; this.reset();
  }
  reset() {
    this.entries = new Map(); this.tools = new Map(); this.aliases = new Map();
    // Keep identities after a completed row retires, so history/live overlap cannot resurrect it or repeat output.
    this.received = new Set(); this.ends = new Map();
  }
  apply(record) {
    if (!record || record.isSidechain || record.parent_tool_use_id || record.isCompactSummary || record.message?.model === '<synthetic>') return false;
    const at = Date.parse(record.timestamp);
    if (!Number.isFinite(at)) return false;
    let changed = false;
    const content = record.message?.content;
    for (const block of Array.isArray(content) ? content : []) {
      if (record.type === 'assistant' && !record.isMeta && block?.type === 'tool_use') changed = this.use(block, at) || changed;
      else if (record.type === 'user' && !record.isMeta && block?.type === 'tool_result') changed = this.result(block, record.toolUseResult || {}, at) || changed;
    }
    const queued = record.type === 'queue-operation';
    if (queued && ['enqueue', 'remove'].includes(record.operation) || record.type === 'user' || record.attachment?.type === 'queued_command') {
      const content = body(queued ? record.content : record.attachment?.prompt ?? record.message?.content);
      for (const [notice] of content.matchAll(/<task-notification>[\s\S]*?<\/task-notification>/g)) {
        if (!terminal(tag(notice, 'status'))) continue;
        changed = this.end(tag(notice, 'tool-use-id'), tag(notice, 'task-id'), at) || changed;
      }
    }
    return this.prune() || changed;
  }
  use(block, at) {
    if (!text(block.id) || this.tools.has(block.id) || this.received.has(block.id)) return false;
    const input = block.input || {};
    if (block.name === 'Bash' && text(input.command)) {
      const call = { name: block.name, id: block.id, command: input.command, at };
      this.tools.set(block.id, call);
      return enabled(input.run_in_background) && this.start(call);
    }
    if (polls.has(block.name) || stops.has(block.name)) {
      const target = input.task_id || input.bash_id || input.shell_id;
      if (text(target)) this.tools.set(block.id, { name: block.name, target });
    }
    return false;
  }
  start(call, taskId = null) {
    let entry = this.entries.get(call.id), changed = !entry;
    if (!entry) {
      entry = { id: call.id, command: call.command, terminalId: this.terminalId, startedAt: call.at, state: 'running', exitCode: null };
      this.entries.set(call.id, entry);
    }
    if (taskId) this.aliases.set(taskId, call.id);
    for (const notice of [...(this.ends.get(call.id) || []), ...(this.ends.get(taskId) || [])]) {
      changed = this.end(notice.toolId, notice.taskId, notice.at) || changed;
    }
    return changed;
  }
  end(toolId, taskId, at) {
    const bound = this.aliases.get(taskId);
    if (toolId && bound && bound !== toolId) return false;
    const id = toolId || bound || taskId;
    if (!id) return false;
    const entry = this.entries.get(id);
    if (entry) return this.finish(entry, at);
    if (this.received.has(id)) return false;
    // Preserve separate receipts until binding: an old timestamp must not hide a later valid completion.
    for (const key of new Set([toolId, taskId].filter(Boolean))) {
      const pending = this.ends.get(key) || [];
      if (!pending.some(notice => notice.at === at && notice.toolId === toolId && notice.taskId === taskId)) pending.push({ toolId, taskId, at });
      this.ends.set(key, pending);
    }
    return false;
  }
  result(block, result, at) {
    const call = this.tools.get(block.tool_use_id);
    if (!call || at < (call.at ?? -Infinity)) return false;
    this.tools.delete(block.tool_use_id); this.received.add(block.tool_use_id);
    const structured = typeof result.stdout === 'string' || typeof result.stderr === 'string';
    if (call.name === 'Bash') {
      // The structured ID is captured in 2.1.312. Accept the CLI's plain launch acknowledgment only as metadata,
      // never as command output. Unrecognized acknowledgments cannot prove that a task ended.
      const taskId = text(result.backgroundTaskId) || (!structured && /\brunning in background with ID:?\s+([\w-]+)/i.exec(body(block.content))?.[1]);
      let changed = !block.is_error && taskId ? this.start(call, taskId) : false;
      const entry = this.entries.get(call.id);
      if (!entry) return changed;
      changed = this.output(entry, result, at) || changed;
      if (block.is_error || structured && !taskId) changed = this.finish(entry, at) || changed;
      return changed;
    }
    if (block.is_error) return false;
    // Poll/stop compatibility follows AgentCalls' existing receipt contract, not an inferred English summary.
    const target = result.task?.task_id || result.task_id || call.target;
    if (target !== call.target) return false;
    const entry = this.entries.get(this.aliases.get(target) || target);
    if (!entry) return false;
    let changed = polls.has(call.name) && this.output(entry, result, at);
    if (stops.has(call.name) || terminal(result.task?.status || result.status)) changed = this.finish(entry, at) || changed;
    return changed;
  }
  output(entry, result, at) {
    if (result.isImage || at < entry.startedAt || at < (entry.lastOutputAt ?? -Infinity)) return false;
    // Keep the latest inline stdout/stderr observation. Polling identical cached output does not make it newer.
    const output = [text(result.stdout), text(result.stderr)].filter(Boolean).join('\n');
    if (!output) return false;
    // The renderer contract is `tail?: string[]`: the last lines, one string each.
    const tail = output.replace(/\r\n?/g, '\n').split('\n').slice(-TAIL_LINES);
    if (entry.tail && tail.join('\n') === entry.tail.join('\n')) return false;
    entry.tail = tail; entry.lastOutputAt = at;
    return true;
  }
  finish(entry, at) {
    if (at < entry.startedAt || entry.state === 'done' && at >= entry.endedAt) return false;
    entry.state = 'done'; entry.endedAt = at;
    return true;
  }
  prune() {
    const done = [...this.entries.values()].filter(entry => entry.state === 'done').sort((a, b) => b.endedAt - a.endedAt);
    let changed = false;
    for (const [index, entry] of done.entries()) {
      if (index < DONE_LIMIT && this.now() - entry.endedAt <= DONE_AGE) continue;
      this.entries.delete(entry.id); changed = true;
    }
    return changed;
  }
  snapshot() {
    this.prune();
    return [...this.entries.values()].map(entry => ({ ...entry, ...(entry.tail ? { tail: [...entry.tail] } : {}) }));
  }
}

// Integration attaches after the usage snapshot (including any retained history); BG never mutates its owner.
function attach(usage, entries) {
  return { ...usage, background: entries.map(entry => ({ ...entry })) };
}

module.exports = { BackgroundTasks, attach };
