const fs = require('node:fs/promises');
const { lstatSync, realpathSync } = require('node:fs');
const { StringDecoder } = require('node:string_decoder');
const path = require('node:path');
const { claudePrompt, TranscriptTail } = require('../../agent-actions.cjs');
const { TokenRates, emptyRate } = require('./token-rate.cjs');
const { agentSettings } = require('./agent-settings.cjs');
const { taskKind } = require('../dashboard/records-routing.cjs');
const { containedFile } = require('../../session-files.cjs');
const { SubagentFeeds, stateOf, shownModel, time, rootValue } = require('./subagent-feed.cjs');
const { BackgroundTasks, attach } = require('./background-tasks.cjs');
const { agentDescription, callSeat, declaredSeat, seatExpectation, CLAUDE_ALIAS, CLAUDE_EFFORT } = require('./call-seat.cjs');
const { LOST_WORK_TIMEOUT } = require('../../completion-work.cjs');
// Host processes can restart while their terminal's dispatched workers keep running.
const terminalCalls = new WeakMap();

const text = value => typeof value === 'string' ? value : '';
const short = value => text(value).replace(/\s+/g, ' ').trim().slice(0, 240);
const enabled = value => value === true || value === 'true';
const REMOTE_ID = /^[A-Za-z0-9_-]{1,100}$/, REMOTE_FOLLOWS = 16;
const RECENT_KEEP = 10, RECENT_AGE_MS = 30 * 60 * 1000;
const TOOL_ID = /^[A-Za-z0-9_-]{1,160}$/;
const CALL_FILE_LIMIT = 256 * 1024;
const UNKNOWN_PLANNER = Object.freeze({ kind: 'planner', agent: null, model: null });
const regularArtifact = stat => stat.isFile() && stat.nlink === 1n;
const sameFile = (left, right) => regularArtifact(right) && left.dev === right.dev && left.ino === right.ino;
const artifactError = error => error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 'missing' : error.code === 'EFBIG' ? 'too-large' : 'refused';

function localArtifactPath(filename) {
  return typeof filename === 'string' && path.isAbsolute(filename) && (process.platform !== 'win32' ||
    !/^[\\/]{2}/.test(filename) && !filename.replace(/^[a-z]:/i, '').includes(':'));
}

function bindArtifact(filename, pinIdentity) {
  if (!localArtifactPath(filename)) return { code: 'refused' };
  try {
    // Resolve parent aliases once. The log can be created after dispatch-start.
    const file = path.join(realpathSync.native(path.dirname(filename)), path.basename(filename));
    if (!localArtifactPath(file)) return { code: 'refused' };
    if (!pinIdentity) return { file };
    const identity = lstatSync(file, { bigint: true });
    return regularArtifact(identity) ? { file, identity } : { code: 'refused' };
  } catch (error) { return { code: artifactError(error) }; }
}

const accountingId = (call, id = call.id) => call.generation ? `${id}:continue:${call.generation}` : id;
// One record of a sub-agent's own transcript, read here or compacted by the SSH host: its own effort and speed, and its
// replies' timing once the call started. Both readers take every record through this, and name the model alike.
function childRecord(call, record, clockOffset = 0) {
  const settings = agentSettings(null, 'claude', { ...record, isSidechain: false });
  if (settings) {
    call.childEffort = settings.effort ?? call.childEffort;
    call.effort = call.childEffort ?? call.effort;
    call.fast = settings.fast ?? call.fast;
  }
  if (call.startedAt === null || Date.parse(record.timestamp) + clockOffset >= call.startedAt) call.meter.apply(record);
}
const childModel = (call, meta) => call.meter?.model || call.resultModel || text(meta?.model) || call.seatInput?.model || call.requested.model;
function resetChildSettings(call) {
  Object.assign(call, call.requested, call.seatInput, { childEffort: null });
}
const agentRoles = new Map(Object.entries({ Explore: '搜索', Plan: '规划', 'general-purpose': '通用', claude: '通用', none: '通用', fork: '分身' }));
function helperAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'ESRCH' ? false : error.code === 'EPERM' ? true : null; }
}

