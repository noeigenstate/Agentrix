const { imageMetadata } = require('../../oversized-record.cjs');
const { claudeLeadSeat } = require('../agents/call-seat.cjs');
const { routingVerdict: strictRoutingVerdict } = require('../dashboard/records-routing.cjs');
const manifests = require('./manifests/worker.cjs');

const word = value => typeof value === 'string' && value.trim() ? value.trim() : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const atCapacity = /\bat capacity\b|overloaded|capacity exceeded/i;
const failedResult = record => /^error_/.test(record.subtype || '');

// What Claude Code printed for one of its own commands: "Set model to `Opus 5.5` …", "Set effort level to max (…)",
// and fast mode turned on or off.
function claudeStdout(record) {
  const content = record.message?.content;
  const words = typeof content === 'string' ? content : Array.isArray(content) ? content.map(block => typeof block?.text === 'string' ? block.text : '').join('\n') : '';
  return /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(words)?.[1].replace(/\x1b\[[0-9;]*m/g, '');
}

const fastEcho = /^[ \t]*(?:↯\s*|Kept\s+)?Fast mode\s+(?:is (?:now )?)?(on|enabled|off|disabled)\b/i;
const fastEnabled = /^(?:on|enabled)$/i;

function claudeFastModeEcho(record) {
  if (record?.type !== 'user' || record.isSidechain || record.isMeta || record.isCompactSummary) return null;
  const output = claudeStdout(record);
  if (!output) return null;
  const reason = /^[ \t]*(?:↯\s*)?Fast mode unavailable:\s*(.+)/i.exec(output)?.[1].trim();
  if (!reason && !fastEnabled.test(fastEcho.exec(output)?.[1] ?? '')) return null;
  const at = Date.parse(record.timestamp);
  return Number.isFinite(at) ? { at, reason: reason || null } : null;
}

function claudeCommandOutput(record) {
  const output = claudeStdout(record);
  if (!output) return null;
  const model = /^\s*Set model to\s+`?([^`\n(]+?)`?(?:\s+\(|\s+and\b|\s+for this session only\b|\s*$)/im.exec(output)?.[1];
  const effort = /^\s*Set effort level to\s+([a-z]+)\b/im.exec(output)?.[1];
  const fast = fastEcho.exec(output)?.[1];
  const fastModel = fast && /\bmodel set to\s+`?([^`·\n]+?)`?(?:\s*·|\s*$)/i.exec(output)?.[1];
  const standaloneUltra = /^\s*Ultracode (?:on|off) \(|^\s*Ultracode off\. Effort stays \w+\./i;
  const ultracode = (effort || standaloneUltra.test(output)) && /\bUltracode\s+(on|off)\b/i.exec(output)?.[1];
  if (!model && !effort && !fast && !ultracode) return null;
  return { model: word(model || fastModel), effort: word(effort)?.toLowerCase() ?? null,
    fast: fast ? fastEnabled.test(fast) : null, ultracode: ultracode ? ultracode.toLowerCase() === 'on' : null };
}

function claudeSettings(record) {
  // A subagent's replies carry its own model, not the session's.
  if (record.isSidechain) return null;
  if (record.type === 'assistant') {
    const model = word(record.message?.model), speed = record.message?.usage?.speed;
    return { model: model && model !== '<synthetic>' ? model : null, effort: word(record.perTurnEffort) ?? word(record.effort),
      fast: speed === 'fast' ? true : speed === 'standard' ? false : null };
  }
  if (record.type === 'user') return claudeCommandOutput(record);
  if (record.type === 'attachment') {
    const kind = record.attachment?.type;
    if (kind === 'ultra_effort_enter' || kind === 'ultra_effort_exit') return { ultracode: kind === 'ultra_effort_enter' };
  }
  return null;
}

function codexSettings(record) {
  const payload = record.payload || {};
  if (record.type === 'turn_context') return { model: word(payload.model), effort: word(payload.effort) ?? word(payload.collaboration_mode?.settings?.reasoning_effort) };
  if (record.type === 'event_msg' && payload.type === 'thread_settings_applied') {
    const settings = payload.thread_settings || {}, tier = settings.service_tier;
    return { model: word(settings.model), effort: word(settings.reasoning_effort),
      fast: tier === undefined ? null : tier === 'priority' || tier === 'fast' };
  }
  return null;
}

const READ_ONLY_MODE = 'dontAsk';
const READ_TOOLS = ['Read', 'Glob', 'Grep', 'LS'];
const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
const WORKER_DENIED = ['EnterPlanMode'];
const READ_ONLY_DENIED = [...EDIT_TOOLS, ...WORKER_DENIED, 'ExitPlanMode', 'AskUserQuestion', 'mcp__*'];
const FORBIDDEN_GIT_OPERATIONS = ['commit', 'push', 'reset --hard'];
const forbiddenGit = new RegExp('\\bgit\\b[^\\n;&|]*(?:' + FORBIDDEN_GIT_OPERATIONS
  .map(operation => '\\b' + operation.replace(' ', '\\b[^\\n;&|]*') + '\\b').join('|') + ')', 'i');

const isReadOnly = options => options.readOnly || ['plan', READ_ONLY_MODE].includes(options.permission);

function workerToolArgs(readOnly, platform = process.platform) {
  const shells = platform === 'win32' ? ['Bash', 'PowerShell'] : ['Bash'];
  const gitRules = shells.flatMap(shell => FORBIDDEN_GIT_OPERATIONS.map(operation => {
    const command = operation.includes(' ') ? operation.replace(' ', ' *') + '*' : operation + ' *';
    return shell + '(git ' + command + ')';
  }));
  const tools = readOnly ? ['--tools', [...READ_TOOLS, ...shells].join(',')] : [];
  const denied = readOnly ? READ_ONLY_DENIED : WORKER_DENIED;
  return [...tools, '--allowedTools', shells.join(','), '--disallowedTools', [...denied, ...gitRules].join(',')];
}

function workerToolEnvironment(env, platform = process.platform) {
  const key = 'CLAUDE_CODE_USE_POWERSHELL_TOOL';
  if (platform !== 'win32' || Object.keys(env).some(name => name.toUpperCase() === key)) return env;
  return { ...env, [key]: '1' };
}

const claudePermission = readOnly => readOnly ? READ_ONLY_MODE : 'acceptEdits';
const claudePolicy = (readOnly, platform) => ({ args: workerToolArgs(readOnly, platform), mode: claudePermission(readOnly) });

function claudeCommand(options) {
  const settings = options.fast || options.fastFromSeat ? ['--settings', JSON.stringify({ fastMode: options.fast })] : [];
  const { args, mode } = claudePolicy(isReadOnly(options));
  return ['-p', ...(options.resume ? ['--resume', options.resume] : []), '--model', options.model,
    '--effort', options.effort, ...settings, '--permission-mode', mode, ...args, '--output-format', 'stream-json', '--verbose'];
}

function claudeOptions(options) {
  if (options.readOnly || options.images.length) throw new Error('Claude supports --permission, not Codex options');
  if (!['plan', READ_ONLY_MODE, 'acceptEdits'].includes(options.permission)) throw new Error('Expected --permission dontAsk or acceptEdits');
  if (options.permission === 'plan') options.permission = READ_ONLY_MODE;
  if (options.permission === READ_ONLY_MODE) options.readOnly = true;
}

const stdoutUsage = (inputTokens, cached, output) => ({ inputTokens, cachedTokens: count(cached), outputTokens: count(output) });
function codexUsage(input, cached, output) {
  return stdoutUsage(count(input) !== null && count(cached) !== null && input >= cached ? input - cached : null, cached, output);
}
function claudeUsage({ input, cachedInput, cacheWrite, output, costUsdMicros }) {
  const micros = count(costUsdMicros);
  return { usage: stdoutUsage(count(input) !== null && count(cacheWrite) !== null ? count(input + cacheWrite) : null, cachedInput, output),
    cost: micros === null ? null : micros / 1e6 };
}

function claudeRecord(record) {
  if (record.parent_tool_use_id || record.isSidechain) return null;
  const { type, session_id: sessionId } = record;
  if (type === 'system' && record.subtype === 'init') return { sessionId: word(sessionId), confirmed: true, settings: [record] };
  if (type === 'assistant') return { settings: [record, record.message || {}], measure: record };
  if (type === 'user') {
    const content = record.message?.content;
    const inputId = typeof record.uuid === 'string' && (typeof content === 'string' || content?.some(part => part.type === 'text')) ? record.uuid : null;
    return { inputId, measure: record };
  }
  if (type !== 'result') return {};
  const models = Object.keys(record.modelUsage || {}), settings = models.length === 1 ? [record, { model: models[0] }] : [record];
  const { input_tokens: rawInput, cache_creation_input_tokens: rawCreation, cache_read_input_tokens: cached, output_tokens: output } = record.usage || {};
  const input = count(rawInput), creation = count(rawCreation), cost = record.total_cost_usd, session = word(sessionId);
  return { ...(session && { sessionId: session }), confirmSession: true, settings,
    result: typeof record.result === 'string' ? record.result : null,
    stdoutUsage: stdoutUsage(input !== null && creation !== null ? input + creation : null, cached, output),
    reportedCostUsd: Number.isFinite(cost) && cost >= 0 ? cost : null,
    resetFailure: !record.is_error && !failedResult(record),
    // Final API totals can time the response without counting the whole process.
    ...(count(output) !== null && { outputTokens: output, activeMs: Number.isFinite(record.duration_api_ms) && record.duration_api_ms > 0 ? record.duration_api_ms : null }) };
}

function codexRecord(record) {
  if (record.type === 'thread.started') return { sessionId: word(record.thread_id) };
  if (record.type !== 'turn.completed') return {};
  const usage = record.usage || {};
  return { resetFailure: true, completed: true, stdoutUsage: codexUsage(usage.input_tokens, usage.cached_input_tokens, usage.output_tokens) };
}

function workerOutput(normalizeRecord) {
  function* records(record) {
    if (Array.isArray(record)) { for (const entry of record) yield* records(entry); return; }
    if (!record || typeof record !== 'object') return;
    const event = normalizeRecord(record);
    if (!event) return;
    if (['error', 'turn.failed'].includes(record.type) || record.is_error === true || record.type === 'result' && failedResult(record)) {
      event.failure = { capacity: atCapacity.test(JSON.stringify(record)) };
    }
    yield event;
  }
  function* output(line) {
    const clean = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
    let value;
    try { value = JSON.parse(clean, imageMetadata); } catch {
      const capacity = atCapacity.test(clean);
      const header = /^(model|reasoning effort|service tier|speed|session id):\s*(.+)$/i.exec(clean);
      if (!header) { if (capacity) yield { capacity, silent: true }; return; }
      const [, key, text] = header, name = key.toLowerCase();
      yield { ...(capacity && { capacity }), ...(name === 'session id' ? { sessionId: word(text) }
        : { settings: [{ [name.replace('reasoning effort', 'effort').replace('service tier', 'service_tier')]: text }] }) };
      return;
    }
    yield* records(value);
  }
  return { output, records };
}

function claudeRoutingVerdict(actual, declared, fallback = false) {
  // Bundled alias floor (major, minor): bump this one line with a supported release.
  const CLAUDE_ALIAS_FLOOR = [5, 5];
  const target = fallback ? declared?.model?.replace(/\[(?:1m|fast)\]$/gi, '') : declared?.model;
  const current = /^(opus|sonnet|haiku)$/.test(target) && CLAUDE_ALIAS_FLOOR;
  const model = actual.model?.replace(/(?:\[(?:1m|fast)\]|-\d{8})+$/gi, '');
  const resolved = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:[.-](\d+))?(?:[.-]\d+)*$/.exec(model || '');
  const follows = current && resolved?.[1] === target && (Number(resolved[2]) > current[0]
    || Number(resolved[2]) === current[0] && Number(resolved[3] || 0) >= current[1]);
  const sameFallback = fallback && (target === model || target === 'fable' && resolved?.[1] === 'fable');
  return strictRoutingVerdict(actual, follows || sameFallback ? { ...declared, model: actual.model } : declared);
}

function claudeSandboxFallback({ lead, seat, reason }) {
  if (!lead) return { instruction: reason + ' 请在模型路由中为 Claude 总指挥选择 Claude 模型后重试。' };
  return { roleFallback: { configured: seat.model, model: lead.model,
    effort: ['low', 'medium', 'high'].includes(seat.effort) ? seat.effort : lead.effort, fast: false }, reason };
}

function codexSandboxFallback({ ssh, reason, env, elevatedSetupMessage }) {
  if (ssh) return { instruction: reason + ' 请用 Codex 内置的子代理完成这个席位的工作。' };
  const instruction = '这台电脑尚未完成 Codex 角色沙箱设置。请用 Codex 内置的子代理完成这个席位的工作。';
  return { instruction: instruction + ' ' + elevatedSetupMessage(env) };
}

function workerRules(rules) {
  return options => {
    const { allow = [], files = [], inline, small } = options;
    const readOnly = isReadOnly(options);
    const scope = readOnly ? rules.readOnlyScope : allow.length ? 'Change only the paths under "Files you may change"; stay inside the task.'
      : 'Change only what the task needs.';
    const standard = files.length ? `read ${files.map(file => `\`${file}\``).join(' and ')} and follow them`
      : 'follow the code-standard skill this session was given and the project\'s conventions';
    return ['# Standing rules\n\nAgentrix gives these to every worker. They hold unless the task below states an exception.\n',
      inline ? 'Follow the Code standards below in any code you write or review.' : `Code standard: ${standard} in any code you write or review.`,
      `Scope: ${scope}`,
      rules.git,
      'Run no GUI smoke test and never read or write the system clipboard.',
      ...(rules.commands ? [rules.commands] : []),
      'Run only the tests the task touches, never the whole suite.',
      'Skip a named skill only if it is neither installed nor present under the repository\'s skills/ folder. Do not search elsewhere.',
      'Never ask the user. Finish independent work. Report exact refusals under ## Needs approval. Do not work around them.',
      ...(small ? ['Decide implementation (one line with why), take the smaller viable approach (note the other), '
        + 'and defer scope changes, irreversible actions, or changes to UI or behavior to the lead under ## Needs decision (options, effects, recommendation).'] : [
        'Decide implementation details and explain your choice in one line. Take the smaller viable approach and note the other.',
        'Stop before scope changes, irreversible actions, or changes to UI or behavior. Under ## Needs decision give the lead options, consequences and a recommendation.',
      ]),
      ...(rules.answer ? [rules.answer] : []),
      `Report ${readOnly ? 'what you found, with the evidence (file:line)' : 'what you changed'}, what you ran with its result, and what stays unverified.`,
      'Write your messages and report in the language the task is written in; code, identifiers and comments follow the project\'s convention.',
    ].map((line, index) => index ? `- ${line}` : line).join('\n') + (inline ? `\n\n# Code standards\n\n${inline}` : '');
  };
}

