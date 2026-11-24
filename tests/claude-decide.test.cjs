// R2: decide() is the one path decision (I1). Pure, table-driven: each fact set, setting and session option gives one path
// and a coded reason, and no other module decides.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { decide, workerToolArgs, workerToolEnvironment } = require('../electron/features/claude-runtime/decide.cjs');
const { fact } = require('../electron/features/claude-runtime/facts.cjs');
const { codesOf } = require('../electron/shared/reason.cjs');

const root = path.join(__dirname, '..');
const of = (name, code, fields) => fact(name, code, { source: 'test', observedAt: 1, ...fields });
test('CLI roles at both access levels allow shells and deny three Git operations on each shell', () => {
  const denied = 'Edit,Write,MultiEdit,NotebookEdit,EnterPlanMode,ExitPlanMode,AskUserQuestion,mcp__*';
  const bash = 'Bash(git commit *),Bash(git push *),Bash(git reset *--hard*)';
  const powershell = 'PowerShell(git commit *),PowerShell(git push *),PowerShell(git reset *--hard*)';
  assert.deepEqual(workerToolArgs(true, 'win32'), ['--tools', 'Read,Glob,Grep,LS,Bash,PowerShell',
    '--allowedTools', 'Bash,PowerShell', '--disallowedTools', [denied, bash, powershell].join(',')]);
  assert.deepEqual(workerToolArgs(true, 'linux'), ['--tools', 'Read,Glob,Grep,LS,Bash',
    '--allowedTools', 'Bash', '--disallowedTools', [denied, bash].join(',')]);
  assert.deepEqual(workerToolArgs(false, 'win32'), ['--allowedTools', 'Bash,PowerShell',
    '--disallowedTools', ['EnterPlanMode', bash, powershell].join(',')]);
  assert.deepEqual(workerToolArgs(false, 'linux'), ['--allowedTools', 'Bash', '--disallowedTools', ['EnterPlanMode', bash].join(',')]);
});

test('PowerShell defaults on for Windows CLI workers when the environment has no preference', () => {
  const env = {}, optedOut = { claude_code_use_powershell_tool: '0' };
  assert.deepEqual(workerToolEnvironment(env, 'win32'), { CLAUDE_CODE_USE_POWERSHELL_TOOL: '1' });
  assert.deepEqual(env, {});
  assert.equal(workerToolEnvironment(optedOut, 'win32'), optedOut);
  assert.equal(workerToolEnvironment(env, 'linux'), env);
});

// Each fact decide() reads, in the order it explains a refusal.
const FACTS = {
  no_key: of('key', 'no_key'), invalid_key: of('key', 'invalid_key'),
  cli: of('cli', 'native_cli_required'), cli_old: of('cli', 'cli_too_old'),
  billing: of('billing', 'billing_identity_mismatch', { message: 'Claude Code 用的是 /login 登录的密钥。' }),
  credits: of('limit', 'credits_exhausted', { trial: 'trial-1', message: '控制台余额不足。' }), account: of('limit', 'account_limit'),
  rate: of('rate', 'rate_limited'),
};
const ORDER = ['no_key', 'invalid_key', 'cli', 'cli_old', 'billing', 'credits', 'account', 'rate'];
const MODES = ['api-then-terminal', 'api-only', 'terminal-only'];
// Every fact set of one or two facts the resolver can hold together (one per name), and none; each pair is given last first.
const SETS = [[], ...ORDER.map(name => [name]), ...ORDER.flatMap((a, i) => ORDER.slice(i + 1).filter(b => FACTS[a].name !== FACTS[b].name).map(b => [b, a]))];

