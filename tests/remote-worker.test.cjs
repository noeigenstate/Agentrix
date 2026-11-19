const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const { seatRouting } = require('../integration/agent-event.cjs');
const { specialtyCases } = require('./seat-auto.test.cjs');

function pythonProbe(t, script) {
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', script,
    path.join(__dirname, '../integration/remote-worker.py')], { encoding: 'utf8', timeout: 20000, windowsHide: true });
  if (result.error?.code === 'ENOENT') { t.skip('Python missing'); return null; }
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout;
}

test('remote policy write failure replies without closing the channel; Bash launches a stand-in in both switch directions', t => {
  const script = String.raw`
import ast, os, pathlib, shutil, subprocess, sys, tempfile, types
tree = ast.parse(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))
channel = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == 'Channel')
receive = next(node for node in channel.body if isinstance(node, ast.FunctionDef) and node.name == 'receive')
namespace = {}
exec(compile(ast.fix_missing_locations(ast.Module(body=[ast.ClassDef(name='Channel', bases=[], keywords=[], body=[receive], decorator_list=[])], type_ignores=[])), '<channel>', 'exec'), namespace)
messages = []
def fail(): raise PermissionError('synthetic lock')
worker = types.SimpleNamespace(allow_background_tasks=False, write_background_choice=fail, emit=messages.append)
connection = namespace['Channel']()
connection.worker = worker
connection.receive({'op':'claude-background', 'id':7, 'allow':True})
assert messages == [{'type':'response','id':7,'ok':False,'error':'Could not update the Claude background setting.'}]
assert worker.allow_background_tasks is False
worker.write_background_choice = lambda: None
connection.receive({'op':'claude-background', 'id':8, 'allow':True})
assert messages[-1]['ok'] is True and worker.allow_background_tasks is True
if sys.platform == 'win32':
    print('operation error path OK; SKIP Bash Windows: the remote worker runs only on POSIX hosts')
    sys.exit(0)
bash = shutil.which('bash')
if not bash:
    print('operation error path OK; SKIP Bash missing')
    sys.exit(0)
source = next(ast.literal_eval(node.value) for node in tree.body if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'BASH_SOURCE' for target in node.targets))
assert '$' + '{name^^}' not in source and 'compgen -e' not in source
source = source[source.index('function claude {'):source.index('\n__pg_prompt()')]
with tempfile.TemporaryDirectory(prefix='remote-nobg-') as directory:
    root = pathlib.Path(directory)
    stub = root / 'claude'
    stub.write_text('#!/bin/sh\nprintf "%s\\n" "' + '$' + '{CLAUDE_CODE_DISABLE_BACKGROUND_TASKS-unset}"\n')
    stub.chmod(0o700)
    policy = root / 'policy'
    policy.write_text('0')
    rc = root / 'test.bash'
    rc.write_text('[[ $(type -P claude) -ef "$AGENTRIX_TEST_BIN/claude" ]] || exit 87\n__pg_emit() { :; }\n__pg_command() { :; }\n__pg_reading_note() { :; }\n' + source + '\nclaude\nprintf 1 > "$AGENTRIX_CLAUDE_BACKGROUND_FILE"\nclaude\nprintf 0 > "$AGENTRIX_CLAUDE_BACKGROUND_FILE"\nclaude\n')
    environment = {key:value for key,value in os.environ.items() if key not in ('BASH_ENV', 'ENV', 'SHELLOPTS', 'BASHOPTS')}
    environment.update(PATH=str(root)+os.pathsep+os.environ.get('PATH',''), HOME=str(root), AGENTRIX_TEST_BIN=str(root), AGENTRIX_PYTHON=sys.executable.replace('\\','/'), AGENTRIX_NOTIFY_FILE=str(root/'notify'), AGENTRIX_CLAUDE_BACKGROUND_FILE=str(policy), __pg_note_file=str(root/'note'), CLAUDE_CODE_DISABLE_BACKGROUND_TASKS='inherited')
    result = subprocess.run([bash, '--noprofile', '--norc', str(rc)], env=environment, text=True, capture_output=True, timeout=15)
    assert result.returncode == 0, result.stderr
    assert result.stdout.splitlines() == ['1','unset','1'], (result.stdout, result.stderr)
print('remote policy and stand-in Bash OK')
`;
  const output = pythonProbe(t, script);
  if (output?.includes('SKIP Bash Windows')) t.diagnostic('Bash stand-in skipped on Windows: the remote worker runs only on POSIX hosts; policy error and recovery assertions passed');
  if (output?.includes('SKIP Bash missing')) t.diagnostic('Bash missing: policy operation tested; shell check skipped');
});

