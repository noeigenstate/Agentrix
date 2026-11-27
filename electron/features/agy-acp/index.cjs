const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createEvents, turnItems } = require('./events.cjs');
const { createRequests } = require('./requests.cjs');
const { readActualModel, isCatalogModel, observedModel, probeModels } = require('./models.cjs');
const { profileOf, createConnection, projectExtensions, initialize, openSession, configure, effectiveOptions, config, modelKey, errorWithCode, SESSION_ID } = require('./session.cjs');
const { listHistory } = require('./history.cjs');
const { TurnQueue } = require('./turns.cjs');

const occupied = new Set();
const errorCode = error => typeof error.code === 'string' ? error.code : error.message;

function configChoices(options, id, map = value => value) {
  return (config(options, id)?.options ?? []).filter(option => typeof option?.value === 'string')
    .map(({ value, name }) => ({ value: map(value), label: typeof name === 'string' ? name : value }));
}

class AgySession {
  state = 'starting';
  disconnected = false;
  startup = new AbortController();
  routingChanges = [];

  constructor(spec, emit, { connect, dataDir, clientVersion, now, remoteContext }) {
    this.spec = { ...spec, agent: 'agy' };
    Object.assign(this, { connect, dataDir, clientVersion, remoteContext });
    this.events = createEvents(this.spec, emit, now);
    this.turns = new TurnQueue({ events: this.events, now, owner: spec.owner === 'gui', setState: this.setState, onModel: actual => this.model(actual),
      beforeTurn: () => this.applyPendingRouting(),
      onDisconnect: code => { this.disconnect(code); void this.connection.close().catch(() => {}); } });
  }

  setState = (state, reason = null) => {
    this.state = state;
    this.events.publish('session.state', { state, reason });
  };

  checkOpen = () => { if (this.closing || this.disconnected) throw errorWithCode(this.closing ? 'session_closed' : 'disconnected'); };

  disconnect = code => {
    if (this.closing || this.disconnected) return;
    this.disconnected = true;
    this.rejectRouting(code);
    this.turns.end('unknown', code);
    if (this.state !== 'starting') this.setState('disconnected', code);
  };

  notification = (method, params) => {
    if (this.closing || this.disconnected || method !== 'session/update' || !params?.update || params.sessionId !== this.sessionId) return;
    if (params.update.sessionUpdate === 'usage_update') {
      if (this.historyItems) this.historyContext = params.update;
      else this.events.context(params.update);
    } else if (this.historyItems) this.historyItems.update(params.update);
    else this.turns.update(params.update);
  };

  model(actual) {
    this.routing = { ...this.routing, observed: observedModel(actual, this.routing.effective), reason: actual ? null : 'model_unverified' };
    this.events.publish('routing.updated', this.routing);
  }

  reserve(profile, sessionId) {
    const key = `${process.platform === 'win32' ? profile.toLowerCase() : profile}\0${sessionId.toLowerCase()}`;
    if (occupied.has(key)) throw errorWithCode('agy_session_in_use');
    occupied.add(key);
    this.lock = key;
  }

  async closeConnection() {
    try { await this.connection?.close(); }
    finally {
      if (this.lock) occupied.delete(this.lock);
      this.lock = null;
    }
  }