test('every settings × fact set × owner × trial × retained combination gives one path and a coded reason', () => {
  for (const names of SETS) for (const claudePath of MODES) for (const owner of ['gui', 'dispatch']) for (const trial of [null, 'trial-1'])
    for (const retained of [false, true]) for (const running of [false, true]) {
      const label = JSON.stringify({ names, claudePath, owner, trial, retained, running });
      const facts = names.map(name => FACTS[name]), before = JSON.stringify(facts);
      const decision = decide(facts, { claudePath }, { owner, trial, retained, running });
      assert.deepEqual(decide(facts, { claudePath }, { owner, trial, retained, running }), decision, `${label}: the same answer twice`);
      assert.equal(JSON.stringify(facts), before, `${label}: the facts are not changed`);
      // What should keep the session off the API: every fact but those it is excused from, and the CLI for a running one.
      const excused = name => owner === 'dispatch' && name === 'credits' || trial === 'trial-1' && name === 'credits' || running && name.startsWith('cli');
      const first = ORDER.find(name => names.includes(name) && !excused(name));
      const mode = retained ? 'api-only' : claudePath;
      if (mode === 'terminal-only') {
        assert.deepEqual([decision.path, decision.reason.code], ['terminal', 'claude.terminal_selected'], label); continue;
      }
      if (!first) { assert.deepEqual([decision.path, decision.reason], ['api', null], label); continue; }
      const limit = ['credits', 'account', 'rate'].includes(first);
      const expected = mode === 'api-only' ? running && limit ? 'api' : null : 'terminal';
      assert.equal(decision.path, expected, label);
      assert.equal(decision.reason, FACTS[first].reason, `${label}: the first fact explains it`);
      assert.deepEqual(decision.blockers, ORDER.filter(name => names.includes(name) && !excused(name)).map(name => FACTS[name].reason), label);
    }
  assert.equal(decide([FACTS.no_key, FACTS.billing, FACTS.credits], { claudePath: 'terminal-only' }, { agent: 'codex' }).path, 'native', 'Codex reads only its CLI');
  assert.equal(decide([FACTS.cli_old], {}, { agent: 'codex' }).path, null, 'a Codex CLI that cannot run refuses Codex');
});

test('every refused or terminal path carries a code from the claude table, and the windows are told the names they know', () => {
  const codes = codesOf('claude');
  for (const names of SETS) for (const claudePath of MODES) {
    const decision = decide(names.map(name => FACTS[name]), { claudePath });
    if (decision.path === 'api') continue;
    assert.ok(codes.includes(decision.reason.code), `${decision.reason.code} is a claude code`);
    for (const blocker of decision.blockers) assert.ok(codes.includes(blocker.code), blocker.code);
  }
  // What the windows receive is unchanged: a fact's sentence when it has one, a few codes' old sentences, else the bare name.
  const wire = value => decide([value]).wire;
  assert.equal(wire(FACTS.billing), FACTS.billing.message);
  assert.equal(wire(FACTS.no_key), 'no_key');
  assert.equal(wire(FACTS.cli), 'native_cli_required');
  assert.equal(wire(FACTS.cli_old), 'Claude Code 版本过低，请升级到 2.1.317 或更高');
  assert.equal(wire(of('key', 'api_unreachable')), '无法连接 Anthropic API。');
  assert.equal(decide([], { claudePath: 'terminal-only' }).wire, 'terminal_selected');
  assert.equal(decide([FACTS.credits], { claudePath: 'api-only' }, { running: true }).wire, 'credits_exhausted', 'a running API-only session names its limit');
});

// Until R4 moves them onto decide(): the dispatcher's worker (frozen this wave), and the two wrappers that keep its shape.
// They may call the legacy choosePath( and apiState( only; what excuses a fact (excused() inside decide.cjs) is never
// asked anywhere else.
const UNTIL_R4 = ['electron/features/native-session/worker.cjs', 'electron/features/native-session/routing.cjs', 'electron/features/claude-sdk/index.cjs'];
test('choosePath(, apiState( and excused( decide nowhere but decide.cjs', () => {
  const found = [];
  for (const folder of ['electron', 'src', 'integration']) {
    for (const name of fs.readdirSync(path.join(root, folder), { recursive: true })) {
      const file = path.join(folder, name).split(path.sep).join('/');
      if (!/\.(?:cjs|mjs|js|ts|tsx)$/.test(file) || file === 'electron/features/claude-runtime/decide.cjs') continue;
      const source = fs.readFileSync(path.join(root, file), 'utf8');
      const legacy = !UNTIL_R4.includes(file) && /\b(?:choosePath|apiState)\(/.test(source);
      if (legacy || /\bexcused\(/.test(source)) found.push(file);
    }
  }
  assert.deepEqual(found, []);
  for (const file of UNTIL_R4) assert.ok(fs.existsSync(path.join(root, file)), `${file} is still there to be moved in R4`);
});