test('the SSH worker replaces a complete Claude lead seat and retains it after invalid updates', t => {
  pythonProbe(t, String.raw`
import pathlib, runpy, sys, tempfile
module = runpy.run_path(sys.argv[1])
messages = []
connection = module['Channel'](1, messages.append)
with tempfile.TemporaryDirectory(prefix='remote-lead-') as directory:
    connection.worker.temp = directory
    file = pathlib.Path(directory) / 'claude-lead'
    background = 'ANTHROPIC_DEFAULT_HAIKU_MODEL'
    subagent = 'CLAUDE_CODE_SUBAGENT_MODEL'
    first = {'model':'claude-opus-5-5[1m]', 'effort':'high', 'fast':True,
             'env':{background:'claude-sonnet-5-5', subagent:'claude-opus-5-5[1m]', subagent+'_FORCE':'ignored'}}
    current = {'model':'sonnet', 'effort':'medium'}
    connection.worker.write_claude_lead(first)
    assert file.read_bytes() == b'claude-opus-5-5[1m]\nhigh\n1\nclaude-sonnet-5-5\nclaude-opus-5-5[1m]\n'
    def update(lead, ok):
        connection.receive({'op':'claude-lead', 'id':len(messages)+1, 'claudeLead':lead})
        assert messages[-1]['type'] == 'response' and messages[-1]['ok'] is ok, messages
    update(dict(current, env={subagent:'haiku'}), True)
    assert file.read_bytes() == b'sonnet\nmedium\n0\n\nhaiku\n'
    for bad in [dict(current, model='bad&model'), dict(current, model='x'*161), dict(current, effort='High'),
                dict(current, effort='x'*33), dict(current, fast='true'), dict(current, env=[]),
                dict(current, env={background:'sonnet\nchanged'}), dict(current, env={subagent:'x'*161}), dict(current, env={subagent:True})]:
        update(bad, False)
        assert file.read_bytes() == b'sonnet\nmedium\n0\n\nhaiku\n'
    update(current, True)
    assert file.read_bytes() == b'sonnet\nmedium\n0\n\n\n'
    update(dict(first, seatsMap={'padding':'x'*8192}), True)
    assert file.read_bytes() == b'claude-opus-5-5[1m]\nhigh\n1\nclaude-sonnet-5-5\nclaude-opus-5-5[1m]\n'
    update(None, True)
    assert file.read_bytes() == b''
`);
});

test('the SSH command hook matches the local Agent tool routing rules and observations', t => {
  const pairs = [
    ['opus', 'opus', 'low'], ['sonnet', 'sonnet', 'medium'], ['haiku', 'haiku', 'high'], ['fable', 'fable', 'xhigh'],
    ['claude-opus-5-5', 'opus', 'max'], ['claude-other', 'opus', 'adaptive'], ['claude-other', 'opus-next', 'high'],
    ['opus-next', 'opus', 'high'], ['gpt-6.2-sol', null, 'high'],
  ];
  const choices = [...pairs.map(([model, agentModel, effort]) => ['reviewer', { reviewer: { model, agentModel, effort } }]), ...specialtyCases];
  const cases = choices.flatMap(([seat, map]) => ['PreToolUse', 'PostToolUse'].map(hook_event_name => {
    const snapshot = JSON.stringify(map);
    const hook = { hook_event_name, tool_name: 'Agent', tool_use_id: 'toolu_1', session_id: 'fixture',
      tool_input: { description: `[${seat}] Review`, prompt: 'Review', model: 'haiku', effort: 'medium' } };
    return { snapshot, hook, expected: seatRouting(JSON.stringify(hook), snapshot) };
  }));
  pythonProbe(t, String.raw`
import contextlib, io, json, os, runpy, socket, sys
from unittest.mock import patch
source = runpy.run_path(sys.argv[1])['NOTIFY_SOURCE']
for case in json.loads(${JSON.stringify(JSON.stringify(cases))}):
    with patch.object(socket, 'socket') as connect, patch.object(socket, 'AF_UNIX', 1, create=True), patch.object(sys, 'argv', ['notify', 'claude-seat']), \
         patch.object(sys, 'stdin', io.StringIO(json.dumps(case['hook']))), contextlib.redirect_stdout(io.StringIO()) as out, \
         patch.dict(os.environ, AGENTRIX_TOKEN='fixture', AGENTRIX_SOCKET='fixture', AGENTRIX_SEATS=case['snapshot']):
        try: exec(source, {})
        except SystemExit as e: assert e.code == 0
    event = connect.return_value.__enter__.return_value.sendall
    result = {}
    if out.getvalue(): result['output'] = json.loads(out.getvalue())
    if event.called:
        observed = json.loads(event.call_args.args[0])
        result['observed'] = {key: observed[key] for key in ('toolUseId','sessionId','model','effort','phase')}
    assert result == case['expected'], (result, case)
`);
});

