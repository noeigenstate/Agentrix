const process = require('node:process');
// A command-line worker declares its assignment here; Agentrix never infers it from shell commands.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFile, execFileSync } = require('node:child_process');
const { randomUUID, createHmac, randomBytes } = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const { homedir, tmpdir, constants: { signals } } = require('node:os');
const { setImmediate } = require('node:timers');

// Plain Node cannot read app.asar. Packaged and SSH helpers carry these same pure modules beside them.
const bundled = module.agentrixRuntimeLayout === 'bundled';
const runtime = path.join(__dirname, bundled || fs.existsSync(path.join(__dirname, 'electron')) ? 'electron' : '../electron');
const { TokenRates } = require(path.join(runtime, 'features/agents/token-rate.cjs'));
const { agentSettings } = require(path.join(runtime, 'features/agents/agent-settings.cjs'));
const { rolloutFiles, sessionMeta, isOwnedDirectory } = require(path.join(runtime, 'session-files.cjs'));
const { TranscriptTail } = require(path.join(runtime, 'transcript-tail.cjs'));
const { imageMetadata } = require(path.join(runtime, 'oversized-record.cjs'));
const { matches, snapshot, changedBetween, boundariesFor, repoFiles } = require(path.join(runtime, 'boundaries.cjs'));
const { projectTeam, recordFindings } = require(path.join(runtime, 'features/team/team.cjs'));
const { RunInbox, runId, validText, readBoard } = require(path.join(runtime, 'features/team/inbox.cjs'));
const { DISPATCH_TASK_KINDS, taskKind } = require(path.join(runtime, 'features/dashboard/records-routing.cjs'));
const { plainReply, skillFrontMatter } = require(path.join(runtime, 'features/skills/session.cjs'));
const { WorkerSkillProposals } = require(path.join(runtime, 'features/skills/worker-proposals.cjs'));
const { createCodexRuntime, workerEnvironment, elevatedSetupMessage, readiness } = require(path.join(runtime, 'features/codex-app-server/index.cjs'));
const { ROLE_LIMIT } = require(path.join(runtime, 'features/codex-app-server/sandbox-refresh.cjs'));
const { connectDispatchControl } = require(path.join(runtime, 'features/agents/dispatch-control.cjs'));
const { createCodexLocator } = require(path.join(runtime, 'features/codex-runtime/locator.cjs'));
const { createLocator } = require(path.join(runtime, 'features/claude-runtime/locator.cjs'));
const { workerOf, agentOfModel, defaultWorkerRules, isReadOnly, word, count } = require(path.join(runtime, 'features/cli-adapters/workers.cjs'));
const { dispatchDirectory, validSeat, REFUSAL_LIMIT, validRefusal } = require(path.join(runtime, 'features/agents/dispatch-events.cjs'));
const { launchSeat, liveSeatMap, launchSeatMap, parseSeatMap, seatExpectation } =
  require(path.join(runtime, 'features/agents/call-seat.cjs'));
const { commandPhrase } = require(path.join(runtime, 'command-phrase.cjs'));
const { diagnosticLine } = require(path.join(runtime, 'features/agents/start-failure.cjs'));
const outboxFile = path.join(__dirname, fs.existsSync(path.join(__dirname, 'dispatch-outbox.cjs')) ? 'dispatch-outbox.cjs' : 'electron/dispatch-outbox.cjs');
const { DispatchOutbox, DetachedRuns } = require(outboxFile);
const shimDirectory = path.join(__dirname, fs.existsSync(path.join(__dirname, 'shims/intercept.cjs')) ? 'shims' : 'electron/shims');
const { withShims, runtimeFiles: shimRuntimeFiles } = require(path.join(shimDirectory, 'intercept.cjs'));
const dispatchCompanions = Object.freeze(['role-tools.cjs', 'role-artifacts.cjs']);
const RUNTIME_FILES = ['boundaries.cjs', 'command-phrase.cjs', 'generated-image-path.cjs', 'session-files.cjs', 'transcript-tail.cjs', 'transcript-window.cjs', 'completion-history.cjs',
  'oversized-record.cjs', 'prompt-queue.cjs', 'features/agents/token-rate.cjs', 'features/agents/agent-settings.cjs', 'features/agents/agent-command.cjs',
  'features/team/team.cjs', 'features/team/inbox.cjs', 'features/dashboard/records-routing.cjs',
  'features/skills/session.cjs', 'features/skills/worker-proposals.cjs', 'features/agents/dispatch-control.cjs', 'features/agents/dispatch-events.cjs',
  'features/skills/agent-seat.cjs', 'features/agents/call-seat.cjs',
  'features/agents/codex-account-usage.cjs', 'features/agents/usage-observation.cjs', 'features/codex-app-server/index.cjs', 'features/codex-app-server/rpc.cjs',
  'features/codex-app-server/events.cjs', 'features/codex-app-server/requests.cjs', 'features/codex-app-server/account.cjs', 'features/codex-app-server/compatibility.cjs', 'features/codex-app-server/environment.cjs', 'features/codex-app-server/status.cjs',
  'features/codex-app-server/sandbox-refresh.cjs',
  'features/agents/start-failure.cjs', 'features/agents/skill-privacy.cjs', 'features/codex-runtime/locator.cjs', 'features/claude-runtime/locator.cjs', 'features/claude-runtime/path-env.cjs',
  'features/cli-adapters/workers.cjs', 'features/cli-adapters/manifests/worker.cjs',
  'shared/reason.cjs', 'shared/reasons/claude.cjs', 'shared/reasons/dispatch.cjs', 'shared/reasons/term.cjs', 'shared/reasons/codex.cjs', 'shared/agentrix-shims.cjs'];
const runtimeFiles = () => {
  const files = Object.fromEntries(RUNTIME_FILES.map(file => [file, fs.readFileSync(path.join(runtime, file), 'utf8')]));
  // Packaging and SSH already carry this module. Keep the document alongside its parser without adding a file.
  if (plainReply === undefined) files['features/skills/session.cjs'] += `\nmodule.exports.plainReply = ${JSON.stringify(plainReplyInstructions())};\n`;
  return { ...files, 'dispatch-outbox.cjs': fs.readFileSync(outboxFile, 'utf8'), ...shimRuntimeFiles() };
};

function plainReplyInstructions() {
  if (plainReply !== undefined) return plainReply;
  const source = fs.readFileSync(path.join(__dirname, '../resources/skills/plain-reply/SKILL.md'), 'utf8');
  return skillFrontMatter.frontMatter(source).body.trim();
}

const START_TIMEOUT = 30000;
const localWindowsCodex = (agent, env, platform = process.platform) => workerOf(agent)?.localWindows?.(env, platform) === true;
const RATE_INTERVAL = 5000;
const PINNED_SEATS = Symbol('pinned dispatch seats');
// How long a Codex worker's blocking request (a question, a form, an approval) waits for an answer before it is declined.
const REQUEST_TIMEOUT = 600000;
// How often a Codex worker's session file is read until its start is confirmed, and how long a worker's last output may
// take to arrive after it exits before the helper decides from what it has.
const POLL_INTERVAL = 250, EXIT_SETTLE = 500;
const LIMIT = 4 * 1024 * 1024;
const roles = new Map([['执行', '执行'], ['调查', '调查'], ['审查', '审查'], ['exec', '执行'], ['investigate', '调查'], ['review', '审查']]);
const USAGE = `Usage: node dispatch.cjs <codex|claude> --role <执行|调查|审查|exec|investigate|review>
  --title <task> --model <model> --effort <effort> --cwd <dir> --brief <file> --out <file>
  [--seat <id>[/<specialty>]] the team role for this run, for example --seat x-mobile
                             uses the launch seat for omitted --model, --effort and --fast
  [--allow <glob> ...]    the only files it may change; any other change is reported as out of scope
  [--small]              shorten the brief for a lookup or an edit to one or two named files
  [--ledger <file>]       the task's shared context: given to the worker, its findings appended after
  [--resume <session>]    continue that worker session (same context) instead of starting a new one
  [--kind <${DISPATCH_TASK_KINDS.join('|')}>] task category for long-term evaluation
  [--detach]             survive the launching shell; collect results with wait
  Codex: [--fast] [--image <file> ...] [--read-only]
  Claude: --permission <dontAsk|acceptEdits> (dontAsk is read-only)

  node dispatch.cjs stop <run id> [--reason <text>] [--no-resume] [--cwd <dir>]
  node dispatch.cjs wait <run id> [<run id> ...] [--timeout <seconds>] [--cwd <dir>]
`;

function seatChoice(seats, seat) {
  if (!seats || !validSeat(seat)) return null;
  const id = launchSeat(seat, Object.keys(seats));
  return id ? seats[id] : null;
}

function applySeatDefaults(options, env, pinnedLive, explicitFast) {
  if (!options.seat) return;
  const live = pinnedLive === undefined ? liveSeatMap(env.AGENTRIX_BOOTSTRAP) : pinnedLive;
  const baseline = parseSeatMap(env.AGENTRIX_SEATS) ?? (pinnedLive === undefined ? launchSeatMap(env.AGENTRIX_BOOTSTRAP) : null);
  const launch = seatChoice(baseline, options.seat);
  const choice = live ? seatChoice(live, options.seat) : launch;
  if (!choice) return;
  options.expectedSeat = { model: choice.model, effort: choice.effort, fast: choice.fast === true };
  const agent = agentOfModel(choice.model);
  if (agent !== options.agent) {
    if (live && (!options.model || agentOfModel(options.model) !== options.agent || options.model === launch?.model)) {
      throw new Error(`[${options.seat}] uses ${agent}. Run the dispatch helper with ${agent}.`);
    }
    return;
  }
  // A delivered routing table can still include flags copied from the launch configuration.
  const stale = live && launch && (options.model == null || options.model === launch.model);
  if (options.model == null || stale) options.model = choice.model;
  if (options.effort == null || stale && options.effort === launch.effort) options.effort = choice.effort;
  if ((!explicitFast || stale && launch.fast === true) && typeof choice.fast === 'boolean') {
    options.fast = choice.fast;
    options.fastFromSeat = true;
  }
}

function waitOptions(flags) {
  const options = { agent: 'wait', ids: [], timeout: 540, cwd: process.cwd() }, seen = new Set();
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (runId(flag)) { if (options.ids.includes(flag)) throw new Error('Repeated run id'); options.ids.push(flag); continue; }
    if (!['--timeout', '--cwd'].includes(flag) || seen.has(flag)) throw new Error(`Unknown or repeated option ${flag}`);
    seen.add(flag);
    const value = flags[++i];
    if (!value || value.startsWith('--') || !validText(value)) throw new Error(`Expected a value for ${flag}`);
    if (flag === '--cwd') options.cwd = value;
    else {
      if (!/^\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value)) || Number(value) > 570) throw new Error('--timeout must be between 0 and 570 seconds');
      options.timeout = Number(value);
    }
  }
  if (!options.ids.length) throw new Error('Expected at least one run id for wait');
  options.cwd = path.resolve(options.cwd);
  return options;
}

function stopOptions([id, ...flags]) {
  const options = { agent: 'stop', id, cwd: process.cwd(), noResume: false };
  if (!runId(id)) throw new Error('Expected a run id for stop');
  const seen = new Set();
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (!['--reason', '--no-resume', '--cwd'].includes(flag) || seen.has(flag)) throw new Error(`Unknown or repeated option ${flag}`);
    seen.add(flag);
    if (flag === '--no-resume') { options.noResume = true; continue; }
    const value = flags[++i];
    if (!value || value.startsWith('--') || !validText(value)) throw new Error(`Expected a value for ${flag}`);
    options[flag === '--reason' ? 'reason' : 'cwd'] = value;
  }
  options.cwd = path.resolve(options.cwd);
  return options;
}

const roundtablesRemoved = 'Roundtables were removed. Run without --meeting, minutes or consolidate.';
const usesRoundtable = ([command, ...flags]) => command === 'minutes' || command === 'consolidate'
  || flags.some(flag => flag === '--meeting' || flag.startsWith('--meeting='));

function validateSmallScope(readOnly, allow) {
  if (readOnly) return;
  if (!Array.isArray(allow) || !allow.length || allow.length > 2 || allow.some(file => typeof file !== 'string' || /[*?\[\]{}]/.test(file))) {
    throw new Error('A small writable role needs one or two named files in allow, without wildcards.');
  }
}

