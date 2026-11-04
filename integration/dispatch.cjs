// A command-line worker declares its assignment here; Agentrix never infers it from shell commands.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const { homedir, constants: { signals } } = require('node:os');
const { setImmediate } = require('node:timers');

// Plain Node cannot read app.asar. Packaged and SSH helpers carry these same pure modules beside them.
const runtime = path.join(__dirname, fs.existsSync(path.join(__dirname, 'electron')) ? 'electron' : '../electron');
const { TokenRates } = require(path.join(runtime, 'features/agents/token-rate.cjs'));
const { agentSettings } = require(path.join(runtime, 'features/agents/agent-settings.cjs'));
const { rolloutFiles, sessionMeta } = require(path.join(runtime, 'session-files.cjs'));
const { TranscriptTail } = require(path.join(runtime, 'transcript-tail.cjs'));
const { matches, snapshot, changedBetween, boundariesFor, repoFiles } = require(path.join(runtime, 'boundaries.cjs'));
const { projectTeam, meetingRequest, recordFindings, minutesMarkdown, FINDINGS } = require(path.join(runtime, 'features/team/team.cjs'));
const { RunInbox, runId, validText } = require(path.join(runtime, 'features/team/inbox.cjs'));
const { minutesPage } = require(path.join(runtime, 'features/team/minutes-page.cjs'));
const { TASK_KINDS, taskKind, routingVerdict } = require(path.join(runtime, 'features/dashboard/records-routing.cjs'));
const { WorkerSkillProposals } = require(path.join(runtime, 'features/skills/worker-proposals.cjs'));
const { createCodexRuntime, workerEnvironment } = require(path.join(runtime, 'features/codex-app-server/index.cjs'));
const { connectDispatchControl } = require(path.join(runtime, 'features/agents/dispatch-control.cjs'));
const RUNTIME_FILES = ['boundaries.cjs', 'session-files.cjs', 'transcript-tail.cjs', 'transcript-window.cjs', 'completion-history.cjs',
  'oversized-record.cjs', 'prompt-queue.cjs', 'features/agents/token-rate.cjs', 'features/agents/agent-settings.cjs',
  'features/team/team.cjs', 'features/team/minutes-page.cjs', 'features/team/inbox.cjs', 'features/dashboard/records-routing.cjs',
  'features/skills/session.cjs', 'features/skills/worker-proposals.cjs', 'features/agents/dispatch-control.cjs',
  'features/agents/codex-account-usage.cjs', 'features/codex-app-server/index.cjs', 'features/codex-app-server/rpc.cjs',
  'features/codex-app-server/events.cjs', 'features/codex-app-server/requests.cjs', 'features/codex-app-server/account.cjs', 'features/codex-app-server/compatibility.cjs', 'features/codex-app-server/environment.cjs'];
const runtimeFiles = () => {
  // A supplies this pure module in the merged tree. Older or standalone helper trees remain usable without it.
  const routing = 'features/native-session/routing.cjs';
  const files = fs.existsSync(path.join(runtime, routing)) ? [...RUNTIME_FILES, routing] : RUNTIME_FILES;
  return Object.fromEntries(files.map(file => [file, fs.readFileSync(path.join(runtime, file), 'utf8')]));
};

const START_TIMEOUT = 30000;
const RATE_INTERVAL = 5000;
// How often a Codex worker's session file is read until its start is confirmed, and how long a worker's last output may
// take to arrive after it exits before the helper decides from what it has.
const POLL_INTERVAL = 250, EXIT_SETTLE = 500;
const LIMIT = 4 * 1024 * 1024;
const word = value => typeof value === 'string' && value.trim() ? value.trim() : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const roles = new Map([['执行', '执行'], ['调查', '调查'], ['审查', '审查'], ['exec', '执行'], ['investigate', '调查'], ['review', '审查']]);
const USAGE = `Usage: node dispatch.cjs <codex|claude> --role <执行|调查|审查|exec|investigate|review>
  --title <task> --model <model> --effort <effort> --cwd <dir> --brief <file> --out <file>
  [--allow <glob> ...]    the only files it may change; any other change is reported as out of scope
  [--ledger <file>]       the task's shared context: given to the worker, its findings appended after
  [--resume <session>]    continue that worker session (same context) instead of starting a new one
  [--meeting <id>]        roundtable before work; no file changes and no --read-only
  [--skip-meeting <reason>] execution with --allow may bypass confirmation; the reason is recorded
  [--kind <${TASK_KINDS.join('|')}>] task category for long-term evaluation
  Codex: [--fast] [--image <file> ...] [--read-only]
  Claude: --permission <plan|acceptEdits>

  node dispatch.cjs minutes --cwd <dir> --meeting <id> --out <minutes.md> [--issues <issues.json>] [--language zh|en]
  node dispatch.cjs consolidate --cwd <dir> --meeting <id> --summary <file.md> [--incidents <file.json>] [--findings <file.json>]
  node dispatch.cjs stop <run id> [--reason <text>] [--no-resume] [--cwd <dir>]
`;

