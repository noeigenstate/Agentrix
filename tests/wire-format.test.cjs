const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { WIRE_FIELDS, readEnvelope, readKeyValue, writeKeyValue, readRoleResult, readSessionMode, readLeadSeat } =
  require('../electron/features/agents/dispatch-events.cjs');
const cases = require('./fixtures/wire/cases.json');
const remoteCases = require('./fixtures/wire/remote-cases.json');

function readNulWords(text, options) {
  const records = text.split('\0');
  assert.equal(records.pop(), '');
  const header = [], unset = [], env = {}, argv = [];
  for (const record of records) {
    const equals = record.indexOf('=');
    const key = record.slice(0, equals), value = record.slice(equals + 1);
    if (key === 'format' || key === 'version') header.push(record);
    else if (key === 'unset') unset.push(value);
    else if (key === 'arg') argv.push(value);
    else if (key === 'env') {
      const split = value.indexOf('=');
      env[value.slice(0, split)] = value.slice(split + 1);
    }
  }
  const { version } = readKeyValue(header.join('\n'), options);
  return { v: Number(version), type: 'launch.words', unset, env, argv };
}

function runCase({ input, repeat, kind, ...options }) {
  const text = input + (repeat ? repeat[0].repeat(repeat[1]) : '');
  const reader = { envelope: readEnvelope, kv: readKeyValue, words: readNulWords }[kind];
  try {
    return { value: reader(text, options) };
  } catch (error) {
    return { code: error.code, message: error.message };
  }
}

test('wire fixtures preserve fields and reject unsupported versions with their channel', () => {
  for (const fixture of cases) {
    const parsed = runCase(fixture);
    if (fixture.error) {
      assert.equal(parsed.code, fixture.error, fixture.name);
      if (fixture.received) {
        assert.ok(parsed.message.startsWith(`${fixture.channel ?? fixture.format}: `), fixture.name);
        assert.ok(parsed.message.includes(fixture.received), fixture.name);
      }
    } else if (fixture.kind === 'kv') {
      assert.deepEqual(parsed.value, fixture.expected, fixture.name);
      const written = writeKeyValue(parsed.value, { format: fixture.format });
      assert.ok(written.startsWith(Object.keys(parsed.value)[0] + '='));
      assert.ok(written.endsWith('\n'));
      assert.deepEqual(readKeyValue(written, { format: fixture.format }), fixture.expected);
    } else if (fixture.kind === 'words') {
      assert.deepEqual(parsed.value, fixture.expected);
    } else {
      assert.deepEqual(parsed.value, { value: JSON.parse(fixture.input), version: fixture.version, legacy: fixture.version === 0 }, fixture.name);
    }
  }
});

test('Node, the isolated Python reference and the SSH worker agree on the wire fixtures', t => {
  const commands = process.platform === 'win32' ? [['python3'], ['python'], ['py', '-3']] : [['python3']];
  const selected = commands.find(([command, ...args]) =>
    spawnSync(command, [...args, '-I', '-c', 'import sys; sys.exit(sys.version_info < (3, 6))'], { timeout: 5000, windowsHide: true }).status === 0);
  if (!selected && process.platform === 'win32') return t.skip('No Python 3.6+ interpreter accepting -I was found on Windows');
  assert.ok(selected, 'python3 -I is required');
  const [command, ...args] = selected;
  const reference = path.join(__dirname, 'helpers/wire-reference.py');
  const worker = path.join(__dirname, '../integration/remote-worker.py');
  function readFixture(file, ...paths) {
    const python = spawnSync(command, [...args, '-I', '-B', reference, path.join(__dirname, 'fixtures/wire', file), ...paths],
      { encoding: 'utf8', timeout: 10000, windowsHide: true });
    assert.ifError(python.error);
    assert.equal(python.status, 0, python.stderr);
    return JSON.parse(python.stdout);
  }
  for (const [file, fixtures] of [['cases.json', cases], ['remote-cases.json', remoteCases]]) {
    const expected = fixtures.map(runCase);
    assert.deepEqual(readFixture(file), expected);
    assert.deepEqual(readFixture(file, worker), expected.map((parsed, i) =>
      parsed.value && fixtures[i].kind === 'kv' ? { ...parsed, written: writeKeyValue(parsed.value, fixtures[i]) } : parsed));
  }
});