function argumentsOf(argv, env = process.env, seatSnapshot = env[PINNED_SEATS], roleFallback) {
  if (usesRoundtable(argv)) throw new Error(roundtablesRemoved);
  const [agent, ...flags] = argv;
  if (agent === 'wait') return waitOptions(flags);
  if (agent === 'stop') return stopOptions(flags);
  const worker = workerOf(agent);
  if (!worker) throw new Error('Expected codex or claude');
  const options = { agent, images: [], allow: [], fast: false, readOnly: false };
  const keys = ['role', 'title', 'model', 'effort', 'cwd', 'brief', 'out', 'permission', 'ledger', 'resume', 'kind', 'seat'];
  const names = new Map(keys.map(key => [`--${key}`, key]));
  const switches = new Map([['--fast', 'fast'], ['--read-only', 'readOnly'], ['--detach', 'detach'], ['--small', 'small']]);
  const seen = new Set();
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (switches.has(flag)) {
      if (seen.has(flag)) throw new Error(`Repeated option ${flag}`);
      seen.add(flag); options[switches.get(flag)] = true; continue;
    }
    if (!names.has(flag) && !['--image', '--allow', '--skip-meeting'].includes(flag)) throw new Error(`Unknown option ${flag}`);
    const value = flags[++i];
    if (!value || value.startsWith('--') || /[\0\r\n]/.test(value)) throw new Error(`Expected one-line value for ${flag}`);
    if (flag === '--skip-meeting') continue;
    if (flag === '--image') options.images.push(value);
    else if (flag === '--allow') {
      const glob = value.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
      if (/^(?:[A-Za-z]:|[\/~])|(?:^|\/)\.\.(?:\/|$)/.test(glob)) throw new Error('--allow must be relative to --cwd and cannot contain .. path components');
      options.allow.push(glob);
    }
    else {
      if (options[names.get(flag)] !== undefined) throw new Error(`Repeated option ${flag}`);
      options[names.get(flag)] = value;
    }
  }
  if (roleFallback) {
    const { configured, ...choice } = roleFallback, expected = seatExpectation(choice);
    if (!expected || !seatExpectation({ model: configured, effort: 'low' }) || !validSeat(options.seat)
      || !worker.leadSeat || agentOfModel(expected.model) !== agent || !workerOf(agentOfModel(configured)).needsSandbox || expected.fast) {
      throw new Error('Invalid role fallback');
    }
    Object.assign(options, expected, { expectedSeat: expected, fastFromSeat: true, fallbackFrom: configured });
  } else applySeatDefaults(options, env, seatSnapshot, seen.has('--fast'));
  for (const key of ['role', 'title', 'model', 'effort', 'cwd', 'brief', 'out']) if (!options[key]) throw new Error('Missing --' + key);
  if (!roles.has(options.role)) throw new Error('Expected --role 执行, 调查, 审查, exec, investigate or review');
  options.role = roles.get(options.role);
  if (options.kind && !DISPATCH_TASK_KINDS.includes(options.kind)) throw new Error(`Expected --kind ${DISPATCH_TASK_KINDS.join(', ')}`);
  if (options.seat != null && !validSeat(options.seat)) throw new Error('Expected a lowercase seat id with an optional /specialty for --seat');
  if (options.title.length > 1024 || options.model.length > 160 || options.effort.length > 32) throw new Error('Assignment is too long');
  // Each of these reaches a CLI as an option's value: none may start with a dash and become an option of its own.
  if (!/^[A-Za-z0-9][\w.:@+/[\]-]*$/.test(options.model)) throw new Error('Expected a model name for --model');
  if (!/^[A-Za-z][\w-]*$/.test(options.effort)) throw new Error('Expected an effort level for --effort');
  worker.validate(options);
  if (options.small) validateSmallScope(options.readOnly, options.allow);
  if (options.resume && !/^[A-Za-z0-9][\w-]{0,159}$/.test(options.resume)) throw new Error('Expected a session id for --resume');
  options.cwd = path.resolve(options.cwd);
  for (const key of ['brief', 'out', 'ledger']) if (options[key]) options[key] = path.resolve(options.cwd, options[key]);
  options.images = options.images.map(file => path.resolve(options.cwd, file));
  for (const file of [options.cwd, options.brief, options.out, ...options.images]) if (file.length > 4096) throw new Error('Path is too long');
  return options;
}

function commandOf(options, lab = false) {
  const command = workerOf(options.agent)?.command(options) ?? 'native';
  if (command !== 'native') return command;
  // The Lab links the account file into a private home without keyring access.
  return [...(lab ? ['-c', 'cli_auth_credentials_store="file"'] : []), 'app-server', '--listen', 'stdio://'];
}

function reportChangedFiles(event, changed) {
  if (!changed?.length) return event;
  const filesChanged = [];
  let remaining = 15 * 1024 - Buffer.byteLength(JSON.stringify(event));
  for (const file of changed) {
    if (filesChanged.length === 50) break;
    if (file.length > 4096 || /[\x00-\x1f\x7f]/.test(file)) continue;
    const bytes = Buffer.byteLength(JSON.stringify(file)) + 1;
    if (bytes > remaining) continue;
    filesChanged.push(file);
    remaining -= bytes;
  }
  return { ...event, filesChangedCount: changed.length, filesChanged };
}


// The code-standard skill files in the worker's folder: the system skill's source and the project's extensions of it.
function codeStandardFiles(cwd) {
  const extensionPrefix = 'code-standard-';
  const skillIn = (root, name) => fs.existsSync(path.join(cwd, root, name, 'SKILL.md')) ? [`${root}/${name}/SKILL.md`] : [];
  const extensions = root => {
    try { return fs.readdirSync(path.join(cwd, root)).filter(name => name.startsWith(extensionPrefix)).sort().flatMap(name => skillIn(root, name)); }
    catch { return []; }
  };
  return [...skillIn('resources/skills', extensionPrefix.slice(0, -1)), ...['skills', '.claude/skills', '.codex/skills'].flatMap(extensions)];
}

const STANDARD_LIMIT = 8 * 1024;
function inlineStandards(options, files) {
  if (options.small || files.length < 2 || files[0] !== 'resources/skills/code-standard/SKILL.md') return '';
  let remaining = STANDARD_LIMIT;
  try {
    const bodies = files.map(file => {
      const target = path.join(options.cwd, file), stat = fs.lstatSync(target);
      remaining -= stat.size;
      if (!stat.isFile() || remaining < 0) throw new Error('code_standard_unavailable');
      return fs.readFileSync(target, 'utf8').replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n/u, '').trim();
    });
    const body = bodies.join('\n\n');
    return bodies.every(Boolean) && Buffer.byteLength(body) <= STANDARD_LIMIT ? body : '';
  } catch { return ''; }
}

function standingRules(options) {
  const files = codeStandardFiles(options.cwd);
  const rules = workerOf(options.agent)?.rules ?? defaultWorkerRules;
  return rules({ ...options, files, inline: inlineStandards(options, files) });
}