function argumentsOf(argv) {
  const [agent, ...flags] = argv;
  if (agent === 'stop') {
    const [id, ...rest] = flags, options = { agent, id, cwd: process.cwd(), noResume: false };
    if (!runId(id)) throw new Error('Expected a run id for stop');
    const seen = new Set();
    for (let i = 0; i < rest.length; i++) {
      const flag = rest[i];
      if (!['--reason', '--no-resume', '--cwd'].includes(flag) || seen.has(flag)) throw new Error(`Unknown or repeated option ${flag}`);
      seen.add(flag);
      if (flag === '--no-resume') { options.noResume = true; continue; }
      const value = rest[++i];
      if (!value || value.startsWith('--') || !validText(value)) throw new Error(`Expected a value for ${flag}`);
      options[flag === '--reason' ? 'reason' : 'cwd'] = value;
    }
    options.cwd = path.resolve(options.cwd);
    return options;
  }
  const command = ['minutes', 'consolidate'].includes(agent);
  if (!command && !['codex', 'claude'].includes(agent)) throw new Error('Expected codex, claude, minutes or consolidate');
  const options = { agent, images: [], allow: [], fast: false, readOnly: false };
  const keys = command ? ['cwd', 'meeting', ...(agent === 'minutes' ? ['out', 'issues', 'language'] : ['summary', 'incidents', 'findings'])]
    : ['role', 'title', 'model', 'effort', 'cwd', 'brief', 'out', 'permission', 'ledger', 'resume', 'meeting', 'kind'];
  const names = new Map(keys.map(key => [`--${key}`, key]));
  if (!command) names.set('--skip-meeting', 'skipMeeting');
  const seen = new Set();
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (!command && (flag === '--fast' || flag === '--read-only')) {
      if (seen.has(flag)) throw new Error(`Repeated option ${flag}`);
      seen.add(flag); options[flag === '--fast' ? 'fast' : 'readOnly'] = true; continue;
    }
    if (!names.has(flag) && (command || flag !== '--image' && flag !== '--allow')) throw new Error(`Unknown option ${flag}`);
    const value = flags[++i];
    if (!value || value.startsWith('--') || /[\0\r\n]/.test(value)) throw new Error(`Expected one-line value for ${flag}`);
    if (flag === '--image') options.images.push(value);
    else if (flag === '--allow') options.allow.push(value.replace(/\\/g, '/').replace(/^\.\//, ''));
    else {
      if (options[names.get(flag)] !== undefined) throw new Error(`Repeated option ${flag}`);
      options[names.get(flag)] = value;
    }
  }
  const required = command ? ['cwd', 'meeting', agent === 'minutes' ? 'out' : 'summary'] : ['role', 'title', 'model', 'effort', 'cwd', 'brief', 'out'];
  for (const key of required) if (!options[key]) throw new Error(`Missing --${key}`);
  if (options.meeting && !/^[\w.-]{1,64}$/.test(options.meeting)) throw new Error('Expected --meeting id with 1–64 letters, digits, _, . or -');
  if (command) {
    options.cwd = path.resolve(options.cwd);
    for (const key of ['out', 'issues', 'summary', 'incidents', 'findings']) if (options[key]) options[key] = path.resolve(options.cwd, options[key]);
    if (options.language && !['zh', 'en'].includes(options.language)) throw new Error('Expected --language zh or en');
    return options;
  }
  if (!roles.has(options.role)) throw new Error('Expected --role 执行, 调查, 审查, exec, investigate or review');
  options.role = roles.get(options.role);
  if (options.kind && !TASK_KINDS.includes(options.kind)) throw new Error(`Expected --kind ${TASK_KINDS.join(', ')}`);
  if (options.title.length > 1024 || options.model.length > 160 || options.effort.length > 32) throw new Error('Assignment is too long');
  if (agent === 'claude' && (options.fast || options.readOnly || options.images.length)) throw new Error('Claude supports --permission, not Codex options');
  if (agent === 'claude' && !['plan', 'acceptEdits'].includes(options.permission)) throw new Error('Expected --permission plan or acceptEdits');
  if (agent === 'codex' && options.permission) throw new Error('--permission is only for Claude');
  if (options.resume && !/^[\w-]{1,160}$/.test(options.resume)) throw new Error('Expected a session id for --resume');
  if (options.resume && options.readOnly) throw new Error('A resumed Codex session keeps its own sandbox; --read-only applies to new sessions');
  if (options.meeting && options.readOnly) throw new Error('A roundtable session must later build; --meeting cannot use --read-only');
  if (options.meeting && options.skipMeeting) throw new Error('--meeting and --skip-meeting cannot be combined');
  if (options.meeting && options.role === '执行' && !options.allow.length) throw new Error('An execution roundtable requires --allow for the agreed scope');
  if (options.skipMeeting && (!options.skipMeeting.trim() || options.skipMeeting.length > 1024 || options.role !== '执行' || !options.allow.length)) {
    throw new Error('--skip-meeting requires a reason and an execution run with --allow');
  }
  options.cwd = path.resolve(options.cwd);
  for (const key of ['brief', 'out', 'ledger']) if (options[key]) options[key] = path.resolve(options.cwd, options[key]);
  options.images = options.images.map(file => path.resolve(options.cwd, file));
  for (const file of [options.cwd, options.brief, options.out, ...options.images]) if (file.length > 4096) throw new Error('Path is too long');
  return options;
}

function commandOf(options) {
  if (options.agent === 'claude') return ['-p', ...(options.resume ? ['--resume', options.resume] : []), '--model', options.model,
    '--effort', options.effort, '--permission-mode', options.permission, '--output-format', 'stream-json', '--verbose'];
  const settings = ['-m', options.model, '-c', `model_reasoning_effort=${options.effort}`, ...(options.fast ? ['-c', 'service_tier="fast"'] : []), '--json'];
  const images = options.images.flatMap(file => ['-i', file]);
  // `codex exec resume` keeps the session's own folder and sandbox: it takes no -C or -s, and runs from cwd.
  if (options.resume) return ['exec', 'resume', options.resume, ...settings, '-o', options.out, ...images, '-'];
  return ['exec', ...settings, '-C', options.cwd, '-o', options.out, ...images, ...(options.readOnly ? ['-s', 'read-only'] : []), '-'];
}

// What the worker reads before the brief: the task's shared ledger, the boundaries of the modules it may change, the
// paths it may change, and how to hand its findings back.
function briefOf(options, brief, team, { id, phase, repo, before } = {}) {
  const parts = [];
  if (options.ledger) {
    let ledger = '';
    try { ledger = fs.readFileSync(options.ledger, 'utf8').trim(); } catch {}
    if (ledger) parts.push(`# Shared context for this task\n\n${ledger}`);
  }
  if (team) parts.push(...team.context(id, before));
  if (options.allow.length) {
    for (const boundary of boundariesFor(options.cwd, options.allow, repo)) parts.push(`# Module boundary: ${boundary.file}\n\n${boundary.text.trim()}`);
    parts.push(`# Files you may change\n\n${options.allow.map(glob => `- \`${glob}\``).join('\n')}\n\nChange nothing else. Any other changed file is `
      + 'reported to the lead as out of scope and the work is rejected. If the task cannot be done within these paths, stop and say which file you would need and why.');
  }
  parts.push('# Skill changes\n\nDo not edit, add or delete any SKILL.md unless --allow names that exact file without wildcards: that is the lead\'s approval. '
    + 'Put suggested skill changes under ## Skill proposals in your answer. Unapproved changes are preserved beside your answer; only an isolated worker worktree is restored. Shared or managed files are report-only because their author is unknown.');
  if (options.ledger || team) parts.push(`# Handing back\n\nEnd your final answer with a section headed exactly \`${FINDINGS}\`: bullets with the facts, decisions `
    + 'and pitfalls the next worker on this task must know (file:line where it helps). They are added to the shared context.');
  const prefixed = parts.length ? Buffer.concat([Buffer.from(`${parts.join('\n\n')}\n\n# Task\n\n`), brief]) : brief;
  return team && options.meeting ? Buffer.concat([prefixed, Buffer.from('\n\n' + meetingRequest(phase))]) : prefixed;
}

async function teamCommand(argv, stdout) {
  try {
    const options = argumentsOf(argv), team = projectTeam(options.cwd, options.agent !== 'stop');
    if (!team) throw new Error('Team commands require a git repository');
    if (options.agent === 'stop') {
      await team.queueControl(options.id, { id: randomUUID(), type: 'stop', at: Date.now(),
        ...(options.reason ? { reason: options.reason } : {}), ...(options.noResume ? { noResume: true } : {}) });
      stdout.write(`[dispatch] stop queued ${options.id}\n`);
      return 0;
    }
    if (options.agent === 'consolidate') {
      const records = {};
      for (const kind of ['incidents', 'findings']) if (options[kind]) {
        if (fs.statSync(options[kind]).size > 1024 * 1024) throw new Error(`--${kind} exceeds 1 MiB`);
        try { records[kind] = JSON.parse(fs.readFileSync(options[kind], 'utf8').replace(/^\uFEFF/, '')); }
        catch { throw new Error(`--${kind} must contain valid JSON`); }
      }
      await team.consolidate(options.meeting, fs.readFileSync(options.summary, 'utf8'), records);
    }
    else {
      const issues = options.issues ? JSON.parse(fs.readFileSync(options.issues, 'utf8').replace(/^\uFEFF/, '')) : undefined;
      const html = path.join(path.dirname(options.out), path.parse(options.out).name + '.html');
      if (html === options.out) throw new Error('--out must name the Markdown minutes, not the HTML companion');
      const minutes = await team.locked(() => team.minutes(options.meeting, issues, options.language));
      fs.writeFileSync(options.out, minutesMarkdown(minutes));
      fs.writeFileSync(html, minutesPage(minutes));
    }
    return 0;
  } catch (error) {
    stdout.write(`[dispatch] ${error.message.replace(/[\r\n]+/g, ' ')}\n`); return 1;
  }
}

// Serialize sends to preserve start/rate/end order. No pipe callback delays the worker or its output.
function eventSink(filename) {
  let bootstrap;
  try {
    if (!filename || fs.statSync(filename).size > 16384) return () => {};
    bootstrap = JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''));
    if (![bootstrap.pipeName, bootstrap.projectId, bootstrap.sessionKey].every(word)) return () => {};
  } catch { return () => {}; }
  const address = process.platform === 'win32' && !bootstrap.pipeName.startsWith('\\\\') ? `\\\\.\\pipe\\${bootstrap.pipeName}` : bootstrap.pipeName;
  let sending = false;
  const queue = [];
  function drain() {
    if (sending || !queue.length) return;
    sending = true;
    const event = queue.shift(), socket = net.connect(address);
    socket.setTimeout(250, () => socket.destroy());
    socket.on('error', () => socket.destroy());
    socket.once('close', () => { sending = false; drain(); });
    socket.once('connect', () => socket.end(JSON.stringify({ ...event, projectId: bootstrap.projectId, sessionKey: bootstrap.sessionKey }) + '\n'));
  }
  return event => {
    // A slow/disappeared app cannot retain unlimited rate reports.
    if (event.type === 'dispatch-rate') {
      const index = queue.findIndex(value => value.type === 'dispatch-rate');
      if (index >= 0) queue.splice(index, 1);
    }
    queue.push(event); drain();
  };
}

