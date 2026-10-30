// A command-line worker declares its assignment here; Agentrix never infers it from shell commands.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const { homedir, constants: { signals } } = require('node:os');

// Plain Node cannot read app.asar. Packaged and SSH helpers carry these same pure modules beside them.
const runtime = path.join(__dirname, fs.existsSync(path.join(__dirname, 'electron')) ? 'electron' : '../electron');
const { TokenRates } = require(path.join(runtime, 'features/agents/token-rate.cjs'));
const { agentSettings } = require(path.join(runtime, 'features/agents/agent-settings.cjs'));
const { rolloutFiles, sessionMeta } = require(path.join(runtime, 'session-files.cjs'));
const { TranscriptTail } = require(path.join(runtime, 'transcript-tail.cjs'));
const { matches, snapshot, changedBetween, boundariesFor, repoFiles } = require(path.join(runtime, 'boundaries.cjs'));
const { projectTeam, meetingRequest, recordFindings, minutesMarkdown, FINDINGS } = require(path.join(runtime, 'features/team/team.cjs'));
const { minutesPage } = require(path.join(runtime, 'features/team/minutes-page.cjs'));
const RUNTIME_FILES = ['boundaries.cjs', 'session-files.cjs', 'transcript-tail.cjs', 'transcript-window.cjs', 'completion-history.cjs',
  'oversized-record.cjs', 'prompt-queue.cjs', 'features/agents/token-rate.cjs', 'features/agents/agent-settings.cjs',
  'features/team/team.cjs', 'features/team/minutes-page.cjs'];
const runtimeFiles = () => Object.fromEntries(RUNTIME_FILES.map(file => [file, fs.readFileSync(path.join(runtime, file), 'utf8')]));

const START_TIMEOUT = 30000;
const RATE_INTERVAL = 5000;
// How often a Codex worker's session file is read until its start is confirmed, and how long a worker's last output may
// take to arrive after it exits before the helper decides from what it has.
const POLL_INTERVAL = 250, EXIT_SETTLE = 500;
const LIMIT = 4 * 1024 * 1024;
const word = value => typeof value === 'string' && value.trim() ? value.trim() : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const roles = new Map([['执行', '执行'], ['调查', '调查'], ['审查', '审查'], ['exec', '执行'], ['investigate', '调查'], ['review', '审查']]);
const KINDS = ['core', 'frontend', 'test', 'ui-check', 'docs', 'small', 'review', 'investigate', 'roundtable'];
const kindOf = (options, roundtable = false) => options.kind || (roundtable ? 'roundtable' : ({ 审查: 'review', 调查: 'investigate' }[options.role] || null));
const USAGE = `Usage: node dispatch.cjs <codex|claude> --role <执行|调查|审查|exec|investigate|review>
  --title <task> --model <model> --effort <effort> --cwd <dir> --brief <file> --out <file>
  [--allow <glob> ...]    the only files it may change; any other change is reported as out of scope
  [--ledger <file>]       the task's shared context: given to the worker, its findings appended after
  [--resume <session>]    continue that worker session (same context) instead of starting a new one
  [--meeting <id>]        roundtable before work; no file changes and no --read-only
  [--skip-meeting <reason>] execution with --allow may bypass confirmation; the reason is recorded
  [--kind <${KINDS.join('|')}>] task category for long-term evaluation
  Codex: [--fast] [--image <file> ...] [--read-only]
  Claude: --permission <plan|acceptEdits>

  node dispatch.cjs minutes --cwd <dir> --meeting <id> --out <minutes.md> [--issues <issues.json>] [--language zh|en]
  node dispatch.cjs consolidate --cwd <dir> --meeting <id> --summary <file.md> [--incidents <file.json>] [--findings <file.json>]
`;