const localWindows = (env, platform = process.platform) => platform === 'win32' && !env.SSH_CONNECTION;
const claudeWorker = Object.freeze({
  command: claudeCommand, policy: claudePolicy, validate: claudeOptions, ...workerOutput(claudeRecord),
  roleArgs: readOnly => ['--permission', claudePermission(readOnly)],
  nativeUsage: claudeUsage, multilineOutput: true, pinEffort: true, cliEnvironment: workerToolEnvironment,
  brokerMethod: 'claude-sdk.run', terminalAnswers: true, routingVerdict: claudeRoutingVerdict,
  acceptsRateRecord: (meter, record) => (!record.isSidechain || meter.sidechain) && !!(record.uuid || record.message || meter.pending.size),
  applyRateRecord: (meter, record) => meter.claude(record),
  parseSettings: claudeSettings,
  sandboxFallback: claudeSandboxFallback, leadSeat: claudeLeadSeat,
  rules: workerRules({
    readOnlyScope: 'This task is read-only: do not change, create, or delete project files.',
    git: 'Do not commit, push, or run git reset --hard. Do not start another worker or agent.',
    commands: 'You may run commands and tests. Decide whether to run tests and which to run based on the task.',
    answer: 'End with a plain text answer. Never call ExitPlanMode.',
  }),
});
const codexWorker = Object.freeze({
  command: () => 'native', policy: readOnly => ({ sandbox: readOnly ? 'read-only' : 'workspace-write', approvalPolicy: 'never' }),
  validate: options => { if (options.permission) throw new Error('--permission is only for Claude'); },
  ...workerOutput(codexRecord), roleArgs: readOnly => readOnly ? ['--read-only'] : [],
  nativeUsage: value => ({ usage: codexUsage(value.input, value.cachedInput, value.output), cost: null }),
  routingVerdict: strictRoutingVerdict, localWindows, sandboxFallback: codexSandboxFallback,
  applyRateRecord: (meter, record) => meter.codex(record),
  parseSettings: codexSettings,
  needsSandbox: ({ ssh, env, platform }) => ssh || localWindows(env, platform),
  rules: workerRules({ readOnlyScope: 'This task is read-only: change, create and delete no file.',
    git: 'Do not commit or push, and do not start another worker or agent.' }),
});

const workers = new Map([['claude', claudeWorker], ['codex', codexWorker]]);
const workerOf = id => workers.get(id);
const brokerMethods = new Set([...workers.values()].map(worker => worker.brokerMethod).filter(Boolean));
const agentOfModel = model => manifests.find(({ models }) => models.match.test(model)).id;

module.exports = { workerOf, brokerMethods, claudeSettings, codexSettings, claudeFastModeEcho, agentOfModel, defaultWorkerRules: codexWorker.rules, isReadOnly, word, count,
  READ_ONLY_MODE, READ_TOOLS, EDIT_TOOLS, READ_ONLY_DENIED, WORKER_DENIED, workerToolArgs, workerToolEnvironment, forbiddenGit };