  async open(resumed, override) {
    this.checkOpen();
    const spec = Object.assign(this.spec, override, { agent: 'agy' });
    this.setState('starting');
    try {
      if (resumed && !SESSION_ID.test(spec.providerSessionId)) throw errorWithCode('agy_invalid_session');
      const owner = spec.owner === 'gui';
      const remote = spec.kind === 'ssh';
      const local = remote ? {} : await this.prepareLocal(spec, owner);
      this.connection = await this.connect({ spec, ...local, purpose: 'session', signal: this.startup.signal, rpcTimeoutMs: spec.rpcTimeoutMs, checkOpen: this.checkOpen,
        onNotification: this.notification, onDisconnect: this.disconnect, onRequest: message => this.requests?.open(message),
        onDropped: bytes => this.events.publish('item.dropped', { reason: 'too_large', bytes }) });
      const { rpc } = this.connection;
      if (remote) {
        spec.cwd = this.connection.cwd;
        Object.assign(spec, this.remoteContext?.(spec, this.connection));
      }
      this.requests = createRequests({ spec, rpc, events: this.events, providerSessionId: () => this.sessionId,
        active: () => this.turns.awaitingApproval(), setState: this.setState });
      const physicalProfile = remote ? `ssh:${this.connection.child.remoteScope || spec.projectId}`
        : await fs.realpath(this.profile).catch(error => { if (local.profile) throw error; return this.profile; });
      this.checkOpen();
      if (resumed) this.reserve(physicalProfile, spec.providerSessionId);
      await initialize(rpc, this.clientVersion);
      this.checkOpen();
      const session = await this.openProtocolSession(rpc, spec, resumed);
      this.checkOpen();
      this.sessionId = session.sessionId;
      if (!resumed) this.reserve(physicalProfile, this.sessionId);
      this.events.provider(this.sessionId);
      this.options = await configure(rpc, session, spec);
      this.checkOpen();
      this.turns.bind({ rpc, requests: this.requests, profile: this.profile, sessionId: this.sessionId, turnTimeoutMs: spec.turnTimeoutMs });
      this.routing = { declared: { model: spec.model ?? null, effort: spec.effort ?? null, fast: null }, effective: effectiveOptions(this.options) };
      this.model(null);
      if (this.historyContext) { this.events.context(this.historyContext); this.historyContext = null; }
      const activeExtensions = [local.extensions?.hooks && 'agy hooks', local.extensions?.mcp && 'MCP servers'].filter(Boolean);
      if (!owner && activeExtensions.length) {
        const text = `Project ${activeExtensions.join(' and ')} were enabled in this run. Some approvals may have bypassed Agentrix.`;
        this.events.publish('worker.notice', { text });
      }
      this.setState('idle');
      return { providerSessionId: this.sessionId };
    } catch (error) {
      try { await this.closeConnection(); } catch {}
      if (!this.closing) {
        const code = errorCode(error);
        const message = ['agy_cli_outdated', 'agy_role_server_conflict'].includes(code) ? error.message : code;
        this.events.publish('error', { code, message, stage: 'startup', retryable: false, willRetry: false });
        this.setState('failed', code);
      }
      throw error;
    }
  }

  async prepareLocal(spec, owner) {
    spec.cwd = path.resolve(spec.cwd);
    const extensions = !owner || spec.mcpServers?.length ? await projectExtensions(spec.cwd) : {};
    this.checkOpen();
    if (spec.geminiDir && !path.isAbsolute(spec.geminiDir)) throw errorWithCode('agy_invalid_data_dir');
    const profile = spec.geminiDir ?? (owner ? null : profileOf(spec.dataDir ?? this.dataDir, spec.env ?? process.env));
    const home = spec.env?.USERPROFILE || spec.env?.HOME || os.homedir();
    this.profile = profile ?? path.join(home, '.gemini');
    return { profile, cwd: spec.cwd, env: spec.env, extensions };
  }

  async openProtocolSession(rpc, spec, resumed) {
    if (!resumed || spec.owner !== 'gui') return openSession(rpc, spec, resumed);
    const id = randomUUID();
    this.sessionId = spec.providerSessionId;
    this.events.provider(this.sessionId);
    this.events.turn(id);
    this.historyItems = turnItems(this.events, id, true);
    try {
      const session = await openSession(rpc, spec, true);
      this.historyItems.finish('completed');
      return session;
    } finally {
      this.historyItems = null;
      this.events.turn(null);
    }
  }

  modelOptions() {
    const { model, effort } = effectiveOptions(this.options);
    const models = configChoices(this.options, 'model', modelKey).filter(option => isCatalogModel(option.value));
    return { model, effort, models, efforts: configChoices(this.options, 'thought_level') };
  }

