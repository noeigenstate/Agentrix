const fs = require('node:fs/promises');
const path = require('node:path');
const { claudePrompt, TranscriptTail } = require('../../agent-actions.cjs');
const { TokenRates, emptyRate } = require('./token-rate.cjs');
const { agentSettings } = require('./agent-settings.cjs');
const { taskKind } = require('../dashboard/records-routing.cjs');
const { containedFile } = require('../../session-files.cjs');
const { SubagentFeeds, stateOf, shownModel, time, rootValue } = require('./subagent-feed.cjs');

const text = value => typeof value === 'string' ? value : '';
const short = value => text(value).replace(/\s+/g, ' ').trim().slice(0, 240);
const enabled = value => value === true || value === 'true';
const REMOTE_ID = /^[A-Za-z0-9_-]{1,100}$/, REMOTE_FOLLOWS = 16;
// One record of a sub-agent's own transcript, read here or compacted by the SSH host: its own effort and speed, and its
// replies' timing once the call started. Both readers take every record through this, and name the model alike.
function childRecord(call, record) {
  const settings = agentSettings(null, 'claude', { ...record, isSidechain: false });
  if (settings) { call.effort = settings.effort ?? call.effort; call.fast = settings.fast ?? call.fast; }
  if (call.startedAt === null || Date.parse(record.timestamp) >= call.startedAt) call.meter.apply(record);
}
const childModel = (call, meta) => call.meter?.model || call.resultModel || text(meta?.model) || call.requested.model;
const agentRoles = new Map(Object.entries({ Explore: '搜索', Plan: '规划', 'general-purpose': '通用', claude: '通用', none: '通用', fork: '分身' }));
function helperAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'ESRCH' ? false : error.code === 'EPERM' ? true : null; }
}

