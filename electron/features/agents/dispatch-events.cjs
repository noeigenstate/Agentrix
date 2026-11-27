const { TASK_KINDS } = require('../dashboard/records-routing.cjs');
const { workerOf } = require('../cli-adapters/workers.cjs');
const { createHash, createHmac, timingSafeEqual } = require('node:crypto');
const path = require('node:path');
const uuid = value => typeof value === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value);
const REFUSAL_LIMIT = 20;
const line = (value, limit) => typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value);
const number = value => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const validSeat = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,31}(?:\/[a-z][a-z0-9-]{0,23})?$/.test(value);
const routing = value => line(value?.model, 160) && (value.effort === null || line(value.effort, 32)) && (value.fast === null || typeof value.fast === 'boolean');
const totals = event => Number.isSafeInteger(event.outputTokens) && event.outputTokens >= 0 && number(event.activeMs);
const optionalCount = value => value == null || Number.isSafeInteger(value) && value >= 0;
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const percent = value => value === null || Number.isFinite(value) && value >= 0 && value <= 100;
// An observation time: never later than a minute past this clock.
const observed = value => number(value) && value <= Date.now() + 60000;
const NOTICES = ['credits_required', 'spend_limit', 'rate_limited'];
const dispatchDirectory = bootstrapFile => path.join(path.dirname(bootstrapFile), 'dispatch-outbox', path.basename(bootstrapFile));
const dispatchKeyId = key => createHash('sha256').update(key).digest('hex');
// Sort object keys so JSON encoding and field order never change a signed fact. Credentials travel only on the pipe.
function signedBytes(frame) {
  const { mac, sessionKey, sequence, ...body } = frame;
  return JSON.stringify(body, (_key, value) => object(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value);
}
function dispatchFrame(event, { projectId, sessionKey, seq }) {
  const { mac, sessionKey: ignored, ...body } = event;
  const frame = { ...body, projectId, version: 1, seq, keyId: dispatchKeyId(sessionKey) };
  frame.mac = createHmac('sha256', sessionKey).update(signedBytes(frame)).digest('hex');
  return frame;
}
function verifyDispatchFrame(frame, key) {
  if (!key || frame?.version !== 1 || !uuid(frame.id) || !line(frame.projectId, 200) || !Number.isSafeInteger(frame.seq) || frame.seq < 1
    || frame.keyId !== dispatchKeyId(key) || typeof frame.mac !== 'string' || !/^[a-f\d]{64}$/.test(frame.mac)
    || Buffer.byteLength(JSON.stringify(frame)) > 16384) return false;
  return timingSafeEqual(Buffer.from(frame.mac, 'hex'), createHmac('sha256', key).update(signedBytes(frame)).digest());
}

// A quota window as the worker's app-server merged it (mergeLimits); undefined when it is not one.
function quotaWindow(value) {
  if (value === null) return null;
  if (!object(value) || !percent(value.usedPercent) || !optionalCount(value.windowDurationMins) || !optionalCount(value.resetsAtMs)) return undefined;
  return { usedPercent: value.usedPercent, windowDurationMins: value.windowDurationMins ?? null, resetsAtMs: value.resetsAtMs ?? null };
}
const validNotice = notice => notice == null
  || object(notice) && NOTICES.includes(notice.code) && optionalCount(notice.resetsAtMs) && line(notice.message, 200);
function quota(value) {
  if (!object(value) || !['ready', 'unavailable'].includes(value.state) || !observed(value.observedAtMs) || !object(value.limitsById)) return undefined;
  const buckets = Object.entries(value.limitsById), limitsById = {};
  if (buckets.length > 8) return undefined;
  for (const [id, bucket] of buckets) {
    if (!/^[\w.-]{1,64}$/.test(id) || !object(bucket)) return undefined;
    limitsById[id] = {};
    for (const name of ['primary', 'secondary']) if (name in bucket) {
      const parsed = quotaWindow(bucket[name]);
      if (parsed === undefined) return undefined;
      limitsById[id][name] = parsed;
    }
  }
  const { resetCredits: credits, notice, ordinaryUsageAllowed, providerStatus } = value;
  if (!(credits === null || object(credits) && optionalCount(credits.availableCount))) return undefined;
  if (!(ordinaryUsageAllowed === null || typeof ordinaryUsageAllowed === 'boolean')) return undefined;
  if (!(providerStatus === undefined || providerStatus === 'rejected') || !validNotice(notice)) return undefined;
  return { state: value.state, observedAtMs: value.observedAtMs, limitsById, ordinaryUsageAllowed,
    resetCredits: credits && { availableCount: credits.availableCount ?? null },
    ...(providerStatus ? { providerStatus } : {}),
    ...(notice ? { notice: { code: notice.code, resetsAtMs: notice.resetsAtMs ?? null, message: notice.message } } : {}) };
}

// A dispatched Codex worker's account and quota as its own app-server read them, rebuilt from known fields only, as the
// limits payload an account read gives (subscriptionLimits). The account's name was made with main's key (a local
// helper receives it at control registration), so it is used as given; the connection goes with the payload as
// host-only evidence. null when the report is not one.
function dispatchAccount(event) {
  const { connection: reported, limits: read } = event;
  if (!object(reported) || !['api', 'subscription', 'none', 'unknown'].includes(reported.kind)) return null;
  if (!(reported.observedAt === null || observed(reported.observedAt))) return null;
  if (!(reported.scopeId === undefined || typeof reported.scopeId === 'string' && /^[a-f\d]{64}$/.test(reported.scopeId))) return null;
  const limits = read === null ? null : quota(read), named = reported.kind !== 'unknown';
  if (limits === undefined) return null;
  const connection = { kind: reported.kind, active: false, source: 'codex-app-server account/read', observedAt: named ? reported.observedAt : null,
    ...(named && reported.scopeId ? { scopeId: reported.scopeId } : {}) };
  const observedAtMs = limits?.observedAtMs ?? connection.observedAt;
  if (observedAtMs === null) return null;
  const payload = { state: 'unavailable', limitsById: {}, resetCredits: null, ordinaryUsageAllowed: null, ...limits,
    scopeId: connection.scopeId ? `codex-dispatch:${connection.scopeId}` : 'codex-dispatch', accountScopeId: connection.scopeId || null,
    billingRoute: 'subscription', observedAtMs, source: 'codex-app-server' };
  return Object.defineProperty(payload, 'accountConnection', { value: connection });
}
const envelope = event => !!event && uuid(event.id) && Buffer.byteLength(JSON.stringify(event)) <= 16384;

const isDispatchAgent = agent => !!workerOf(agent);

function validDispatch(event) {
  if (!envelope(event)) return false;
  if (event.type === 'dispatch-declared') return isDispatchAgent(event.agent) && ['执行', '调查', '审查', '圆桌'].includes(event.role)
    && line(event.title, 1024) && line(event.cwd, 4096) && line(event.worktree, 4096) && routing(event.requested)
    && (event.expected == null || routing(event.expected) && event.expected.effort !== null && typeof event.expected.fast === 'boolean')
    && Number.isSafeInteger(event.helperPid) && event.helperPid > 0 && ['dispatch', 'intercepted'].includes(event.source)
    && (event.parentId == null) && (event.leadMode == null || ['native', 'terminal', 'codex'].includes(event.leadMode))
    && (event.resumed == null || typeof event.resumed === 'boolean') && number(event.at)
    && (event.kind == null || TASK_KINDS.includes(event.kind)) && (event.seat == null || validSeat(event.seat))
    && (event.meeting == null || typeof event.meeting === 'string' && /^[\w.-]{1,64}$/.test(event.meeting));
  if (event.type === 'dispatch-notice') return number(event.at) && (event.controlFailure === null
    || line(event.controlFailure, 160) && /^[\w.-]+\/[\w.-]+$/.test(event.controlFailure));
  if (event.type === 'dispatch-rate') return totals(event) && event.activeMs > 0;
  if (event.type === 'dispatch-input') return line(event.sessionId, 160) && line(event.entryId, 200)
    && event.entryId.startsWith('u:') && (event.inputId == null || line(event.inputId, 160)) && ['owner', 'planner'].includes(event.origin)
    && (event.ownerMessageIds == null || Array.isArray(event.ownerMessageIds) && event.ownerMessageIds.length <= 32 && event.ownerMessageIds.every(uuid));
  if (event.type === 'dispatch-receipt') return typeof event.messageId === 'string' && /^[\w-]{1,160}$/.test(event.messageId)
    && ['queued', 'delivered', 'consumed', 'rejected', 'unknown'].includes(event.status);
  if (event.type === 'dispatch-account') return !!dispatchAccount(event);
  if (!routing(event)) return false;
  if (event.type === 'dispatch-routing') return true;
  if (event.type === 'dispatch-start') return isDispatchAgent(event.agent) && ['执行', '调查', '审查', '圆桌'].includes(event.role) &&
    line(event.title, 1024) && ['cwd', 'brief', 'out'].every(key => line(event[key], 4096)) &&
    (event.seat == null || validSeat(event.seat)) && (event.log == null || line(event.log, 4100) && event.log === `${event.out}.log`) &&
    (event.unconfirmed === undefined || typeof event.unconfirmed === 'boolean') &&
    (line(event.sessionId, 160) || event.unconfirmed === true && event.sessionId === null) &&
    number(event.startedAt) && (event.declared === undefined || routing(event.declared)) && (event.requestedModel == null || line(event.requestedModel, 160)) &&
    (event.kind == null || TASK_KINDS.includes(event.kind)) &&
    (event.meeting == null || typeof event.meeting === 'string' && /^[\w.-]{1,64}$/.test(event.meeting)) &&
    (event.skipMeeting == null || line(event.skipMeeting, 1024));
  return event.type === 'dispatch-end' && ['exit', 'killed', 'capacity', 'error', 'unconfirmed', 'scope', 'permission'].includes(event.reason) &&
    (event.refused === undefined || validRefusals(event.refused)) &&
    (event.treeStopFailure === undefined || event.reason === 'killed' && line(event.treeStopFailure, 160)) &&
    (event.outOfScope === undefined || Array.isArray(event.outOfScope) && event.outOfScope.length <= 50 && event.outOfScope.every(file => line(file, 4096))) &&
    (event.exitCode === null || Number.isSafeInteger(event.exitCode) && Math.abs(event.exitCode) <= 0xffffffff) && number(event.endedAt) &&
    (event.outputTokens === null || Number.isSafeInteger(event.outputTokens) && event.outputTokens >= 0) &&
    (event.activeMs === null || number(event.activeMs)) && optionalCount(event.inputTokens) && optionalCount(event.cachedTokens) && optionalCount(event.totalOutputTokens) &&
    (event.filesChanged === undefined || Array.isArray(event.filesChanged) && event.filesChanged.length <= 50
      && event.filesChanged.every(file => line(file, 4096))) && optionalCount(event.filesChangedCount) &&
    optionalCount(event.outOfScopeCount) && (event.reportedCostUsd == null || number(event.reportedCostUsd)) &&
    (event.verdict === undefined || ['ok', 'mismatch', 'unverified'].includes(event.verdict));
}

const validRefusal = entry => line(entry?.action, 160) && typeof entry.reason === 'string' &&
  (entry.reason === 'needs approval' || /^[a-z_]{1,40}$/.test(entry.reason)) && Object.keys(entry).length === 2;
const validRefusals = value => Array.isArray(value) && value.length <= REFUSAL_LIMIT && value.every(validRefusal);

// calls: the session's called models (AgentCalls), present whether or not an agent runs in that terminal.
// observeAccount: takes a running Codex call's account report as a limits payload (dispatchAccount); it may decline it.
function acceptDispatch(session, event, calls, observeAccount, admissionKey = session?.sessionKey) {
  if (!session || event.sessionKey !== admissionKey || event.projectId !== session.terminalId) return false;
  if (event.type === 'dispatch-account') {
    const call = envelope(event) && calls?.byId(`dispatch:${event.id}`), payload = call?.sourceAgent === 'codex' && !call.done && dispatchAccount(event);
    return !!payload && (observeAccount?.(payload) || false);
  }
  if (!validDispatch(event)) return false;
  const agent = isDispatchAgent(session.agent) ? session.agent : null;
  const model = session.nativeStructured ? session.nativeObservedModel : session.usage?.rates?.model;
  const planner = { kind: 'planner', agent, model: line(model, 160) && model !== '<synthetic>' ? model : null };
  return calls?.dispatch(['dispatch-declared', 'dispatch-start'].includes(event.type) ? { ...event, planner } : event) || false;
}

const fields = (required, optional = '') => Object.freeze({
  required: Object.freeze(required.split(' ')),
  optional: Object.freeze(optional ? optional.split(' ') : []),
});
const dispatchFields = (required = '', optional) => fields(`v type id at${required && ' ' + required}`, optional);
const shellFields = optional => fields('v type projectId sessionKey sequence', `sentAt ${optional}`);
const fileFields = (required = '', optional, version = 1) => Object.freeze({ ...fields(`format version${required && ' ' + required}`, optional), version });

// Field names for the unsigned channels. Signed frames retain their own admission and version checks above.
const WIRE_FIELDS = Object.freeze({
  dispatch: Object.freeze({
    'dispatch.started': dispatchFields('agent model effort fast routing pid session', 'fallback'),
    'dispatch.waiting': dispatchFields('kind message', 'menu'),
    'dispatch.start-failed': dispatchFields('code message'),
    'dispatch.ended': dispatchFields('agent model effort fast exitCode reason rate scope refused needsDecision result routing',
      'interventions stops treeStopFailure warnings fallback'),
    'dispatch.running': dispatchFields('seconds lastActivityAt', 'waiting'),
    'dispatch.unknown-run': dispatchFields(),
    'dispatch.detached': dispatchFields(),
    'dispatch.intervention': dispatchFields('messageId status', 'reason'),
    'dispatch.transport': dispatchFields('path reason'),
    'dispatch.request': dispatchFields('requestId resolution'),
    'dispatch.resume': dispatchFields('state message'),
    'dispatch.notice': dispatchFields('code', 'detail'),
    'dispatch.failed': dispatchFields('message'),
  }),
  shell: Object.freeze({
    'shell-ready': shellFields('codexAvailable claudeAvailable codexHome cwd agent exitCode'),
    'shell-prompt': shellFields('codexAvailable claudeAvailable codexHome cwd agent exitCode'),
    'agent-started': shellFields('agent exitCode codexAvailable claudeAvailable codexHome cwd command accountLaunch args'),
    'agent-exited': shellFields('agent exitCode codexAvailable claudeAvailable codexHome cwd command'),
    'hook-channel': shellFields('agent exitCode codexAvailable claudeAvailable codexHome cwd command'),
  }),
  hook: Object.freeze({
    'agent-activity': fields('v type projectId sessionKey agent state sessionId eventId',
      'message sentAt hookEvent sessionSource menuTool turnId requestId promptId transcriptPath prompt agentId agentType'),
    'claude-seat-input': fields('v type projectId sessionKey toolUseId model effort phase', 'sessionId expected cwd sentAt sequence'),
    'turn-complete': fields('v type projectId sessionKey eventId threadId turnId', 'cwd sentAt sequence'),
  }),
  journal: Object.freeze({
    end: fields('v type id time agent title session role kind model reason outputTokens totalOutputTokens activeMs',
      'exitCode at effort fast requested verdict seat source parentId meeting outcome filesChanged outOfScope'),
    intervention: fields('v type id messageId at time text'),
    stop: fields('v type id messageId at time', 'reason noResume'),
    withdrawn: fields('v type id messageId at time'),
    'control-receipt': fields('v type id messageId status at time', 'reason'),
    'dispatch-input': fields('v type id sessionId entryId inputId origin ownerMessageIds at time'),
    // Historical dashboard and Lab rows can carry either time or at.
    meeting: fields('v type', 'id time at meeting agent session title status confirmation'),
    skip: fields('v type id reason', 'time at meeting'),
    consolidate: fields('v type', 'id time at meeting'),
    incident: fields('v type', 'id time at meeting model kind cause fix lead weight'),
    finding: fields('v type', 'id time at meeting author category title fixed'),
    issues: fields('v type issues', 'id time at meeting'),
  }),
  inbox: Object.freeze({
    // In 1.6.4 the intervention row has no type; 1.6.5 writes the explicit type.
    intervention: fields('v id at text', 'type'),
    stop: fields('v type id at', 'reason noResume'),
    withdrawn: fields('v type id at'),
  }),
  memory: Object.freeze({ 'memory.entry': fields('v type at title text', 'runId source') }),
  launch: Object.freeze({ 'launch.words': fields('v type unset env argv') }),
  files: Object.freeze({
    'agentrix.detached-run': fileFields('id argv source cwd out createdAt',
      'roleFallback roleArtifacts helperPid helperStartedAt lease admitted activityAt startedAt confirmedAt endedAt settled exitCode ownerWait ownerWaitSequence menu refused routing needsDecision'
      + ' started waiting startFailed ended startedLine waitingLine failedLine endedLine', 2),
    'agentrix.bootstrap': fileFields('projectId projectPath sessionKey pipeName', 'controlAddress controlCapability shims nodePath claudeEnvFile'),
    'agentrix.background-policy': fileFields('claudeBackgroundTasks'),
    'agentrix.seat-map': fileFields('seats'),
    'agentrix.terminal-wire': fileFields('words claude'),
    'agentrix.board': fileFields('id pid title role agent model cwd allow startedAt', 'session controls closing'),
    'agentrix.role-result': fileFields('runId source answer needsDecision needsApproval findings calls at', 'verification warnings'),
    'agentrix.lead-seat': fileFields('model effort fast ultracode seats'),
    'agentrix.session-mode': fileFields('mode'),
    'agentrix.launch-route': fileFields('route'),
    'agentrix.launch-words': fileFields('', 'unset env arg'),
  }),
});

const KEY_VALUE_LIMIT = 16 * 1024;
const KEY = /^[a-z][a-z0-9_]*$/;
const VERSION = /^[1-9][0-9]*$/;
const WIRE_FORMAT = /^agentrix\.[a-z][a-z0-9-]*$/;

function wireError(code, channel, detail) {
  return Object.assign(new Error(`${channel}: ${detail}`), { code: `wire.${code}` });
}

function checkVersion(channel, received, version, versions) {
  if (!Number.isSafeInteger(version) || version < 1 || !versions.includes(version)) {
    const label = received && typeof received === 'object' ? Object.prototype.toString.call(received)
      : String(received).slice(0, 80).replace(/[\r\n\0]/g, ' ');
    throw wireError('unsupported_version', channel, `unsupported version ${label}`);
  }
}

// Parsing the envelope leaves payload validation to the channel owner and keeps the original legacy record intact.
function readEnvelope(input, { format, channel = format ?? 'JSONL', versions = [WIRE_FIELDS.files[format]?.version ?? 1], legacy: allowLegacy = true } = {}) {
  const value = typeof input === 'string' ? JSON.parse(input) : input;
  if (!object(value)) throw wireError('invalid', channel, 'expected a JSON object');
  const key = format ? 'version' : 'v';
  const legacy = !Object.hasOwn(value, key);
  if (!legacy || !allowLegacy) checkVersion(channel, legacy ? '0 (missing)' : value[key], legacy ? 0 : value[key], versions);
  if (format && (!legacy || Object.hasOwn(value, 'format')) && value.format !== format) {
    throw wireError('invalid', channel, `expected format ${format}`);
  }
  return { value, version: legacy ? 0 : value[key], legacy };
}

function readKeyValue(text, { format, versions = [1] } = {}) {
  const channel = format ?? 'key=value';
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > KEY_VALUE_LIMIT) {
    throw wireError('invalid', channel, 'expected UTF-8 text up to 16 KiB');
  }
  const lines = text.replace(/^\uFEFF/, '').split('\n'), values = {};
  if (lines.at(-1) === '') lines.pop();
  for (const row of lines) {
    const equals = row.indexOf('='), key = row.slice(0, equals), value = row.slice(equals + 1);
    if (equals < 1 || !KEY.test(key) || /[\r\0]/.test(value) || Object.hasOwn(values, key)) {
      throw wireError('invalid', channel, 'invalid or repeated key=value record');
    }
    values[key] = value;
  }
  if (!WIRE_FORMAT.test(values.format) || (format !== undefined && values.format !== format) || !Object.hasOwn(values, 'version')) {
    throw wireError('invalid', channel, 'expected format and version');
  }
  checkVersion(format ?? values.format, values.version, VERSION.test(values.version) ? Number(values.version) : NaN, versions);
  return values;
}