function argumentsOf(argv) {
  const [agent, ...flags] = argv;
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
  if (options.kind && !KINDS.includes(options.kind)) throw new Error(`Expected --kind ${KINDS.join(', ')}`);
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
  if (options.ledger || team) parts.push(`# Handing back\n\nEnd your final answer with a section headed exactly \`${FINDINGS}\`: bullets with the facts, decisions `
    + 'and pitfalls the next worker on this task must know (file:line where it helps). They are added to the shared context.');
  const prefixed = parts.length ? Buffer.concat([Buffer.from(`${parts.join('\n\n')}\n\n# Task\n\n`), brief]) : brief;
  return team && options.meeting ? Buffer.concat([prefixed, Buffer.from('\n\n' + meetingRequest(phase))]) : prefixed;
}

async function teamCommand(argv, stdout) {
  try {
    const options = argumentsOf(argv), team = projectTeam(options.cwd, argv[0] !== 'consolidate');
    if (!team) throw new Error('Team commands require a git repository');
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
      const issues = options.issues ? JSON.parse(fs.readFileSync(options.issues, 'utf8').replace(/^\uFEFF/, '')) : [];
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
      const delta = key => count(totals[key]) !== null && count(this.baseline?.[key]) !== null && totals[key] >= this.baseline[key]
        ? totals[key] - this.baseline[key] : null;
      const input = delta('input_tokens'), cached = delta('cached_input_tokens');
      const usage = { inputTokens: input !== null && cached !== null && input >= cached ? input - cached : null,
        cachedTokens: cached, outputTokens: delta('output_tokens') };
      if (Object.values(usage).some(value => value !== null)) this.rolloutUsage = usage;
    }
    this.measure(record);
  }
  counters(record) {
    if (record.type === 'event_msg' && record.payload?.type === 'token_count') return record.payload.info?.total_token_usage || null;
    if (record.type === 'token_usage_record' || record.type === 'event_msg' && record.payload?.type === 'token_usage_record') return record.payload?.thread_token_usage || null;
    return null;
  }
  usage() {
    return { inputTokens: null, cachedTokens: null, outputTokens: this.outputTokens, ...(this.rolloutUsage || this.stdoutUsage),
      activeMs: this.activeMs, reportedCostUsd: this.reportedCostUsd };
  }
  verdict(requested) {
    const actual = this.routing();
    if (Object.keys(actual).some(key => this[key] !== null && actual[key] !== requested[key])) return 'mismatch';
    return this.model === null ? 'unverified' : 'ok';
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
        if (this.activeMs === null) this.outputTokens = count(record.usage?.output_tokens);
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
    for (const filename of await this.files(id)) {
      if ((await sessionMeta(filename))?.id !== id) continue;
      this.tail = this.reader(filename);
      this.output.baseline = null;
      await this.tail.read(record => { const totals = this.output.counters(record); if (totals) this.output.baseline = totals; });
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

async function run(argv, { env = process.env, stdout = process.stdout, launch = spawn, resolveExecutable = executable, startTimeout = START_TIMEOUT } = {}) {
  if (argv.at(-1) === '--help' && (argv.length === 1 || argv.length === 2 && ['codex', 'claude', 'minutes', 'consolidate'].includes(argv[0]))) {
    stdout.write(USAGE); return 0;
  }
  if (['minutes', 'consolidate'].includes(argv[0])) return teamCommand(argv, stdout);
  const id = randomUUID(), send = eventSink(env.AGENTRIX_BOOTSTRAP);
  let options, child, log, startTimer, forceTimer, pollTimer, rateTimer, lastRate, endSent = false;
  let started = false, unconfirmed = false, killed = false, exited = false, spawnError = null, before = null, drain;
  let team = null, admission = null, teamFinished = false, roundtable = false;
  const teamLabel = (end = false) => !team ? '' : roundtable ? ` · roundtable ${options.meeting}`
    : options.skipMeeting && !end ? ` · roundtable skipped: ${options.skipMeeting}` : '';
  const recordTeam = async report => {
    if (!team || !admission || teamFinished) return {};
    teamFinished = true;
    try { return await team.finish(options, { id, session: output.sessionId, model: unconfirmed ? 'unreported' : output.routing().model,
      kind: kindOf(options, roundtable), ...output.usage(), ...admission, ...report }); }
    catch (error) { return { warning: String(error.message || error).replace(/[\r\n]+/g, ' ') }; }
  };
  const teamEnd = ({ status, warning }) => {
    let wording = '';
    if (roundtable && status) wording = admission.phase === 'confirmation' ? (status === 'confirmed' ? 'confirmed' : 'open')
      : `understanding ${status === 'understood' ? 'complete' : 'incomplete'}`;
    return (wording ? ` · ${wording}` : '') + (warning ? ` · WARNING: team bookkeeping failed: ${warning}` : '');
  };
  // Settles once the worker's output has been read to the end.
  const drained = new Promise(resolve => { drain = resolve; });
  const signal = line => stdout.write(`[dispatch] ${line}\n`);
  const declared = () => ({ model: options.model, effort: options.effort, fast: options.fast });
  const assignment = () => ({ type: 'dispatch-start', id, agent: options.agent, role: roundtable ? '圆桌' : options.role, title: options.title,
    kind: kindOf(options, roundtable), meeting: admission?.meeting || options.meeting || null, skipMeeting: options.skipMeeting || null,
    cwd: options.cwd, brief: options.brief, out: options.out, sessionId: output.sessionId, startedAt: Date.now() });
  const failed = (reason, exitCode = null) => {
    if (unconfirmed || started) return;
    unconfirmed = true; signal(`failed to start ${id}: ${reason.replace(/[\r\n]+/g, ' ')}`);
    if (!options) return;
    // Even without a session, the pane needs a declared row before it can retain the failure.
    send({ ...assignment(), model: 'unreported', effort: null, fast: null, declared: declared(), unconfirmed: true });
    send({ type: 'dispatch-end', id, model: 'unreported', effort: null, fast: null, exitCode, reason: 'unconfirmed',
      inputTokens: null, cachedTokens: null, reportedCostUsd: null, outputTokens: null, activeMs: null, verdict: 'unverified', endedAt: Date.now() });
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
    if (started || unconfirmed || !child?.pid || !output.sessionId || !final && (exited || child.exitCode !== null)) return;
    if (!output.confirmed) { if (!final && options.agent === 'codex') void rollout.read(); return; }
    started = true; clearTimeout(startTimer);
    const actual = output.routing(), requested = declared();
    const unverified = Object.keys(requested).filter(key => output[key] === null);
    const mismatch = Object.keys(requested).some(key => !unverified.includes(key) && actual[key] !== requested[key]);
    const verdict = mismatch ? `MISMATCH (declared ${requested.model} ${requested.effort} fast ${requested.fast ? 'on' : 'off'})`
      : unverified.includes('model') ? 'unverified' : 'ok';
    const routing = verdict + (unverified.length ? ` (${unverified.join(', ')}${verdict === 'unverified' ? '' : ' unverified'})` : '');
    signal(`started ${id} ${reported()} · routing ${routing} · pid ${child.pid} session ${output.sessionId}${teamLabel()}`);
    send({ ...assignment(), ...actual, ...(mismatch ? { declared: requested } : {}) });
    if (final) return;
    rateTimer = setInterval(() => {
      const { outputTokens, activeMs } = output;
      if (outputTokens === null || !(activeMs > 0) || lastRate?.outputTokens === outputTokens && lastRate?.activeMs === activeMs) return;
      lastRate = { outputTokens, activeMs };
      send({ type: 'dispatch-rate', id, ...lastRate });
    }, RATE_INTERVAL);
  };
  const output = new WorkerOutput(argv[0], () => confirm());
  const rollout = new CodexRollout(env.CODEX_HOME || path.join(homedir(), '.codex'), output);
  const stop = (kind, requested = true) => {
    if (requested) killed = true;
    if (exited || !child?.pid || child.exitCode !== null) return;
    if (process.platform === 'win32') {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
      killer.on('error', () => child.kill());
    } else {
      try { process.kill(-child.pid, kind); } catch { child.kill(kind); }
      clearTimeout(forceTimer);
      forceTimer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 1000);
      forceTimer.unref();
    }
  };
  const onInterrupt = () => stop('SIGINT'), onTerminate = () => stop('SIGTERM'), onHangup = () => stop('SIGHUP');
  try {
    options = argumentsOf(argv);
    process.on('SIGINT', onInterrupt); process.on('SIGTERM', onTerminate); process.on('SIGHUP', onHangup);
    team = projectTeam(options.cwd, true);
    roundtable = Boolean(team && options.meeting);
    if (options.meeting && !team) throw new Error('roundtables need a git repository');
    if (team) admission = await team.admit(options, id, __filename);
    if (killed) throw new Error('Dispatch interrupted before launch');
    const repo = admission?.repo || (options.allow.length ? repoFiles(options.cwd) : undefined);
    const checking = options.allow.length > 0 || roundtable;
    // What the working tree held before the worker, so its own changes can be checked against --allow afterwards.
    if (checking) before = snapshot(options.cwd, repo);
    if (roundtable && !before) throw new Error('Cannot verify the roundtable working tree');
    const brief = briefOf(options, fs.readFileSync(options.brief), team, { id, phase: admission?.phase, repo, before: checking ? before : undefined });
    log = fs.createWriteStream(options.out + '.log');
    await new Promise((resolve, reject) => { log.once('open', resolve); log.once('error', reject); });
    const command = resolveExecutable(options.agent, commandOf(options), env);
    if (options.agent === 'codex' && options.resume) await rollout.prepare(options.resume);
    if (killed) throw new Error('Dispatch interrupted before launch');
    child = launch(command.file, command.args, { cwd: options.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      detached: process.platform !== 'win32' });
    if (killed) stop('SIGTERM');
    log.on('error', error => { spawnError = error; stop('SIGTERM', false); });
    startTimer = setTimeout(() => { failed('session not reported within 30 s'); stop('SIGTERM', false); }, startTimeout);
    if (options.agent === 'codex') pollTimer = setInterval(() => { void rollout.read(); }, POLL_INTERVAL);
    child.once('exit', code => {
      exited = true; clearTimeout(startTimer); clearInterval(pollTimer); clearInterval(rateTimer);
      if (started) return;
      // Its last output can still be in the pipes: once that is read (at most EXIT_SETTLE), decide from its records,
      // without waiting for pipes a leftover child process may hold open.
      void Promise.race([drained, new Promise(resolve => setTimeout(resolve, EXIT_SETTLE))]).then(async () => {
        if (started || unconfirmed) return;
        if (options.agent === 'codex') { await rollout.pending; await rollout.read(); }
        confirm(true);
        if (!started) failed(output.capacity ? 'at capacity' : 'worker exited without a confirmed session', code === 0 ? 1 : code);
      });
    });
    const tails = [];
    for (const stream of [child.stdout, child.stderr]) {
      const decoder = new StringDecoder('utf8');
      let buffer = '', skipping = false, json = '';
      const parseLine = line => {
        // Claude's JSON result can be a pretty-printed array, or older builds can emit JSON lines.
        if (options.agent !== 'claude' || !json && !/^\s*[\[{]\s*$/.test(line)) { output.line(line); return; }
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
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') spawnError = error; });
    child.stdin.end(brief);
    const result = await new Promise(resolve => {
      child.once('error', error => { spawnError = error; });
      child.once('close', (code, killedBy) => resolve({ code, killedBy }));
    });
    for (const tail of tails) tail();
    clearInterval(pollTimer); clearInterval(rateTimer);
    if (options.agent === 'codex') { await rollout.pending; await rollout.read(); }
    confirm(true); drain();
    clearTimeout(startTimer); clearTimeout(forceTimer);
    if (!started) failed(spawnError?.message || (output.capacity ? 'at capacity' : 'worker exited without a confirmed session'), result.code === 0 ? 1 : result.code);
    if (options.agent === 'claude' && output.result !== null && output.result !== undefined) fs.writeFileSync(options.out, output.result);
    const after = checking ? snapshot(options.cwd, before) : null;
    // The helper's own files (the answer, its log, the ledger it appends to) are not the worker's changes.
    const own = after ? new Set([options.out, `${options.out}.log`, options.ledger, team?.memory].filter(Boolean).map(file => path.relative(after.root, file).split(path.sep).join('/'))) : null;
    const changed = (after && changedBetween(before, after)?.filter(file => !own.has(file))) ?? null;
    const outOfScope = changed && (roundtable ? changed : changed.filter(file => !matches(options.allow, file)));
    const route = output.routing();
    let reason = 'exit';
    if (unconfirmed) reason = 'unconfirmed';
    else if (killed) reason = 'killed';
    else if (output.capacity) reason = 'capacity';
    else if (result.killedBy) reason = 'killed';
    else if (roundtable && outOfScope?.length) reason = 'scope';
    else if (spawnError || output.failed || result.code !== 0 || roundtable && changed === null) reason = 'error';
    else if (outOfScope?.length) reason = 'scope';
    let answer = '';
    try { answer = fs.readFileSync(options.out, 'utf8'); } catch {}
    const header = `${new Date().toISOString().slice(0, 16).replace('T', ' ')} · ${options.title} · ${options.agent} ${route.model} · session ${output.sessionId || 'unreported'}`;
    const bookkeeping = await recordTeam({ answer, header, reason });
    if (!team) { try { recordFindings(options, answer, header); } catch {} }
    const scope = !checking ? '' : changed === null ? (team ? ' · scope unchecked (working tree unavailable)' : ' · scope unchecked (not a git working tree)')
      : outOfScope.length ? ` · OUT OF SCOPE: ${outOfScope.slice(0, 10).join(', ')}${outOfScope.length > 10 ? ` and ${outOfScope.length - 10} more` : ''}` : ' · scope ok';
    const exitCode = Number.isInteger(result.code) ? (result.code === 0 && (unconfirmed || roundtable && reason !== 'exit') ? 1 : result.code) : result.killedBy ? 128 + (signals[result.killedBy] || 1) : 1;
    const rate = output.outputTokens !== null && output.activeMs > 0 ? `${Math.round(output.outputTokens * 1000 / output.activeMs)} token/s (${output.outputTokens.toLocaleString('en-US')} output tokens in ${Math.round(output.activeMs / 1000)} s)` : 'token/s unreported';
    signal(`ended ${id} ${reported()} · ${rate} · exit ${exitCode} reason ${reason}${scope}${teamLabel(true)}${teamEnd(bookkeeping)} · out ${options.out}`);
    if (!endSent) send({ type: 'dispatch-end', id, ...route, exitCode, reason, ...output.usage(), verdict: output.verdict(declared()),
      ...(outOfScope ? { outOfScopeCount: outOfScope.length } : {}),
      ...(outOfScope?.length ? { outOfScope: outOfScope.slice(0, 50) } : {}), endedAt: Date.now() });
    await new Promise(resolve => log.end(resolve));
    return exitCode;
  } catch (error) {
    failed(error.message, 1);
    if (child?.pid) stop('SIGTERM', false);
    if (options) {
      const reason = unconfirmed ? 'unconfirmed' : 'error';
      const bookkeeping = await recordTeam({ answer: '', header: '', reason });
      signal(`ended ${id} ${reported()} · token/s unreported · exit 1 reason ${reason}${teamLabel(true)}${teamEnd(bookkeeping)} · out ${options.out}`);
      if (!endSent) send({ type: 'dispatch-end', id, ...output.routing(), exitCode: 1, reason: 'error', ...output.usage(),
        verdict: output.verdict(declared()), endedAt: Date.now() });
    }
    log?.destroy();
    return 1;
  } finally {
    clearTimeout(startTimer); clearTimeout(forceTimer);
    clearInterval(pollTimer); clearInterval(rateTimer);
    await rollout.pending;
    team?.release(id);
    process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onTerminate); process.removeListener('SIGHUP', onHangup);
  }
}

if (require.main === module) run(process.argv.slice(2)).then(code => { process.exitCode = code; });
module.exports = { argumentsOf, commandOf, briefOf, recordFindings, WorkerOutput, CodexRollout, runtimeFiles, run, RATE_INTERVAL };