// Settings are read only from worker records/headers. A missing value remains unreported.
class WorkerOutput {
  constructor(agent, changed = () => {}) {
    this.agent = agent; this.changed = changed; this.meter = new TokenRates(agent);
    this.model = null; this.effort = null; this.fast = null; this.sessionId = null;
    this.outputTokens = null; this.activeMs = null; this.failed = false; this.capacity = false; this.confirmed = false;
    this.stdoutUsage = null; this.rolloutUsage = null; this.reportedCostUsd = null;
    this.baseline = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
    this.resumed = false; this.lastCounters = {}; this.invalidCounters = new Set();
  }
  settings(value) {
    this.model = word(value.model) || this.model;
    this.effort = word(value.perTurnEffort ?? value.reasoning_effort ?? value.reasoningEffort ?? value.effort ?? value.reasoning?.effort) || this.effort;
    const tier = value.service_tier ?? value.serviceTier ?? value.speed ?? value.usage?.speed;
    if (typeof value.fast === 'boolean') this.fast = value.fast;
    else if (typeof value.fast_mode === 'boolean') this.fast = value.fast_mode;
    else if (['on', 'off'].includes(value.fast_mode_state)) this.fast = value.fast_mode_state === 'on';
    else if (['fast', 'priority', 'standard', 'default', 'flex', 'auto'].includes(tier)) this.fast = ['fast', 'priority'].includes(tier);
  }
  measure(record) {
    this.meter.apply(record);
    const rates = [...this.meter.rates.values()];
    if (!rates.length) return;
    if (!rates.some(rate => rate.samples)) { this.outputTokens = null; this.activeMs = null; return; }
    this.outputTokens = rates.reduce((sum, rate) => sum + rate.outputTokens, 0);
    this.activeMs = rates.reduce((sum, rate) => sum + rate.activeMs, 0);
  }
  rollout(record) {
    const payload = record.payload || {};
    const settings = agentSettings({ model: this.model, effort: this.effort, fast: this.fast }, 'codex', record);
    Object.assign(this, settings);
    if (record.type === 'session_meta' || record.type === 'turn_context') this.settings(payload);
    if (record.type === 'turn_context') this.confirmed = true;
    const totals = this.counters(record);
    if (totals) {
      const delta = key => {
        const current = count(totals[key]), baseline = count(this.baseline?.[key]);
        if (current !== null) {
          if (current < Math.max(this.lastCounters[key] ?? 0, baseline ?? 0)) this.invalidCounters.add(key);
          this.lastCounters[key] = current;
        }
        return current !== null && baseline !== null && !this.invalidCounters.has(key) ? current - baseline : null;
      };
      const input = delta('input_tokens'), cached = delta('cached_input_tokens');
      this.rolloutUsage = { inputTokens: input !== null && cached !== null && input >= cached ? input - cached : null,
        cachedTokens: cached, outputTokens: delta('output_tokens') };
    }
    this.measure(record);
  }
  counters(record) {
    if (record.type === 'event_msg' && record.payload?.type === 'token_count') return record.payload.info?.total_token_usage || null;
    if (record.type === 'token_usage_record' || record.type === 'event_msg' && record.payload?.type === 'token_usage_record') return record.payload?.thread_token_usage || null;
    return null;
  }
  usage() {
    const total = this.rolloutUsage || (!this.resumed ? this.stdoutUsage : null);
    return { inputTokens: total?.inputTokens ?? null, cachedTokens: total?.cachedTokens ?? null,
      outputTokens: this.outputTokens, totalOutputTokens: total?.outputTokens ?? null,
      activeMs: this.activeMs, reportedCostUsd: this.reportedCostUsd };
  }
  nativeUsage(value, resumed) {
    // Native usage is cumulative; a resumed query without an invocation baseline cannot report its history as new cost.
    if (resumed) return;
    const input = count(value.input), cached = count(value.cachedInput), creation = count(value.cacheWrite);
    this.stdoutUsage = { inputTokens: this.agent === 'claude' ? (input !== null && creation !== null ? count(input + creation) : null)
      : input !== null && cached !== null && input >= cached ? input - cached : null,
      cachedTokens: cached, outputTokens: count(value.output) };
    const micros = count(value.costUsdMicros);
    if (this.agent === 'claude' && micros !== null && (this.reportedCostUsd === null || micros / 1e6 >= this.reportedCostUsd)) this.reportedCostUsd = micros / 1e6;
  }
  line(line) {
    const clean = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
    let record;
    try { record = JSON.parse(clean); } catch {
      if (/\bat capacity\b|overloaded|capacity exceeded/i.test(clean)) this.capacity = true;
      const header = /^(model|reasoning effort|service tier|speed|session id):\s*(.+)$/i.exec(clean);
      if (header) {
        const [, key, value] = header;
        if (key.toLowerCase() === 'session id') this.sessionId = word(value);
        else this.settings({ [key.toLowerCase().replace('reasoning effort', 'effort').replace('service tier', 'service_tier')]: value });
        this.changed();
      }
      return;
    }
    this.record(record);
  }
  record(record) {
    if (Array.isArray(record)) { for (const entry of record) this.record(entry); return; }
    if (!record || typeof record !== 'object') return;
    if (this.agent === 'claude' && (record.parent_tool_use_id || record.isSidechain)) return;
    const type = record.type;
    if (['error', 'turn.failed'].includes(type) || record.is_error === true || type === 'result' && /^error_/.test(record.subtype || '')) {
      this.failed = true;
      if (/\bat capacity\b|overloaded|capacity exceeded/i.test(JSON.stringify(record))) this.capacity = true;
    }
    if (this.agent === 'codex') {
      if (type === 'thread.started') this.sessionId = word(record.thread_id);
      if (type === 'turn.completed') {
        this.failed = false; this.capacity = false;
        const input = count(record.usage?.input_tokens), cached = count(record.usage?.cached_input_tokens);
        this.stdoutUsage = { inputTokens: input !== null && cached !== null && input >= cached ? input - cached : null,
          cachedTokens: cached, outputTokens: count(record.usage?.output_tokens) };
      }
    } else {
      if (type === 'system' && record.subtype === 'init') {
        this.sessionId = word(record.session_id); this.settings(record); this.confirmed = true;
      }
      if (type === 'assistant') {
        this.settings(record);
        this.settings(record.message || {});
      }
      if (type === 'assistant' || type === 'user') this.measure(record);
      if (type === 'result') {
        this.sessionId = word(record.session_id) || this.sessionId;
        this.confirmed ||= !!this.sessionId;
        this.settings(record);
        const models = Object.keys(record.modelUsage || {});
        if (models.length === 1) this.model = models[0];
        this.result = typeof record.result === 'string' ? record.result : null;
        const input = count(record.usage?.input_tokens), creation = count(record.usage?.cache_creation_input_tokens);
        this.stdoutUsage = { inputTokens: input !== null && creation !== null ? input + creation : null,
          cachedTokens: count(record.usage?.cache_read_input_tokens), outputTokens: count(record.usage?.output_tokens) };
        this.reportedCostUsd = Number.isFinite(record.total_cost_usd) && record.total_cost_usd >= 0 ? record.total_cost_usd : null;
        if (!record.is_error && !/^error_/.test(record.subtype || '')) { this.failed = false; this.capacity = false; }
        // JSON-only/older CLIs may expose only these final API totals. Never time a whole process as a response.
        if (count(record.usage?.output_tokens) !== null) {
          this.outputTokens = record.usage.output_tokens;
          this.activeMs = Number.isFinite(record.duration_api_ms) && record.duration_api_ms > 0 ? record.duration_api_ms : null;
        }
      }
    }
    this.changed();
  }
  routing() { return { model: this.model || 'unreported', effort: this.effort, fast: this.fast }; }
}

class CodexRollout {
  constructor(home, output) { this.directory = path.join(home, 'sessions'); this.output = output; }
  read() {
    if (!this.pending) this.pending = this.update().catch(() => {}).finally(() => { this.pending = null; });
    return this.pending;
  }
  async prepare(id) {
    // Capture the old file boundary before launch. Old turns never prove this invocation started.
    this.preparedId = id;
    this.output.resumed = true; this.output.baseline = null;
    for (const filename of await this.files(id)) {
      if ((await sessionMeta(filename))?.id !== id) continue;
      this.tail = this.reader(filename);
      await this.tail.read(record => { const totals = this.output.counters(record); if (totals) this.output.baseline = totals; });
      this.output.lastCounters = { ...this.output.baseline };
      this.output.meter.reset(true);
      this.output.meter.counter = count(this.output.baseline?.output_tokens);
      return;
    }
  }
  reader(filename) {
    return new TranscriptTail(filename, { onReset: partial => {
      this.output.meter.reset(partial); this.output.outputTokens = null; this.output.activeMs = null;
    } });
  }
  async update() {
    const id = this.output.sessionId;
    if (!id) return;
    if (this.preparedId && id !== this.preparedId) {
      this.tail = null; this.preparedId = null;
      this.output.baseline = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
      this.output.resumed = false; this.output.lastCounters = {}; this.output.invalidCounters.clear();
      this.output.rolloutUsage = null; this.output.stdoutUsage = null; this.output.outputTokens = null; this.output.activeMs = null;
      this.output.model = null; this.output.effort = null; this.output.fast = null; this.output.confirmed = false;
      this.output.meter.reset();
    }
    if (!this.tail) {
      for (const filename of await this.files(id)) {
        if ((await sessionMeta(filename))?.id !== id) continue;
        this.tail = this.reader(filename);
        break;
      }
    }
    await this.tail?.read(record => this.output.rollout(record));
    this.output.changed();
  }
  // Codex writes sessions/<year>/<month>/<day>/rollout-*-<id>.jsonl under the local date it started. Today's and
  // yesterday's folders are read directly on every poll, so a new file is found at once; the shared listing (kept
  // current by a watcher, walked again every 10 s) covers any other folder.
  async files(id) {
    const suffix = `-${id}.jsonl`, found = [];
    for (const at of [Date.now(), Date.now() - 86400000]) {
      const day = new Date(at), pad = value => String(value).padStart(2, '0');
      const folder = path.join(this.directory, String(day.getFullYear()), pad(day.getMonth() + 1), pad(day.getDate()));
      try { for (const name of await fs.promises.readdir(folder)) if (name.startsWith('rollout-') && name.endsWith(suffix)) found.push(path.join(folder, name)); } catch {}
    }
    return found.length ? found : (await rolloutFiles(this.directory)).filter(file => file.name.endsWith(suffix)).map(file => file.filename);
  }
}