// What the worker reads before the brief: the task's shared ledger, the boundaries of the modules it may change, the
// paths it may change, the standing rules, and how to hand its findings back.
function briefOf(options, brief, team, { id, repo, before } = {}) {
  const parts = [];
  const smallReadOnly = options.small && isReadOnly(options);
  if (options.ledger) {
    let ledger = '';
    try { ledger = fs.readFileSync(options.ledger, 'utf8').trim(); } catch {}
    if (ledger) parts.push(`# Shared context for this task\n\n${ledger}`);
  }
  if (team && !smallReadOnly) parts.push(...team.context(id, before, { small: options.small, readOnly: isReadOnly(options), allow: options.allow, brief: brief.toString('utf8') }));
  if (smallReadOnly) parts.push('# Files you may change\n\nNone.');
  else if (options.allow.length) {
    for (const boundary of boundariesFor(options.cwd, options.allow, repo)) {
      const text = options.small ? 'Read this file from the repository root before editing.' : boundary.text.trim();
      parts.push(`# Module boundary: ${boundary.file}\n\n${text}`);
    }
    parts.push(`# Files you may change\n\n${options.allow.map(glob => `- \`${glob}\``).join('\n')}\n\nChange nothing else. Any other changed file is `
      + 'reported to the lead as out of scope and the work is rejected. If the task cannot be done within these paths, stop and say which file you would need and why.');
  }
  parts.push(standingRules(options));
  parts.push('# Skill changes\n\nDo not edit, add or delete any SKILL.md unless --allow names that exact file without wildcards: that is the lead\'s approval. '
    + 'Record suggested skill changes in finish_role.skillProposals. Unapproved changes are preserved beside your answer; only an isolated worker worktree is restored. '
    + 'Shared or managed files are report-only because their author is unknown.');
  if (options.ledger || team || options.small) parts.push('# Handing back\n\nRecord the facts, decisions and pitfalls the next worker must know in finish_role.findings '
    + '(file:line where it helps). They are added to the shared context.');
  parts.push(plainReplyInstructions());
  return Buffer.concat([Buffer.from(parts.join('\n\n') + '\n\n# Task\n\n'), brief]);
}

const oneLine = message => String(message).replace(/[\r\n]+/g, ' ');
const quoted = text => JSON.stringify(text).slice(1, -1);
const dispatchEvent = (type, id, fields = {}) => ({ v: 1, type: 'dispatch.' + type, id, at: Date.now(), ...fields });
const routeText = ({ agent, model, effort, fast }) =>
  `${agent} model ${model} effort ${effort || 'unreported'} fast ${fast === null ? 'unreported' : fast ? 'on' : 'off'}`;

function renderDispatchStart(event) {
  const { routing: { verdict, declared, fallback, unverified }, pid, session } = event;
  const route = verdict === 'mismatch' ? `MISMATCH (declared ${declared.model} ${declared.effort} fast ${declared.fast ? 'on' : 'off'})` : verdict;
  const notes = unverified.length ? ` (${unverified.join(', ')}${verdict === 'unverified' ? '' : ' unverified'})` : '';
  const routedFallback = fallback && verdict === 'ok' ? ' · fallback' : '';
  return `${routeText(event)} · routing ${route}${routedFallback}${notes} · pid ${pid} session ${session}${fallbackText(event.fallback)}`;
}

function fallbackText(fallback) {
  if (!fallback) return '';
  const reason = fallback.reason === 'remote_sandbox_unavailable' ? '因为远端 Codex 或其 Linux 沙箱不可用。' : '因为这台电脑尚未完成 Codex 沙箱设置。';
  return ` · ${fallback.from} → ${fallback.to}，${reason}`;
}

function scopeText({ state, count, files, unavailable }) {
  switch (state) {
    case 'off': return '';
    case 'unchecked': return ` · scope unchecked (${unavailable === 'working-tree' ? 'working tree unavailable' : 'not a git working tree'})`;
    case 'changed': return ` · files changed during run: ${count} (author unknown)`;
    case 'out-of-scope': return ` · OUT OF SCOPE: ${files.join(', ')}${count > files.length ? ` and ${count - files.length} more` : ''}`;
    case 'ok': return ' · scope ok';
  }
}

function renderDispatchEnd(event) {
  const { id, agent, exitCode, reason, rate, scope, refused, needsDecision, result, routing, fallback,
    warnings = [], skillProposals, skillChangesLeftLive, interventions, stops, treeStopFailure } = event;
  if (!agent) {
    const label = result.source === 'lab' ? (reason === 'killed' ? 'stopped' : reason) : 'error';
    const failure = warnings.find(value => value.code === 'lab_dispatch_failed');
    const detail = failure ? ' · ' + (failure.event ? renderDispatchLine(failure.event).slice(0, 1000) : failure.detail)
      : reason === 'lost' || warnings.some(value => value.code === 'helper_lost') ? ' (helper exited without a final receipt)' : '';
    return `ended ${id} · exit ${exitCode} reason ${label}${detail}`;
  }
  const speed = rate ? `${Math.round(rate.outputTokens * 1000 / rate.activeMs)} token/s (${rate.outputTokens.toLocaleString('en-US')} output tokens in ${Math.round(rate.activeMs / 1000)} s)`
    : 'token/s unreported';
  const warning = code => warnings.find(value => value.code === code)?.detail;
  const restore = warning('scope_left_live') ? ' · out-of-scope changes left live (shared checkout or worktree; author unknown)' : '';
  const restored = warnings.find(value => value.code === 'scope_restored');
  const restoredText = restored ? ` · restored ${restored.count} out-of-scope paths${restored.quarantine ? ' · quarantined scope changes: ' + restored.quarantine : ''}` : '';
  const bookkeeping = warning('team_bookkeeping_failed');
  return `ended ${id} ${routeText(event)} · ${speed} · exit ${exitCode} reason ${reason}${scopeText(scope)}`
    + (refused.count ? ` · refused ${refused.count}${refused.first ? ': ' + refused.first.action : ''}` : '') + restore + restoredText
    + (bookkeeping ? ' · WARNING: team bookkeeping failed: ' + bookkeeping : '')
    + (skillProposals ? ` · ${skillProposals} skill proposals restored and awaiting the lead` : '')
    + (skillChangesLeftLive ? ` · ${skillChangesLeftLive} skill changes left live (author unknown)` : '')
    + warnings.filter(value => value.code === 'skill_proposal').map(value => ' · ' + value.detail).join('')
    + (interventions ? ` · owner intervened ${interventions}` : '') + (stops ? ` · owner stopped ${stops}` : '')
    + (treeStopFailure ? ' · tree stop failed: ' + treeStopFailure : '')
    + ` · out ${result.out}${fallbackText(fallback)}${routing ? ' · routing ' + routing : ''}${needsDecision ? ' · needs decision' : ''}`;
}

function renderNotice({ id, code, detail }) {
  switch (code) {
    case 'events_undelivered': return `events not delivered to Agentrix (${detail})`;
    case 'codex_control_unavailable': return `transport ${id} app-server: ${detail}`;
    case 'receipt_unavailable': return `receipt unavailable ${id}: ${detail}`;
    case 'role_result_unavailable': return `role result unavailable ${id} (${detail}); using final-text`;
    case 'stop_queued': return `stop queued ${id}`;
    case 'stop_requested': return `stop requested ${id}${detail.reason ? ': ' + quoted(detail.reason) : ''}${detail.noResume ? ' · no resume' : ''}`;
    case 'intervened': return `intervened ${id}: ${quoted(detail)}`;
    case 'scope_restore_unavailable': return `scope restore unavailable for pre-existing file: ${detail}`;
    case 'scope_restore_failed': return `scope restore failed: ${detail}`;
    case 'runtime_failed': return `runtime failed ${id}: ${detail}`;
    case 'finalization_failed': return `finalization failed: ${detail}`;
    case 'skill_recovery_failed': return `skill recovery failed: ${detail}`;
    case 'deferred_control_unavailable': return 'deferred control receipts unavailable';
  }
}

function renderRequest({ id, requestId, resolution }) {
  const { state, kind, preview, timeout, message } = resolution;
  const text = state === 'opened' ? `${kind} opened${preview ? ': ' + quoted(preview) : ''}`
    : state === 'declining' ? `${timeout === null ? 'requires owner approval' : `unanswered for ${timeout} s`}; declining`
      : state === 'decline-failed' ? `not declined: ${message}` : message;
  return `request ${id} ${requestId} ${text}`;
}

const lineRenderers = {
  'dispatch.started': event => `started ${event.id} ${renderDispatchStart(event)}`,
  'dispatch.ended': renderDispatchEnd,
  'dispatch.waiting': event => `waiting ${event.id}: ${event.message}`,
  'dispatch.start-failed': event => `failed to start ${event.id}: ${event.message}`,
  'dispatch.running': ({ id, seconds, lastActivityAt, waiting }) => `still running ${id} · `
    + (lastActivityAt === null ? 'receipt temporarily unavailable' : `${seconds} s · last activity ${new Date(lastActivityAt).toISOString()}${waiting ? ' · ' + waiting.message : ''}`),
  'dispatch.detached': event => `detached ${event.id} · session follows in wait`,
  'dispatch.unknown-run': event => `unknown run ${event.id}`,
  'dispatch.intervention': ({ id, messageId, status, reason }) => `intervention ${id} ${messageId} ${status}${reason ? ': ' + reason : ''}`,
  'dispatch.transport': ({ id, path, reason }) => `transport ${id} ${path}: ${reason}`,
  'dispatch.request': renderRequest,
  'dispatch.resume': ({ id, state, message }) => `${state === 'resuming' ? 'resuming' : 'resume failed'} ${id}: ${message}`,
  'dispatch.notice': renderNotice,
  'dispatch.failed': event => `failed: ${event.message}`,
};
function renderDispatchLine(event, { compactFailure = false } = {}) {
  if (event.type === 'dispatch.waiting' && event.kind !== 'sandbox') return event.message;
  if (event.type === 'dispatch.failed' && compactFailure) return '[dispatch] ' + event.message;
  if (event.type === 'dispatch.notice' && event.code === 'usage') return event.detail.trimEnd();
  return '[dispatch] ' + lineRenderers[event.type](event);
}

function dispatchOutput({ onEvent, jsonl = false, stdout = onEvent && !jsonl ? null : process.stdout, compactFailure } = {}) {
  return (event, legacyLine) => {
    onEvent?.(event);
    stdout?.write((jsonl ? JSON.stringify(event) : legacyLine ?? renderDispatchLine(event, { compactFailure })) + '\n');
  };
}

function dispatchArguments(argv) {
  let jsonl = false;
  const args = [...argv];
  for (let index = 1; index < args.length; index++) {
    if (args[index] !== '--events') continue;
    if (jsonl || args[index + 1] !== 'jsonl') return { args, jsonl: true, error: 'Expected one --events jsonl option' };
    jsonl = true;
    args.splice(index--, 2);
  }
  return { args, jsonl };
}

function scopeReport(checking, changed, outOfScope, readOnly, team) {
  if (!checking) return { state: 'off', count: 0, files: [] };
  if (changed === null) return { state: 'unchecked', count: 0, files: [], unavailable: team ? 'working-tree' : 'git' };
  const files = readOnly ? changed : outOfScope;
  const state = !files.length ? 'ok' : readOnly ? 'changed' : 'out-of-scope';
  return { state, count: files.length, files: files.slice(0, 10) };
}

async function stopWorker(argv, emit) {
  try {
    const options = argumentsOf(argv), team = projectTeam(options.cwd);
    if (!team) throw new Error('Team commands require a git repository');
    await team.queueControl(options.id, { id: randomUUID(), type: 'stop', at: Date.now(),
      ...(options.reason ? { reason: options.reason } : {}), ...(options.noResume ? { noResume: true } : {}) });
    emit(dispatchEvent('notice', options.id, { code: 'stop_queued' }));
    return 0;
  } catch (error) {
    emit(dispatchEvent('failed', null, { message: oneLine(error.message) })); return 1;
  }
}

// Local terminal bootstraps include HTTP and command hook settings, plus their fast-mode copies.
const BOOTSTRAP_LIMIT = 256 * 1024;

// The planner is told once per helper process, on run()'s output, that Agentrix did not receive its events: the worker
// runs on regardless.
let undeliveredNoted = false;
const PIPE_WAKE_TIMEOUT_MS = 2000;
// Serialize sends to preserve start/rate/end order. No pipe callback delays the worker or its output.
function eventSink(filename, notice) {
  let bootstrap, outbox, sending = false;
  const queue = [];
  function undelivered(code) {
    if (undeliveredNoted) return;
    undeliveredNoted = true;
    notice('events_undelivered', code);
  }
  function drain() {
    if (sending || !queue.length) return;
    sending = true;
    const address = process.platform === 'win32' && !bootstrap.pipeName.startsWith('\\\\') ? `\\\\.\\pipe\\${bootstrap.pipeName}` : bootstrap.pipeName;
    const event = queue.shift(), socket = net.connect(address);
    // A socket write is only a wake. Main's signed disk acknowledgment is the delivery proof.
    let failure = null, written = false;
    // The wake is only a nudge (the disk records are the delivery), so a slow pipe on a busy machine is given time
    // before the planner is told: at 250 ms a slow Windows runner reported "not delivered" for a pipe that was listening.
    socket.setTimeout(PIPE_WAKE_TIMEOUT_MS, () => { failure ??= 'timeout'; socket.destroy(); });
    socket.on('error', error => { failure ??= error.code || 'socket_error'; socket.destroy(); });
    socket.once('close', () => {
      if (!written) undelivered(failure || 'closed');
      sending = false; drain();
    });
    socket.once('connect', () => socket.end(JSON.stringify({ ...event, projectId: bootstrap.projectId, sessionKey: bootstrap.sessionKey }) + '\n',
      error => { if (!error) written = true; }));
  }
  const send = event => {
    try {
      if (!outbox) {
        if (!filename) return;
        if (fs.statSync(filename).size > BOOTSTRAP_LIMIT) return undelivered('bootstrap_invalid');
        let value;
        try { value = JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, '')); }
        catch (error) { if (error instanceof SyntaxError) return undelivered('bootstrap_invalid'); throw error; }
        if (![value?.pipeName, value?.projectId, value?.sessionKey].every(word)) return undelivered('bootstrap_invalid');
        // First event is the admitted declaration; later bootstrap replacements cannot change its signing identity.
        bootstrap = value; send.bootstrap = value;
        outbox = new DispatchOutbox({ directory: dispatchDirectory(filename), id: event.id, projectId: value.projectId, sessionKey: value.sessionKey,
          wake: frame => {
            // These wakes can coalesce; their records on disk remain complete and ordered.
            if (['dispatch-rate', 'dispatch-routing', 'dispatch-account'].includes(frame.type)) {
              const index = queue.findIndex(value => value.type === frame.type);
              if (index >= 0) queue.splice(index, 1);
            }
            queue.push(frame); drain();
          } });
        send.directory = outbox.directory;
      }
      outbox.append(event);
    } catch (error) {
      // Paths and credentials are never printed, including when durable storage is unavailable.
      undelivered(error.message === 'dispatch.oversize_event' ? 'dispatch.oversize_event' : 'dispatch.outbox_unreadable');
    }
  };
  return send;
}

// Claude's effort comes from launch. Other settings come from worker records; missing values stay unreported.
class WorkerOutput {
  constructor(agent, changed = () => {}, launchEffort = null) {
    this.worker = workerOf(agent); this.changed = changed; this.meter = new TokenRates(agent);
    this.launchEffort = launchEffort;
    this.model = null; this.effort = launchEffort; this.fast = null; this.sessionId = null;
    this.outputTokens = null; this.activeMs = null; this.failed = false; this.capacity = false; this.confirmed = false;
    this.stdoutUsage = null; this.rolloutUsage = null; this.reportedCostUsd = null;
    this.baseline = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
    this.resumed = false; this.lastCounters = {}; this.invalidCounters = new Set();
  }
  settings(value) {
    const model = word(value.model);
    if (model && model !== '<synthetic>') this.model = model;
    this.effort = this.launchEffort ?? (word(value.perTurnEffort ?? value.reasoning_effort ?? value.reasoningEffort ?? value.effort ?? value.reasoning?.effort) || this.effort);
    const tier = value.service_tier ?? value.serviceTier ?? value.speed ?? value.usage?.speed;
    if (typeof value.fast === 'boolean') this.fast = value.fast;
    else if (typeof value.fast_mode === 'boolean') this.fast = value.fast_mode;
    else if (['on', 'off'].includes(value.fast_mode_state)) this.fast = value.fast_mode_state === 'on';
    else if (['fast', 'priority', 'standard', 'default', 'flex', 'auto'].includes(tier)) this.fast = ['fast', 'priority'].includes(tier);
  }
  nativeRouting({ observed, effective }) {
    this.settings({ model: observed?.model ?? effective?.model,
      effort: observed?.effort ?? effective?.effort, fast: observed?.fast ?? effective?.fast });
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
    // Native usage is cumulative. A resumed query cannot report its history as new cost.
    if (resumed) return;
    const { usage, cost } = this.worker.nativeUsage(value);
    this.stdoutUsage = usage;
    if (cost !== null && (this.reportedCostUsd === null || cost >= this.reportedCostUsd)) this.reportedCostUsd = cost;
  }
  line(line, options) { for (const event of this.worker.output(line, options)) this.applyOutput(event); }
  record(record) { for (const event of this.worker.records(record)) this.applyOutput(event); }
  applyOutput({ settings, measure, inputId, failure, capacity, confirmSession, resetFailure, silent, ...fields }) {
    if (inputId != null) this.onInput?.(inputId);
    if (failure) this.failed = true;
    if (failure?.capacity || capacity) this.capacity = true;
    Object.assign(this, fields);
    if (confirmSession) this.confirmed ||= !!this.sessionId;
    if (settings) for (const value of settings) this.settings(value);
    if (measure) this.measure(measure);
    if (resetFailure) { this.failed = false; this.capacity = false; }
    if (!silent) this.changed();
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

// The helper never uses the version `codex --version` prints, so its locator's probe answers at once with none and runs no Codex.
const helperLocator = createCodexLocator({ probe: (_file, _args, _options, done) => { done(null, ''); } });
const helperClaudeLocator = createLocator();
// The Codex file a worker runs: the one the terminal was told (AGENTRIX_CODEX_EXECUTABLE) while it is there, resolved
// to its program the way main's locator resolves it, else codex-runtime's own search; null when there is none.
const locateCodex = (env, locator = helperLocator) => locator.locate({ env,
  prefer: Object.entries(env).find(([key]) => key.toUpperCase() === 'AGENTRIX_CODEX_EXECUTABLE')?.[1] || undefined }).then(found => found.file);
async function roleReadiness(cwd, env, locate = locateCodex, check = readiness) {
  const file = await locate(env);
  return file ? check(file, { cwd, env }) : null;
}

async function sshRoleReadiness(cwd, env, locate = locateCodex, execute = execFile) {
  const file = await locate(env);
  if (!file) return 'missing';
  const proof = 'agentrix-sandbox-ready';
  return new Promise(resolve => {
    execute(file, ['sandbox', '--', '/bin/echo', proof], { cwd, env, timeout: 5000, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
      // Bubblewrap can fail while the Codex sandbox command exits zero. Require the command's own output.
      resolve(!error && stdout.trim() === proof && !/bwrap:.*(?:fail|denied|permitted)/i.test(stderr) ? 'ready' : 'unavailable');
    });
  });
}
// The Claude Code file a terminal would run, outside the shim folder; null when there is none.
const locateClaude = async env => (await helperClaudeLocator.locate({ env })).terminal?.file || null;

// CLI lookup belongs to the shared locators. Never resolve a bare Claude against the worker's shim-prefixed PATH.
function executable(agent, args, _env, file) { return { file: file || agent, args }; }

function readWorkerOutput(child, log, output) {
  const tails = [];
  for (const stream of [child.stdout, child.stderr]) {
    const decoder = new StringDecoder('utf8');
    let buffer = '', skipping = false, json = '';
    const parseLine = line => {
      // Claude's JSON result can be a pretty-printed array, or older builds can emit JSON lines.
      if (stream !== child.stdout || !output.worker.multilineOutput || !json && !/^\s*[\[{]\s*$/.test(line)) {
        output.line(line, { stderr: stream === child.stderr }); return;
      }
      json += line + '\n';
      if (json.length > LIMIT) { json = ''; return; }
      try { const record = JSON.parse(json, imageMetadata); json = ''; output.record(record); } catch {}
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

function waitForWorkerClose(child) {
  return new Promise(resolve => {
    let settleTimer;
    child.once('exit', (code, killedBy) => {
      settleTimer = setTimeout(() => {
        // An inherited pipe can outlive the worker. Keep its exit status and stop waiting for that pipe.
        if (process.platform !== 'win32' && child.pid) {
          try { process.kill(-child.pid, 'SIGTERM'); } catch { /* The process group may already be gone. */ }
        }
        child.stdout.destroy();
        child.stderr.destroy();
        resolve({ code, killedBy });
      }, EXIT_SETTLE);
    });
    child.once('close', (code, killedBy) => { clearTimeout(settleTimer); resolve({ code, killedBy }); });
  });
}

// A terminal worker's transcript record as main compacts it for the meter (worker-terminals meterRecord): a user or
// assistant record of bounded size whose message holds only a content list.
const meterRecord = record => !!record && typeof record === 'object' && !Array.isArray(record) && ['user', 'assistant'].includes(record.type)
  && !!record.message && typeof record.message === 'object' && Array.isArray(record.message.content) && JSON.stringify(record).length <= 16384;

// Associate a provider echo with the input channel that supplied its identifier. Content never selects an origin.
function workerInput(event, controls, resumeIds, resumeInputId) {
  if (event.type !== 'item.upsert' || event.payload?.kind !== 'user-message' || event.replay || typeof event.itemId !== 'string') return null;
  const inputId = event.payload.content?.clientMessageId;
  const direct = controls.has(inputId);
  const ownerMessageIds = direct ? [inputId] : resumeIds.length && inputId === resumeInputId ? resumeIds : [];
  return { entryId: `u:${event.itemId}`, inputId, origin: direct ? 'owner' : 'planner', ownerMessageIds };
}

function detachedRuns(cwd, create = false) {
  const team = projectTeam(cwd, create);
  // Standalone, non-Git helpers still need receipts that a later invocation can locate.
  const key = createHmac('sha256', 'agentrix-detached-directory').update(fs.realpathSync(cwd)).digest('hex');
  if (team) return new DetachedRuns(path.join(team.directory, 'detached'));
  const temporary = fs.realpathSync(tmpdir()), owner = typeof process.getuid === 'function' ? process.getuid() : fs.statSync(temporary).uid;
  const parents = [process.platform === 'win32' ? 'agentrix-dispatch' : `agentrix-dispatch-${owner}`, key, 'detached'];
  let folder = temporary;
  for (const name of parents) {
    folder = path.join(folder, name);
    if (create) { try { fs.mkdirSync(folder, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
    const stat = fs.lstatSync(folder, { throwIfNoEntry: false });
    if (!stat) break;
    if (!isOwnedDirectory(stat, owner, process.platform === 'win32' ? 0 : 0o077)) throw new Error('Unsafe standalone receipt directory');
  }
  return new DetachedRuns(path.join(temporary, ...parents));
}

function reportDetachedTiming(onTiming, { id, startedAt, confirmedAt, settled, endedAt, waiting, ownerWait, ownerWaitSequence, menu, refused, needsDecision, routing }) {
  onTiming?.({ id, startedAt, confirmedAt, endedAt: settled ? endedAt : undefined, ...(waiting && { waiting }),
    ...(ownerWaitSequence && { ownerWait, ownerWaitSequence, menu }), ...(refused && { refused }),
    ...(settled && needsDecision === true && { needsDecision }), ...(routing && { routing }) });
}

const receiptLines = { started: 'startedLine', waiting: 'waitingLine', startFailed: 'failedLine', ended: 'endedLine' };
const receiptEvent = (key, event) => ({ [key]: event, [receiptLines[key]]: event && renderDispatchLine(event).trimEnd() });
const legacyLine = (entry, key) => entry?.legacy ? entry[receiptLines[key]] : null;
const startFailed = (id, code, message) => dispatchEvent('start-failed', id, { code, message: oneLine(message) });
const waitingEvent = ({ id, ownerWait, menu, waiting }) => waiting ?? (ownerWait ? dispatchEvent('waiting', id, {
  kind: menu ? 'menu' : 'owner', message: ownerWait, ...(menu && { menu }),
}) : null);

function detachedEnd(id, { exitCode = 1, reason = 'error', out = null, source = 'detached', warnings } = {}) {
  return dispatchEvent('ended', id, { agent: null, model: null, effort: null, fast: null, exitCode, reason, rate: null,
    scope: { state: 'off', count: 0, files: [] }, refused: { count: 0 }, needsDecision: null, routing: null,
    result: { source, out }, ...(warnings?.length && { warnings }) });
}

function reportReceiptStart(entry, emit) {
  if (entry.started) { emit(entry.started); return; }
  const line = legacyLine(entry, 'started');
  if (!line) return;
  emit(dispatchEvent('started', entry.id, { agent: entry.argv?.[0] ?? null, model: 'unreported', effort: null, fast: null,
    routing: { verdict: 'unverified', unverified: ['model', 'effort', 'fast'], fallback: false }, pid: entry.helperPid ?? 'broker', session: null }), line);
}

function reportReceiptEnd(entry, emit, lost = false) {
  emit(entry.ended ?? detachedEnd(entry.id, { exitCode: entry.exitCode, out: entry.out,
    source: entry.legacy ? 'legacy' : 'detached', reason: entry.legacy ? 'unknown' : lost ? 'lost' : 'error',
    warnings: lost ? [{ code: 'helper_lost' }] : [] }), !entry.ended ? legacyLine(entry, 'ended') : null);
}

function detachedLaunchState(current, emit, onTiming, store, continued) {
  if (current?.started || legacyLine(current, 'started')) {
    reportDetachedTiming(onTiming, current);
    if (store.claimStart(current.id) || continued && onTiming) reportReceiptStart(current, emit);
    return 0;
  }
  const failure = current?.startFailed ?? startFailed(current.id, 'helper-exit', 'helper ended before confirmation');
  emit(failure, !current.startFailed ? legacyLine(current, 'startFailed') : null);
  if (current.ended || legacyLine(current, 'ended')) reportReceiptEnd(current, emit);
  return 1;
}

function receiptReader(store, emit) {
  const reported = new Set();
  return (id, options) => {
    try { return store.read(id, options); }
    catch (error) {
      if (!reported.has(id)) emit(dispatchEvent('notice', id, { code: 'receipt_unavailable', detail: error.code || 'invalid_receipt' }));
      reported.add(id);
      return undefined;
    }
  };
}

async function answerDetachedRole({ id, cwd, agent, allow, readOnly }, { wait, choice }, env) {
  const file = env.AGENTRIX_BOOTSTRAP;
  if (!file || fs.statSync(file).size > BOOTSTRAP_LIMIT) throw new Error('Role control is unavailable.');
  const { controlAddress: address, projectId, sessionKey, controlCapability: capability } = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  if (!address || !sessionKey || !capability) throw new Error('Role control is unavailable.');
  const client = await connectDispatchControl({ address, runId: id, projectId, sessionKey, capability, cwd, agent, allow, readOnly, answerOnly: true });
  try { return await client.request('role.answer', { wait, choice }); }
  finally { client.close(); }
}

function hasDecisionHeading(answer) {
  let fence = '';
  for (const [, marker, rest] of answer.matchAll(/^ {0,3}(#{2}(?=[ \t])|`{3,}|~{3,})([^\r\n]*)/gm)) {
    if (fence) {
      if (marker.startsWith(fence) && !rest.trim()) fence = '';
    } else if (marker === '##') {
      if (rest.trim().replace(/[ \t]+#+$/, '') === 'Needs decision') return true;
    } else if (marker[0] !== '`' || !rest.includes('`')) fence = marker;
  }
  return false;
}

async function startDetached(argv, { env = process.env, launch = spawn, store, timeout, source = 'dispatch', onTiming,
  roleFallback, roleArtifacts, stdout, onEvent, jsonl, emit = dispatchOutput({ stdout, onEvent, jsonl }) } = {}) {
  // Keep the admitted choices stable if routing changes before the detached child starts.
  const seatSnapshot = argv.includes('--seat') ? liveSeatMap(env.AGENTRIX_BOOTSTRAP) : null;
  const launchSnapshot = argv.includes('--seat') ? parseSeatMap(env.AGENTRIX_SEATS) ?? launchSeatMap(env.AGENTRIX_BOOTSTRAP) : null;
  env = { ...env, AGENTRIX_DISPATCH_PINNED_SEATS: JSON.stringify(seatSnapshot), AGENTRIX_SEATS: JSON.stringify(launchSnapshot) };
  const id = randomUUID();
  let options, file, descriptor;
  try {
    options = argumentsOf(argv, env, seatSnapshot, roleFallback);
    timeout ??= 60000 + (localWindowsCodex(options.agent, env) ? ROLE_LIMIT : 0);
    store ||= detachedRuns(options.cwd, true);
    file = store.file(id);
    const saved = argv.filter(arg => arg !== '--detach');
    saved[saved.indexOf('--cwd') + 1] = options.cwd;
    store.create({ id, argv: saved, source, cwd: options.cwd, out: options.out, createdAt: Date.now(), roleFallback, roleArtifacts });
    try { store.prune(); } catch { /* Old receipt cleanup never prevents a new launch. */ }
    descriptor = fs.openSync(file + '.log', 'ax', 0o600);
  } catch (error) {
    if (roleArtifacts) await require('./role-artifacts.cjs').stampRoleArtifacts(roleArtifacts, 'ended');
    throw error;
  }
  let child, exit;
  const exited = new Promise(resolve => { exit = resolve; }), controller = new AbortController();
  try {
    // The child registers the run before launching the model.
    const script = 'require(process.argv[1]).runDetached(process.argv[2], { pinnedSeats: true }).then(code => { process.exitCode = code; })'
      + '.catch(error => { console.error(error.message); process.exitCode = 1; });';
    child = launch(process.execPath, ['-e', script, __filename, file], {
      cwd: options.cwd, env, detached: true, windowsHide: true, stdio: ['ignore', descriptor, descriptor],
    });
    child.once('exit', (code, signal) => exit({ code, signal }));
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
  } catch (error) {
    if (roleArtifacts) await require('./role-artifacts.cjs').stampRoleArtifacts(roleArtifacts, 'ended');
    const failure = startFailed(id, 'spawn', error.message);
    await store.update(id, { settled: true, exitCode: 1, ...receiptEvent('startFailed', failure) }).catch(() => {});
    emit(failure);
    return 1;
  } finally { fs.closeSync(descriptor); }
  let announcedWait;
  const read = receiptReader(store, emit);
  const observed = store.observe(() => {
    const current = read(id);
    const waiting = current && waitingEvent(current), line = waiting ? null : legacyLine(current, 'waiting');
    const message = waiting?.message ?? line;
    if (message && message !== announcedWait) {
      announcedWait = message;
      const event = waiting ?? dispatchEvent('waiting', id, { kind: 'sandbox', message: 'waiting for sandbox permissions' });
      reportDetachedTiming(onTiming, { ...current, waiting: event });
      emit(event, line);
    }
    return current?.started || legacyLine(current, 'started') || current?.settled ? current : undefined;
  }, timeout, { signal: controller.signal });
  let failure;
  let entry;
  try {
    entry = await Promise.race([observed, exited.then(result => { failure = result; return null; })]);
  } finally { controller.abort(); }
  let current = entry || read(id);
  if (failure && !current?.settled) {
    // A cached read after exit can predate the child's final rename. Only fresh disk state may authorize settlement.
    current = await store.update(id, { settled: true, exitCode: failure.code || 1 }, { unlessEnded: true }).catch(() => null)
      || read(id, { fresh: true }) || current;
  }
  if (current?.started || legacyLine(current, 'started') || current?.settled || failure) {
    return detachedLaunchState(current ?? { id }, emit, onTiming, store, announcedWait);
  }
  if (current && !current.admitted) {
    child.kill();
    let settleTimer;
    const stopped = await Promise.race([exited, new Promise(resolve => { settleTimer = setTimeout(resolve, EXIT_SETTLE); })]);
    clearTimeout(settleTimer);
    const failure = startFailed(id, 'timeout', `admission not confirmed within ${timeout / 1000} s`);
    if (stopped) {
      current = await store.update(id, { settled: true, exitCode: 1, ...receiptEvent('startFailed', failure) }, { unlessEnded: true }).catch(() => null);
      if (current?.started || current?.ended || legacyLine(current, 'started')) return detachedLaunchState(current, emit, onTiming, store, announcedWait);
    } else {
      // Without evidence of exit the caller must retain the worker's worktree.
      emit(dispatchEvent('detached', id));
      return 0;
    }
    emit(failure);
    return 1;
  }
  emit(dispatchEvent('detached', id));
  return 0;
}

async function runDetached(file, deps = {}) {
  const store = new DetachedRuns(path.dirname(file)), id = path.basename(file, '.json'), entry = store.read(id);
  if (entry.helperPid || entry.settled || !Array.isArray(entry.argv) || entry.argv.includes('--detach')) throw new Error('Invalid detached launch');
  const env = { ...(deps.env || process.env) };
  if (deps.pinnedSeats) Object.defineProperty(env, PINNED_SEATS, { value: parseSeatMap(env.AGENTRIX_DISPATCH_PINNED_SEATS) });
  delete env.AGENTRIX_DISPATCH_PINNED_SEATS;
  const { roleArtifacts } = entry;
  const artifacts = roleArtifacts && require('./role-artifacts.cjs');
  let processExitUnconfirmed = false;
  if (artifacts) artifacts.trackRoleProcess(roleArtifacts, process.pid);
  // A per-run socket answers with a nonce: PID existence alone cannot distinguish a reused PID.
  const token = randomUUID(), server = net.createServer(socket => {
    socket.on('error', () => {}); socket.setTimeout(1000, () => socket.destroy()); socket.end(token);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  let pending = Promise.resolve(), warned = false;
  const receipt = changes => {
    pending = Promise.resolve().then(() => store.update(id, changes)).catch(error => {
      if (warned) return;
      warned = true;
      const event = dispatchEvent('notice', id, { code: 'receipt_unavailable', detail: error.code || 'write_error' });
      try { dispatchOutput({ stdout: process.stderr, onEvent: deps.onEvent })(event); } catch {}
    });
    return pending;
  };
  await receipt({ helperPid: process.pid, helperStartedAt: Date.now() - Math.floor(process.uptime() * 1000), lease: { port: server.address().port, token } });
  let startTiming;
  const output = dispatchOutput(deps);
  const onEvent = event => {
    const changes = { activityAt: event.at };
    if (event.type === 'dispatch.waiting') Object.assign(changes, receiptEvent('waiting', event));
    if (event.type === 'dispatch.started') Object.assign(changes, startTiming, receiptEvent('started', event), receiptEvent('waiting', null));
    if (event.type === 'dispatch.start-failed') Object.assign(changes, receiptEvent('startFailed', event), receiptEvent('waiting', null));
    if (event.type === 'dispatch.ended') Object.assign(changes, receiptEvent('ended', event));
    void receipt(changes);
    try { output(event); } catch { /* Planner output cannot interrupt signed events or worker cleanup. */ }
  };
  let ownerWaitSequence = 0, needsDecision = false;
  const detached = { id, admitted: () => receipt({ admitted: true }), sandboxReady: () => receipt(receiptEvent('waiting', null)),
    ownerWaiting: (detail, menu = null) => {
      const ownerWait = menu ? `waiting on ${menu.kind} [${menu.id}]: ${menu.title}`
        + menu.options.map(({ number, label }) => ` · ${number}. ${label}`).join('')
        + (menu.answerable || menu.kind === 'permission' ? '' : ' · no supported answer')
        : detail ? 'waiting for the owner: ' + detail : null;
      if (ownerWait) ownerWaitSequence++;
      const waiting = ownerWait ? waitingEvent({ id, ownerWait, menu }) : null;
      // The legacy waitingLine was reserved for sandbox prompts.
      return receipt({ waiting, ownerWait, ownerWaitSequence, menu, activityAt: Date.now() });
    },
    refusals: refused => receipt({ refused: [...refused] }),
    routing: routing => receipt({ routing }),
    needsDecision: () => { needsDecision = true; },
    trackProcess: pid => artifacts?.trackRoleProcess(roleArtifacts, pid),
    deferArtifactSettlement: () => { processExitUnconfirmed = true; },
    confirmed: (startedAt, confirmedAt, routing) => { startTiming = { startedAt, confirmedAt, ...(routing && { routing }) }; } };
  let code = 1;
  try {
    code = await run(entry.argv, { ...deps, env, stdout: null, onEvent, source: entry.source, detached,
      startTimeout: 60000, roleFallback: entry.roleFallback, roleArtifacts });
    return code;
  } finally {
    const endedAt = Date.now();
    if (artifacts && !processExitUnconfirmed) await artifacts.stampRoleArtifacts(roleArtifacts, 'ended', endedAt);
    await receipt({ settled: true, exitCode: code, endedAt, activityAt: endedAt, ...receiptEvent('waiting', null), ownerWait: null, menu: null,
      ...(needsDecision && { needsDecision }) }); await pending;
    await new Promise(resolve => server.close(resolve));
  }
}

function helperAlive(pid, entry) {
  if (!entry.lease) { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } }
  if (!Number.isInteger(entry.lease.port) || entry.lease.port < 1 || entry.lease.port > 65535 || !runId(entry.lease.token)) return false;
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port: entry.lease.port }); let text = '';
    const finish = alive => { socket.destroy(); resolve(alive); };
    socket.setTimeout(750, () => finish(null));
    socket.on('error', error => finish(error.code === 'ECONNREFUSED' || error.code === 'ENOENT' ? false : null));
    socket.on('data', chunk => { text += chunk; if (text.length >= entry.lease.token.length) finish(text === entry.lease.token); });
    socket.on('end', () => finish(text === entry.lease.token));
  });
}