for (const shell of ['bash', 'zsh', 'PowerShell']) test(`${shell} reads versioned key=value fields when installed`, t => {
  const powershell = shell === 'PowerShell';
  const gitBash = path.join(process.env.ProgramFiles || '', 'Git', 'bin', 'bash.exe');
  const choices = powershell ? ['powershell', 'pwsh'] : [shell, ...(shell === 'bash' && process.platform === 'win32' && fs.existsSync(gitBash) ? [gitBash] : [])];
  const options = { encoding: 'utf8', timeout: 10000, windowsHide: true, env: { ...process.env, BASH_ENV: '', ENV: '' } };
  const available = choices.find(command => spawnSync(command, powershell ? ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'] : ['--version'], options).status === 0);
  if (!available) return t.skip(`${shell} is unavailable`);
  const script = path.join(__dirname, `helpers/wire-reference.${powershell ? 'ps1' : 'sh'}`);
  for (const fixture of cases.filter(value => value.kind === 'kv' && value.format && (value.expected || value.error === 'wire.unsupported_version'))) {
    const argv = powershell ? ['-NoProfile', '-NonInteractive', '-File', script, fixture.format] : [script, fixture.format];
    const result = spawnSync(available, argv, { ...options, input: fixture.input });
    assert.ifError(result.error);
    assert.equal(result.status, fixture.error ? 3 : 0, result.stderr || fixture.name);
    if (fixture.expected) assert.deepEqual(readKeyValue(result.stdout, { format: fixture.format }), fixture.expected);
  }
  if (!powershell) {
    const fixture = cases.find(value => value.kind === 'words');
    const reader = path.join(__dirname, '../integration/shims/hooks/terminal-wire.sh');
    const script = [
      'source "$1"',
      'planner_unset=() planner_env=() launch_args=()',
      '__pg_launch_words || exit',
      'printf "%s\\0" format=agentrix.launch-words version=1',
      'for word in "${planner_unset[@]}"; do [[ $word == -u ]] || printf "unset=%s\\0" "$word"; done',
      'for word in "${planner_env[@]}"; do printf "env=%s\\0" "$word"; done',
      'for word in "${launch_args[@]}"; do printf "arg=%s\\0" "$word"; done',
    ].join('\n');
    const result = spawnSync(available, ['-c', script, 'wire-fixture', reader], { ...options, input: fixture.input });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readNulWords(result.stdout), fixture.expected);
    return;
  }
  for (const fixture of cases.filter(value => value.localShell || value.kind === 'words')) {
    const argv = ['-NoProfile', '-NonInteractive', '-File', script, '-Kind', fixture.kind];
    if (fixture.format) argv.push('-Expected', fixture.format);
    const result = spawnSync(available, argv, { ...options, input: fixture.input });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr || fixture.name);
    const parsed = JSON.parse(result.stdout);
    assert.deepEqual({ value: parsed }, runCase(fixture), fixture.name);
  }
});

test('the intercept launch formats and named shell events use the shared fields', () => {
  const { terminalLaunch } = require('../integration/shims/intercept.cjs');
  const { shellEvent } = require('../integration/agent-event.cjs');
  const { parseSeatMap } = require('../electron/features/agents/call-seat.cjs');
  const fixture = name => cases.find(value => value.name === name);
  const route = fixture('classify route carries a version');
  assert.deepEqual(readKeyValue(terminalLaunch({}, 'claude', 'classify', 'native', [])), route.expected);
  const input = { AGENTRIX_LAUNCH_NOTE: '甲=乙\n--\n-u' };
  const json = readEnvelope(terminalLaunch(input, 'claude', 'json', 'plain', []), { legacy: false }).value;
  const nul = readNulWords(terminalLaunch(input, 'claude', 'words', 'plain', []));
  assert.deepEqual(json, nul);
  assert.deepEqual(nul.argv, ['--append-system-prompt', input.AGENTRIX_LAUNCH_NOTE]);
  const event = JSON.parse(fixture('local shell launch event').input);
  const args = Object.entries(event).map(([key, value]) => `${key}=${value}`);
  assert.deepEqual(shellEvent(args, event.projectId, event.sessionKey), { ...event, exitCode: 0, codexHome: '' });
  assert.equal(shellEvent([...args, 'sequence=9'], event.projectId, event.sessionKey), null);
  assert.equal(shellEvent(args.map(arg => arg === 'v=1' ? 'v=2' : arg), event.projectId, event.sessionKey), null);
  const seats = fixture('local seat map file').input;
  assert.deepEqual(parseSeatMap(seats), JSON.parse(seats).seats);
  assert.deepEqual(parseSeatMap(JSON.stringify(JSON.parse(seats).seats)), JSON.parse(seats).seats);
});