// Standard Windows npm installs expose a JS entrypoint beside the shim; never invoke a shell.
function executable(agent, args, env) {
  if (process.platform !== 'win32') return { file: agent, args };
  const searchPath = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] || '';
  for (const directory of searchPath.split(path.delimiter).filter(Boolean)) {
    const folder = directory.replace(/^"|"$/g, '');
    const native = path.join(folder, agent + '.exe');
    if (fs.existsSync(native)) return { file: native, args };
    const entry = path.join(folder, 'node_modules', agent === 'codex' ? '@openai/codex/bin/codex.js' : '@anthropic-ai/claude-code/cli.js');
    if (fs.existsSync(entry)) return { file: process.execPath, args: [entry, ...args] };
  }
  return { file: agent, args };
}

function readWorkerOutput(child, agent, log, output) {
  const tails = [];
  for (const stream of [child.stdout, child.stderr]) {
    const decoder = new StringDecoder('utf8');
    let buffer = '', skipping = false, json = '';
    const parseLine = line => {
      // Claude's JSON result can be a pretty-printed array, or older builds can emit JSON lines.
      if (agent !== 'claude' || !json && !/^\s*[\[{]\s*$/.test(line)) { output.line(line); return; }
      json += line + '\n';
      if (json.length > LIMIT) { json = ''; return; }
      try { const record = JSON.parse(json); json = ''; output.record(record); } catch {}
    };
    const accept = data => {
      buffer += data;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!skipping && line.length <= LIMIT) parseLine(line);
        skipping = false;
      }
      if (buffer.length > LIMIT) { buffer = ''; skipping = true; }
    };
    stream.on('data', chunk => { log.write(chunk); accept(decoder.write(chunk)); });
    tails.push(() => { accept(decoder.end()); if (!skipping && buffer.trim()) parseLine(buffer); });
  }
  return () => { for (const tail of tails) tail(); };
}