async function waitDetached(options, { store = detachedRuns(options.cwd), observe, onTiming,
  alive = helperAlive, untilAny = false, signal, stdout, onEvent, jsonl, emit = dispatchOutput({ stdout, onEvent, jsonl }) } = {}) {
  const pending = new Set(options.ids); let unknown = false;
  let completed = false, observing = true;
  const done = () => !pending.size || (untilAny && (completed || unknown));
  const read = receiptReader(store, emit);
  const finish = (id, entry, lost = false) => {
    reportDetachedTiming(onTiming, entry);
    const line = legacyLine(entry, 'startFailed');
    if (!(entry.started || legacyLine(entry, 'started')) && (entry.startFailed || line)) {
      emit(entry.startFailed ?? startFailed(id, 'unconfirmed', 'helper ended before confirmation'), !entry.startFailed ? line : null);
    }
    reportReceiptEnd(entry, emit, lost);
    pending.delete(id);
    completed = true;
  };
  const check = async () => {
    const entries = [...pending].map(id => [id, read(id)]);
    const hasResult = untilAny && entries.some(([, entry]) => entry === null || entry?.settled || entry?.ownerWait);
    await Promise.all(entries.map(async ([id, entry]) => {
      if (entry === null) { emit(dispatchEvent('unknown-run', id)); pending.delete(id); unknown = true; }
      if (!entry) return;
      if ((entry.started || legacyLine(entry, 'started')) && store.claimStart(id)) reportReceiptStart(entry, emit);
      if (entry.settled) { finish(id, entry); return; }
      if ((hasResult && !entry.ownerWait) || signal?.aborted || !Number.isSafeInteger(entry.helperPid) || entry.helperPid < 1) return;
      if (await alive(entry.helperPid, entry) === false && observing) finish(id, entry, true);
    }));
    return done() || hasResult ? true : undefined;
  };
  const ready = await check();
  if (!ready && !signal?.aborted && options.timeout > 0) await (observe || store.observe.bind(store))(check, options.timeout * 1000, { signal });
  observing = false;
  for (const id of pending) {
    const entry = read(id);
    if (!entry) { emit(dispatchEvent('running', id, { seconds: null, lastActivityAt: null })); continue; }
    if (entry.settled) { finish(id, entry); continue; }
    reportDetachedTiming(onTiming, entry);
    let activity = entry.activityAt || entry.createdAt;
    try { activity = Math.max(activity, fs.statSync(entry.out + '.log').mtimeMs); } catch {}
    const waiting = waitingEvent(entry) ?? (legacyLine(entry, 'waiting')
      ? dispatchEvent('waiting', id, { kind: 'sandbox', message: 'waiting for sandbox permissions' }) : null);
    emit(dispatchEvent('running', id, { seconds: Math.floor((Date.now() - entry.createdAt) / 1000), lastActivityAt: activity, ...(waiting && { waiting }) }));
  }
  return done() ? (unknown ? 1 : 0) : 75;
}