test('the key=value writer bounds encoded bytes and rejects line separators and non-string fields', () => {
  const values = { format: 'agentrix.lead-seat', version: '1', model: '' };
  for (const model of ['line\rbreak', 'line\nbreak', 'nul\0byte', 1]) {
    assert.throws(() => writeKeyValue({ ...values, model }), { code: 'wire.invalid' });
  }
  const exact = 16 * 1024 - Buffer.byteLength(writeKeyValue(values));
  const model = '好'.repeat(Math.floor(exact / 3)) + 'a'.repeat(exact % 3);
  assert.equal(Buffer.byteLength(writeKeyValue({ ...values, model })), 16 * 1024);
  assert.throws(() => writeKeyValue({ ...values, model: model + 'a' }), { code: 'wire.invalid' });
});

test('wire readers expose role results and shell seats by field name', () => {
  assert.equal(readSessionMode(cases.find(value => value.format === 'agentrix.session-mode' && value.expected).input), 'conductor');
  assert.throws(() => readSessionMode('format=agentrix.session-mode\nversion=1\nmode=invalid\n'), { code: 'wire.invalid' });
  const seat = cases.find(value => value.format === 'agentrix.lead-seat' && value.expected);
  assert.deepEqual(readLeadSeat(seat.input), { model: '测试=a=b', effort: 'high', fast: false, ultracode: true, seatsMap: { Developer: 'a=b' } });
  const result = { format: 'agentrix.role-result', version: 1, runId: '00000000-0000-0000-0000-000000000001', source: 'final-text',
    answer: '## Needs decision\n\nFree text', needsDecision: null, needsApproval: [], findings: [], calls: 0, at: 100 };
  assert.deepEqual(readRoleResult(JSON.stringify({ ...result, future: true })), result);
  assert.throws(() => readRoleResult({ ...result, version: 2 }), { code: 'wire.unsupported_version' });
  assert.throws(() => readRoleResult({ ...result, needsDecision: true }), { code: 'wire.invalid' });
});

test('the wire field tables declare the envelope, payload and optional keys', () => {
  assert.deepEqual(Object.keys(WIRE_FIELDS.dispatch).sort(), [
    'detached', 'ended', 'failed', 'intervention', 'notice', 'request', 'resume', 'running', 'start-failed', 'started', 'transport', 'unknown-run', 'waiting',
  ].map(type => 'dispatch.' + type));
  for (const group of Object.values(WIRE_FIELDS)) for (const { required, optional } of Object.values(group)) {
    const all = [...required, ...optional];
    assert.equal(new Set(all).size, all.length);
    assert.ok(['v', 'format'].includes(required[0]));
  }
  assert.ok(WIRE_FIELDS.inbox.intervention.optional.includes('type'));
  assert.ok(!WIRE_FIELDS.inbox.intervention.required.includes('type'));
  assert.ok(!Object.hasOwn(WIRE_FIELDS.dispatch, 'dispatch-start'));
  for (const type of ['meeting', 'skip', 'end', 'consolidate', 'incident', 'finding', 'issues']) {
    assert.ok(Object.hasOwn(WIRE_FIELDS.journal, type));
  }
  assert.equal(WIRE_FIELDS.files['agentrix.detached-run'].version, 2);
});