async function run(argv, { env = process.env, stdout = process.stdout, launch = spawn, resolveExecutable = executable, startTimeout = START_TIMEOUT, rateInterval = RATE_INTERVAL } = {}) {
  if (argv.at(-1) === '--help' && (argv.length === 1 || argv.length === 2 && ['codex', 'claude', 'minutes', 'consolidate', 'stop'].includes(argv[0]))) {
    stdout.write(USAGE); return 0;
  }
  if (['minutes', 'consolidate', 'stop'].includes(argv[0])) return teamCommand(argv, stdout);
  const id = randomUUID(), send = eventSink(env.AGENTRIX_BOOTSTRAP);
  // Keep reporting authority in the helper; preserve the owner's environment outside marked SDK parents.
  const workerEnv = workerEnvironment(env);
  let finalize, options, child, log, startTimer, forceTimer, pollTimer, rateTimer, lastRate, endSent = false;
  let started = false, unconfirmed = false, killed = false, exited = false, spawnError = null, before = null, drain;
  let team = null, admission = null, teamFinished = false, roundtable = false, skillGuard = null, skillProposals = 0, skillChangesLeftLive = 0;
  let inbox = null, inboxTimer, inboxRead = Promise.resolve(), messages = [], noResume = false, segmentStopped = false;
  let interventions = 0, stops = 0, completedUsage = null, resumeSession = null, segmentConfirmed = false;
  let treeStop = Promise.resolve(), stoppingChild = null;
  let controlClient = null, activeRuntime = null, nativeTurn = null, settleNative, nativeFallback = null, nativeRunning = false;
  let bootstrap, controlOpening = false, controlAttemptAt = 0, ending = false;
  let controlFailure = 'bootstrap/missing_environment', transportFallback = false;
  let nativeBilling = null;
  let boardWatch, scopeRestoreBlocked = false, scopeRestoreNote = '';
  const controlReceipts = new Map();
  const deferredControlIds = [];
  let resumeControlIds = [], resumeInputId;
  let receiptTail = Promise.resolve();
  function recordReceipt(messageId, status, reason) {
    if (!['queued', 'delivered', 'consumed', 'rejected', 'unknown'].includes(status)) status = 'unknown';
    const previous = controlReceipts.get(messageId);
    if (previous === status || previous === 'consumed' || previous === 'delivered' && status === 'queued') return receiptTail;
    controlReceipts.set(messageId, status);
    signal(`intervention ${id} ${messageId} ${status}${reason ? `: ${reason}` : ''}`);
    receiptTail = receiptTail.catch(() => {}).then(() => team?.locked(() => {
      team.append({ type: 'control-receipt', id, messageId, status, ...(reason ? { reason } : {}), at: Date.now() });
      fs.appendFileSync(team.memory, `\n\n[dispatch] intervention ${id} ${messageId} ${status}${reason ? `: ${reason}` : ''}\n`);
    }));
    return receiptTail;
  }
  async function rejectDeferredControls() {
    for (const messageId of [...deferredControlIds, ...resumeControlIds]) {
      if (controlReceipts.get(messageId) === 'queued') await recordReceipt(messageId, 'rejected', 'worker_ended_without_resume');
    }
  }
  const billing = () => nativeBilling ? { billingPath: nativeBilling, usageRecordId: `dispatch:${id}`, costCompleteness: output.reportedCostUsd === null ? 'unknown' : 'estimated' } : {};
  const usage = (live = false) => {
    const current = output.usage();
    if (!completedUsage) return current;
    const total = Object.fromEntries(Object.keys(current).map(key => [key,
      completedUsage[key] === null || current[key] === null ? null : completedUsage[key] + current[key]]));
    // A rate is a measured pair. An untimed reply cannot add tokens while borrowing the previous segment's time.
    if (live && (current.outputTokens === null || !(current.activeMs > 0))) {
      total.outputTokens = completedUsage.outputTokens; total.activeMs = completedUsage.activeMs;
    }
    return total;
  };
  const interventionNote = () => (interventions ? ` · owner intervened ${interventions}` : '') + (stops ? ` · owner stopped ${stops}` : '');
  const restoreSkills = changedFiles => {
    if (!skillGuard) return;
    const total = skillGuard.finish(id, changedFiles);
    skillProposals = skillGuard.restoredCount;
    skillChangesLeftLive = total - skillProposals;
  };
  const proposalNote = () => (skillProposals ? ` · ${skillProposals} skill proposals restored and awaiting the lead` : '')
    + (skillChangesLeftLive ? ` · ${skillChangesLeftLive} skill changes left live (author unknown)` : '')
    + [...(skillGuard?.notes || [])].map(note => ` · ${note}`).join('');
  const teamLabel = (end = false) => !team ? '' : roundtable ? ` · roundtable ${options.meeting}`
    : options.skipMeeting && !end ? ` · roundtable skipped: ${options.skipMeeting}` : '';
  const recordTeam = async report => {
    if (!team || !admission || teamFinished) return {};
    teamFinished = true;
    try { return await team.finish(options, { id, session: resumeSession || output.sessionId, model: unconfirmed ? 'unreported' : output.routing().model,
      kind: taskKind(options, roundtable), ...usage(), ...admission, ...report }); }
    catch (error) { return { warning: String(error.message || error).replace(/[\r\n]+/g, ' ') }; }
  };
  const teamEnd = ({ status, warning }) => {
    let wording = '';
    if (roundtable && status) wording = admission.phase === 'confirmation' ? (status === 'confirmed' ? 'confirmed' : 'open')
      : `understanding ${status === 'understood' ? 'complete' : 'incomplete'}`;
    return (wording ? ` · ${wording}` : '') + (warning ? ` · WARNING: team bookkeeping failed: ${warning}` : '');
  };
  // Settles once the worker's output has been read to the end.
  let drained = new Promise(resolve => { drain = resolve; });
  const signal = line => stdout.write(`[dispatch] ${line}\n`);
  const declared = () => ({ model: options.model, effort: options.effort, fast: options.fast });
  const assignment = () => ({ type: 'dispatch-start', id, agent: options.agent, role: roundtable ? '圆桌' : options.role, title: options.title,
    ...billing(),
    kind: taskKind(options, roundtable), meeting: admission?.meeting || options.meeting || null, skipMeeting: options.skipMeeting || null,
    cwd: options.cwd, brief: options.brief, out: options.out, sessionId: output.sessionId, startedAt: Date.now() });
  const failed = (reason, exitCode = null) => {
    if (unconfirmed || started) return;
    unconfirmed = true; signal(`failed to start ${id}: ${reason.replace(/[\r\n]+/g, ' ')}`);
    if (!options) return;
    // Even without a session, the pane needs a declared row before it can retain the failure.
    send({ ...assignment(), model: 'unreported', effort: null, fast: null, declared: declared(), unconfirmed: true });
    // A real timed-out process is stopped next; recover after it exits, before reporting its final proposal count.
    if (child?.pid && !exited && child.exitCode === null) return;
    try { restoreSkills(); } catch {}
    send({ type: 'dispatch-end', id, model: 'unreported', effort: null, fast: null, exitCode, reason: 'unconfirmed',
      inputTokens: null, cachedTokens: null, reportedCostUsd: null, outputTokens: null, totalOutputTokens: null, activeMs: null, verdict: 'unverified', skillProposals, skillChangesLeftLive, endedAt: Date.now() });
    endSent = true;
  };
  const reported = () => {
    const route = unconfirmed ? declared() : output.routing();
    return `${options.agent} model ${route.model} effort ${route.effort || 'unreported'} fast ${route.fast === null ? 'unreported' : route.fast ? 'on' : 'off'}`;
  };
  // A start is confirmed only by the worker's own records: its session, and Codex's turn context in that session's file.
  // While it runs, every new record is checked at once. A worker that has exited is judged once, on everything it left
  // (final), so a fast worker that did start is reported started and done, and one without those records is not.
  const confirm = (final = false) => {
    if (segmentConfirmed || unconfirmed || spawnError || !child?.pid || !output.sessionId || !final && (exited || child.exitCode !== null)) return;
    if (resumeSession && output.sessionId !== resumeSession) { spawnError = new Error('Resumed worker reported a different session'); stop('SIGTERM', false); return; }
    if (!output.confirmed) { if (!final && options.agent === 'codex') void rollout.read(); return; }
    segmentConfirmed = true; clearTimeout(startTimer);
    if (!activeRuntime) for (const messageId of resumeControlIds) void recordReceipt(messageId, 'delivered').catch(() => {});
    const actual = output.routing(), requested = declared();
    const unverified = Object.keys(requested).filter(key => output[key] === null);
    const decision = routingVerdict(output, requested), mismatch = decision === 'mismatch';
    const verdict = mismatch ? `MISMATCH (declared ${requested.model} ${requested.effort} fast ${requested.fast ? 'on' : 'off'})` : decision;
    const routing = verdict + (unverified.length ? ` (${unverified.join(', ')}${verdict === 'unverified' ? '' : ' unverified'})` : '');
    if (!started) {
      started = true;
      signal(`started ${id} ${reported()} · routing ${routing} · pid ${child.pid} session ${output.sessionId}${teamLabel()}`);
      send({ ...assignment(), ...actual, ...(mismatch ? { declared: requested } : {}) });
    }
    if (final || rateTimer) return;
    rateTimer = setInterval(() => {
      const { outputTokens, activeMs } = usage(true);
      if (outputTokens === null || !(activeMs > 0) || lastRate?.outputTokens === outputTokens && lastRate?.activeMs === activeMs) return;
      lastRate = { outputTokens, activeMs };
      send({ type: 'dispatch-rate', id, ...lastRate });
    }, rateInterval);
  };
  let output = new WorkerOutput(argv[0], () => confirm());
  let rollout = new CodexRollout(env.CODEX_HOME || path.join(homedir(), '.codex'), output);
  const stop = (kind, requested = true) => {
    if (requested) killed = true;
    if (activeRuntime) {
      treeStop = Promise.resolve(activeRuntime.interrupt()).catch(() => {}).then(() => activeRuntime.close()).finally(() => settleNative?.({ code: 1, killedBy: kind }));
      return;
    }
    if (exited || !child?.pid || child.exitCode !== null) return;
    const victim = child;
    if (stoppingChild === victim) return;
    stoppingChild = victim;
    if (process.platform === 'win32') {
      treeStop = new Promise(resolve => {
        const killer = spawn('taskkill.exe', ['/pid', String(victim.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
        killer.on('error', error => { spawnError ||= error; victim.kill(); resolve(); });
        killer.once('close', code => { if (code && victim.exitCode === null) { spawnError ||= new Error('Unable to stop worker tree'); victim.kill(); } resolve(); });
      });
    } else {
      try { process.kill(-victim.pid, kind); } catch { victim.kill(kind); }
      treeStop = new Promise(resolve => {
        forceTimer = setTimeout(() => { try { process.kill(-victim.pid, 'SIGKILL'); } catch {} resolve(); }, 1000);
      });
    }
  };
  const readInbox = (finish = false) => {
    if (!inbox) return Promise.resolve();
    const task = inboxRead.then(async () => {
      let controls;
      try { controls = await inbox.take(finish && !messages.length); }
      catch (error) {
        // Polling failures must not interrupt the worker. Only an unreadable final empty check prevents closure.
        if (finish && !messages.length) throw error;
        return;
      }
      for (const control of controls) {
        if (control.type === 'stop') {
          stops++; segmentStopped = true; noResume ||= !!control.noResume;
          signal(`stop requested ${id}${control.reason ? ': ' + JSON.stringify(control.reason).slice(1, -1) : ''}${control.noResume ? ' · no resume' : ''}`);
          const direct = !!activeRuntime;
          stop('SIGTERM', false);
          if (direct) {
            let status = 'delivered';
            try { await treeStop; } catch { status = 'unknown'; }
            await recordReceipt(control.id, status);
          }
        } else {
          interventions++;
          if (activeRuntime) {
            controlReceipts.set(control.id, null);
            let receipt;
            try { receipt = await activeRuntime.send({ clientMessageId: control.id, text: control.text }); }
            catch (error) { receipt = { status: error.message === 'control_unavailable' ? 'rejected' : 'unknown', reason: error.message }; }
            if (receipt?.status === 'rejected' && ['worker_ended', 'control_unavailable'].includes(receipt.reason)) {
              messages.push(control.text); deferredControlIds.push(control.id); receipt.status = 'queued';
            }
            await recordReceipt(control.id, receipt?.status);
          } else {
            messages.push(control.text); deferredControlIds.push(control.id);
            signal(`intervened ${id}: ${JSON.stringify(control.text).slice(1, -1)}`);
            await recordReceipt(control.id, 'queued');
          }
        }
      }
    });
    inboxRead = task.catch(() => {});
    return task;
  };
  const onInterrupt = () => stop('SIGINT'), onTerminate = () => stop('SIGTERM'), onHangup = () => stop('SIGHUP');
  try {
    options = argumentsOf(argv);
    process.on('SIGINT', onInterrupt); process.on('SIGTERM', onTerminate); process.on('SIGHUP', onHangup);
    team = projectTeam(options.cwd, true);
    // Watch before admission: a peer that finishes before us must still disable restoration.
    // Lost, malformed or unresolvable board evidence is report-only, never proof of exclusive ownership.
    let scopeRoot;
    if (team) try {
      // Resolve Git outside the team lock; peer checks then need only canonical paths.
      const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: options.cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      scopeRoot = fs.realpathSync.native(root);
    } catch { scopeRestoreBlocked = true; }
    const checkPeer = name => {
      if (name === id + '.json' || name === id + '.tmp') return;
      try {
        const entry = JSON.parse(fs.readFileSync(path.join(team.board, name), 'utf8'));
        if (!Number.isSafeInteger(entry.pid) || entry.pid <= 0 || typeof entry.cwd !== 'string') throw new Error('invalid_board');
        try { process.kill(entry.pid, 0); } catch (error) { if (error.code === 'ESRCH') return; if (error.code !== 'EPERM') throw error; }
        // Native canonicalization expands Windows 8.3 names as well as junctions.
        const relative = path.relative(scopeRoot, fs.realpathSync.native(entry.cwd));
        if (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)) scopeRestoreBlocked = true;
      } catch { scopeRestoreBlocked = true; }
    };
    const checkBoard = () => {
      if (!team) { scopeRestoreBlocked = true; return; }
      try { for (const name of fs.readdirSync(team.board)) checkPeer(name); }
      catch { scopeRestoreBlocked = true; }
    };
    if (team) {
      try {
        const board = fs.realpathSync.native(team.board), identity = fs.statSync(board, { bigint: true });
        boardWatch = fs.watch(board, (_event, name) => {
          if (!name) { scopeRestoreBlocked = true; return; }
          // FSEvents names directory metadata events after the watched directory itself.
          // Re-scan that same inode instead of treating "board/board" as an unreadable peer.
          if (String(name) === path.basename(board)) {
            try {
              const current = fs.statSync(board, { bigint: true });
              if (current.dev !== identity.dev || current.ino !== identity.ino) scopeRestoreBlocked = true;
              else checkBoard();
            } catch { scopeRestoreBlocked = true; }
          } else checkPeer(String(name));
        });
        boardWatch.on('error', () => { scopeRestoreBlocked = true; });
        await team.locked(checkBoard);
      } catch { scopeRestoreBlocked = true; }
    }
    roundtable = Boolean(team && options.meeting);
    if (options.meeting && !team) throw new Error('roundtables need a git repository');
    if (team) admission = await team.admit(options, id, __filename);
    if (team && !roundtable) {
      inbox = new RunInbox(team, id); await inbox.open();
      inboxTimer = setInterval(() => {
        void readInbox().catch(() => {});
        if (activeRuntime && options.agent === 'codex' && controlClient?.connected === false && Date.now() - controlAttemptAt >= 1000) void openControl();
      }, POLL_INTERVAL);
    }
    if (killed) throw new Error('Dispatch interrupted before launch');
    const repo = admission?.repo || (options.allow.length ? repoFiles(options.cwd) : undefined);
    const checking = options.allow.length > 0 || roundtable;
    // What the working tree held before the worker, so its own changes can be checked against --allow afterwards.
    if (checking) before = snapshot(options.cwd, repo);
    if (roundtable && !before) throw new Error('Cannot verify the roundtable working tree');
    skillGuard = new WorkerSkillProposals(options, env, repo);
    const dirtyBytes = new Map();
    let capturedBytes = 0;
    for (const { file } of before?.status || []) {
      try {
        const filename = path.join(before.root, file), stat = fs.lstatSync(filename);
        const relative = path.relative(fs.realpathSync(before.root), fs.realpathSync(path.dirname(filename)));
        if (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep) && stat.isFile() && stat.nlink === 1 && !stat.isSymbolicLink() && capturedBytes + stat.size <= 32 * 1024 * 1024) {
          dirtyBytes.set(file, fs.readFileSync(filename)); capturedBytes += stat.size;
        }
      } catch { /* A missing original is captured as absent by the scope snapshot. */ }
    }
    function restoreScope(files) {
      if (!files?.length) return;
      if (scopeRestoreBlocked || !skillGuard.restoreRoot) { scopeRestoreNote = ' · out-of-scope changes left live (shared checkout or worktree; author unknown)'; return; }
      let restored = 0, quarantine;
      const restoredNote = () => { scopeRestoreNote = ` · restored ${restored} out-of-scope paths${quarantine ? ` · quarantined scope changes: ${quarantine}` : ''}`; };
      const preserveCurrent = (filename, file) => {
        if (!fs.lstatSync(filename, { throwIfNoEntry: false })) return;
        quarantine ||= path.join(team.directory, 'scope-quarantine', id);
        const destination = path.join(quarantine, file);
        if (fs.lstatSync(destination, { throwIfNoEntry: false })) throw new Error('scope_backup_exists');
        fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.renameSync(filename, destination);
        restoredNote();
      };
      for (const file of files) {
        const filename = path.resolve(before.root, file), relative = path.relative(before.root, filename);
        if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep) || relative.split(path.sep).includes('.git')) throw new Error('scope_restore_path');
        const parent = path.relative(fs.realpathSync(before.root), fs.realpathSync(path.dirname(filename)));
        if (path.isAbsolute(parent) || parent === '..' || parent.startsWith('..' + path.sep)) throw new Error('scope_restore_path');
        const replace = contents => {
          const temporary = path.join(path.dirname(filename), `.dispatch-restore-${randomUUID()}`);
          try {
            fs.writeFileSync(temporary, contents, { flag: 'wx' });
            // Preserve the current leaf (including symlinks) without following it or guessing its author.
            // If preservation fails, leave it live instead of overwriting bytes without a recovery copy.
            preserveCurrent(filename, file);
            fs.renameSync(temporary, filename);
          }
          finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
        };
        if (dirtyBytes.has(file)) replace(dirtyBytes.get(file));
        else if (before.files.has(file)) {
          if (before.files.get(file) === 'deleted') preserveCurrent(filename, file);
          else if (before.files.get(file) !== 'deleted') { signal(`scope restore unavailable for pre-existing file: ${file}`); continue; }
        }
        else {
          let contents;
          try { contents = execFileSync('git', ['show', `${before.head}:${file.split(path.sep).join('/')}`], { cwd: before.root, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, windowsHide: true }); } catch {}
          if (contents) replace(contents);
          else if (repo?.files.includes(file)) throw new Error('scope_restore_unavailable');
          else preserveCurrent(filename, file);
        }
        restored++;
        restoredNote();
      }
    }
    const inspectScope = () => {
      const after = checking ? snapshot(options.cwd, before) : null;
      const own = after ? new Set([options.out, `${options.out}.log`, options.ledger, team?.memory, ...skillGuard.artifacts].filter(Boolean)
        .map(file => path.relative(after.root, file).split(path.sep).join('/'))) : null;
      const changed = (after && changedBetween(before, after)?.filter(file => !own.has(file))) ?? null;
      return { after, changed, outOfScope: changed && (roundtable ? changed : changed.filter(file => !matches(options.allow, file))) };
    };
    let brief = briefOf(options, fs.readFileSync(options.brief), team, { id, phase: admission?.phase, repo, before: checking ? before : undefined });
    log = fs.createWriteStream(options.out + '.log');
    await new Promise((resolve, reject) => { log.once('open', resolve); log.once('error', reject); });
    async function openControl() {
      if (controlOpening || ending) return;
      controlOpening = true; controlAttemptAt = Date.now();
      try {
        if (!env.AGENTRIX_BOOTSTRAP) { controlFailure = 'bootstrap/missing_environment'; return; }
        if (fs.statSync(env.AGENTRIX_BOOTSTRAP).size > 16384) { controlFailure = 'bootstrap/size_limit'; return; }
        bootstrap = JSON.parse(fs.readFileSync(env.AGENTRIX_BOOTSTRAP, 'utf8').replace(/^\uFEFF/, ''));
        if (!bootstrap?.controlAddress) { controlFailure = 'bootstrap/missing_address'; return; }
        if (!bootstrap.controlCapability) { controlFailure = 'bootstrap/missing_capability'; return; }
        if (!bootstrap.sessionKey) { controlFailure = 'bootstrap/missing_session_key'; return; }
        const client = await connectDispatchControl({ address: bootstrap.controlAddress, runId: id,
        projectId: bootstrap.projectId, sessionKey: bootstrap.sessionKey, capability: bootstrap.controlCapability,
        readOnly: !!options.readOnly || options.permission === 'plan', roundtable,
        onControl: async messageId => { await readInbox(); const status = controlReceipts.get(messageId) || inbox?.receipt(messageId) || 'queued'; return status === 'consumed' ? 'delivered' : status; },
        onEvent: event => acceptNative(event) });
        if (ending) client.close(); else { controlClient = client; controlFailure = null; }
      } catch (error) {
        // Never print exception messages: filesystem/socket errors contain the bootstrap path.
        controlFailure = error.message === 'control_unavailable' ? `${error.stage}/${error.category}`
          : `bootstrap/${error instanceof SyntaxError ? 'invalid_json' : ['ENOENT', 'EACCES', 'EPERM'].includes(error.code) ? error.code : 'read_failed'}`;
      }
      finally { controlOpening = false; }
    }
    await openControl();
    function acceptNative(event) {
      if (event.providerSessionId) output.sessionId = event.providerSessionId;
      if (event.type === 'turn.started') {
        nativeTurn = event.turnId; nativeRunning = true; output.confirmed = true; confirm();
        if (resumeControlIds.length) resumeInputId = event.payload.clientMessageId;
      } else if (event.type === 'routing.updated' && event.payload.observed) output.settings(event.payload.observed);
      else if (event.type === 'input.receipt' && controlReceipts.has(event.payload.clientMessageId)) void recordReceipt(event.payload.clientMessageId, event.payload.status).catch(() => {});
      else if (event.type === 'input.receipt' && event.payload.clientMessageId === resumeInputId) {
        for (const id of resumeControlIds) void recordReceipt(id, event.payload.status).catch(() => {});
      }
      else if (event.type === 'usage.updated' && !event.replay) output.nativeUsage(event.payload, !!(options.resume || resumeSession));
      else if (event.type === 'error' && event.payload.code === 'billing_identity_mismatch') signal(`transport ${id} claude-sdk: ${event.payload.message}`);
      else if (event.type === 'item.upsert' && event.payload.kind === 'agent-message' && event.payload.status === 'completed') {
        const content = event.payload.content;
        if (typeof content?.text === 'string' && (!content.phase || content.phase === 'final_answer')) output.result = content.text;
      } else if (event.type === 'turn.completed' && event.turnId === nativeTurn) {
        nativeRunning = false;
        settleNative?.({ code: event.payload.status === 'completed' ? 0 : 1, killedBy: event.payload.status === 'interrupted' ? 'SIGTERM' : null });
      } else if (event.type === 'session.state' && ['disconnected', 'failed'].includes(event.payload.state)) {
        nativeRunning = false;
        settleNative?.({ code: 1, killedBy: null });
      } else if (event.type === 'path.changed' && event.payload.selected === 'terminal' && !nativeTurn) {
        nativeFallback = event.payload.reason || 'terminal_selected';
      }
      if (event.providerSessionId && output.confirmed) confirm();
      log.write(JSON.stringify(event) + '\n');
    }
    finalize = async result => {
      const { after, changed, outOfScope } = inspectScope();
      const restore = () => {
        checkBoard();
        // Skill proposals keep their original snapshot/ownership policy; N1 covers ordinary files only.
        restoreSkills(after?.status.map(entry => entry.file));
        restoreScope(outOfScope);
      };
      // Drain board notifications before taking the lock for the final exclusive check.
      await new Promise(resolve => setImmediate(resolve));
      try { if (team) await team.locked(restore); else restore(); }
      catch (error) { signal(`scope restore failed: ${String(error.message).replace(/[\r\n]+/g, ' ')}`); }
      await rejectDeferredControls();
      const route = output.routing();
      let reason = 'exit';
      if (unconfirmed) reason = 'unconfirmed';
      else if (killed) reason = 'killed';
      else if (spawnError) reason = 'error';
      else if (segmentStopped || noResume) reason = 'killed';
      else if (output.capacity) reason = 'capacity';
      else if (result.killedBy) reason = 'killed';
      else if (roundtable && outOfScope?.length) reason = 'scope';
      else if (output.failed || result.code !== 0 || roundtable && changed === null) reason = 'error';
      else if (outOfScope?.length) reason = 'scope';
      let answer = '';
      try { answer = fs.readFileSync(options.out, 'utf8'); } catch {}
      const header = `${new Date().toISOString().slice(0, 16).replace('T', ' ')} · ${options.title} · ${options.agent} ${route.model} · session ${resumeSession || output.sessionId || 'unreported'}`;
      const bookkeeping = await recordTeam({ answer, header, reason });
      if (!team) { try { recordFindings(options, answer, header); } catch {} }
      const scope = !checking ? '' : changed === null ? (team ? ' · scope unchecked (working tree unavailable)' : ' · scope unchecked (not a git working tree)')
        : outOfScope.length ? ` · OUT OF SCOPE: ${outOfScope.slice(0, 10).join(', ')}${outOfScope.length > 10 ? ` and ${outOfScope.length - 10} more` : ''}` : ' · scope ok';
      const exitCode = Number.isInteger(result.code) ? (result.code === 0 && (unconfirmed || roundtable && reason !== 'exit') ? 1 : result.code) : result.killedBy ? 128 + (signals[result.killedBy] || 1) : 1;
      const measured = usage(), rate = measured.outputTokens !== null && measured.activeMs > 0 ? `${Math.round(measured.outputTokens * 1000 / measured.activeMs)} token/s (${measured.outputTokens.toLocaleString('en-US')} output tokens in ${Math.round(measured.activeMs / 1000)} s)` : 'token/s unreported';
      signal(`ended ${id} ${reported()} · ${rate} · exit ${exitCode} reason ${reason}${scope}${scopeRestoreNote}${teamLabel(true)}${teamEnd(bookkeeping)}${proposalNote()}${interventionNote()} · out ${options.out}`);
      if (!endSent) send({ type: 'dispatch-end', id, ...route, ...billing(), exitCode, reason, ...measured, verdict: routingVerdict(output, declared()),
        ...(outOfScope ? { outOfScopeCount: outOfScope.length } : {}),
        ...(outOfScope?.length ? { outOfScope: outOfScope.slice(0, 50) } : {}), skillProposals, skillChangesLeftLive, endedAt: Date.now() });
      await new Promise(resolve => log.end(resolve));
      return exitCode;
    };
    let result;
    for (;;) {
      const effective = resumeSession ? { ...options, resume: resumeSession } : options;
      if (resumeSession) {
        const nextOutput = new WorkerOutput(options.agent, () => confirm());
        const nextRollout = new CodexRollout(env.CODEX_HOME || path.join(homedir(), '.codex'), nextOutput);
        if (options.agent === 'codex') await nextRollout.prepare(resumeSession);
        await readInbox();
        if (noResume || killed || spawnError) break;
        completedUsage = usage(); output = nextOutput; rollout = nextRollout;
        resumeControlIds = deferredControlIds.splice(0); resumeInputId = null;
        segmentConfirmed = false; segmentStopped = false; exited = false;
        drained = new Promise(resolve => { drain = resolve; });
        brief = briefOf(options, Buffer.from(messages.splice(0).map(text => `业主插话：${text}`).join('\n\n') + '\n\n继续执行当前任务。'), team,
          { id, phase: admission?.phase, repo, before: checking ? before : undefined });
      }
      if (controlClient) {
        const spec = { owner: 'dispatch', projectId: bootstrap.projectId, terminalId: bootstrap.projectId, runtimeSessionId: id, runId: id,
          cwd: options.cwd, worktree: options.cwd, model: options.model, effort: options.effort, fast: options.fast,
          readOnly: options.readOnly || options.permission === 'plan', roundtable, allow: options.allow, env: workerEnv,
          policy: { approvalPolicy: 'never' },
          providerSessionId: effective.resume || null };
        const completion = new Promise(resolve => { settleNative = resolve; });
        if (options.agent === 'codex') {
          activeRuntime = createCodexRuntime({ resolveExecutable: async () => 'codex', spawnProcess: (_file, args, spawnOptions) => {
            const command = resolveExecutable('codex', args, env); return launch(command.file, command.args, spawnOptions);
          } }).create(spec, acceptNative);
          if (options.resume) await rollout.prepare(options.resume);
          try { if (options.resume) await activeRuntime.resume(); else await activeRuntime.start(); }
          catch (error) {
            await activeRuntime.close(); activeRuntime = null; controlClient.close(); controlClient = null;
            transportFallback = true;
            const stage = ['resolve_executable', 'spawn', 'initialize', 'capability_probe', 'thread_start', 'thread_resume'].includes(error.stage) ? error.stage : 'startup';
            const category = error.category && /^(?:rpc_-\d+|request_failed|unexpected_success)$/.test(error.category) ? error.category
              : Number.isInteger(error.code) ? `rpc_${error.code}`
              : ['ENOENT', 'EACCES', 'EPERM', 'EINVAL', 'codex_cli_required', 'rpc_timeout', 'process_failed', 'process_exited', 'disconnected',
                'frame_limit', 'write_failed', 'invalid_response', 'invalid_json', 'invalid_frame', 'invalid_payload', 'truncated_frame', 'unsupported_codex_capabilities'].includes(error.code || error.message) ? error.code || error.message : 'runtime_failed';
            signal(`transport ${id} codex-exec fallback: native runtime unavailable before input (${stage}/${category})`); continue;
          }
          child = { pid: activeRuntime.pid, exitCode: null };
          pollTimer = setInterval(() => { void rollout.read(); }, POLL_INTERVAL);
          const receipt = await activeRuntime.send({ clientMessageId: id, text: brief.toString('utf8'), images: options.images });
          if (receipt.status !== 'delivered') throw new Error('native_input_' + receipt.status);
          result = await completion;
        } else {
          nativeBilling = 'api';
          activeRuntime = { send: async input => {
            const receipt = await controlClient.request('control.deliver', { messageId: input.clientMessageId, type: 'intervene', text: input.text });
            return typeof receipt === 'string' ? { status: receipt } : receipt;
          },
            interrupt: () => controlClient.request('control.deliver', { messageId: randomUUID(), type: 'stop' }), close() {} };
          // Main's broker owns this process. It supplies execution evidence in the streamed events.
          child = { pid: 'broker', exitCode: null };
          const remote = controlClient.request('claude-sdk.run', { prompt: brief.toString('utf8'), model: options.model, effort: options.effort,
            fast: options.fast, resume: effective.resume || null, out: options.out }).then(value => {
            nativeRunning = false;
            const result = value?.status ? { code: value.status === 'completed' ? 0 : 1, killedBy: value.status === 'interrupted' ? 'SIGTERM' : null } : undefined;
            if (result) settleNative?.(result);
            return result;
          }).catch(() => {
            nativeRunning = false;
            const failed = { code: 1, killedBy: segmentStopped || killed ? 'SIGTERM' : null };
            settleNative?.(failed); return failed;
          });
          result = await Promise.race([completion, remote]);
          if (nativeFallback) {
            activeRuntime = null; nativeBilling = null; controlClient.close(); controlClient = null;
            transportFallback = true;
            signal(`transport ${id} claude-cli fallback: ${String(nativeFallback).replace(/[\r\n]+/g, ' ')}`); continue;
          }
          if (!result) result = await completion;
          activeRuntime.finished = remote;
        }
        for (;;) {
          await readInbox(true); await inboxRead;
          if (!nativeRunning) {
            if (options.agent === 'claude' && !segmentStopped && !killed && result.code === 0) {
              const receipt = await controlClient.request('control.finish', {}).catch(() => ({ status: 'unknown' }));
              if (receipt?.status === 'queued') { result = await new Promise(resolve => { settleNative = resolve; }); continue; }
            }
            break;
          }
          result = await new Promise(resolve => { settleNative = resolve; });
        }
        if (options.agent === 'codex') { await rollout.pending; await rollout.read(); }
        confirm(true);
        if (typeof output.result === 'string') fs.writeFileSync(options.out, output.result);
        const remoteResult = await activeRuntime.finished;
        if (remoteResult?.code) result = remoteResult;
        await activeRuntime.close(); activeRuntime = null; child.exitCode = result.code; clearInterval(pollTimer);
        if (!started) failed('worker ended without execution evidence', 1);
        if (messages.length && result.code === 0 && !killed && !noResume && !spawnError && output.sessionId) {
          const { changed, outOfScope } = inspectScope();
          if (checking && (changed === null || outOfScope.length)) break;
          resumeSession = output.sessionId; controlClient.close(); controlClient = null;
          // The rejected correction is known not to have executed; resume only that input, on the same billing path.
          await new Promise(resolve => setTimeout(resolve, 20)); await openControl();
          if (!controlClient) throw new Error('native_resume_control_unavailable');
          signal(`resuming ${id}: native worker ended before correction`);
          continue;
        }
        break;
      }
      if (!resumeSession && !transportFallback) signal(`transport ${id} ${options.agent === 'codex' ? 'codex-exec' : 'claude-cli'} fallback: Agentrix control unavailable (${controlFailure || 'control/disconnected'})`);
      const command = resolveExecutable(options.agent, commandOf(effective), env);
      if (options.agent === 'codex' && effective.resume && !resumeSession) await rollout.prepare(effective.resume);

      if (killed) throw new Error('Dispatch interrupted before launch');
      child = launch(command.file, command.args, { cwd: options.cwd, env: workerEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
        detached: process.platform !== 'win32' });
      if (killed) stop('SIGTERM');
      if (!resumeSession) log.on('error', error => { spawnError = error; stop('SIGTERM', false); });
      startTimer = setTimeout(() => {
        if (started) spawnError = new Error('Resumed session not reported within 30 s');
        else failed('session not reported within 30 s');
        stop('SIGTERM', false);
      }, startTimeout);
      if (options.agent === 'codex') pollTimer = setInterval(() => { void rollout.read(); }, POLL_INTERVAL);
      const segmentOutput = output, segmentRollout = rollout, segmentDrain = drained;
      child.once('exit', code => {
        exited = true; clearTimeout(startTimer); clearInterval(pollTimer);
        if (segmentConfirmed) return;
        // Its last output can still be in the pipes: once that is read (at most EXIT_SETTLE), decide from its records,
        // without waiting for pipes a leftover child process may hold open.
        void Promise.race([segmentDrain, new Promise(resolve => setTimeout(resolve, EXIT_SETTLE))]).then(async () => {
          if (output !== segmentOutput || segmentConfirmed || unconfirmed) return;
          if (options.agent === 'codex') { await segmentRollout.pending; await segmentRollout.read(); }
          if (output !== segmentOutput) return;
          confirm(true);
          if (!started) failed(output.capacity ? 'at capacity' : 'worker exited without a confirmed session', code === 0 ? 1 : code);
        });
      });
      const flushOutput = readWorkerOutput(child, options.agent, log, output);
      child.stdin.on('error', error => { if (error.code !== 'EPIPE') spawnError = error; });
      child.stdin.end(brief);
      result = await new Promise(resolve => {
        child.once('error', error => { spawnError = error; });
        child.once('close', (code, killedBy) => resolve({ code, killedBy }));
      });
      flushOutput();
      clearInterval(pollTimer);
      if (options.agent === 'codex') { await rollout.pending; await rollout.read(); }
      confirm(true); drain();
      clearTimeout(startTimer); await treeStop;
      if (!started) failed(spawnError?.message || (output.capacity ? 'at capacity' : 'worker exited without a confirmed session'), result.code === 0 ? 1 : result.code);
      if (resumeSession && !segmentConfirmed) { spawnError ||= new Error('Resumed worker exited without a confirmed session'); result.code = result.code || 1; }
      if (resumeSession && spawnError) signal(`resume failed ${id}: ${String(spawnError.message).replace(/[\r\n]+/g, ' ')}`);
      if (options.agent === 'claude' && output.result !== null && output.result !== undefined) fs.writeFileSync(options.out, output.result);
      await readInbox(!messages.length);
      if (!messages.length || killed || noResume || unconfirmed || spawnError) break;
      if (checking) {
        const { changed, outOfScope } = inspectScope();
        if (changed === null || outOfScope.length) break;
      }
      resumeSession = output.sessionId;
    }
    if (inbox) { await inbox.close(); await readInbox(); }
    clearInterval(inboxTimer); clearInterval(rateTimer);
    return await finalize(result);
  } catch (error) {
    if (finalize && child) {
      spawnError ||= error;
      try { stop('SIGTERM', false); await treeStop; await activeRuntime?.finished; } catch {}
      if (!started) failed('worker ended without execution evidence', 1);
      try { return await finalize({ code: 1, killedBy: killed || segmentStopped ? 'SIGTERM' : null }); }
      catch (failure) { signal(`finalization failed: ${String(failure.message).replace(/[\r\n]+/g, ' ')}`); }
    }
    try { restoreSkills(); } catch (recovery) { signal(`skill recovery failed: ${String(recovery.message).replace(/[\r\n]+/g, ' ')}`); }
    failed(error.message, 1);
    if (child?.pid) stop('SIGTERM', false);
    if (options) {
      const reason = unconfirmed ? 'unconfirmed' : 'error';
      const bookkeeping = await recordTeam({ answer: '', header: '', reason });
      signal(`ended ${id} ${reported()} · token/s unreported · exit 1 reason ${reason}${teamLabel(true)}${teamEnd(bookkeeping)}${proposalNote()}${interventionNote()} · out ${options.out}`);
      if (!endSent) send({ type: 'dispatch-end', id, ...output.routing(), exitCode: 1, reason: 'error', ...usage(),
        verdict: routingVerdict(output, declared()), skillProposals, skillChangesLeftLive, endedAt: Date.now() });
    }
    log?.destroy();
    return 1;
  } finally {
    ending = true;
    boardWatch?.close();
    clearTimeout(startTimer);
    clearInterval(pollTimer); clearInterval(rateTimer); clearInterval(inboxTimer);
    await inboxRead; await treeStop;
    await rejectDeferredControls().catch(() => { signal('deferred control receipts unavailable'); });
    await receiptTail; clearTimeout(forceTimer);
    await rollout.pending;
    await activeRuntime?.close(); controlClient?.close();
    team?.release(id);
    process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onTerminate); process.removeListener('SIGHUP', onHangup);
  }
}

if (require.main === module) run(process.argv.slice(2)).then(code => { process.exitCode = code; });
module.exports = { argumentsOf, commandOf, briefOf, recordFindings, WorkerOutput, CodexRollout, runtimeFiles, run, RATE_INTERVAL };