async function run(argv, deps = {}) {
  const { env = process.env, stdout = process.stdout, source = 'dispatch', launch = spawn, onTiming, untilAny, signal, roleFallback, roleArtifacts } = deps;
  if (argv[0] === 'intercept') return require(path.join(shimDirectory, 'intercept.cjs')).intercept(argv.slice(1), { env });
  if (argv[0] === 'mcp') {
    const { serve, createRoleTools } = require('./role-tools.cjs');
    const [, leadAgent, model, effort] = argv;
    const leadSeat = model && seatExpectation({ model, effort });
    return serve({ roles: createRoleTools({ env, engine: run, leadAgent, leadSeat, cleanup: true }) }).then(() => 0);
  }
  if (argv[0] === 'mcp-role') {
    const [, runId, folder] = argv;
    const { createRoleResultTools, ROLE_RESULT_SERVER } = require('./role-artifacts.cjs');
    const { serve } = require('./role-tools.cjs');
    return serve({ name: ROLE_RESULT_SERVER, roles: createRoleResultTools({ runId, folder }) }).then(() => 0);
  }
  const { args, jsonl, error } = dispatchArguments(argv);
  const roundtable = usesRoundtable(args);
  const emit = dispatchOutput({ ...deps, jsonl, compactFailure: !error && (roundtable || args[0] === 'stop') });
  const fail = message => { emit(dispatchEvent('failed', null, { message: oneLine(message) })); return 1; };
  if (error) return fail(error);
  argv = args;
  if (roundtable) return fail(roundtablesRemoved);
  if (argv.at(-1) === '--help' && (argv.length === 1 || argv.length === 2 && ['codex', 'claude', 'stop', 'wait'].includes(argv[0]))) {
    if (jsonl) emit(dispatchEvent('notice', randomUUID(), { code: 'usage', detail: USAGE }));
    else stdout?.write(USAGE);
    return 0;
  }
  if (argv[0] === 'stop') return stopWorker(argv, emit);
  if (argv[0] === 'wait' || argv.includes('--detach')) {
    try {
      if (argv[0] === 'wait') return await waitDetached(argumentsOf(argv), { emit, onTiming, untilAny, signal });
      return await startDetached(argv, { env, emit, launch, source, onTiming, roleFallback, roleArtifacts });
    } catch (error) { return fail(error.message); }
  }
  return runWorker(argv, deps, emit);
}

