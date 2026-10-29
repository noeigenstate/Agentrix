const fs = require('node:fs/promises');
const path = require('node:path');
const { claudePrompt, TranscriptTail } = require('../../agent-actions.cjs');
const { TokenRates, emptyRate } = require('./token-rate.cjs');
const { agentSettings } = require('./agent-settings.cjs');

const text = value => typeof value === 'string' ? value : '';
const short = value => text(value).replace(/\s+/g, ' ').trim().slice(0, 240);
const enabled = value => value === true || value === 'true';
const agentRoles = new Map(Object.entries({ Explore: '搜索', Plan: '规划', 'general-purpose': '通用', claude: '通用', none: '通用', fork: '分身' }));

class AgentCalls {
  constructor({ changed = () => {}, local = true } = {}) {
    this.changed = changed; this.local = local; this.folder = null;
    this.reset();
  }
  reset(preserveDispatch = false) {
    clearTimeout(this.timer);
    const dispatched = [...(this.calls || [])].filter(([, call]) => preserveDispatch && call.dispatch);
    for (const call of this.calls?.values() || []) if (!preserveDispatch || !call.dispatch) clearTimeout(call.expiry);
    this.timer = null; this.calls = new Map(dispatched); this.polls = new Map(); this.meta = new Map(); this.pending = new Set(); this.work = null;
  }
  setFolder(folder) { if (folder !== this.folder) { this.reset(true); this.folder = folder; } }
  snapshot(provider) {
    const groups = new Map();
    for (const call of this.calls.values()) {
      if (call.reviewed) continue;
      const route = { agent: call.agent, provider: call.dispatch ? null : provider ?? null, model: call.model, effort: call.effort, fast: call.fast };
      const key = JSON.stringify(route);
      if (!groups.has(key)) groups.set(key, { ...route, preparing: 0, running: 0, reviewing: 0, tasks: [], items: [], rate: emptyRate(false) });
      const group = groups.get(key);
      if (!call.rate) group.rate = null;
      else if (group.rate) {
        group.rate.outputTokens += call.rate.outputTokens; group.rate.activeMs += call.rate.activeMs; group.rate.samples += call.rate.samples;
        group.rate.updatedAt = Math.max(group.rate.updatedAt, call.rate.updatedAt); group.rate.partial ||= call.rate.partial;
      }
      let state = call.preparing ? 'preparing' : 'running';
      if (call.done) state = call.dispatch && !call.failure ? 'done' : 'reviewing';
      if (state !== 'done') group[state]++;
      group.items.push({ state, role: call.role, title: call.title,
        ...(call.dispatch ? { failure: call.failure || null, ...(call.declared ? { declared: call.declared } : {}) } : {}) });
      if (call.task) { group.tasks = group.tasks.filter(task => task !== call.task); group.tasks.push(call.task); group.tasks = group.tasks.slice(-5); }
    }
    for (const group of groups.values()) group.items.reverse();
    return [...groups.values()];
  }
  dispatch(event) {
    const call = this.calls.get(event.id);
    if (event.type === 'dispatch-start') {
      if (call || this.calls.size >= 1024) return false;
      this.calls.set(event.id, { dispatch: true, agent: event.agent === 'codex' ? 'Codex' : 'Claude Code',
        model: event.model, effort: event.effort, fast: event.fast, declared: event.declared,
        role: event.role, title: event.title, task: short(event.title), sessionId: event.sessionId,
        startedAt: event.startedAt, done: false, rate: null, meter: new TokenRates(event.agent) });
      return true;
    }
    if (!call?.dispatch || call.done || call.reviewed) return false;
    if (event.type === 'dispatch-rate') {
      if (call.rate && (event.outputTokens < call.rate.outputTokens || event.activeMs < call.rate.activeMs)) return false;
      call.rate = call.meter.totals(call.model, event.outputTokens, event.activeMs, Date.now());
      return true;
    }
    if (event.type !== 'dispatch-end') return false;
    call.done = true; call.finishedAt = event.endedAt;
    call.model = event.model; call.effort = event.effort; call.fast = event.fast;
    call.rate = event.outputTokens === null || event.activeMs === null ? null
      : call.meter.totals(call.model, event.outputTokens, event.activeMs, event.endedAt);
    call.failure = event.reason === 'exit' && event.exitCode === 0 ? null
      : { reason: event.reason === 'exit' ? 'error' : event.reason, exitCode: event.exitCode };
    call.pendingReview = !!call.failure;
    if (!call.failure) {
      call.expiry = setTimeout(() => {
        if (this.calls.get(event.id) !== call) return;
        // Retain the receipt so a delayed duplicate start cannot resurrect a completed row.
        call.reviewed = true; this.changed();
      }, 3000);
      call.expiry.unref();
    }
    return true;
  }
  review(at, prompt = false) {
    let changed = false;
    for (const call of this.calls.values()) {
      if ((call.dispatch && !call.failure) || !call.done || call.reviewed || call.finishedAt > at || (call.pendingReview && !prompt)) continue;
      call.reviewed = true; changed = true;
    }
    return changed;
  }
  apply(record) {
    if (record.isSidechain) return false;
    const content = record.message?.content;
    const at = Date.parse(record.timestamp);
    let changed = false;
    for (const block of Array.isArray(content) ? content : []) {
      if (record.type === 'assistant' && block.type === 'tool_use' && ['BashOutput', 'TaskOutput', 'TaskStop', 'KillShell'].includes(block.name)) {
        const task = block.input?.bash_id || block.input?.task_id || block.input?.shell_id;
        if (typeof block.id === 'string' && typeof task === 'string' && task) this.polls.set(block.id, { task, stop: ['TaskStop', 'KillShell'].includes(block.name) });
        continue;
      }
      if (record.type === 'assistant' && block.type === 'tool_use' && typeof block.id === 'string' && !this.calls.has(block.id)) {
        if (block.name !== 'Agent') continue;
        const input = block.input || {};
        const settings = { model: text(input.model) || 'default', effort: text(input.effort).trim() || null, fast: null };
        this.calls.set(block.id, {
          agent: 'Claude Code', provider: null, ...settings, requested: settings, rate: null,
          task: short(input.description || block.description || input.subagent_type || block.name),
          title: text(input.description || block.description || input.subagent_type || block.name).replace(/\s+/g, ' ').trim(),
          role: agentRoles.get(input.subagent_type) || text(input.subagent_type) || '通用',
          background: enabled(input.run_in_background), done: false, preparing: this.local && !!this.folder,
        });
        this.refresh(block.id);
        changed = true;
      } else if (record.type === 'user' && block.type === 'tool_result') {
        const result = record.toolUseResult || {}, poll = this.polls.get(block.tool_use_id);
        if (poll) {
          this.polls.delete(block.tool_use_id);
          const task = result.task?.task_id || result.task_id || poll.task;
          const call = [...this.calls.values()].find(call => call.backgroundTaskId === task || (poll.stop && call.agentId === task));
          if (call && !call.reviewed && (!call.done || call.pendingReview) && !block.is_error && (poll.stop || /^(?:completed|failed|killed)$/.test(result.task?.status || result.status))) {
            call.done = true; call.finishedAt = at; call.pendingReview = false; changed = true;
          }
          continue;
        }
        const call = this.calls.get(block.tool_use_id);
        if (!call || call.reviewed) continue;
        call.background ||= enabled(result.isAsync) || !!result.backgroundTaskId;
        if (typeof result.backgroundTaskId === 'string' && result.backgroundTaskId) call.backgroundTaskId = result.backgroundTaskId;
        if ((block.is_error || !call.background) && !call.done) { call.done = true; call.finishedAt = at; changed = true; }
        if (call.agent === 'Claude Code') {
          if (typeof result.resolvedModel === 'string' && result.resolvedModel) {
            call.resultModel = result.resolvedModel;
            const model = call.meter?.model || result.resolvedModel;
            changed ||= call.model !== model; call.model = model;
          }
          if (typeof result.agentId === 'string' && /^[\w-]+$/.test(result.agentId)) call.agentId = result.agentId;
          this.refresh(block.tool_use_id);
        }
      }
    }
    // An enqueue ends the worker; its delivered notification starts the lead's review round.
    let hasNotification = false;
    const queued = record.type === 'queue-operation';
    if (record.type === 'user' || (queued && ['enqueue', 'remove'].includes(record.operation)) || record.attachment?.type === 'queued_command') {
      const notificationContent = queued ? text(record.content) : record.attachment?.prompt ?? content;
      const body = typeof notificationContent === 'string' ? notificationContent : (Array.isArray(notificationContent) ? notificationContent.filter(block => block.type === 'text').map(block => text(block.text)).join('\n') : '');
      for (const [notification] of body.matchAll(/<task-notification>[\s\S]*?<\/task-notification>/g)) {
        hasNotification = true;
        let id = /<tool-use-id>\s*([^<]+?)\s*<\/tool-use-id>/.exec(notification)?.[1];
        const taskId = /<task-id>\s*([^<]+?)\s*<\/task-id>/.exec(notification)?.[1];
        if (!/<status>\s*(?:completed|failed|killed)\s*<\/status>/.test(notification)) continue;
        // Dispatch has its own UUID, not a transcript tool-use id. Delivery opens the lead's next review round.
        if (!queued || record.operation === 'remove') for (const call of this.calls.values()) {
          if (call.dispatch && call.failure && call.finishedAt <= at) call.pendingReview = false;
        }
        if (!this.calls.has(id) && taskId) id = [...this.calls].find(([, call]) => call.backgroundTaskId === taskId || call.agentId === taskId)?.[0];
        const call = this.calls.get(id);
        if (!call || call.reviewed) continue;
        if (queued && record.operation === 'remove' && !call.done) continue;
        if (!call.done) {
          call.done = true; call.finishedAt = at; call.pendingReview = queued; changed = true;
        }
        if (call.pendingReview && (!queued || record.operation === 'remove')) { call.pendingReview = false; call.finishedAt = at; }
      }
    }
    // The app completes Claude rounds on Stop. Use that hook's transcript record, not assistant text or idle time.
    const prompt = claudePrompt(record) && !hasNotification;
    if (prompt || (record.type === 'system' && record.subtype === 'stop_hook_summary')) {
      changed = this.review(at, prompt) || changed;
    }
    for (const [id, call] of this.calls) if (call.done && !call.drained) this.refresh(id);
    this.schedule();
    return changed;
  }
  follows(call) {
    return this.local && !call.dispatch && this.folder && (call.done ? !call.drained : !call.reviewed);
  }
  // Follow running workers too; generation identity cancels even an already queued callback.
  schedule() {
    const active = [...this.calls.values()].filter(call => this.follows(call));
    if (!active.length) { clearTimeout(this.timer); this.timer = null; return; }
    if (this.timer || this.work) return;
    const calls = this.calls;
    this.timer = setTimeout(() => {
      if (this.calls !== calls) return;
      this.timer = null;
      for (const [id, call] of calls) if (this.follows(call)) this.refresh(id);
    }, active.some(call => !call.preparing) ? 1000 : 2500);
    this.timer.unref();
  }
  // Batch related history records; bound workers retain offsets and partial lines.
  refresh(id) {
    if (!this.local || !this.folder || this.calls.get(id)?.dispatch) return;
    clearTimeout(this.timer); this.timer = null;
    this.pending.add(id);
    if (this.work) return;
    const calls = this.calls, pending = this.pending, folder = this.folder;
    this.work = Promise.resolve().then(async () => {
      while (pending.size && this.calls === calls) {
        const ids = new Set(pending); pending.clear();
        const before = new Map([...ids].map(id => [id, this.signature(calls.get(id))]));
        await this.readModels(folder, ids, calls);
        if (this.calls !== calls) return;
        for (const id of ids) {
          const call = calls.get(id);
          if (!call) continue;
          if (call.done && (!call.rate || call.reader?.offset >= call.reader?.fileSize)) call.drained = true;
        }
        if ([...ids].some(id => !calls.get(id)?.reviewed && before.get(id) !== this.signature(calls.get(id)))) this.changed();
      }
    }).catch(() => {}).finally(() => { if (this.calls === calls) { this.work = null; this.schedule(); } });
  }
  signature(call) { return JSON.stringify(call && [call.model, call.effort, call.fast, call.preparing, call.title, call.role, call.rate]); }
  async readSubagent(call, filename, calls, meta) {
    if (call.reader?.filename !== filename) {
      Object.assign(call, call.requested);
      call.model = call.resultModel || call.model; call.rate = null;
      call.meter = new TokenRates('claude', { sidechain: true });
      call.reader = filename ? new TranscriptTail(filename, { onReset: partial => {
        call.meter.reset(partial); Object.assign(call, call.requested);
      } }) : null;
    }
    if (!call.reader) { call.model = call.resultModel || text(meta?.model) || call.requested.model; return; }
    const readable = await call.reader.read(record => {
      if (this.calls !== calls) return;
      const settings = agentSettings(null, 'claude', { ...record, isSidechain: false });
      if (settings) { call.effort = settings.effort ?? call.effort; call.fast = settings.fast ?? call.fast; }
      call.meter.apply(record);
      if (record.type === 'assistant' || record.type === 'token_usage_record') call.preparing = false;
    }).catch(() => false);
    if (this.calls !== calls) return;
    call.rate = readable ? call.meter.snapshot() : null;
    call.effort ??= text(meta?.effort).trim() || null;
    call.model = call.meter.model || call.resultModel || text(meta?.model) || call.requested.model;
  }
  async readModels(folder, ids, calls) {
    ids = new Set([...ids].filter(id => calls.get(id)?.agent === 'Claude Code' && !calls.get(id).dispatch));
    if (!folder || !ids.size) return;
    const files = [...ids].some(id => !calls.get(id).filename) ? await fs.readdir(folder).catch(() => []) : [...ids].map(id => path.basename(calls.get(id).filename).replace(/\.jsonl$/, '.meta.json'));
    if (this.calls !== calls) return;
    const matches = new Map();
    for (const name of files) {
      if (!/^agent-[\w-]+\.meta\.json$/.test(name)) continue;
      const filename = path.join(folder, name), stat = await fs.stat(filename).catch(() => null);
      if (this.calls !== calls) return;
      if (!stat || stat.size > 64 * 1024) continue;
      let entry = this.meta.get(filename);
      if (!entry || entry.at !== stat.mtimeMs || entry.size !== stat.size) {
        try { entry = { at: stat.mtimeMs, size: stat.size, value: JSON.parse(await fs.readFile(filename, 'utf8')) }; } catch { continue; }
        if (this.calls !== calls) return;
        this.meta.set(filename, entry);
      }
      if (ids.has(entry.value?.toolUseId)) {
        const id = entry.value.toolUseId;
        if (!matches.has(id)) matches.set(id, { ...entry.value, filename: filename.replace(/\.meta\.json$/, '.jsonl') });
        else matches.set(id, null);
      }
    }
    for (const id of ids) {
      const call = calls.get(id), meta = matches.get(id);
      const filename = matches.has(id) && !meta ? null : meta?.filename || (call?.agentId && path.join(folder, `agent-${call.agentId}.jsonl`)) || call?.filename;
      if (!call || this.calls !== calls) continue;
      call.filename = filename || null;
      await this.readSubagent(call, call.filename, calls, meta);
      if (this.calls !== calls || this.folder !== folder) return;
    }
  }
}

module.exports = { AgentCalls };