  async setModelOptions(patch, betweenTurns = false) {
    this.checkOpen();
    if ((!betweenTurns && (this.state !== 'idle' || this.routingChanges.length)) || this.configuring)
      throw errorWithCode('agy_session_busy', '请等待当前操作完成后再切换模型或强度。');
    const current = this.modelOptions();
    const models = betweenTurns ? configChoices(this.options, 'model', modelKey) : current.models;
    if (patch.model !== undefined && !models.some(option => option.value === patch.model)) throw errorWithCode('agy_invalid_model');
    if (patch.model === undefined && !current.efforts.some(option => option.value === patch.effort)) throw errorWithCode('agy_invalid_effort');
    if (patch.model === current.model) patch = { ...patch, model: undefined };
    if (patch.model === undefined && (patch.effort === undefined || patch.effort === current.effort)) return current;
    this.configuring = true;
    try {
      this.options = await configure(this.connection.rpc, { sessionId: this.sessionId, configOptions: this.options }, patch,
        options => { this.options = options; });
      if (patch.effort && effectiveOptions(this.options).effort !== patch.effort) throw errorWithCode('agy_invalid_effort');
      this.checkOpen();
    } finally {
      this.configuring = false;
      if (!this.closing && !this.disconnected) {
        const effective = effectiveOptions(this.options);
        this.routing = { declared: { ...effective, fast: null }, effective };
        this.model(null);
      }
      if (!betweenTurns && this.routingChanges.length) this.turns.pump();
    }
    return this.modelOptions();
  }

  async applyRouting({ model, effort }) {
    await this.opening;
    this.checkOpen();
    return new Promise((resolve, reject) => {
      this.routingChanges.push({ patch: { ...(model && { model }), ...(effort && effort !== 'default' && { effort }) }, resolve, reject });
      this.turns.pump();
    });
  }

  applyPendingRouting() {
    const pending = this.routingChanges[0];
    if (!pending) return false;
    if (!pending.started && !this.configuring) {
      pending.started = true;
      const { patch, resolve, reject } = pending;
      const applied = Object.keys(patch).length ? this.setModelOptions(patch, true) : Promise.resolve(this.modelOptions());
      void applied.then(resolve, reject).finally(() => {
        if (this.routingChanges[0] === pending) this.routingChanges.shift();
        this.turns.pump();
      });
    }
    return true;
  }

  rejectRouting(code) {
    for (const pending of this.routingChanges.splice(0)) pending.reject(errorWithCode(code));
  }

  begin(resumed, override) {
    this.checkOpen();
    if (this.opening) throw errorWithCode('session_already_started');
    this.opening = Promise.resolve().then(() => this.open(resumed, override));
    return this.opening;
  }

  start(override) { return this.begin(false, override); }
  resume(override) { return this.begin(true, override); }
  send(input) {
    const available = !this.closing && (!this.configuring || this.routingChanges.length > 0) && ['idle', 'running', 'waiting'].includes(this.state);
    return this.turns.send(input, available);
  }
  interrupt() { return this.turns.interrupt(); }
  answer(id, answer) { if (!this.requests) throw errorWithCode('request_expired'); return this.requests.answer(id, answer); }
  cancel(id) { if (!this.requests) throw errorWithCode('request_expired'); return this.requests.cancel(id); }
  workerIntent(id) { return this.requests?.workerIntent(id); }
  snapshot() { return { ...this.events.snapshot(), requests: this.requests?.snapshot() ?? [] }; }
  readActualModel() { return this.profile ? readActualModel(this.profile, this.sessionId) : Promise.resolve(null); }
  bindHost() { this.connection?.bindHost?.(); }
  get pid() { return this.connection?.pid; }

  close() {
    return this.closing ??= Promise.resolve().then(async () => {
      if (!this.connection) this.startup.abort();
      this.setState('stopping');
      this.rejectRouting('session_closed');
      this.turns.end('interrupted', 'session_closed');
      try {
        await this.closeConnection();
        await this.opening?.catch(() => {});
      } finally { this.setState('stopped'); }
    });
  }
}

function createAgyRuntime({ dataDir, clientVersion, now = Date.now, report, remoteContext, ...processOptions } = {}) {
  const connect = createConnection(processOptions);
  return {
    create: (spec, emit) => new AgySession(spec, emit, { connect, dataDir, clientVersion, now, remoteContext }),
    history: (spec, { signal } = {}) => listHistory(connect, spec, { signal, clientVersion }),
    models: (spec, { signal } = {}) => {
      const { cwd, env = process.env, rpcTimeoutMs } = spec;
      return probeModels(connect, spec.kind === 'ssh' ? { spec, signal, clientVersion, rpcTimeoutMs, report }
        : { cwd: path.resolve(cwd), env, profile: profileOf(dataDir, env), clientVersion, rpcTimeoutMs, report });
    },
  };
}

module.exports = { createAgyRuntime, readActualModel };