test('SSH Bash exports only valid operation models to Claude conversations', { skip: process.platform === 'win32' }, t => {
  const output = pythonProbe(t, String.raw`
import pathlib, runpy, shutil, subprocess, sys, tempfile
module = runpy.run_path(sys.argv[1])
bash = shutil.which('bash', path='/usr/bin:/bin')
if not bash:
    print('SKIP Bash missing')
    sys.exit(0)
with tempfile.TemporaryDirectory(prefix='remote-lead-shell-') as directory:
    root = pathlib.Path(directory)
    stub = root / 'claude'
    stub.write_text('''#!/bin/sh
printf "values=%s|%s|%s|" "$ANTHROPIC_DEFAULT_HAIKU_MODEL" "$CLAUDE_CODE_SUBAGENT_MODEL" "$CLAUDE_CODE_SUBAGENT_MODEL_FORCE"
shift 2
printf "%s " "$@"
printf "\\n"
''')
    stub.chmod(0o700)
    worker = module['Worker'](lambda _event: None)
    worker.temp = directory
    worker.write_claude_lead({'model':'sonnet', 'effort':'high', 'env':{
        'ANTHROPIC_DEFAULT_HAIKU_MODEL':'claude-opus-5-5', 'CLAUDE_CODE_SUBAGENT_MODEL':'haiku'}})
    rc = root / 'agentrix.bash'
    rc.write_text(module['BASH_SOURCE'], encoding='utf-8')
    probe = '''
source "$1"
[[ $(type -P claude) -ef "$AGENTRIX_ROOT/claude" ]] || exit 87
claude --resume fixture
claude --version
printf '%s\\n' sonnet high 0 'invalid&word' haiku > "$AGENTRIX_CLAUDE_LEAD_FILE"
claude
printf '%s\\n' sonnet high 0 > "$AGENTRIX_CLAUDE_LEAD_FILE"
claude
'''
    env = {'HOME':directory, 'PATH':directory+':/usr/bin:/bin', 'AGENTRIX_ROOT':directory, 'AGENTRIX_PYTHON':sys.executable,
           'AGENTRIX_NOTIFY_FILE':str(root/'notify'), 'AGENTRIX_READING_NOTE_FILE':str(root/'note'),
           'AGENTRIX_CLAUDE_LEAD_FILE':str(root/'claude-lead'), 'AGENTRIX_CLAUDE_BACKGROUND_FILE':str(root/'policy')}
    result = subprocess.run([bash, '--noprofile', '--norc', '-c', probe, 'probe', str(rc)], env=env, text=True, capture_output=True, timeout=15)
    assert result.returncode == 0, result.stderr
    assert [line.rstrip() for line in result.stdout.splitlines() if line.startswith('values=')] == [
        'values=claude-opus-5-5|haiku||--model sonnet --effort high --resume fixture',
        'values=|||--version', 'values=|haiku||--model sonnet --effort high', 'values=|||--model sonnet --effort high',
    ], result.stdout
`);
  if (output?.includes('SKIP Bash missing')) t.skip('Bash missing');
});

test('SSH open carries the background switch and Claude seat, and changes use separate control messages', async t => {
  const filename = path.join(__dirname, '../electron/remote-connection.cjs'), native = createRequire(filename);
  for (const allow of [false, true]) {
    const module = { exports: {} }, sent = [];
    let remote;
    const link = { attach: () => 1, detach() {}, open: message => sent.push(message), send: message => {
      sent.push(message); remote.receive({ type: 'response', id: message.id, ok: true, value: true });
    } };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8') + '\nlinkFor = () => testLink;', {
      module, testLink: link, require: name => name.endsWith('dispatch.cjs') ? { runtimeFiles: () => ({}) } : native(name),
      process, Buffer, setInterval, clearInterval, setTimeout, clearTimeout,
    });
    const claudeLead = allow ? { model: 'opus', effort: 'high', fast: true } : null;
    remote = new module.exports.RemoteConnection({ path: '/fixture', id: 'fixture', ssh: {} }, {
      auth: {}, integrationDir: path.join(__dirname, '../integration'), allowBackgroundTasks: allow, claudeLead });
    t.after(() => remote.close());
    assert.equal(sent[0].allowBackgroundTasks, allow);
    assert.deepEqual(sent[0].claudeLead, claudeLead);
    remote.receive({ type: 'ready', info: { root: '/fixture', cwd: '/fixture' } });
    await remote.setBackgroundTasks(!allow);
    assert.equal(sent[1].op, 'claude-background');
    assert.equal(sent[1].allow, !allow);
    const nextLead = { model: 'sonnet', effort: 'low', fast: false };
    await remote.setClaudeLead(nextLead);
    assert.equal(sent[2].op, 'claude-lead');
    assert.deepEqual(sent[2].claudeLead, nextLead);
  }
});
