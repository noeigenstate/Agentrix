// The one path decision (C-11, I1): the facts the resolver holds and the run-mode setting give the path a Claude or
// Codex session takes, and why. Pure: no clock, files or credentials, so every caller (a new session, a running one,
// the connection test, the usage panel, the dispatcher's worker) gets the same answer for the same facts.
const { reason } = require('../../shared/reason.cjs');

// Which fact explains a refusal first: a key that is missing or refused, then the CLI, then billing, then the limits.
const RANK = { key: 0, cli: 1, billing: 2, limit: 3, rate: 4 };
const PROVIDER_LIMITS = new Set(['credits_exhausted', 'account_limit', 'rate_limited']);
// What the windows were told for these codes before reasons were codes; every other code is told by its name.
const SAID = {
  key_forbidden: 'API 密钥没有调用权限。', api_unreachable: '无法连接 Anthropic API。', key_check_failed: '无法完成 API 连接检查。',
  cli_too_old: 'Claude Code 版本过低，请升级到 2.1.317 或更高',
};
// The sentence a refused start says for a CLI that cannot run, as the session's own start said it before; the path's
// reason keeps the bare names.
const REFUSED = { cli_too_old: SAID.cli_too_old, native_cli_unverified: 'Claude Code 检查没有通过，无法通过 API 运行',
  native_cli_required: '未找到原生 Claude Code，无法通过 API 运行' };
const TERMINAL_SELECTED = reason('claude.terminal_selected', { source: 'settings', observedAt: 0 });

const nameOf = value => value?.code?.replace(/^claude\./, '') ?? null;
// A worker keeps the API through the owner's credits refusal, and a session that claimed a limit's trial through that limit.
const excused = (value, { owner = 'gui', trial = null } = {}) =>
  owner === 'dispatch' && nameOf(value.reason) === 'credits_exhausted' || !!trial && value.trial === trial;
// The facts that keep this session off the API, the first explaining it first.
const blockers = (facts, options) => facts.filter(value => value?.reason && !excused(value, options))
  .sort((a, b) => (RANK[a.name] ?? RANK.limit) - (RANK[b.name] ?? RANK.limit));
const said = value => value.message ?? SAID[nameOf(value.reason)] ?? nameOf(value.reason);

// facts: the resolver's facts for this session's scope and card. options: `owner`, the `trial` this session claimed,
// `retained` (a failed switch keeps the session on the API as if API-only) and `running` (a session already on its way:
// its CLI is not in question, and under API-only a provider limit keeps it on the API to say so instead of refusing
// it). The answer: `path` ('api', 'terminal', 'native' or null for none), the `reason` (a Reason, null on the API),
// `wire` (what the windows are told today: the fact's sentence, else the code's name), `message` (the sentence a refusal
// is told in: the fact's own, else its CLI code's) and every `blockers` Reason.
function decide(facts = [], settings = {}, { agent = 'claude', owner = 'gui', trial = null, retained = false, running = false } = {}) {
  const held = blockers(running ? facts.filter(value => value.name !== 'cli') : facts, { owner, trial });
  const answer = (path, first, wire = first && said(first)) => ({ path, reason: first?.reason ?? null, wire: wire ?? null,
    message: first?.message ?? REFUSED[nameOf(first?.reason)] ?? null, blockers: held.map(value => value.reason) });
  if (agent === 'codex') {
    const cli = held.find(value => value.name === 'cli');
    return cli ? answer(null, cli) : answer('native', null);
  }
  const mode = retained ? 'api-only' : settings.claudePath || 'api-then-terminal';
  if (mode === 'terminal-only') return { ...answer('terminal', null), reason: TERMINAL_SELECTED, wire: nameOf(TERMINAL_SELECTED) };
  const [first] = held;
  if (!first) return answer('api', null);
  if (mode === 'api-only' && running && PROVIDER_LIMITS.has(nameOf(first.reason))) return answer('api', first, nameOf(first.reason));
  return answer(mode === 'api-only' ? null : 'terminal', first);
}

// Read-only worker policy for the terminal, print-mode CLI and SDK.
const READ_ONLY_MODE = 'dontAsk';
const READ_TOOLS = ['Read', 'Glob', 'Grep', 'LS'];
const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
const READ_ONLY_DENIED = [...EDIT_TOOLS, 'Bash', 'PowerShell', 'EnterPlanMode', 'ExitPlanMode', 'AskUserQuestion', 'mcp__*'];
const readOnlyArgs = () => ['--tools', READ_TOOLS.join(','), '--disallowedTools', READ_ONLY_DENIED.join(',')];

module.exports = { decide, nameOf, READ_ONLY_MODE, READ_TOOLS, EDIT_TOOLS, READ_ONLY_DENIED, readOnlyArgs };