class AgentCalls {
  static alive(pid) { return helperAlive(pid); }
  static forTerminal(scope, id, create) {
    let calls = terminalCalls.get(scope);
    if (!calls && create) { calls = new Map(); terminalCalls.set(scope, calls); }
    if (create && !calls.has(id)) {
      const tracker = create(); calls.set(id, tracker);
      tracker.release = () => { if (calls.get(id) === tracker) calls.delete(id); };
    }
    return calls?.get(id) || null;
  }
  constructor({ terminalId = null, changed = () => {}, finished = () => {}, feedChanged = () => {}, local = true,
    codexHome = null, claudeHome = null, now = Date.now, since = now(), dispatchAlive = call => helperAlive(call.helperPid),
    dispatchReplay = null, roles = () => null } = {}) {
    this.changed = changed; this.finished = finished; this.local = local; this.folder = null; this.terminalId = terminalId;
    this.now = now; this.since = since; this.claudeHome = claudeHome; this.finishedIds = new Set(); this.awaitingEarly = new Map();
    this.dispatchAlive = dispatchAlive; this.clockOffset = 0;
    this.dispatchReplay = dispatchReplay; this.roles = roles;
    this.background = new BackgroundTasks(terminalId, { now });
    this.feeds = new SubagentFeeds({ changed: feedChanged, retired: () => this.changed(), local, codexHome, claudeHome, now,
      plannerOf: id => this.calls?.get(id)?.planner || null,
      read: async call => { this.refresh(call.key); await this.work; } });
    this.reset();
  }
  reset(preserveDispatch = false, preserveSignals = preserveDispatch) {
    this.stopSubagents();
    if (!preserveDispatch) this.background.reset();
    clearTimeout(this.timer);
    clearTimeout(this.dispatchTimer); this.dispatchTimer = null;
    const retained = [...(this.calls || [])].filter(([, call]) => preserveDispatch && call.dispatch || preserveSignals && call.signalRunning);
    const keep = new Set(retained.map(([, call]) => call));
    for (const call of this.calls?.values() || []) if (!keep.has(call)) { clearTimeout(call.expiry); clearTimeout(call.startNotice); }
    this.feeds.reset(preserveDispatch ? keep : null);
    const ids = new Set(retained.map(([, call]) => call.id));
    this.aliases = new Map([...(this.aliases || [])].filter(([, id]) => ids.has(id)));
    this.seatInputs = new Map();
    this.timer = null; this.calls = new Map(retained); this.polls = new Map(); this.meta = new Map(); this.pending = new Set(); this.work = null;
    this.schedule();
    this.watchDispatch();
  }
  // Only unexpired runs in this process hold completion; lapsed rows remain available for display and late receipts.
  openDispatch(now = this.now()) {
    const open = [...this.calls.values()].filter(call => call.dispatch && !call.done && !call.reviewed && (call.startedAt ?? now) + LOST_WORK_TIMEOUT > now);
    return { count: open.length, deadline: open.length ? Math.min(...open.map(call => call.startedAt ?? now)) + LOST_WORK_TIMEOUT : null };
  }
  watchDispatch() {
    clearTimeout(this.dispatchTimer); this.dispatchTimer = null;
    const { count, deadline } = this.openDispatch(), remaining = deadline - this.now();
    if (!count || remaining <= 0) return;
    this.dispatchTimer = setTimeout(() => {
      this.dispatchTimer = null;
      this.dispatchEnded?.();
      this.watchDispatch();
    }, remaining);
    this.dispatchTimer.unref?.();
  }
  setFolder(folder) { if (folder !== this.folder) { this.reset(true, false); this.folder = folder; } }
  history(reading) { this.replaying = reading; }
  feed(id) { return this.feeds.get(this.aliases.get(id) || id); }
  async callFile(id, kind) {
    if (typeof id !== 'string' || !/^dispatch:[a-f\d-]{36}$/i.test(id) || !['brief', 'log'].includes(kind)) return { ok: false, code: 'refused' };
    if (!this.local) return { ok: false, code: 'unavailable' };
    const call = this.byId(id), artifact = call?.artifacts?.[kind];
    if (!artifact) return { ok: false, code: 'unavailable' };
    if (artifact.code) return { ok: false, code: artifact.code };
    const { file: filename, identity } = artifact;
    let file;
    try {
      const before = await fs.lstat(filename, { bigint: true });
      if (!regularArtifact(before) || (identity && !sameFile(identity, before)) || await fs.realpath(filename) !== filename) return { ok: false, code: 'refused' };
      const { O_RDONLY, O_NOFOLLOW = 0, O_NONBLOCK = 0 } = fs.constants;
      file = await fs.open(filename, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
      const opened = await file.stat({ bigint: true });
      if (!sameFile(before, opened)) return { ok: false, code: 'refused' };
      const bytes = Buffer.alloc(CALL_FILE_LIMIT), { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      const current = await fs.lstat(filename, { bigint: true });
      if (this.byId(id) !== call || !sameFile(opened, current) || await fs.realpath(filename) !== filename) return { ok: false, code: 'refused' };
      const truncated = current.size > BigInt(bytesRead), content = bytes.subarray(0, bytesRead);
      return { ok: true, text: truncated ? new StringDecoder('utf8').write(content) : content.toString('utf8'), truncated };
    } catch (error) { return { ok: false, code: artifactError(error) }; }
    finally { await file?.close().catch(() => {}); }
  }
  ownerInput(id, messageId, message) {
    const call = this.byId(id);
    if (call?.dispatch) this.feeds.ownerInput(call, messageId, call.key, message);
  }
  byId(id) { return [...this.calls.values()].find(call => call.id === (this.aliases.get(id) || id)) || null; }
  toolCall(id) {
    if (typeof id !== 'string') return null;
    const call = this.calls.get(id);
    return call && !call.dispatch ? call : [...this.calls.values()].find(call => !call.dispatch && call.toolUseId === id) || null;
  }
  addSubagent({ key, agentId = null, toolUseId = null, startedAt, agentType, title, task, cwd, planner, labels, background = false,
    requested = { model: 'default', effort: null, fast: null } }) {
    const call = { id: `agent:${toolUseId || agentId}`, key, agentId, toolUseId, toolGeneration: 0, sourceAgent: 'claude', agent: 'Claude Code',
      provider: null, ...requested, requested, startedAt, done: false, rate: null, cwd, background, agentType, ...labels,
      title: title || short(agentType) || 'Agent', task, role: agentRoles.get(agentType) || short(agentType) || agentRoles.get('none'),
      preparing: this.local && !!this.folder, planner: planner || UNKNOWN_PLANNER };
    call.kind = taskKind(call);
    this.calls.set(key, call);
    const settings = this.seatInputs.get(toolUseId);
    if (settings) this.applySeatInput(call, settings);
    this.feeds.track(call);
    return call;
  }
  applySeatInput(call, settings) {
    const meta = this.meta.get(call.agentId);
    call.expected ??= settings.expected;
    call.seatInput = settings.model === null ? null : { model: settings.model, effort: settings.effort };
    call.model = childModel(call, meta);
    call.effort = call.childEffort ?? (text(meta?.effort).trim() || call.seatInput?.effort || call.requested.effort);
  }
  observeSeatInput({ toolUseId, model, effort, phase = 'post', expected }) {
    const expectation = phase === 'pre' ? seatExpectation(expected) : null;
    const validSettings = CLAUDE_ALIAS.test(text(model)) && CLAUDE_EFFORT.test(text(effort));
    const unobserved = model === null && effort === null && (phase === 'post' || expectation);
    if (!TOOL_ID.test(text(toolUseId)) || !['pre', 'post'].includes(phase) || !(validSettings || unobserved)) return false;
    const prior = this.seatInputs.get(toolUseId);
    const firstExpectation = prior?.expected ?? expectation;
    const keepPrior = prior?.phase === 'post' && phase === 'pre'
      || prior?.phase === phase && (phase === 'pre' || prior.model === model && prior.effort === effort);
    if (keepPrior && prior.expected === firstExpectation) return false;
    if (!prior && this.seatInputs.size >= 1024) this.seatInputs.delete(this.seatInputs.keys().next().value);
    const settings = { ...(keepPrior ? prior : { phase, model, effort }), expected: firstExpectation };
    this.seatInputs.set(toolUseId, settings);
    const call = this.toolCall(toolUseId);
    if (!call || call.generation) return false;
    this.applySeatInput(call, settings);
    this.feeds.update(call);
    this.changed();
    return true;
  }
  // Keep the first row's display identity, but retain the child object: its reader callbacks and accounting belong to
  // that object. A metadata join must not discard samples just because the parent tool record arrived first.
  bindSubagent(agentId, toolUseId) {
    const agent = agentId && [...this.calls.values()].find(call => !call.dispatch && call.agentId === agentId);
    const tool = toolUseId && this.toolCall(toolUseId);
    let call = agent || tool;
    if (agent && tool && agent !== tool) {
      const first = [...this.calls.values()].find(value => value === agent || value === tool), identity = { id: first.id, key: first.key };
      call = agent.signalAt != null ? agent : tool.signalAt != null ? tool : agent;
      const other = call === agent ? tool : agent, ids = [call.id, other.id];
      const recorded = call.recorded || other.recorded || ids.some(id => this.finishedIds.has(accountingId(call, id)));
      const entry = this.feeds.owned(call), retired = this.feeds.owned(other);
      call.expected ??= other.expected;
      if (tool.title) Object.assign(call, { title: tool.title, task: tool.task, role: tool.role, planner: tool.planner, cwd: tool.cwd,
        requested: tool.requested, background: tool.background, agentType: tool.agentType,
        seat: tool.seat, specialty: tool.specialty, seatSource: tool.seatSource, seatName: tool.seatName, offTeam: tool.offTeam });
      clearTimeout(other.expiry); clearTimeout(call.expiry);
      this.calls.delete(other.key); this.calls.delete(call.key);
      this.pending.delete(other.key); this.pending.delete(call.key);
      if (retired) this.feeds.retire(retired, false);
      this.feeds.entries.delete(call.id);
      Object.assign(call, identity);
      this.calls.set(call.key, call);
      if (entry) {
        entry.revision = Math.max(entry.revision, retired?.revision || 0); entry.dirty = true;
        this.feeds.entries.set(call.id, entry);
      }
      for (const id of ids) if (id !== call.id) this.aliases.set(id, call.id);
      for (const [id, target] of this.aliases) if (ids.includes(target)) this.aliases.set(id, call.id);
      if (recorded) {
        call.recorded = true;
        for (const id of ids) { this.finishedIds.add(id); this.finishedIds.add(accountingId(call, id)); }
      }
      if (call.done) this.hideAfterEnd(call);
      this.feeds.update(call);
    }
    if (call) {
      if (agentId) call.agentId = agentId;
      if (toolUseId && call.toolUseId !== toolUseId) {
        call.toolUseId = toolUseId; call.toolGeneration = call.generation || 0;
        const settings = this.seatInputs.get(toolUseId);
        if (settings && !call.generation) this.applySeatInput(call, settings);
      }
    }
    return call || null;
  }
  subagent(signal) {
    if (!signal || !['start', 'stop', 'continue'].includes(signal.kind) || !REMOTE_ID.test(text(signal.agentId))
      || time(signal.at) === null || this.terminalId != null && signal.terminalId !== this.terminalId
      || signal.toolUseId != null && !TOOL_ID.test(text(signal.toolUseId))) return false;
    const toolUseId = signal.kind === 'continue' ? null : signal.toolUseId;
    let call = this.bindSubagent(signal.agentId, toolUseId);
    if (signal.kind === 'continue' && signal.toolUseId && call?.continuations?.has(signal.toolUseId)) return false;
    if (call && (signal.at < (call.signalAt ?? -Infinity)
      || signal.at === call.signalAt && (signal.kind === call.signalKind || call.signalKind === 'stop' && signal.kind === 'start'))) return false;
    if (!call) {
      if (signal.kind === 'continue') return false;
      if (this.calls.size >= 1024) return false;
      const key = toolUseId && !this.calls.has(toolUseId) ? toolUseId : `subagent:${signal.agentId}`;
      call = this.addSubagent({ key, agentId: signal.agentId, toolUseId, startedAt: signal.at, agentType: signal.agentType });
    }
    if (signal.kind === 'continue' && !call.done) {
      this.noteContinuation(call, signal.toolUseId);
      return false;
    }
    if (signal.kind !== 'stop' && call.done) {
      if (!call.drained) this.finishPartial(call);
      const entry = this.feeds.owned(call);
      if (signal.kind === 'continue' && signal.toolUseId) call.revival = { toolUseId: signal.toolUseId, at: signal.at,
        previous: { ...call }, feed: entry && { completedAt: entry.completedAt, replies: new Map(entry.replies), usageUnknown: entry.usageUnknown } };
      clearTimeout(call.expiry);
      Object.assign(call, { done: false, reviewed: false, hidden: false, recorded: false, recordable: false, drained: false,
        finishedAt: null, completedAt: null, failure: null, pendingReview: false, reviewAt: null, outcome: null,
        partial: false, rate: null, resumed: true, startedAt: signal.at, generation: (call.generation || 0) + 1 });
      call.meter = new TokenRates('claude', { sidechain: true });
      if (entry) { delete entry.completedAt; entry.replies.clear(); entry.usageUnknown = false; this.feeds.prune(); }
    }
    call.signalAt = signal.at; call.signalKind = signal.kind; call.signalRunning = signal.kind !== 'stop';
    if (signal.kind === 'continue') this.noteContinuation(call, signal.toolUseId);
    else delete call.revival;
    if (typeof signal.transcriptPath === 'string' && signal.transcriptPath) call.filename = signal.transcriptPath;
    if (signal.kind === 'stop') this.endSubagent(call, signal.at, signal.outcome === 'killed' ? 'killed' : 'completed');
    this.feeds.update(call);
    if (call.done && (!this.local || !this.folder) && call.behind !== true) this.drain(call);
    else this.refresh(call.key);
    this.schedule(); this.changed();
    return true;
  }
  noteContinuation(call, toolUseId) {
    if (!toolUseId) return;
    call.continuations ||= new Set(); call.continuations.add(toolUseId);
    if (call.continuations.size > 64) call.continuations.delete(call.continuations.values().next().value);
  }
  finishContinuation(toolUseId, at, failed = false) {
    const call = [...this.calls.values()].find(call => call.revival?.toolUseId === toolUseId);
    if (!call || !Number.isFinite(at) || at < call.revival.at) return false;
    const { previous, feed } = call.revival;
    delete call.revival;
    if (!failed) return false;
    const identity = Object.fromEntries(['id', 'key', 'agentId', 'toolUseId', 'toolGeneration', 'title', 'task', 'role', 'planner', 'cwd', 'requested', 'background', 'continuations',
      'agentType', 'seat', 'specialty', 'seatSource', 'seatName', 'offTeam']
      .map(key => [key, call[key]]));
    clearTimeout(call.expiry);
    for (const key of Object.keys(call)) delete call[key];
    Object.assign(call, previous, identity);
    const entry = this.feeds.owned(call);
    if (entry && feed) { Object.assign(entry, feed); entry.dirty = true; this.feeds.prune(); }
    if (!call.hidden && !call.reviewed) this.hideAfterEnd(call);
    this.feeds.update(call); this.schedule(); this.changed();
    return true;
  }
  finishPartial(call) {
    if (!call.done || call.dispatch || call.recorded) return;
    call.partial = true;
    if (call.rate) call.rate = { ...call.rate, partial: true };
    this.drain(call);
  }
  stopSubagents() {
    for (const call of this.calls?.values() || []) if (call.done && !call.drained) this.finishPartial(call);
  }
  dispose() { this.release?.(); this.reset(); this.finishedIds.clear(); }
  endSession() {
    this.reset(true, false); this.setFolder(null); this.bindBackground(null, true);
    this.schedule();
  }
  bindBackground(binding, reset = false) {
    if (reset || this.backgroundBinding !== binding) { this.backgroundBinding = binding; this.background.reset(); }
  }
  backgroundRecord(record) { if (this.background.apply(record)) this.changed(); }
  usage(value) {
    const entries = this.background.snapshot();
    return value || entries.length ? attach(value || { provider: null, context: null, round: null, total: null, limits: [], calls: [] }, entries) : null;
  }
  running() {
    return [...this.calls.values()].filter(call => !call.done && !call.reviewed).map(call => ({
      id: call.id, agent: call.agent, ...shownModel(call), title: call.title, role: call.role,
      startedAt: time(call.startedAt), rate: call.rate ? { ...call.rate } : null,
    }));
  }
  // The owner's 「最近完成」 bounds: this terminal's last ten finished calls, none older than thirty minutes, read at
  // each snapshot (nothing is polled; an older call drops out at the next publish, as the renderer also filters by age).
  recent() {
    const end = call => call.finishedAt ?? call.completedAt ?? -Infinity, now = this.now();
    return new Set([...this.calls.values()].filter(call => call.done && now - end(call) <= RECENT_AGE_MS)
      .sort((a, b) => end(b) - end(a)).slice(0, RECENT_KEEP));
  }
  snapshot(provider) {
    // A group sums the members whose records can be read; one that cannot marks the sum partial, and with none readable
    // the group has no rate.
    const groups = new Map(), rated = new Set(), unrated = new Set(), recent = this.recent();
    for (const call of this.calls.values()) {
      // A call retired from the live list (hidden after its end, or reviewed by the lead) is still sent as a hidden
      // `done` row while it is one of the last finished, for 「最近完成」; it adds nothing to the counts or the rate.
      const retired = !!(call.reviewed || call.hidden);
      if (retired && !recent.has(call) && (call.reviewed || call.dispatch && !call.failure)) continue;
      const route = { agent: call.agent, provider: call.dispatch ? null : provider ?? null,
        ...(call.unconfirmed && call.declared ? call.declared : { ...shownModel(call), effort: call.effort, fast: call.fast }) };
      const key = JSON.stringify(route);
      if (!groups.has(key)) groups.set(key, { ...route, preparing: 0, running: 0, reviewing: 0, tasks: [], items: [], rate: emptyRate(false) });
      const group = groups.get(key);
      if (!retired && !call.rate) unrated.add(group);
      else if (!retired) {
        rated.add(group);
        group.rate.outputTokens += call.rate.outputTokens; group.rate.activeMs += call.rate.activeMs; group.rate.samples += call.rate.samples;
        group.rate.updatedAt = Math.max(group.rate.updatedAt, call.rate.updatedAt); group.rate.partial ||= call.rate.partial;
      }
      const state = retired ? 'done' : call.starting && !call.done ? 'starting' : stateOf(call);
      if (!retired && state !== 'done') group[state] = (group[state] || 0) + 1;
      group.items.push({ id: call.id, state, role: call.role, title: call.title,
        startedAt: time(call.startedAt), endedAt: time(call.finishedAt), viewable: !!call.viewable, hidden: retired, expected: call.expected ?? null,
        ...callSeat(call, route.model), ...(call.cwd ? { worktree: call.worktree || call.cwd } : {}),
        ...(call.dispatch ? { brief: !!call.artifacts?.brief, log: !!call.artifacts?.log } : {}),
        ...(call.dispatch || call.failure ? { failure: call.failure || null } : {}),
        ...(call.dispatch && call.declared ? { declared: call.declared } : {}),
        ...(call.resumed ? { resumed: true } : {}), ...(call.notice ? { notice: call.notice } : {}), ...(call.awaiting && !retired ? { awaiting: call.awaiting } : {}),
        ...(call.source != null ? { source: call.source } : {}),
        ...(call.controlFailure ? { controlFailure: call.controlFailure } : {}) });
      if (!retired && call.task) { group.tasks = group.tasks.filter(task => task !== call.task); group.tasks.push(call.task); group.tasks = group.tasks.slice(-5); }
    }
    // A group of retired calls only has no rate (rather than a zero one the renderer would take for the model's).
    for (const group of groups.values()) if (!rated.has(group)) group.rate = null; else if (unrated.has(group)) group.rate.partial = true;
    for (const group of groups.values()) group.items.reverse();
    return [...groups.values()];
  }
  startDispatch(event, call) {
    if (call && (!call.starting || call.done) || !call && this.calls.size >= 1024) return false;
    if (call && (call.sourceAgent !== event.agent || call.cwd !== event.cwd)) return false;
    // A delayed start can arrive after the lead conversation has already switched.
    if (call?.declaredSpelling != null && event.seat != null && call.declaredSpelling !== event.seat) return false;
    const labels = call?.declaredSpelling == null ? declaredSeat(event.seat, this.roles) : null;
    const next = { id: `dispatch:${event.id}`, key: event.id, dispatch: true, sourceAgent: event.agent, agent: event.agent === 'codex' ? 'Codex' : 'Claude Code',
      model: event.model, effort: event.effort, fast: event.fast, declared: event.declared, requestedModel: event.requestedModel ?? null,
      planner: event.planner || UNKNOWN_PLANNER,
      kind: taskKind(event),
      meeting: event.meeting ?? null, skipMeeting: event.skipMeeting ?? null, unconfirmed: event.unconfirmed === true,
      role: event.role, title: event.title, task: short(event.title), sessionId: event.sessionId, cwd: event.cwd, ...labels,
      artifacts: this.local ? { brief: event.brief && bindArtifact(event.brief, true),
        log: event.log && event.log === `${event.out}.log` ? bindArtifact(event.log, false) : null } : null,
      startedAt: time(event.startedAt), helperPid: Number.isSafeInteger(event.helperPid) && event.helperPid > 0 ? event.helperPid : null,
      done: false, rate: null, meter: new TokenRates(event.agent) };
    if (call) {
      clearTimeout(call.startNotice);
      Object.assign(call, next, { starting: false }); delete call.notice;
      this.feeds.update(call);
    } else { this.takeAwaiting(next, event.id); this.calls.set(event.id, next); this.feeds.track(next); }
    this.schedule(); this.watchDispatch();
    return true;
  }
  dispatch(event) {
    const call = this.calls.get(event.id);
    if (event.type === 'dispatch-declared') {
      if (call || this.finishedIds.has(event.id)) return false;
      const next = { id: `dispatch:${event.id}`, key: event.id, dispatch: true, sourceAgent: event.agent, agent: event.agent === 'codex' ? 'Codex' : 'Claude Code',
        model: 'unreported', effort: null, fast: null, requestedModel: event.requested.model, requested: event.requested,
        planner: event.planner || UNKNOWN_PLANNER, kind: taskKind(event), meeting: event.meeting ?? null,
        role: event.role, title: event.title, task: short(event.title), sessionId: null, cwd: event.cwd, worktree: event.worktree,
        declaredSpelling: event.seat, ...declaredSeat(event.seat, this.roles),
        expected: event.seat ? seatExpectation(event.expected) : null,
        helperPid: event.helperPid, starting: true, unconfirmed: true, resumed: event.resumed === true, source: event.source,
        startedAt: time(event.at), done: false, rate: null, meter: new TokenRates(event.agent) };
      this.takeAwaiting(next, event.id); this.calls.set(event.id, next); this.feeds.track(next);
      next.startNotice = setTimeout(() => {
        if (this.calls.get(event.id) !== next || !next.starting || next.done) return;
        next.notice = 'unconfirmed'; this.changed();
      }, Math.max(0, 15000 - (this.now() - event.at)));
      next.startNotice.unref?.(); this.schedule(); this.watchDispatch(); return true;
    }
    if (event.type === 'dispatch-start') return this.startDispatch(event, call);
    if (!call?.dispatch) return false;
    // Input identity can arrive after the last transcript read. It changes presentation only.
    if (event.type === 'dispatch-input') {
      if (event.sessionId !== call.sessionId) return false;
      return this.feeds.noteInput(call, event);
    }
    if (call.done || call.reviewed) return false;
    if (event.type === 'dispatch-notice') { call.controlFailure = event.controlFailure; return true; }
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
    clearTimeout(call.startNotice); call.starting = false; delete call.notice; delete call.awaiting;
    this.finishedIds.add(event.id);
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
    this.watchDispatch();
    this.dispatchEnded?.();
    return true;
  }
  // A worker terminal's dispatched worker waits for the owner's answer ('owner') or went on (null): presentation only,
  // never completion or a notification (worker-terminals).
  // A wait reported before the row exists is kept for it (at most 64, the newest).
  setAwaiting(id, value) {
    const call = this.calls.get(id);
    if (!call && !this.finishedIds.has(id)) {
      this.awaitingEarly.delete(id);
      if (value === 'owner') this.awaitingEarly.set(id, value);
      if (this.awaitingEarly.size > 64) this.awaitingEarly.delete(this.awaitingEarly.keys().next().value);
      return false;
    }
    if (!call?.dispatch || call.done || (call.awaiting ?? null) === value) return false;
    if (value === 'owner') call.awaiting = value; else delete call.awaiting;
    this.feeds.update(call); this.changed(); return true;
  }
  takeAwaiting(call, id) {
    if (this.awaitingEarly.get(id)) call.awaiting = this.awaitingEarly.get(id);
    this.awaitingEarly.delete(id);
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
  endSubagent(call, at, status = 'completed', proof) {
    if (call.done) return false;
    if (call.signalRunning) {
      if (!Number.isFinite(at) || at <= call.signalAt) return false;
      const ownTool = proof?.toolUseId === call.toolUseId && (call.toolGeneration || 0) === (call.generation || 0);
      if (!(proof?.kind === 'agent' && ownTool || proof?.kind === 'stop' && proof.startedAt >= call.startedAt
        && (proof.generation == null ? proof.startedAt > call.signalAt : proof.generation === (call.generation || 0))
        || proof?.kind === 'notification' && ['killed', 'failed'].includes(status) && (!proof.toolUseId || ownTool))) return false;
      call.signalRunning = false; call.signalAt = at; call.signalKind = 'stop';
    }
    delete call.revival;
    call.done = true; call.finishedAt = time(at); call.completedAt = this.now(); call.outcome = status;
    call.failure = status === 'completed' ? null : { reason: status === 'killed' ? 'killed' : 'error', exitCode: null };
    call.recordable = !this.replaying && call.finishedAt !== null && call.finishedAt >= this.since;
    this.hideAfterEnd(call);
    return true;
  }
  recordSubagent(call) {
    if (call.recorded) return;
    call.recorded = true;
    const id = accountingId(call);
    if (!call.recordable || this.finishedIds.has(id)) return;
    this.finishedIds.add(id);
    const rate = call.rate?.samples > 0 && !call.rate.partial ? call.rate : null;
    const event = { id, source: 'subagent', model: call.meter?.model || call.resultModel || 'unreported',
      effort: call.effort ?? null, fast: call.fast ?? null, endedAt: time(call.finishedAt),
      reason: call.outcome === 'completed' ? 'exit' : call.outcome === 'killed' ? 'killed' : 'error',
      exitCode: call.outcome === 'completed' ? 0 : null, outputTokens: rate?.outputTokens ?? null, activeMs: rate?.activeMs ?? null,
      ...(call.partial ? { partial: true, inputTokens: null, cachedTokens: null, totalOutputTokens: null } : this.feeds.totals(call)) };
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
  applyToolRecords(record, content, at) {
    let changed = false;
    for (const block of Array.isArray(content) ? content : []) {
      if (record.type === 'assistant' && block.type === 'tool_use' && ['BashOutput', 'TaskOutput', 'TaskStop', 'KillShell'].includes(block.name)) {
        const task = block.input?.bash_id || block.input?.task_id || block.input?.shell_id;
        if (typeof block.id === 'string' && typeof task === 'string' && task) {
          const target = [...this.calls.values()].find(call => call.backgroundTaskId === task || call.agentId === task);
          this.polls.set(block.id, { task, stop: ['TaskStop', 'KillShell'].includes(block.name), at, generation: target ? target.generation || 0 : null });
        }
        continue;
      }
      if (record.type === 'assistant' && block.type === 'tool_use' && typeof block.id === 'string') {
        if (!['Agent', 'Task'].includes(block.name)) continue;
        const input = block.input || {};
        const description = text(input.description || block.description || input.subagent_type || block.name).replace(/\s+/g, ' ').trim();
        const { title, labels } = agentDescription(description, this.roles);
        const existing = this.toolCall(block.id);
        if (existing) {
          if (labels && !existing.seatSource) {
            Object.assign(existing, labels, { title: title || existing.title, task: short(title), cwd: existing.cwd || record.cwd });
            this.feeds.update(existing); changed = true;
          }
          continue;
        }
        if (this.calls.size >= 1024) continue;
        const settings = { model: text(input.model) || 'default', effort: text(input.effort).trim() || null, fast: null };
        const next = this.addSubagent({ key: block.id, toolUseId: block.id, startedAt: time(at), cwd: record.cwd, requested: settings,
          planner: { kind: 'planner', agent: 'claude', model: typeof record.message.model === 'string' && record.message.model !== '<synthetic>' ? record.message.model : null },
          task: short(title), title, labels,
          agentType: input.subagent_type, background: enabled(input.run_in_background) });
        this.refresh(next.key);
        changed = true;
      } else if (record.type === 'user' && block.type === 'tool_result') {
        const result = record.toolUseResult || {}, poll = this.polls.get(block.tool_use_id);
        if (poll) {
          this.polls.delete(block.tool_use_id);
          const task = result.task?.task_id || result.task_id || poll.task;
          const call = [...this.calls.values()].find(call => call.backgroundTaskId === task || (poll.stop && call.agentId === task));
          if (call && !call.reviewed && (!call.done || call.pendingReview) && !block.is_error && (poll.stop || /^(?:completed|failed|killed)$/.test(result.task?.status || result.status))) {
            if (this.endSubagent(call, at, poll.stop ? 'killed' : result.task?.status || result.status,
              poll.stop ? { kind: 'stop', startedAt: poll.at, generation: poll.generation } : undefined)) { call.pendingReview = false; changed = true; }
          }
          continue;
        }
        if (block.is_error) changed = this.finishContinuation(block.tool_use_id, at, true) || changed;
        if (!this.toolCall(block.tool_use_id)) continue;
        const agentId = REMOTE_ID.test(text(result.agentId)) ? result.agentId : null;
        const call = this.bindSubagent(agentId, block.tool_use_id);
        if (!call || call.reviewed) continue;
        call.background ||= enabled(result.isAsync) || !!result.backgroundTaskId;
        if (typeof result.backgroundTaskId === 'string' && result.backgroundTaskId) call.backgroundTaskId = result.backgroundTaskId;
        if (block.is_error || !call.background) changed = this.endSubagent(call, at, block.is_error ? 'failed' : 'completed',
          { kind: 'agent', toolUseId: block.tool_use_id }) || changed;
        if (call.agent === 'Claude Code') {
          if (typeof result.resolvedModel === 'string' && result.resolvedModel) {
            call.resultModel = result.resolvedModel;
            const model = call.meter?.model || result.resolvedModel;
            changed ||= call.model !== model; call.model = model;
          }
          this.refresh(call.key);
        }
      }
    }
    return changed;
  }
  apply(record) {
    if (record.isSidechain) return false;
    const content = record.message?.content;
    const at = Date.parse(record.timestamp) + this.clockOffset;
    let changed = this.applyToolRecords(record, content, at);
    // An enqueue ends the worker; its delivered notification starts the lead's review round.
    let hasNotification = false;
    const queued = record.type === 'queue-operation';
    if (record.type === 'user' || (queued && ['enqueue', 'remove'].includes(record.operation)) || record.attachment?.type === 'queued_command') {
      const notificationContent = queued ? text(record.content) : record.attachment?.prompt ?? content;
      const body = typeof notificationContent === 'string' ? notificationContent : (Array.isArray(notificationContent) ? notificationContent.filter(block => block.type === 'text').map(block => text(block.text)).join('\n') : '');
      for (const [notification] of body.matchAll(/<task-notification>[\s\S]*?<\/task-notification>/g)) {
        hasNotification = true;
        const toolUseId = /<tool-use-id>\s*([^<]+?)\s*<\/tool-use-id>/.exec(notification)?.[1];
        let id = toolUseId;
        const taskId = /<task-id>\s*([^<]+?)\s*<\/task-id>/.exec(notification)?.[1];
        if (!/<status>\s*(?:completed|failed|killed)\s*<\/status>/.test(notification)) continue;
        // Dispatch has its own UUID, not a transcript tool-use id. Delivery opens the lead's next review round.
        if (!queued || record.operation === 'remove') for (const call of this.calls.values()) {
          if (call.dispatch && call.failure && call.finishedAt <= at) call.pendingReview = false;
        }
        if (!this.toolCall(id) && taskId) id = [...this.calls].find(([, call]) => call.backgroundTaskId === taskId || call.agentId === taskId)?.[0];
        const call = this.toolCall(id);
        if (!call || call.reviewed) continue;
        if (queued && record.operation === 'remove' && !call.done) continue;
        if (!call.done) {
          if (this.endSubagent(call, at, /<status>\s*(completed|failed|killed)\s*<\/status>/.exec(notification)[1],
            { kind: 'notification', toolUseId })) { call.pendingReview = queued; changed = true; }
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
    // Foreground launches expose their tool-use identity in host metadata before the parent gets a tool result.
    for (const [agentId, entry] of Object.entries(answer)) {
      if (REMOTE_ID.test(agentId) && TOOL_ID.test(text(entry?.toolUseId))) this.bindSubagent(agentId, entry.toolUseId);
    }
    let changed = false;
    for (const call of this.calls.values()) {
      if (!this.remoteFollows(call)) continue;
      const before = this.signature(call), entry = Object.hasOwn(answer, call.agentId) ? answer[call.agentId] : null;
      if (Array.isArray(entry?.records)) {
        if (entry.reset || !call.meter) {
          resetChildSettings(call); call.unfollowed = false;
          call.meter = new TokenRates('claude', { sidechain: true }); call.meter.reset(entry.partial === true);
        }
        for (const record of entry.records) if (record && typeof record === 'object') childRecord(call, record, this.clockOffset);
        call.behind = entry.behind === true;
        call.pollPartial = entry.partial === true;
      } else Object.assign(call, { behind: null, unfollowed: !!call.meter });
      if (call.meter) { call.rate = { ...call.meter.snapshot(), ...(call.unfollowed || call.pollPartial ? { partial: true } : {}) }; call.model = childModel(call); }
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
  signature(call) { return JSON.stringify(call && [call.model, call.effort, call.fast, call.preparing, call.title, call.role, call.rate, call.viewable, call.done, call.failure, call.awaiting]); }
  async readSubagent(call, filename, calls, meta) {
    filename = filename ? await containedFile(this.folder, filename, { exact: true }) : null;
    const home = rootValue(this.claudeHome);
    if (filename && home && !await containedFile(path.join(home, 'projects'), filename, { exact: true })) filename = null;
    if (this.calls !== calls) return;
    if (call.reader?.filename !== filename) {
      resetChildSettings(call);
      call.model = call.resultModel || call.model; call.rate = null;
      call.meter = new TokenRates('claude', { sidechain: true });
      call.reader = filename ? new TranscriptTail(filename, { onReset: async (partial, file) => {
        if (!await containedFile(this.folder, filename, { file, exact: true })) throw new Error('unavailable');
        if (home && !await containedFile(path.join(home, 'projects'), filename, { file, exact: true })) throw new Error('unavailable');
        call.meter.reset(partial); resetChildSettings(call);
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
    if (call.effort == null || call.seatInput && !call.childEffort) call.effort = text(meta?.effort).trim() || call.effort || null;
    call.model = childModel(call, meta);
    this.feeds.update(call, readable);
  }
  async readModels(folder, ids, calls) {
    for (const id of ids) {
      const call = calls.get(id);
      if (call?.dispatch) {
        let alive;
        if (!call.done) { try { alive = await this.dispatchAlive(call); } catch {} }
        // The final wake may have been lost after the helper flushed its end. Drain that proof before inferring death.
        if (alive === false && this.dispatchReplay) { try { await this.dispatchReplay(); } catch { alive = null; } }
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
    const matches = new Map(), metadata = new Map();
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
      const id = entry.value?.toolUseId;
      if (this.toolCall(id)) {
        if (!metadata.has(id)) metadata.set(id, { ...entry.value, agentId: name.slice(6, -10), filename: filename.replace(/\.meta\.json$/, '.jsonl') });
        else metadata.set(id, null);
      }
    }
    for (const [id, meta] of metadata) {
      const tool = this.toolCall(id);
      if (!tool || !ids.has(tool.key)) continue;
      const call = meta ? this.bindSubagent(meta.agentId, id) : tool;
      ids.delete(tool.key); ids.add(call.key); matches.set(call.key, meta);
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