class AgentCalls {
  static alive(pid) { return helperAlive(pid); }
  constructor({ changed = () => {}, finished = () => {}, feedChanged = () => {}, local = true, codexHome = null, claudeHome = null, now = Date.now, since = now(), dispatchAlive = call => helperAlive(call.helperPid) } = {}) {
    this.changed = changed; this.finished = finished; this.local = local; this.folder = null;
    this.now = now; this.since = since; this.claudeHome = claudeHome; this.finishedIds = new Set();
    this.dispatchAlive = dispatchAlive;
    this.feeds = new SubagentFeeds({ changed: feedChanged, retired: () => this.changed(), local, codexHome, claudeHome, now,
      plannerOf: id => this.calls?.get(id)?.planner || null,
      read: async call => { this.refresh(call.key); await this.work; } });
    this.reset();
  }
  reset(preserveDispatch = false) {
    clearTimeout(this.timer);
    const dispatched = [...(this.calls || [])].filter(([, call]) => preserveDispatch && call.dispatch);
    for (const call of this.calls?.values() || []) if (!preserveDispatch || !call.dispatch) clearTimeout(call.expiry);
    this.feeds.reset(preserveDispatch ? new Set(dispatched.map(([, call]) => call)) : null);
    this.timer = null; this.calls = new Map(dispatched); this.polls = new Map(); this.meta = new Map(); this.pending = new Set(); this.work = null;
  }
  setFolder(folder) { if (folder !== this.folder) { this.reset(true); this.folder = folder; } }
  history(reading) { this.replaying = reading; }
  feed(id) { return this.feeds.get(id); }
  ownerInput(id, messageId, message) {
    const call = this.byId(id);
    if (call?.dispatch) this.feeds.ownerInput(call, messageId, call.key, message);
  }
  byId(id) { return [...this.calls.values()].find(call => call.id === id) || null; }
  dispose() { this.reset(); this.finishedIds.clear(); }
  running() {
    return [...this.calls.values()].filter(call => !call.done && !call.reviewed).map(call => ({
      id: call.id, agent: call.agent, ...shownModel(call), title: call.title, role: call.role,
      startedAt: time(call.startedAt), rate: call.rate ? { ...call.rate } : null,
    }));
  }
  snapshot(provider) {
    // A group sums the members whose records can be read; one that cannot marks the sum partial, and with none readable
    // the group has no rate.
    const groups = new Map(), rated = new Set(), unrated = new Set();
    for (const call of this.calls.values()) {
      if (call.reviewed || call.hidden && call.dispatch && !call.failure) continue;
      const route = { agent: call.agent, provider: call.dispatch ? null : provider ?? null,
        ...(call.unconfirmed && call.declared ? call.declared : { ...shownModel(call), effort: call.effort, fast: call.fast }) };
      const key = JSON.stringify(route);
      if (!groups.has(key)) groups.set(key, { ...route, preparing: 0, running: 0, reviewing: 0, tasks: [], items: [], rate: emptyRate(false) });
      const group = groups.get(key);
      if (!call.hidden && !call.rate) unrated.add(group);
      else if (!call.hidden) {
        rated.add(group);
        group.rate.outputTokens += call.rate.outputTokens; group.rate.activeMs += call.rate.activeMs; group.rate.samples += call.rate.samples;
        group.rate.updatedAt = Math.max(group.rate.updatedAt, call.rate.updatedAt); group.rate.partial ||= call.rate.partial;
      }
      const state = stateOf(call);
      if (!call.hidden && state !== 'done') group[state]++;
      group.items.push({ id: call.id, state, role: call.role, title: call.title,
        startedAt: time(call.startedAt), endedAt: time(call.finishedAt), viewable: !!call.viewable, hidden: !!call.hidden,
        ...(call.dispatch || call.failure ? { failure: call.failure || null } : {}),
        ...(call.dispatch && call.declared ? { declared: call.declared } : {}) });
      if (!call.hidden && call.task) { group.tasks = group.tasks.filter(task => task !== call.task); group.tasks.push(call.task); group.tasks = group.tasks.slice(-5); }
    }
    for (const group of unrated) if (rated.has(group)) group.rate.partial = true; else group.rate = null;
    for (const group of groups.values()) group.items.reverse();
    return [...groups.values()];
  }
  dispatch(event) {
    const call = this.calls.get(event.id);
    if (event.type === 'dispatch-start') {
      if (call || this.calls.size >= 1024) return false;
      const next = { id: `dispatch:${event.id}`, key: event.id, dispatch: true, sourceAgent: event.agent, agent: event.agent === 'codex' ? 'Codex' : 'Claude Code',
        model: event.model, effort: event.effort, fast: event.fast, declared: event.declared, requestedModel: event.requestedModel ?? null,
        planner: event.planner || { kind: 'planner', agent: null, model: null },
        kind: taskKind(event),
        meeting: event.meeting ?? null, skipMeeting: event.skipMeeting ?? null, unconfirmed: event.unconfirmed === true,
        role: event.role, title: event.title, task: short(event.title), sessionId: event.sessionId, cwd: event.cwd,
        startedAt: time(event.startedAt), helperPid: Number.isSafeInteger(event.helperPid) && event.helperPid > 0 ? event.helperPid : null,
        done: false, rate: null, meter: new TokenRates(event.agent) };
      this.calls.set(event.id, next); this.feeds.track(next); this.schedule();
      return true;
    }
    if (!call?.dispatch) return false;
    // Input identity can arrive after the last transcript read. It changes presentation only.
    if (event.type === 'dispatch-input') {
      if (event.sessionId !== call.sessionId) return false;
      return this.feeds.noteInput(call, event);
    }
    if (call.done || call.reviewed) return false;
    if (event.type === 'dispatch-receipt') {
      const entry = this.feeds.owned(call);
      if (entry) { entry.dirty = true; this.feeds.update(call); }
      return true;
    }
    // What the worker reported after its start: a Codex worker can name its model only once its turn runs.
    if (event.type === 'dispatch-routing') {
      Object.assign(call, { model: event.model, effort: event.effort, fast: event.fast });
      this.feeds.update(call);
      return true;
    }
    if (event.type === 'dispatch-rate') {
      if (call.rate && (event.outputTokens < call.rate.outputTokens || event.activeMs < call.rate.activeMs)) return false;
      call.rate = call.meter.totals(call.model, event.outputTokens, event.activeMs, this.now());
      this.feeds.update(call);
      return true;
    }
    if (event.type !== 'dispatch-end') return false;
    call.done = true; call.finishedAt = event.endedAt; call.completedAt = this.now();
    try { this.finished(call, event); } catch {}
    call.model = event.model; call.effort = event.effort; call.fast = event.fast;
    call.rate = event.outputTokens === null || event.activeMs === null ? null
      : call.meter.totals(call.model, event.outputTokens, event.activeMs, event.endedAt);
    call.failure = event.reason === 'exit' && event.exitCode === 0 ? null
      : { reason: event.reason === 'exit' ? 'error' : event.reason, exitCode: event.exitCode, ...(event.outOfScope ? { files: event.outOfScope } : {}) };
    call.pendingReview = !!call.failure;
    this.feeds.update(call); this.refresh(event.id);
    if (!this.local) this.feeds.finish(call);
    this.hideAfterEnd(call);
    return true;
  }
  hideAfterEnd(call) {
    const hide = alive => {
      if (this.calls.get(call.key) !== call || call.reviewed || call.hidden) return;
      if (alive === true) { call.expiry = setTimeout(check, 1000); call.expiry.unref?.(); return; }
      // Display retirement never acknowledges a failure or removes its receipt, feed or accounting.
      call.hidden = true; this.changed();
    };
    const check = () => {
      if (!call.dispatch || !this.local) return hide(false);
      try {
        const alive = this.dispatchAlive(call);
        if (alive?.then) void alive.then(hide, () => hide(true)); else hide(alive);
      } catch { hide(true); }
    };
    call.expiry = setTimeout(check, call.failure ? 30000 : 3000);
    call.expiry.unref?.();
  }
  endSubagent(call, at, status = 'completed') {
    if (call.done) return false;
    call.done = true; call.finishedAt = time(at); call.completedAt = this.now(); call.outcome = status;
    call.failure = status === 'completed' ? null : { reason: status === 'killed' ? 'killed' : 'error', exitCode: null };
    call.recordable = !this.replaying && call.finishedAt !== null && call.finishedAt >= this.since;
    this.hideAfterEnd(call);
    return true;
  }
  recordSubagent(call) {
    if (call.recorded) return;
    call.recorded = true;
    if (!call.recordable || this.finishedIds.has(call.id)) return;
    this.finishedIds.add(call.id);
    const rate = call.rate?.samples > 0 && !call.rate.partial ? call.rate : null;
    const event = { id: call.id, source: 'subagent', model: call.meter?.model || call.resultModel || 'unreported',
      effort: call.effort ?? null, fast: call.fast ?? null, endedAt: time(call.finishedAt),
      reason: call.outcome === 'completed' ? 'exit' : call.outcome === 'killed' ? 'killed' : 'error',
      exitCode: call.outcome === 'completed' ? 0 : null, outputTokens: rate?.outputTokens ?? null, activeMs: rate?.activeMs ?? null,
      ...this.feeds.totals(call) };
    try { this.finished(call, event); } catch {}
  }
  review(at, prompt = false) {
    let changed = false;
    for (const call of this.calls.values()) {
      if ((call.dispatch && !call.failure) || !call.done || call.reviewed || (call.reviewAt ?? call.finishedAt) > at || (call.pendingReview && !prompt)) continue;
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
        if (!['Agent', 'Task'].includes(block.name) || this.calls.size >= 1024) continue;
        const input = block.input || {};
        const settings = { model: text(input.model) || 'default', effort: text(input.effort).trim() || null, fast: null };
        const next = {
          id: `agent:${block.id}`, key: block.id, sourceAgent: 'claude', startedAt: time(at), cwd: record.cwd,
          planner: { kind: 'planner', agent: 'claude', model: typeof record.message.model === 'string' && record.message.model !== '<synthetic>' ? record.message.model : null },
          agent: 'Claude Code', provider: null, ...settings, requested: settings, rate: null,
          task: short(input.description || block.description || input.subagent_type || block.name),
          title: text(input.description || block.description || input.subagent_type || block.name).replace(/\s+/g, ' ').trim(),
          role: agentRoles.get(input.subagent_type) || text(input.subagent_type) || '通用',
          background: enabled(input.run_in_background), done: false, preparing: this.local && !!this.folder,
        };
        next.kind = taskKind(next);
        this.calls.set(block.id, next); this.feeds.track(next);
        this.refresh(block.id);
        changed = true;
      } else if (record.type === 'user' && block.type === 'tool_result') {
        const result = record.toolUseResult || {}, poll = this.polls.get(block.tool_use_id);
        if (poll) {
          this.polls.delete(block.tool_use_id);
          const task = result.task?.task_id || result.task_id || poll.task;
          const call = [...this.calls.values()].find(call => call.backgroundTaskId === task || (poll.stop && call.agentId === task));
          if (call && !call.reviewed && (!call.done || call.pendingReview) && !block.is_error && (poll.stop || /^(?:completed|failed|killed)$/.test(result.task?.status || result.status))) {
            this.endSubagent(call, at, poll.stop ? 'killed' : result.task?.status || result.status);
            call.pendingReview = false; changed = true;
          }
          continue;
        }
        const call = this.calls.get(block.tool_use_id);
        if (!call || call.reviewed) continue;
        call.background ||= enabled(result.isAsync) || !!result.backgroundTaskId;
        if (typeof result.backgroundTaskId === 'string' && result.backgroundTaskId) call.backgroundTaskId = result.backgroundTaskId;
        if (block.is_error || !call.background) changed = this.endSubagent(call, at, block.is_error ? 'failed' : 'completed') || changed;
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
          this.endSubagent(call, at, /<status>\s*(completed|failed|killed)\s*<\/status>/.exec(notification)[1]);
          call.pendingReview = queued; changed = true;
        }
        if (call.pendingReview && (!queued || record.operation === 'remove')) { call.pendingReview = false; call.reviewAt = at; }
      }
    }
    // The app completes Claude rounds on Stop. Use that hook's transcript record, not assistant text or idle time.
    const prompt = claudePrompt(record) && !hasNotification;
    if (prompt || (record.type === 'system' && record.subtype === 'stop_hook_summary')) {
      changed = this.review(at, prompt) || changed;
    }
    for (const [id, call] of this.calls) {
      this.feeds.update(call);
      // An SSH sub-agent whose host still has records to send ends once they are in (remoteRecords).
      if (call.done && !call.dispatch && (!this.local || !this.folder) && call.behind !== true) this.drain(call);
      else if (call.done && !call.drained) this.refresh(id);
    }
    this.schedule();
    return changed;
  }
  drain(call) { call.drained = true; this.recordSubagent(call); this.feeds.finish(call); }
  // Over SSH the host reads the sub-agents' records (integration/remote-worker.py, which takes the same id form and
  // count): those whose launch named their id, running or ended with records still to come, until they are all in.
  remoteFollows(call) { return !this.local && !call.dispatch && !call.drained && (call.done || !call.reviewed) && REMOTE_ID.test(call.agentId || ''); }
  // The newest of them, and none while main's history is read: its replayed calls are not live.
  remoteSubagents() {
    if (this.local || this.replaying) return [];
    return [...this.calls.values()].filter(call => this.remoteFollows(call)).map(call => call.agentId).slice(-REMOTE_FOLLOWS);
  }
  // What the host sent of them. A restart builds a new meter, marked partial when the host left out the file's start; a
  // sub-agent the host no longer follows (crowded out, its file gone) keeps its rate marked partial until it restarts.
  remoteRecords(subagents) {
    if (this.local) return;
    const answer = subagents && typeof subagents === 'object' ? subagents : {};
    let changed = false;
    for (const call of this.calls.values()) {
      if (!this.remoteFollows(call)) continue;
      const before = this.signature(call), entry = Object.hasOwn(answer, call.agentId) ? answer[call.agentId] : null;
      if (Array.isArray(entry?.records)) {
        if (entry.reset || !call.meter) {
          Object.assign(call, call.requested, { unfollowed: false });
          call.meter = new TokenRates('claude', { sidechain: true }); call.meter.reset(entry.partial === true);
        }
        for (const record of entry.records) if (record && typeof record === 'object') childRecord(call, record);
        call.behind = entry.behind === true;
      } else Object.assign(call, { behind: null, unfollowed: !!call.meter });
      if (call.meter) { call.rate = { ...call.meter.snapshot(), ...(call.unfollowed ? { partial: true } : {}) }; call.model = childModel(call); }
      changed ||= before !== this.signature(call);
      if (call.done && call.behind !== true) this.drain(call);
    }
    if (changed) this.changed();
  }
  follows(call) {
    return this.local && !call.feedExpired && (call.dispatch ? !call.done || !call.feedDrained : this.folder && (call.done ? !call.drained : !call.reviewed));
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
    if (!this.local || !this.calls.has(id) || this.calls.get(id).feedExpired) return;
    if (!this.calls.get(id).dispatch && !this.folder) return;
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
          if (call.dispatch) continue;
          if (call.done && (!call.rate || call.reader?.offset >= call.reader?.fileSize)) call.drained = true;
          if (call.done && call.drained) { this.recordSubagent(call); this.feeds.finish(call); }
        }
        if ([...ids].some(id => !calls.get(id)?.reviewed && before.get(id) !== this.signature(calls.get(id)))) this.changed();
      }
    }).catch(() => {}).finally(() => { if (this.calls === calls) { this.work = null; this.schedule(); } });
  }
  signature(call) { return JSON.stringify(call && [call.model, call.effort, call.fast, call.preparing, call.title, call.role, call.rate, call.viewable, call.done, call.failure]); }
  async readSubagent(call, filename, calls, meta) {
    filename = filename ? await containedFile(this.folder, filename, { exact: true }) : null;
    const home = rootValue(this.claudeHome);
    if (filename && home && !await containedFile(path.join(home, 'projects'), filename, { exact: true })) filename = null;
    if (this.calls !== calls) return;
    if (call.reader?.filename !== filename) {
      Object.assign(call, call.requested);
      call.model = call.resultModel || call.model; call.rate = null;
      call.meter = new TokenRates('claude', { sidechain: true });
      call.reader = filename ? new TranscriptTail(filename, { onReset: async (partial, file) => {
        if (!await containedFile(this.folder, filename, { file, exact: true })) throw new Error('unavailable');
        if (home && !await containedFile(path.join(home, 'projects'), filename, { file, exact: true })) throw new Error('unavailable');
        call.meter.reset(partial); Object.assign(call, call.requested);
        this.feeds.resetLog(call, partial);
      } }) : null;
    }
    if (!call.reader) { call.model = childModel(call, meta); this.feeds.update(call, false); return; }
    const readable = await call.reader.read(record => {
      if (this.calls !== calls) return;
      childRecord(call, record);
      this.feeds.consume(call, record);
      if (record.type === 'assistant' || record.type === 'token_usage_record') call.preparing = false;
    }).catch(() => false);
    if (this.calls !== calls) return;
    call.rate = readable ? call.meter.snapshot() : null;
    call.effort ??= text(meta?.effort).trim() || null;
    call.model = childModel(call, meta);
    this.feeds.update(call, readable);
  }
  async readModels(folder, ids, calls) {
    for (const id of ids) {
      const call = calls.get(id);
      if (call?.dispatch) {
        let alive;
        if (!call.done) { try { alive = await this.dispatchAlive(call); } catch {} }
        if (this.calls !== calls || calls.get(id) !== call) return;
        if (alive !== false) call.missingSince = null;
        else call.missingSince ??= this.now();
        if (alive === false && this.now() - call.missingSince >= 1000 && !call.done && !call.reviewed) this.dispatch({ type: 'dispatch-end', id, reason: 'killed', exitCode: null,
          model: call.model, effort: call.effort, fast: call.fast, endedAt: this.now(), outputTokens: null, activeMs: null });
        await this.feeds.readDispatch(call);
      }
      if (this.calls !== calls) return;
    }
    ids = new Set([...ids].filter(id => calls.get(id)?.agent === 'Claude Code' && !calls.get(id).dispatch));
    if (!folder || !ids.size) return;
    const home = rootValue(this.claudeHome);
    const valid = !home || await containedFile(path.join(home, 'projects'), folder, { exact: true, directoryOnly: true });
    if (this.calls !== calls) return;
    if (!valid) {
      for (const id of ids) { const call = calls.get(id); call.rate = null; this.feeds.update(call, false); }
      return;
    }
    const files = [...ids].some(id => !calls.get(id).filename) ? await fs.readdir(folder).catch(() => []) : [...ids].map(id => path.basename(calls.get(id).filename).replace(/\.jsonl$/, '.meta.json'));
    if (this.calls !== calls) return;
    const matches = new Map();
    for (const name of files) {
      if (!/^agent-[\w-]+\.meta\.json$/.test(name)) continue;
      const filename = await containedFile(folder, path.join(folder, name), { exact: true });
      if (!filename) continue;
      const stat = await fs.stat(filename).catch(() => null);
      if (this.calls !== calls) return;
      if (!stat || stat.size > 64 * 1024) continue;
      let entry = this.meta.get(filename);
      if (!entry || entry.at !== stat.mtimeMs || entry.size !== stat.size) {
        let file;
        try {
          file = await fs.open(filename, 'r');
          if (!await containedFile(home ? path.join(home, 'projects') : folder, filename, { file, exact: true })) continue;
          const buffer = Buffer.alloc(64 * 1024 + 1), { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
          if (bytesRead > 64 * 1024) continue;
          entry = { at: stat.mtimeMs, size: stat.size, value: JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')) };
        } catch { continue; }
        finally { await file?.close(); }
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