async function runWorker(argv, { env = process.env, source = 'dispatch', launch = spawn, resolveExecutable = executable,
  locate = locateCodex, locateClaude: findClaude = locateClaude, startTimeout = START_TIMEOUT, rateInterval = RATE_INTERVAL,
  requestTimeout = REQUEST_TIMEOUT, detached = null, roleFallback, roleArtifacts, launchTreeStop, labMeter }, emit) {
  const id = detached?.id || randomUUID();
  const signal = (type, fields) => emit(dispatchEvent(type, id, fields));
  const notice = (code, detail) => signal('notice', { code, ...(detail !== undefined && { detail }) });
  const send = labMeter ?? eventSink(env.AGENTRIX_BOOTSTRAP, notice);
  // Keep reporting authority in the helper; preserve the owner's environment outside marked SDK parents.
  let workerEnv = workerEnvironment(env);
  for (const name of Object.keys(workerEnv)) if (name.toUpperCase() === 'AGENTRIX_SEATS') delete workerEnv[name];
  let finalize, options, worker, usesAppServer, child, log, startTimer, forceTimer, pollTimer, rateTimer, lastRate, sentRoute, endSent = false;
  let started = false, unconfirmed = false, killed = false, exited = false, spawnError = null, before = null, drain;
  let workerStartedAt;
  let team = null, registered = false, teamFinished = false, skillGuard = null, skillProposals = 0, skillChangesLeftLive = 0;
  let inbox = null, inboxTimer, inboxRead = Promise.resolve(), messages = [], noResume = false, segmentStopped = false;
  let interventions = 0, stops = 0, completedUsage = null, resumeSession = null, segmentConfirmed = false;
  let treeStop = Promise.resolve(), stoppingChild, stoppingRuntime, treeStopError, workerProcess, nativeStopUnconfirmed;
  let artifacts, localArtifacts, roleFolder, roleServer, roleConfig;
  const stoppedOnRequest = () => killed || segmentStopped || noResume;
  const recordTreeStopFailure = error => { treeStopError ||= error; spawnError ||= error; };
  const stopFailureFor = reason => reason === 'killed' && treeStopError ? diagnosticLine(treeStopError.message) || 'Unknown error' : null;
  function trackWorker(process) {
    workerProcess = process;
    try {
      detached?.trackProcess?.(process.pid);
      if (localArtifacts) artifacts.trackRoleProcess(localArtifacts, process.pid);
    }
    catch (error) { spawnError ||= error; }
    return process;
  }
  let controlClient = null, activeRuntime = null, nativeTurn = null, settleNative, nativeFallback = null, nativeRunning = false;
  let bootstrap, controlOpening = false, controlAttemptAt = 0, ending = false;
  let controlFailure = 'bootstrap/missing_environment', controlLeadMode = null, transportFallback = false, lastControlFailure, lastControlNotice;
  let nativeBilling = null;
  let boardWatch, scopeRestoreBlocked = false, scopeRestoreReport;
  const controlReceipts = new Map(), requestTimers = new Map();
  const refused = [], refusedItems = new Set();
  function recordRefusal(refusal, itemId) {
    if (refused.length >= REFUSAL_LIMIT || !validRefusal(refusal)) return;
    if (refusal.reason === 'provider_declined' && itemId && refusedItems.has(itemId)) return;
    if (itemId) refusedItems.add(itemId);
    refused.push({ action: refusal.action, reason: refusal.reason });
    detached?.refusals?.(refused);
  }
  const controlInputs = new Map(), retriedControls = new Set(), unreadControls = new Set();
  const deferredControlIds = [];
  let resumeControlIds = [], resumeInputId;
  let receiptTail = Promise.resolve();
  const inputFacts = new Map();
  let inputTail = Promise.resolve();
  function recordInput(entryId, inputId, origin, ownerMessageIds = []) {
    if (!output.sessionId || typeof entryId !== 'string' || entryId.length > 200 || inputFacts.size >= 2000) return;
    const key = `${output.sessionId}:${entryId}`;
    if (inputFacts.has(key)) return;
    const fact = { type: 'dispatch-input', id, sessionId: output.sessionId, entryId, inputId: inputId || null, origin, ownerMessageIds: ownerMessageIds.slice(0, 32), at: Date.now() };
    inputFacts.set(key, fact);
    inputTail = inputTail.catch(() => {}).then(() => team?.locked(() => team.append(fact)));
    if (started) send(fact);
  }
  const cliInput = uuid => recordInput(`u:${uuid}`, uuid, 'planner', resumeControlIds);
  function recordReceipt(messageId, status, reason) {
    if (!['queued', 'delivered', 'consumed', 'rejected', 'unknown'].includes(status)) status = 'unknown';
    const previous = controlReceipts.get(messageId);
    if (previous === status || previous === 'consumed' || previous === 'delivered' && status === 'queued') return receiptTail;
    controlReceipts.set(messageId, status);
    if (['queued', 'delivered'].includes(status)) unreadControls.add(messageId);
    if (['consumed', 'rejected'].includes(status)) unreadControls.delete(messageId);
    const event = dispatchEvent('intervention', id, { messageId, status, ...(reason && { reason }) });
    emit(event);
    receiptTail = receiptTail.catch(() => {}).then(() => team?.locked(() => team.appendReceipt(event)))
      .then(() => { send({ type: 'dispatch-receipt', id, messageId, status }); });
    return receiptTail;
  }
  async function rejectDeferredControls() {
    for (const messageId of controlInputs.keys()) {
      if (['queued', 'delivered'].includes(controlReceipts.get(messageId))) await recordReceipt(messageId, 'rejected', 'worker_ended_without_resume');
    }
  }
  function queueUnreadControls() {
    for (const [messageId, text] of controlInputs) {
      if (!unreadControls.has(messageId) || deferredControlIds.includes(messageId)) continue;
      if (retriedControls.has(messageId)) { void recordReceipt(messageId, 'rejected', 'worker_ended_before_read'); continue; }
      messages.push(text); deferredControlIds.push(messageId);
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
  const restoreSkills = changedFiles => {
    if (!skillGuard || options.readOnly) return;
    const total = skillGuard.finish(id, changedFiles);
    skillProposals = skillGuard.restoredCount;
    skillChangesLeftLive = total - skillProposals;
  };
  const recordTeam = async report => {
    if (!registered || teamFinished) return null;
    teamFinished = true;
    try {
      await team.finish(options, { id, session: resumeSession || output.sessionId, model: unconfirmed ? 'unreported' : output.routing().model,
        kind: taskKind(options), ...usage(), ...report });
      return null;
    } catch (error) {
      return { code: 'team_bookkeeping_failed', detail: oneLine(error.message || error) };
    }
  };
  let drained = new Promise(resolve => { drain = resolve; });
  const fallback = () => options.fallbackFrom && { from: options.fallbackFrom, to: output.model || options.model,
    reason: env.AGENTRIX_REMOTE_ROLE_TOOLS === '1' ? 'remote_sandbox_unavailable' : 'local_sandbox_unavailable' };
  const declared = () => ({ model: options.model, effort: options.effort, fast: options.fast });
  const assignment = () => ({ type: 'dispatch-start', id, helperPid: process.pid, agent: options.agent, role: options.role, title: options.title,
    ...billing(),
    kind: taskKind(options),
    seat: options.seat ?? null, cwd: options.cwd, brief: options.brief, out: options.out, log: options.out + '.log',
    requestedModel: options.model, sessionId: output.sessionId, startedAt: Date.now() });
  const failed = (reason, exitCode = null, code = 'unconfirmed') => {
    if (unconfirmed || started) return;
    unconfirmed = true; emit(startFailed(id, code, reason));
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
  const reported = () => ({ agent: options.agent, ...(unconfirmed ? declared() : output.routing()) });
  const ended = ({ exitCode, reason, rate = null, scope = scopeReport(false), bookkeeping, restore,
    resultSource = 'final-text', needsDecision = null, routing = null, treeStopFailure }) => {
    const warnings = [restore, bookkeeping, ...Array.from(skillGuard?.notes ?? [], detail => ({ code: 'skill_proposal', detail }))].filter(Boolean);
    const routeFallback = fallback();
    const result = { source: resultSource, out: options.out };
    signal('ended', { ...reported(), exitCode, reason, rate, scope, needsDecision, routing, result,
      refused: { count: refused.length, ...(refused.length && { first: refused[0] }) }, skillProposals, skillChangesLeftLive, interventions, stops,
      ...(treeStopFailure && { treeStopFailure }), ...(warnings.length && { warnings }), ...(routeFallback && { fallback: routeFallback }) });
  };
  const routeVerdict = () => workerOf(agentOfModel(options.model)).routingVerdict(output, declared(), options.fallbackFrom);
  const roleRouting = () => worker.pinEffort && output.model !== null
    ? { ...output.routing(), verdict: routeVerdict() } : null;
  // A start is confirmed only by the worker's own records: its session, and Codex's turn context in that session's file.
  // While it runs, every new record is checked at once. A worker that has exited is judged once, on everything it left
  // (final), so a fast worker that did start is reported started and done, and one without those records is not.
  const confirm = (final = false) => {
    if (segmentConfirmed || unconfirmed || spawnError || !child?.pid || !output.sessionId || !final && (exited || child.exitCode !== null)) return;
    if (resumeSession && output.sessionId !== resumeSession) { spawnError = new Error('Resumed worker reported a different session'); stop('SIGTERM', false); return; }
    if (!output.confirmed) { if (!final && usesAppServer) void rollout.read(); return; }
    segmentConfirmed = true; clearTimeout(startTimer);
    if (!activeRuntime) for (const messageId of resumeControlIds) void recordReceipt(messageId, 'delivered').catch(() => {});
    const actual = output.routing(), requested = declared();
    const unverified = Object.keys(requested).filter(key => output[key] === null);
    const decision = routeVerdict(), mismatch = decision === 'mismatch';
    const routeFallback = fallback();
    const routing = { verdict: decision, unverified, fallback: Boolean(routeFallback), ...(mismatch && { declared: requested }) };
    if (!started) {
      started = true;
      detached?.confirmed?.(workerStartedAt, Date.now(), roleRouting());
      sentRoute = actual; send({ ...assignment(), ...actual, ...(mismatch ? { declared: requested } : {}) });
      signal('started', { ...reported(), routing, pid: child.pid, session: output.sessionId, ...(routeFallback && { fallback: routeFallback }) });
      for (const fact of inputFacts.values()) send(fact);
      if (heldLimits !== undefined) { reportAccount(heldLimits); heldLimits = undefined; }
    }
    if (final || rateTimer) return;
    rateTimer = setInterval(() => {
      const { outputTokens, activeMs } = usage(true);
      if (outputTokens === null || !(activeMs > 0) || lastRate?.outputTokens === outputTokens && lastRate?.activeMs === activeMs) return;
      lastRate = { outputTokens, activeMs };
      send({ type: 'dispatch-rate', id, ...lastRate, ...(labMeter && output.usage()) });
    }, rateInterval);
  };
  // A model reported after the start went out (app-server's turn can start before its session file names the model, or
  // the server reroutes) is sent on, so the pane's row follows what the worker runs; an unknown model is never sent.
  const reroute = () => {
    if (!started || output.model === null) return;
    const route = output.routing();
    if (['model', 'effort', 'fast'].every(key => route[key] === sentRoute[key])) return;
    sentRoute = route; send({ type: 'dispatch-routing', id, ...route });
    const routing = roleRouting();
    if (routing) detached?.routing?.(routing);
  };
  // The worker's own app-server reads its account and quota. A planner in a terminal has no native Codex session, so
  // these reports are the pane's first-hand Codex reading. Each report reads the account afresh; it is named only with
  // main's key (codexAccountKey, from a local control registration). Reports follow the start and stop at the end.
  let codexAccountKey = null, heldLimits;
  function reportAccount(limits) {
    const codex = activeRuntime;
    if (!codex || endSent) return;
    if (!started) { heldLimits = limits; return; }
    const named = !!codexAccountKey;
    void codex.readAccount().then(connection => {
      if (activeRuntime !== codex || endSent) return;
      send({ type: 'dispatch-account', id, limits, connection: { kind: connection.kind, observedAt: connection.observedAt ?? null,
        ...(named && connection.scopeId ? { scopeId: connection.scopeId } : {}) } });
    });
  }
  const changed = () => { confirm(); reroute(); };
  const workerOutput = () => {
    const segment = new WorkerOutput(options.agent, changed, worker.pinEffort ? options.effort : null);
    segment.onInput = cliInput;
    return segment;
  };
  let output, rollout;
  const stop = (kind, requested = true) => {
    if (requested) killed = true;
    if (activeRuntime) {
      const runtime = activeRuntime;
      if (stoppingRuntime === runtime) return;
      stoppingRuntime = runtime;
      treeStop = Promise.resolve().then(() => runtime.interrupt()).catch(error => {
        if (worker.brokerMethod) {
          nativeStopUnconfirmed = true;
          recordTreeStopFailure(error);
        }
      }).then(() => runtime.close()).catch(error => {
        nativeStopUnconfirmed = true;
        recordTreeStopFailure(error);
      }).finally(() => {
        nativeRunning = false; settleNative?.({ code: 1, killedBy: kind });
      });
      return;
    }
    if (exited || !child?.pid || child.exitCode !== null) return;
    const victim = child;
    if (stoppingChild === victim) return;
    stoppingChild = victim;
    if (process.platform === 'win32') {
      treeStop = new Promise(resolve => {
        const failed = error => {
          recordTreeStopFailure(error);
          try { victim.kill(); } catch { /* Keep the original tree stop diagnostic. */ }
          resolve();
        };
        try {
          const killer = launchTreeStop ? launchTreeStop(victim.pid)
            : spawn('taskkill.exe', ['/pid', String(victim.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
          killer.once('error', failed);
          killer.once('close', (code, signal) => {
            if (code !== 0 && (victim.exitCode == null && victim.signalCode == null || stoppedOnRequest())) {
              failed(new Error(`taskkill ${signal ? `ended with ${signal}` : `exited with code ${code}`}`));
            } else resolve();
          });
        } catch (error) { failed(error); }
      });
    } else {
      try { process.kill(-victim.pid, kind); }
      catch (error) {
        if (error.code !== 'ESRCH') recordTreeStopFailure(error);
        try { victim.kill(kind); } catch (failure) { recordTreeStopFailure(failure); }
      }
      treeStop = new Promise(resolve => {
        forceTimer = setTimeout(() => {
          try { process.kill(-victim.pid, 'SIGKILL'); }
          catch (error) { if (error.code !== 'ESRCH') recordTreeStopFailure(error); }
          resolve();
        }, 1000);
      });
    }
  };
  const readInbox = (finish = false) => {
    if (!inbox) return Promise.resolve();
    const task = inboxRead.then(async () => {
      let controls;
      const unread = unreadControls.size > 0;
      try { controls = await inbox.take(finish && !messages.length && !unread); }
      catch (error) {
        // Polling failures must not interrupt the worker. Only an unreadable final empty check prevents closure.
        if (finish && !messages.length) throw error;
        return;
      }
      for (const control of controls) {
        if (control.type === 'stop') {
          stops++; segmentStopped = true; noResume ||= !!control.noResume;
          notice('stop_requested', { reason: control.reason, noResume: control.noResume });
          const direct = !!activeRuntime;
          stop('SIGTERM', false);
          if (direct) {
            let status = 'delivered';
            await treeStop;
            if (nativeStopUnconfirmed) status = 'unknown';
            await recordReceipt(control.id, status);
          }
        } else {
          interventions++;
          controlInputs.set(control.id, control.text);
          if (activeRuntime) {
            controlReceipts.set(control.id, null);
            let receipt;
            try { receipt = await activeRuntime.send({ clientMessageId: control.id, text: control.text }); }
            catch (error) { receipt = { status: error.message === 'control_unavailable' ? 'rejected' : 'unknown', reason: error.message }; }
            if (receipt?.status === 'rejected' && ['worker_ended', 'control_unavailable'].includes(receipt.reason)) {
              messages.push(control.text); deferredControlIds.push(control.id); receipt.status = 'queued';
              notice('intervened', control.text);
            }
            await recordReceipt(control.id, receipt?.status);
          } else {
            messages.push(control.text); deferredControlIds.push(control.id);
            notice('intervened', control.text);
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
    options = argumentsOf(argv, env, env[PINNED_SEATS], roleFallback);
    worker = workerOf(options.agent); usesAppServer = worker.command(options) === 'native';
    output = workerOutput();
    rollout = new CodexRollout(env.CODEX_HOME || path.join(homedir(), '.codex'), output);
    if (!['dispatch', 'intercepted'].includes(source)) throw new Error('Unknown dispatch source');
    process.on('SIGINT', onInterrupt); process.on('SIGTERM', onTerminate); process.on('SIGHUP', onHangup);
    team = projectTeam(options.cwd, true);
    // Watch before board registration: a peer that finishes before us must still disable restoration.
    // Lost, malformed or unresolvable board evidence is report-only, never proof of exclusive ownership.
    let scopeRoot;
    if (team) try {
      // Resolve the current worktree once; peer checks need only canonical paths.
      const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: options.cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      scopeRoot = fs.realpathSync.native(root);
    } catch { scopeRestoreBlocked = true; }
    const checkPeer = name => {
      if (name === id + '.json' || name === id + '.tmp') return;
      try {
        const entry = readBoard(fs.readFileSync(path.join(team.board, name), 'utf8'));
        if (typeof entry?.cwd !== 'string') throw new Error('invalid_board');
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
        checkBoard();
      } catch { scopeRestoreBlocked = true; }
    }
    if (team) {
      team.register(options, id);
      registered = true;
    }
    send({ type: 'dispatch-declared', id, helperPid: process.pid, agent: options.agent, role: options.role, title: options.title,
      seat: options.seat ?? null, cwd: options.cwd, worktree: options.cwd, requested: declared(), source, parentId: null, resumed: !!options.resume,
      ...(options.expectedSeat && { expected: options.expectedSeat }),
      kind: taskKind(options), at: Date.now() });
    workerEnv = withShims(workerEnv, { depth: 1 + (Number(env.AGENTRIX_DISPATCH_DEPTH) || 0), runId: id,
      proof: createHmac('sha256', send.bootstrap?.sessionKey || randomBytes(32)).update(`agentrix-run:${id}`).digest('hex') });
    if (team) {
      inbox = new RunInbox(team, id); await inbox.open();
      inboxTimer = setInterval(() => {
        void readInbox().catch(() => {});
        if (activeRuntime && usesAppServer && controlClient?.connected === false && Date.now() - controlAttemptAt >= 1000) void openControl();
      }, POLL_INTERVAL);
    }
    if (killed) throw new Error('Dispatch interrupted before launch');
    const scoped = options.allow.length > 0;
    const repo = scoped || options.readOnly ? repoFiles(options.cwd) : undefined;
    // What the working tree held before the worker, so its own changes can be checked against --allow afterwards.
    if (scoped || options.readOnly) before = snapshot(options.cwd, repo);
    const checking = scoped || Boolean(before);
    skillGuard = new WorkerSkillProposals(options, env, repo);
    const dirtyBytes = new Map();
    let capturedBytes = 0;
    for (const { file } of (options.readOnly ? [] : before?.status ?? [])) {
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
      if (scopeRestoreBlocked || !skillGuard.restoreRoot) { scopeRestoreReport = { code: 'scope_left_live', detail: true }; return; }
      let restored = 0, quarantine;
      const restoredNote = () => { scopeRestoreReport = { code: 'scope_restored', count: restored, quarantine }; };
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
          else if (before.files.get(file) !== 'deleted') { notice('scope_restore_unavailable', file); continue; }
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
      const own = after ? new Set([options.out, `${options.out}.log`, ...(options.readOnly ? [] : [options.ledger, team?.memory]), ...skillGuard.artifacts].filter(Boolean)
        .map(file => path.relative(after.root, file).split(path.sep).join('/'))) : null;
      const outbox = after && send.directory && path.relative(after.root, send.directory).split(path.sep).join('/');
      const changed = (after && changedBetween(before, after)?.filter(file => !own.has(file) && !(outbox && file.startsWith(outbox + '/')))) ?? null;
      return { after, changed, outOfScope: changed && changed.filter(file => !options.readOnly && !matches(options.allow, file)) };
    };
    let brief = briefOf(options, fs.readFileSync(options.brief), team, { id, repo, before: checking ? before : undefined });
    log = fs.createWriteStream(options.out + '.log');
    await new Promise((resolve, reject) => { log.once('open', resolve); log.once('error', reject); });
    detached?.admitted();
    async function openControl() {
      if (controlOpening || ending) return;
      controlOpening = true; controlAttemptAt = Date.now();
      try {
        if (!env.AGENTRIX_BOOTSTRAP) { controlFailure = 'bootstrap/missing_environment'; return; }
        if (fs.statSync(env.AGENTRIX_BOOTSTRAP).size > BOOTSTRAP_LIMIT) { controlFailure = 'bootstrap/size_limit'; return; }
        bootstrap = send.bootstrap || JSON.parse(fs.readFileSync(env.AGENTRIX_BOOTSTRAP, 'utf8').replace(/^\uFEFF/, ''));
        if (!bootstrap?.controlAddress) { controlFailure = 'bootstrap/missing_address'; return; }
        if (!bootstrap.controlCapability) { controlFailure = 'bootstrap/missing_capability'; return; }
        if (!bootstrap.sessionKey) { controlFailure = 'bootstrap/missing_session_key'; return; }
        const client = await connectDispatchControl({ address: bootstrap.controlAddress, runId: id,
        projectId: bootstrap.projectId, sessionKey: bootstrap.sessionKey, capability: bootstrap.controlCapability,
        cwd: options.cwd, agent: options.agent, allow: options.allow,
        readOnly: options.readOnly,
        onControl: async messageId => { await readInbox(); return controlReceipts.get(messageId) || inbox?.receipt(messageId) || 'queued'; },
        onEvent: event => acceptNative(event) });
        if (ending) client.close(); else { controlClient = client; controlFailure = null; controlLeadMode = null; }
      } catch (error) {
        controlLeadMode = error.message === 'control_unavailable' && error.stage === 'control_register' ? error.leadMode : null;
        // Never print exception messages: filesystem/socket errors contain the bootstrap path.
        controlFailure = error.message === 'control_unavailable' ? `${error.stage}/${error.category}`
          : `bootstrap/${error instanceof SyntaxError ? 'invalid_json' : ['ENOENT', 'EACCES', 'EPERM'].includes(error.code) ? error.code : 'read_failed'}`;
      }
      finally {
        controlOpening = false;
        const controlNotice = controlClient ? null : controlFailure;
        if (lastControlNotice !== controlNotice) {
          lastControlNotice = controlNotice;
          send({ type: 'dispatch-notice', id, controlFailure: controlNotice, at: Date.now() });
        }
        if (usesAppServer && !controlClient && lastControlFailure !== controlFailure) {
          lastControlFailure = controlFailure;
          notice('codex_control_unavailable', `Agentrix control unavailable (${controlFailure || 'control/disconnected'})`);
        } else if (controlClient) lastControlFailure = null;
      }
    }
    await openControl();
    if (worker.brokerMethod && !controlClient && controlLeadMode === 'native') throw new Error(controlFailure);
    // Lab's private helper is loaded from memory and has no script for a child MCP server to execute.
    if (fs.existsSync(__filename)) {
      artifacts = require('./role-artifacts.cjs');
      if (!roleArtifacts) localArtifacts = await artifacts.createRoleArtifacts();
      roleFolder = (roleArtifacts ?? localArtifacts).folder;
      roleServer = artifacts.roleResultServer(__filename, id, roleFolder);
    }
    function requestOpened({ itemId, payload: { requestId, kind, blocking, preview, questions } }) {
      const text = detached ? '' : (preview || questions?.[0]?.question || '').slice(0, 160);
      signal('request', { requestId, resolution: { state: 'opened', kind, preview: text } });
      if (!blocking) { requestTimers.set(requestId, null); return; }
      const action = kind === 'command' && preview ? 'command approval: ' + commandPhrase(preview).phrase : kind + ' request';
      recordRefusal({ action, reason: 'approval_required' }, itemId);
      const decline = () => {
        if (!requestTimers.has(requestId)) return;
        signal('request', { requestId, resolution: { state: 'declining', timeout: detached ? null : requestTimeout / 1000 } });
        // Cancelling a command or file approval interrupts its turn. Declining lets it continue.
        try { if (['command', 'file-change'].includes(kind)) activeRuntime?.answer(requestId, { decision: 'deny' }); else activeRuntime?.cancel(requestId); }
        catch (error) { signal('request', { requestId, resolution: { state: 'decline-failed', message: error.message } }); }
      };
      requestTimers.set(requestId, detached ? null : setTimeout(decline, requestTimeout));
      if (detached) queueMicrotask(decline);
    }

    function observePermission(event) {
      if (event.replay) return;
      const { type, payload, itemId } = event;
      if (type === 'worker.refused' && worker.brokerMethod) recordRefusal(payload);
      else if (type === 'worker.awaiting-owner' && nativeBilling === 'subscription') {
        detached?.ownerWaiting?.(diagnosticLine(payload.detail) || null);
      } else if (type === 'worker.menu' && nativeBilling === 'subscription') {
        detached?.ownerWaiting?.(null, payload.menu);
      } else if (usesAppServer && type === 'request.opened') requestOpened(event);
      else if (usesAppServer && type === 'item.upsert' && payload.providerStatus === 'declined') {
        const detail = payload.kind === 'command' ? payload.content?.phrase : payload.content?.tool;
        const action = diagnosticLine(detail ? payload.kind + ': ' + detail : payload.kind);
        recordRefusal({ action, reason: 'provider_declined' }, itemId);
      }
    }
    function acceptNative(event) {
      observePermission(event);
      if (event.providerSessionId) output.sessionId = event.providerSessionId;
      if (event.type === 'turn.started') {
        nativeTurn = event.turnId; nativeRunning = true; output.confirmed = true;
        if (usesAppServer) void rollout.read().then(() => confirm()); else confirm();
        if (resumeControlIds.length) resumeInputId = event.payload.clientMessageId;
      } else if (event.type === 'item.upsert' && event.payload.kind === 'user-message' && !event.replay) {
        const fact = workerInput(event, controlInputs, resumeControlIds, resumeInputId);
        if (fact) recordInput(fact.entryId, fact.inputId, fact.origin, fact.ownerMessageIds);
      } else if (event.type === 'routing.updated') {
        // Provider settings can arrive after the start was confirmed.
        output.nativeRouting(event.payload); reroute();
      }
      else if (event.type === 'input.receipt' && controlReceipts.has(event.payload.clientMessageId)) void recordReceipt(event.payload.clientMessageId, event.payload.status).catch(() => {});
      else if (event.type === 'input.receipt' && event.payload.clientMessageId === resumeInputId) {
        for (const id of resumeControlIds) void recordReceipt(id, event.payload.status).catch(() => {});
      }
      else if (event.type === 'usage.updated' && !event.replay) output.nativeUsage(event.payload, !!(options.resume || resumeSession));
      else if (event.type === 'limits.updated' && !event.replay && usesAppServer) reportAccount(event.payload);
      else if (event.type === 'error' && (event.payload.code === 'billing_identity_mismatch' || event.payload.stage === 'startup'
        && ['sdk_initialization_timeout', 'sdk_startup_failed', 'native_cli_required', 'native_cli_outdated'].includes(event.payload.code))) {
        signal('transport', { path: 'claude-sdk', reason: event.payload.message });
      }
      else if (event.type === 'item.upsert' && event.payload.kind === 'agent-message' && event.payload.status === 'completed') {
        const content = event.payload.content;
        if (typeof content?.text === 'string' && (!content.phase || content.phase === 'final_answer')) output.result = content.text;
      } else if (event.type === 'turn.completed' && event.turnId === nativeTurn) {
        output.failed ||= event.payload.status === 'failed';
        output.capacity ||= ['serverOverloaded', 'policyCapacityUnavailable', 'flexUnavailable'].includes(event.payload.terminalReason);
        nativeRunning = false;
        settleNative?.({ code: event.payload.status === 'completed' ? 0 : 1, killedBy: event.payload.status === 'interrupted' ? 'SIGTERM' : null });
      } else if (event.type === 'session.state' && ['disconnected', 'failed'].includes(event.payload.state)) {
        nativeRunning = false;
        settleNative?.({ code: 1, killedBy: null });
      } else if (event.type === 'path.changed' && event.payload.selected === 'terminal' && !nativeTurn) {
        nativeFallback = event.payload.reason || 'terminal_selected';
      } else if (event.type === 'path.changed' && event.payload.selected === 'terminal-worker' && !nativeTurn) {
        // Main runs this worker in a hidden terminal of the lead's own: billed like that terminal.
        nativeBilling = 'subscription';
        signal('transport', { path: 'claude-terminal', reason: oneLine(event.payload.reason || 'terminal lead') });
      } else if (event.type === 'transcript.record' && nativeBilling === 'subscription') {
        if (meterRecord(event.payload)) output.record(event.payload);
      } else if (event.type === 'request.resolved' && requestTimers.has(event.payload.requestId)) {
        clearTimeout(requestTimers.get(event.payload.requestId)); requestTimers.delete(event.payload.requestId);
        signal('request', { requestId: event.payload.requestId, resolution: { state: 'reported', message: event.payload.resolution } });
      }
      if (event.providerSessionId && output.confirmed && !usesAppServer) confirm();
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
      catch (error) { notice('scope_restore_failed', oneLine(error.message)); }
      await rejectDeferredControls();
      await receiptTail;
      const route = output.routing();
      let reason = 'exit';
      if (unconfirmed) reason = 'unconfirmed';
      else if (stoppedOnRequest()) reason = 'killed';
      else if (spawnError) reason = 'error';
      else if (output.capacity) reason = 'capacity';
      else if (result.killedBy) reason = 'killed';
      else if (output.failed || result.code !== 0) reason = 'error';
      else if (outOfScope?.length) reason = 'scope';
      else if (refused.length) reason = 'permission';
      let answer = '';
      try { answer = fs.readFileSync(options.out, 'utf8'); } catch {}
      let roleResult;
      try {
        roleResult = await artifacts?.settleRoleResult({ folder: roleFolder, runId: id, answer, legacyDecision: hasDecisionHeading });
        if (roleResult?.source === 'finish-role') fs.writeFileSync(options.out, roleResult.answer);
      } catch (error) {
        notice('role_result_unavailable', oneLine(error.code || 'write_error'));
      }
      const legacyDecision = !roleResult && hasDecisionHeading(answer);
      const needsDecision = roleResult ? artifacts.roleNeedsDecision(roleResult) : legacyDecision || null;
      const resultSource = roleResult?.source ?? (legacyDecision ? 'legacy-heading' : 'final-text');
      if (needsDecision) detached?.needsDecision?.();
      const findings = resultSource === 'finish-role' ? roleResult.findings : undefined;
      const header = `${new Date().toISOString().slice(0, 16).replace('T', ' ')} · ${options.title} · ${options.agent} ${route.model} · session ${resumeSession || output.sessionId || 'unreported'}`;
      const bookkeeping = await recordTeam({ answer, findings, header, reason });
      await inputTail.catch(() => {});
      if (!team) { try { recordFindings(options, findings ?? answer, header, id); } catch {} }
      const filesChanged = options.readOnly ? changed : null;
      const scope = scopeReport(checking, changed, outOfScope, options.readOnly, team);
      const exitCode = Number.isInteger(result.code) ? (result.code === 0 && unconfirmed ? 1 : result.code) : result.killedBy ? 128 + (signals[result.killedBy] || 1) : 1;
      const measured = usage(), { outputTokens, activeMs } = measured;
      const rate = outputTokens !== null && activeMs > 0 ? { outputTokens, activeMs } : null;
      const stopFailure = stopFailureFor(reason);
      if (!endSent) send(reportChangedFiles({ type: 'dispatch-end', id, ...route, ...billing(), exitCode, reason, ...measured,
        ...(stopFailure && { treeStopFailure: stopFailure }),
        verdict: routeVerdict(),
        ...(outOfScope && !options.readOnly ? { outOfScopeCount: outOfScope.length } : {}),
        ...(outOfScope?.length ? { outOfScope: outOfScope.slice(0, 50) } : {}), ...(refused.length && { refused }), skillProposals, skillChangesLeftLive, endedAt: Date.now() },
      filesChanged));
      endSent = true;
      ended({ exitCode, reason, rate, scope, bookkeeping, restore: scopeRestoreReport, needsDecision, resultSource,
        routing: worker.brokerMethod && !unconfirmed ? routeVerdict() : null, treeStopFailure: stopFailure });
      await new Promise((resolve, reject) => {
        if (log.closed) return resolve();
        log.once('close', resolve); log.once('error', reject); log.end();
      });
      return exitCode;
    };
    let result;
    for (;;) {
      const effective = resumeSession ? { ...options, resume: resumeSession } : options;
      if (resumeSession) {
        const nextOutput = workerOutput();
        const nextRollout = new CodexRollout(env.CODEX_HOME || path.join(homedir(), '.codex'), nextOutput);
        if (usesAppServer) await nextRollout.prepare(resumeSession);
        await readInbox();
        if (noResume || killed || spawnError) break;
        completedUsage = usage(); output = nextOutput; rollout = nextRollout;
        resumeControlIds = deferredControlIds.splice(0); resumeInputId = null;
        for (const id of resumeControlIds) retriedControls.add(id);
        segmentConfirmed = false; segmentStopped = false; exited = false;
        drained = new Promise(resolve => { drain = resolve; });
        brief = briefOf(options, Buffer.from(messages.splice(0).map(text => `业主插话：${text}`).join('\n\n') + '\n\n继续执行当前任务。'), team,
          { id, repo, before: checking ? before : undefined });
      }
      if (controlClient || usesAppServer) {
        if (killed) throw new Error('Dispatch interrupted before launch');
        const readOnly = options.readOnly || ['审查', '调查'].includes(options.role);
        const spec = { owner: 'dispatch', projectId: bootstrap?.projectId || id, terminalId: bootstrap?.projectId || id, runtimeSessionId: id, runId: id,
          cwd: options.cwd, worktree: options.cwd, model: options.model, effort: options.effort, fast: options.fast,
          readOnly, allow: options.allow, env: workerEnv, roleServer,
          providerSessionId: effective.resume || null };
        const completion = new Promise(resolve => { settleNative = resolve; });
        if (usesAppServer) {
          let sandboxWaitReported = false;
          codexAccountKey = controlClient?.accountKey || null;
          // The runtime launches synchronously, so the file is found before it is built; an injected resolver needs none (a test injecting only `launch` names its `locate`).
          const codex = resolveExecutable === executable ? await locate(env) : null;
          // A bare `codex` would find the shim folder again: no Codex outside it is a start failure.
          const found = async () => { if (resolveExecutable === executable && !codex) throw Object.assign(new Error('Codex was not found outside the Agentrix shim folder'), { code: 'ENOENT' }); return 'codex'; };
          activeRuntime = createCodexRuntime({
            accountKey: codexAccountKey || undefined, resolveExecutable: found, appServerArgs: commandOf(effective, Boolean(labMeter)),
            onTreeStopFailure: error => { if (stoppedOnRequest()) recordTreeStopFailure(error); },
            spawnProcess: (_file, args, spawnOptions) => {
              const command = resolveExecutable('codex', args, env, codex);
              if (!started) workerStartedAt = Date.now();
              return trackWorker(launch(command.file, command.args, spawnOptions));
            },
          }).create({ ...spec, policy: worker.policy(readOnly), onSandboxWait: message => {
            sandboxWaitReported = true;
            signal('waiting', { kind: 'sandbox', message });
            log.write(message + '\n');
          } }, acceptNative);
          if (effective.resume) await rollout.prepare(effective.resume);
          try { if (effective.resume) await activeRuntime.resume(); else await activeRuntime.start(); }
          catch (error) {
            await activeRuntime.close(); activeRuntime = null; controlClient?.close(); controlClient = null;
            if (localWindowsCodex(options.agent, workerEnv)
              && ['sandbox_mismatch', 'elevated_sandbox_not_ready', 'sandbox_cwd_unverified', 'sandbox_refresh_pending', 'unsupported_codex_version']
                .includes(error.code)) throw new Error(error.message);
            const stage = ['resolve_executable', 'spawn', 'initialize', 'capability_probe', 'sandbox_readiness', 'sandbox_cwd', 'thread_start', 'thread_resume']
              .includes(error.stage) ? error.stage : 'startup';
            const category = error.category && /^(?:rpc_-\d+|request_failed|unexpected_success)$/.test(error.category) ? error.category
              : Number.isInteger(error.code) ? `rpc_${error.code}`
              : ['ENOENT', 'EACCES', 'EPERM', 'EINVAL', 'codex_cli_required', 'rpc_timeout', 'process_failed', 'process_exited', 'disconnected',
                'frame_limit', 'write_failed', 'invalid_response', 'invalid_json', 'invalid_frame', 'invalid_payload', 'truncated_frame', 'sandbox_mismatch', 'invalid_thread', 'thread_in_use', 'unsupported_codex_capabilities', 'unsupported_codex_version'].includes(error.code || error.message) ? error.code || error.message : 'runtime_failed';
            throw new Error(`Codex app-server startup failed (${stage}/${category})${category === 'sandbox_mismatch' ? error.requestedSandbox === 'read-only'
              ? '：Codex 未应用只读沙箱，已停止启动。请检查 Codex 沙箱配置后重试。'
              : '：请在 Codex 用户配置的 [windows] 中设置 sandbox = "unelevated"，然后重试。' : ''}`);
          }
          if (sandboxWaitReported) void detached?.sandboxReady?.();
          child = { pid: activeRuntime.pid, exitCode: null };
          // The read publishes limits.updated, which reports; an account without plan windows (an API key) reports without them.
          void activeRuntime.readLimits().catch(() => reportAccount(null));
          pollTimer = setInterval(() => { void rollout.read(); }, POLL_INTERVAL);
          const receipt = await activeRuntime.send({ clientMessageId: randomUUID(), text: brief.toString('utf8'), images: options.images });
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
          if (!started) workerStartedAt = Date.now();
          const remote = controlClient.request(worker.brokerMethod, { prompt: brief.toString('utf8'), model: options.model, effort: options.effort,
            fast: options.fast, resume: effective.resume || null, out: options.out, permission: options.permission,
            ...(roleFolder && { roleResultFolder: roleFolder }) }).then(value => {
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
            activeRuntime = null; nativeBilling = null; controlClient?.close(); controlClient = null;
            transportFallback = true;
            signal('transport', { path: 'claude-cli', reason: oneLine(nativeFallback) }); continue;
          }
          if (!result) result = await completion;
          activeRuntime.finished = remote;
        }
        for (;;) {
          await readInbox(true); await inboxRead;
          if (!nativeRunning) {
            if (worker.brokerMethod && !segmentStopped && !killed && result.code === 0) {
              const receipt = await controlClient.request('control.finish', {}).catch(() => ({ status: 'unknown' }));
              if (receipt?.status === 'queued') { result = await new Promise(resolve => { settleNative = resolve; }); continue; }
            }
            break;
          }
          result = await new Promise(resolve => { settleNative = resolve; });
        }
        if (usesAppServer) { await rollout.pending; await rollout.read(); }
        confirm(true);
        if (typeof output.result === 'string') fs.writeFileSync(options.out, output.result);
        const remoteResult = await activeRuntime.finished;
        if (remoteResult?.code) result = remoteResult;
        if ((result.code === 0 || segmentStopped) && !killed && !noResume) queueUnreadControls();
        await activeRuntime.close(); activeRuntime = null; child.exitCode = result.code; clearInterval(pollTimer);
        if (!started) failed('worker ended without execution evidence', 1);
        if (messages.length && (result.code === 0 || segmentStopped) && !killed && !noResume && !spawnError && output.sessionId) {
          const { changed, outOfScope } = inspectScope();
          if (checking && (changed === null || outOfScope.length)) break;
          resumeSession = output.sessionId; controlClient?.close(); controlClient = null;
          // The rejected correction is known not to have executed; resume only that input, on the same billing path.
          await new Promise(resolve => setTimeout(resolve, 20)); await openControl();
          if (!controlClient && !usesAppServer) throw new Error('native_resume_control_unavailable');
          signal('resume', { state: 'resuming', message: 'native worker ended before correction' });
          continue;
        }
        break;
      }
      if (!resumeSession && !transportFallback) signal('transport', { path: 'claude-cli', reason: `Agentrix control unavailable (${controlFailure || 'control/disconnected'})` });
      const claudeFile = resolveExecutable === executable ? await findClaude(env) : null;
      if (resolveExecutable === executable && !claudeFile) throw Object.assign(new Error('Claude Code was not found outside the Agentrix shim folder'), { code: 'ENOENT' });
      if (roleServer && !roleConfig) {
        roleConfig = path.join(roleFolder, 'role-mcp.json');
        await fs.promises.writeFile(roleConfig, JSON.stringify(worker.resultServer(roleServer)), { flag: 'wx', mode: 0o600 });
      }
      const command = resolveExecutable(options.agent, commandOf({ ...effective, roleConfig }), env, claudeFile);

      if (killed) throw new Error('Dispatch interrupted before launch');
      if (!started) workerStartedAt = Date.now();
      workerEnv = worker.cliEnvironment(workerEnv);
      child = trackWorker(launch(command.file, command.args, { cwd: options.cwd, env: workerEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
        detached: process.platform !== 'win32' }));
      if (killed) stop('SIGTERM');
      if (!resumeSession) log.on('error', error => { spawnError = error; stop('SIGTERM', false); });
      startTimer = setTimeout(() => {
        if (started) spawnError = new Error('Resumed session not reported within 30 s');
        else failed('session not reported within 30 s', null, 'timeout');
        stop('SIGTERM', false);
      }, startTimeout);
      const segmentOutput = output, segmentDrain = drained;
      child.once('exit', code => {
        exited = true; clearTimeout(startTimer); clearInterval(pollTimer);
        if (segmentConfirmed) return;
        // Its last output can still be in the pipes: once that is read (at most EXIT_SETTLE), decide from its records,
        // without waiting for pipes a leftover child process may hold open.
        void Promise.race([segmentDrain, new Promise(resolve => setTimeout(resolve, EXIT_SETTLE))]).then(async () => {
          if (output !== segmentOutput || segmentConfirmed || unconfirmed) return;
          if (output !== segmentOutput) return;
          confirm(true);
          if (!started) failed(output.capacity ? 'at capacity' : 'worker exited without a confirmed session', code === 0 ? 1 : code);
        });
      });
      const flushOutput = readWorkerOutput(child, log, output);
      child.stdin.on('error', error => { if (error.code !== 'EPIPE') spawnError = error; });
      child.stdin.end(brief);
      child.once('error', error => { spawnError = error; });
      result = await waitForWorkerClose(child);
      flushOutput();
      clearInterval(pollTimer);
      confirm(true); drain();
      clearTimeout(startTimer); await treeStop;
      if (!started) failed(spawnError?.message || (output.capacity ? 'at capacity' : 'worker exited without a confirmed session'),
        result.code === 0 ? 1 : result.code, spawnError ? 'spawn' : 'unconfirmed');
      if (resumeSession && !segmentConfirmed) { spawnError ||= new Error('Resumed worker exited without a confirmed session'); result.code = result.code || 1; }
      if (resumeSession && spawnError) signal('resume', { state: 'failed', message: oneLine(spawnError.message) });
      if (output.result !== null && output.result !== undefined) fs.writeFileSync(options.out, output.result);
      // A confirmed successful CLI continuation has processed its stdin brief;
      // launch confirmation alone is only delivery, never consumption.
      if (result.code === 0 && segmentConfirmed && (output.completed || typeof output.result === 'string' && output.result.trim())) {
        for (const id of resumeControlIds) await recordReceipt(id, 'consumed');
      }
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
      notice('runtime_failed', oneLine(error.message));
      try { stop('SIGTERM', false); await treeStop; await activeRuntime?.finished; } catch {}
      if (!started) failed(error.message, 1, 'runtime');
      try { return await finalize({ code: 1, killedBy: killed || segmentStopped ? 'SIGTERM' : null }); }
      catch (failure) { notice('finalization_failed', oneLine(failure.message)); }
    }
    try { restoreSkills(); } catch (recovery) { notice('skill_recovery_failed', oneLine(recovery.message)); }
    failed(error.message, 1, options ? 'runtime' : 'admission');
    if (child?.pid) stop('SIGTERM', false);
    if (options) {
      const reason = unconfirmed ? 'unconfirmed' : stoppedOnRequest() ? 'killed' : 'error';
      const stopFailure = stopFailureFor(reason);
      const bookkeeping = await recordTeam({ answer: '', header: '', reason });
      if (!endSent) send({ type: 'dispatch-end', id, ...output.routing(), exitCode: 1, reason, ...usage(),
        ...(stopFailure && { treeStopFailure: stopFailure }),
        verdict: routeVerdict(), ...(refused.length && { refused }), skillProposals, skillChangesLeftLive, endedAt: Date.now() });
      endSent = true;
      ended({ exitCode: 1, reason, bookkeeping, treeStopFailure: stopFailure });
    }
    log?.destroy();
    return 1;
  } finally {
    ending = true;
    boardWatch?.close();
    clearTimeout(startTimer);
    clearInterval(pollTimer); clearInterval(rateTimer); clearInterval(inboxTimer);
    for (const timer of requestTimers.values()) clearTimeout(timer);
    await inboxRead; await treeStop;
    await rejectDeferredControls().catch(() => notice('deferred_control_unavailable'));
    await receiptTail; clearTimeout(forceTimer);
    await rollout?.pending;
    try { await activeRuntime?.close(); }
    finally {
      const exitUnconfirmed = (workerProcess?.pid && workerProcess.exitCode == null && workerProcess.signalCode == null && !exited)
        || (!workerProcess && treeStopError);
      if (exitUnconfirmed) detached?.deferArtifactSettlement?.();
      else if (localArtifacts) await fs.promises.rm(localArtifacts.folder, { recursive: true, force: true }).catch(() => {});
      controlClient?.close();
    }
    team?.release(id);
    process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onTerminate); process.removeListener('SIGHUP', onHangup);
  }
}

module.exports = { argumentsOf, commandOf, briefOf, recordFindings, WorkerOutput, CodexRollout, workerInput, runtimeFiles, dispatchCompanions,
  dispatchEvent, detachedEnd, renderDispatchLine, renderDispatchStart,
  run, startDetached, runDetached, waitDetached, detachedRuns, locateCodex, locateClaude, executable, validateSmallScope, RATE_INTERVAL,
  localWindowsCodex, roleReadiness, sshRoleReadiness, elevatedSetupMessage, answerDetachedRole };
if (require.main === module) {
  run(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
    console.error('[dispatch] ' + oneLine(error.message));
    process.exitCode = 1;
  });
}