function writeKeyValue(values, { format, versions = [1] } = {}) {
  const channel = format ?? 'key=value';
  if (!object(values)) throw wireError('invalid', channel, 'expected key=value fields');
  const rows = Object.entries(values).map(([key, value]) => {
    if (!KEY.test(key) || typeof value !== 'string' || /[\r\n\0]/.test(value)) {
      throw wireError('invalid', channel, 'invalid key=value field');
    }
    return `${key}=${value}\n`;
  });
  const text = rows.join('');
  readKeyValue(text, { format, versions });
  return text;
}

function readRoleResult(input) {
  const format = 'agentrix.role-result';
  const { value } = readEnvelope(input, { format, legacy: false });
  const { required, optional } = WIRE_FIELDS.files[format];
  if (required.some(key => !Object.hasOwn(value, key)) || !uuid(value.runId) || typeof value.answer !== 'string'
    || !['finish-role', 'final-text', 'legacy-heading'].includes(value.source) || !optionalCount(value.calls) || value.calls == null
    || !number(value.at) || !(value.needsDecision === null || Array.isArray(value.needsDecision))
    || !Array.isArray(value.needsApproval) || !Array.isArray(value.findings)
    || value.warnings !== undefined && (!Array.isArray(value.warnings) || value.warnings.length > 4 || !value.warnings.every(warning => line(warning, 240)))) {
    throw wireError('invalid', format, 'invalid role result');
  }
  return Object.fromEntries([...required, ...optional].filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
}

function readSessionMode(text) {
  const format = 'agentrix.session-mode';
  const { mode } = readKeyValue(text, { format });
  if (!['native', 'conductor'].includes(mode)) throw wireError('invalid', format, 'invalid mode');
  return mode;
}

function readLeadSeat(text) {
  const format = 'agentrix.lead-seat';
  const { model, effort, fast, ultracode, seats } = readKeyValue(text, { format });
  if (!line(model, 160) || model.startsWith('-') || !line(effort, 32) || effort.startsWith('-')
    || !['0', '1'].includes(fast) || !['0', '1'].includes(ultracode) || seats === undefined) {
    throw wireError('invalid', format, 'invalid lead seat');
  }
  const seatsMap = JSON.parse(seats);
  if (seatsMap !== null && !object(seatsMap)) throw wireError('invalid', format, 'invalid seat map');
  return { model, effort, fast: fast === '1', ultracode: ultracode === '1', seatsMap };
}

module.exports = {
  REFUSAL_LIMIT, validRefusal, validRefusals, acceptDispatch, validDispatch, validSeat, dispatchAccount, dispatchDirectory, dispatchKeyId, dispatchFrame, verifyDispatchFrame,
  WIRE_FIELDS, readEnvelope, readKeyValue, writeKeyValue, readRoleResult, readSessionMode, readLeadSeat, isDispatchAgent,
};
