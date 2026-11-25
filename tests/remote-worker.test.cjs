const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { RemoteConnection } = require('../electron/remote-connection.cjs');
const { spawnSync } = require('node:child_process');
const { agentSettings } = require('../electron/features/agents/agent-settings.cjs');
const { seatRouting } = require('../integration/agent-event.cjs');
const { specialtyCases } = require('./seat-auto.test.cjs');

function pythonProbe(t, script, timeout = 20_000) {
  const envelope = require('../integration/shims/intercept.cjs').runtimeFiles()['shims/launchers.cjs'];
  const wire = envelope.split('\n')[0].slice('const terminalWire = '.length, -1);
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-B', '-c', script,
    path.join(__dirname, '../integration/remote-worker.py'), wire], { encoding: 'utf8', timeout, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  if (result.error?.code === 'ENOENT') { t.skip('Python missing'); return null; }
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout;
}

test('the real Python SSH worker installs a working Claude role MCP package', {
  skip: process.platform === 'win32' && 'requires the POSIX remote worker and Unix socket',
}, t => {
  const integration = path.join(__dirname, '../integration');
  const { runtimeFiles, dispatchCompanions } = require('../integration/dispatch.cjs');
  const payload = { dispatchHelper: fs.readFileSync(path.join(integration, 'dispatch.cjs'), 'utf8'), dispatchModules: runtimeFiles(),
    dispatchCompanions: Object.fromEntries(dispatchCompanions.map(name => [name, fs.readFileSync(path.join(integration, name), 'utf8')])) };
  const script = String.raw`
import json, os, runpy, subprocess, sys, tempfile
from unittest.mock import patch
worker_source = runpy.run_path(sys.argv[1])
payload = json.load(sys.stdin)
with tempfile.TemporaryDirectory(prefix='remote-role-e2e-') as home, patch.dict(os.environ, HOME=os.environ.get('HOME', '')):
    os.environ['HOME'] = home
    node = sys.argv[2]
    login_path = os.path.dirname(node) + os.pathsep + os.environ['PATH']
    messages = []
    channel = worker_source['Channel'](1, messages.append)
    worker = channel.worker
    try:
        lookup = {'AGENTRIX_NODE': node, 'AGENTRIX_PATH': login_path}
        config = dict(payload, path=home, projectId='test-project', token='test-token', native=True, claudeLead={'conductor': True})
        with patch.dict(worker.install_dispatch.__func__.__globals__, login_tools=lambda _: lookup):
            channel.open(config)
        info = messages[-1]['info']
        assert info['root'] == home or info['root'] == os.path.realpath(home), info
        assert info['roleServer']['args'][-2:] == ['mcp', 'codex'], info
        server = worker.role_server('claude')
        assert server['command'] == node and server['env']['PATH'] == login_path, server
        request = lambda id, method, params: json.dumps(dict(id=id, jsonrpc='2.0', method=method, params=params)) + '\n'
        frames = request(1, 'initialize', {'protocolVersion': '2025-06-18'}) + request(2, 'tools/list', {})
        frames += request(3, 'tools/call', {'name':'roles_status'})
        result = subprocess.run([server['command']] + server['args'], input=frames.encode(), cwd=info['cwd'],
                                env=dict(os.environ, **server['env']), stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15)
        assert result.returncode == 0, result.stderr.decode()
        replies = {item['id']: item['result'] for item in map(json.loads, result.stdout.splitlines())}
        assert replies[1]['serverInfo']['name'] == 'agentrix', replies
        assert 'start_role' in [tool['name'] for tool in replies[2]['tools']], replies
        assert json.loads(replies[3]['content'][0]['text'])['roles'] == [], replies
        channel.receive({'op': 'claude-lead', 'id': 4, 'claudeLead': {'seatsMap': {}, 'conductor': False}})
        assert messages[-1]['ok'], messages
        result = subprocess.run([server['command']] + server['args'], input=frames.encode(), cwd=info['cwd'],
                                env=dict(os.environ, **server['env']), stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15)
        assert result.returncode == 0, result.stderr.decode()
        replies = {item['id']: item['result'] for item in map(json.loads, result.stdout.splitlines())}
        assert replies[2]['tools'] == [] and replies[3]['isError'], replies
        assert 'Conductor mode is off' in replies[3]['content'][0]['text'], replies
    finally:
        channel.close()
`;
  const result = spawnSync('python3', ['-c', script, path.join(integration, 'remote-worker.py'), process.execPath],
    { input: JSON.stringify(payload), encoding: 'utf8', timeout: 40_000 });
  if (result.error?.code === 'ENOENT') { t.skip('Python missing'); return; }
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

test('remote policy write failure replies without closing the channel; Bash launches a stand-in in both switch directions', t => {
  const script = String.raw`
import ast, os, pathlib, runpy, shutil, subprocess, sys, tempfile, types
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
source = source[source.index('__pg_read_wire()'):source.index('\n__pg_prompt()')]
with tempfile.TemporaryDirectory(prefix='remote-nobg-') as directory:
    root = pathlib.Path(directory)
    notify = root / 'notify'
    notify.write_bytes(runpy.run_path(sys.argv[1])['NOTIFY_SOURCE'].encode('utf-8'))
    (root / 'terminal-wire.json').write_text(sys.argv[2], encoding='utf-8')
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

// Found on a real CentOS host: the host's Node planner saw a bootstrap without a format and answered the old bare word,
// which the versioned wrapper rejected, so `claude` returned silently.
test('the SSH Bash wrapper asks the host Node planner for versioned fields even with an unversioned bootstrap', {
  skip: process.platform === 'win32' && 'the remote worker runs only on POSIX hosts',
}, t => {
  const script = String.raw`
import ast, os, pathlib, shutil, subprocess, sys, tempfile, json
bash = shutil.which('bash')
if not bash:
    print('SKIP Bash missing'); sys.exit(0)
tree = ast.parse(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))
source = next(ast.literal_eval(node.value) for node in tree.body if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'BASH_SOURCE' for target in node.targets))
source = source[source.index('__pg_read_wire()'):source.index('\n__pg_prompt()')]
with tempfile.TemporaryDirectory(prefix='remote-planner-') as directory:
    root = pathlib.Path(directory)
    (root / 'bootstrap.json').write_text(json.dumps({'shims': ''}), encoding='utf-8')
    rc = root / 'test.bash'
    rc.write_text('__pg_role_node=$AGENTRIX_TEST_NODE\n__pg_role_intercept=$AGENTRIX_TEST_INTERCEPT\n' + source
      + '\nreply=$(__pg_launch_plan claude classify --version) || exit 9\nroute=\n__pg_read_wire agentrix.launch-route <<< "$reply" || exit 8\nprintf "%s\\n" "$route"\n')
    environment = {key:value for key,value in os.environ.items() if key not in ('BASH_ENV', 'ENV', 'SHELLOPTS', 'BASHOPTS', 'AGENTRIX_LAUNCH_WIRE')}
    environment.update(HOME=str(root), AGENTRIX_BOOTSTRAP=str(root / 'bootstrap.json'), AGENTRIX_TEST_NODE=os.environ['AGENTRIX_TEST_NODE'], AGENTRIX_TEST_INTERCEPT=os.environ['AGENTRIX_TEST_INTERCEPT'], ELECTRON_RUN_AS_NODE='1')
    result = subprocess.run([bash, '--noprofile', '--norc', str(rc)], env=environment, text=True, capture_output=True, timeout=15)
    assert result.returncode == 0, (result.returncode, result.stdout, result.stderr)
    assert result.stdout.splitlines() == ['utility'], (result.stdout, result.stderr)
print('remote planner fields OK')
`;
  process.env.AGENTRIX_TEST_NODE = process.execPath;
  process.env.AGENTRIX_TEST_INTERCEPT = path.join(__dirname, '../integration/shims/intercept.cjs');
  t.after(() => { delete process.env.AGENTRIX_TEST_NODE; delete process.env.AGENTRIX_TEST_INTERCEPT; });
  const output = pythonProbe(t, script);
  if (output?.includes('SKIP Bash missing')) t.skip('Bash missing');
  else if (output !== null) assert.match(output, /remote planner fields OK/);
});

test('the SSH worker replaces a complete Claude lead seat and retains it after invalid updates', t => {
  pythonProbe(t, String.raw`
import pathlib, runpy, sys, tempfile
module = runpy.run_path(sys.argv[1])
messages = []
connection = module['Channel'](1, messages.append)
with tempfile.TemporaryDirectory(prefix='remote-lead-') as directory:
    connection.worker.temp = directory
    file = pathlib.Path(directory) / 'dispatch.json.lead'
    mode = pathlib.Path(directory) / 'dispatch.json.mode'
    seat_env = file.with_suffix('.lead.env')
    mode_env = mode.with_suffix('.mode.env')
    seats = {'researcher': {'model':'sonnet', 'effort':'high'}}
    first = {'model':'claude-opus-5-5[1m]', 'effort':'high', 'fast':True, 'ultracode':True, 'seatsMap':seats}
    current = {'model':'sonnet', 'effort':'medium'}
    connection.worker.write_claude_lead(first)
    assert file.read_bytes() == b'claude-opus-5-5[1m]\nhigh\n1\n{"researcher":{"model":"sonnet","effort":"high"}}\nultracode\n'
    def fields(sidecar, kind):
        return module['read_key_value'](sidecar.read_bytes().decode('utf-8'), 'agentrix.' + kind)
    assert fields(seat_env, 'lead-seat') == dict(format='agentrix.lead-seat', version='1', model=first['model'], effort='high',
                                                  fast='1', ultracode='1', seats='{"researcher":{"model":"sonnet","effort":"high"}}')
    def update(lead, ok):
        connection.receive({'op':'claude-lead', 'id':len(messages)+1, 'claudeLead':lead})
        assert messages[-1]['type'] == 'response' and messages[-1]['ok'] is ok, messages
    update(dict(current, conductor=True), True)
    assert mode.read_text() == 'conductor'
    assert fields(mode_env, 'session-mode')['mode'] == 'conductor'
    saved_seat, saved_mode = seat_env.read_bytes(), mode_env.read_bytes()
    for bad in [dict(current, model='bad&model'), dict(current, model='x'*161), dict(current, effort='High'),
                dict(current, effort='x'*33), dict(current, fast='true'), dict(current, ultracode=1), dict(current, conductor=1), dict(first, seatsMap={'padding':'x'*8192})]:
        update(bad, False)
        assert file.read_bytes() == b'sonnet\nmedium\n0\nnull\n'
        assert mode.read_text() == 'conductor'
        assert seat_env.read_bytes() == saved_seat and mode_env.read_bytes() == saved_mode
    update({'seatsMap': {}, 'conductor': False}, True)
    assert mode.read_text() == 'native'
    assert fields(mode_env, 'session-mode')['mode'] == 'native'
    update(None, True)
    assert file.read_bytes() == b''
    assert not seat_env.exists()
`);
});

test('the SSH Python launcher writes keyed routes and NUL-delimited arguments for both manifest versions', t => {
  const output = pythonProbe(t, String.raw`
import json, os, pathlib, runpy, subprocess, sys, tempfile, threading
worker = runpy.run_path(sys.argv[1])
wire = json.loads(sys.argv[2])
raw_note = 'SSH reading note. Agentrix skill delivery: remote. Skill instructions.'
expected_note = 'SSH reading note. Agentrix delivers skill instructions through its SessionStart hook.'
with tempfile.TemporaryDirectory(prefix='ssh-wire-') as directory:
    root = pathlib.Path(directory)
    notifier = root / 'notify.py'
    notifier.write_bytes(worker['NOTIFY_SOURCE'].encode('utf-8'))
    manifest = root / 'terminal-wire.json'
    def launch(agent, action, *args, note='hello\nworld=a=b'):
        return subprocess.run([sys.executable, str(notifier), 'terminal-launch', agent, action, *args],
                              env=dict(os.environ, AGENTRIX_LAUNCH_NOTE=note,
                                       AGENTRIX_LAUNCH_MODEL='sonnet', AGENTRIX_LAUNCH_EFFORT='high'),
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5)
    legacy = {key: value for key, value in wire.items() if key not in ('format', 'version')}
    legacy['claude'] = dict(wire['claude'], note=dict(wire['claude']['note'], marker=' Agentrix skill delivery: '))
    for document in (legacy, wire):
        manifest.write_text(json.dumps(document), encoding='utf-8')
        for agent, args, route in (('claude', ('--model=sonnet',), 'refused'), ('claude', ('--version',), 'utility'),
                                  ('claude', ('-p',), 'print'), ('claude', ('--', '--model=sonnet'), 'conversation'),
                                  ('codex', (), 'native'), ('codex', ('--version',), 'passthrough')):
            result = launch(agent, 'classify', *args)
            assert result.returncode == 0, result.stderr
            assert worker['read_key_value'](result.stdout.decode('utf-8'), 'agentrix.launch-route')['route'] == route
        result = launch('claude', 'words')
        assert result.returncode == 0, result.stderr
        assert result.stdout.split(b'\0') == [b'format=agentrix.launch-words', b'version=1', b'arg=--append-system-prompt',
                                               b'arg=hello\nworld=a=b', b'arg=--model', b'arg=sonnet', b'arg=--effort', b'arg=high', b'']
        result = launch('claude', 'words', note=raw_note)
        assert result.returncode == 0, result.stderr
        assert result.stdout.split(b'\0')[2:4] == [b'arg=--append-system-prompt', ('arg=' + expected_note).encode('utf-8')]
    session = object.__new__(worker['Worker'])
    session.temp = directory
    session.skill_note_sequence = 1
    session.skill_note_ready = threading.Event()
    session.skill_paths = {}
    session.startup_note = lambda note: note
    session.terminal_manifest = lambda: worker['read_terminal_wire'](wire)
    assert session.write_launch_note(raw_note, None) == raw_note  # Native startup still gets its full context.
    literal = 'Earlier work. Agentrix skill delivery: a literal phrase.'
    assert session.write_launch_note(literal, session.terminal_manifest()) == literal
    assert session.write_launch_note(raw_note, session.terminal_manifest()) == expected_note
    session.update_skill_note(1, raw_note, {})
    assert session.skill_note_ready.is_set()
    print((root / 'skill-note.txt').read_text(encoding='utf-8'))
    manifest.write_text(json.dumps(dict(wire, version=19)), encoding='utf-8')
    result = launch('claude', 'classify')
    assert result.returncode != 0 and not result.stdout
    assert result.stderr.decode('utf-8').splitlines() == ['agentrix.terminal-wire: unsupported version 19']
`);
  if (output === null) return;
  const { terminalLaunch } = require('../integration/shims/intercept.cjs');
  const env = { AGENTRIX_LAUNCH_NOTE: output.trimEnd() };
  assert.deepEqual(JSON.parse(terminalLaunch(env, 'claude', 'json', 'remote', [])).argv,
    ['--append-system-prompt', 'SSH reading note. Agentrix delivers skill instructions through its SessionStart hook.']);
});

test('the SSH lookup requires a supported version and preserves exact path bytes amid login noise', t => {
  pythonProbe(t, String.raw`
import os, runpy, sys
from unittest.mock import Mock, patch
worker = runpy.run_path(sys.argv[1])
assert 'AGENTRIX_LOOKUP_VERSION=1' in worker['CODEX_LOOKUP']
path = '/tools/测试=a=b'.encode('utf-8')
output = b'login banner\nAGENTRIX_CODEX=\nAGENTRIX_NODE=/bin/node\nAGENTRIX_PATH=' + path + b'\n'
with patch.object(worker['subprocess'], 'run') as run:
    run.return_value = Mock(stdout=output + b'AGENTRIX_LOOKUP_VERSION=1\n', stderr=b'', returncode=0)
    tools = worker['login_tools']({})
    assert tools['AGENTRIX_CODEX'] == '' and tools['AGENTRIX_NODE'] == '/bin/node'
    assert os.fsencode(tools['AGENTRIX_PATH']) == path
    for field in (b'', b'AGENTRIX_LOOKUP_VERSION=23\n', b'AGENTRIX_LOOKUP_VERSION=01\n'):
        run.return_value.stdout = output + field
        try:
            worker['login_tools']({})
        except worker['WireError'] as error:
            assert error.code == 'wire.unsupported_version' and 'AGENTRIX_LOOKUP_VERSION' in str(error)
        else:
            raise AssertionError(field)
`);
});

test('the SSH notifier versions shell and hook events and keeps the legacy start name on the wire', t => {
  pythonProbe(t, String.raw`
import io, json, os, runpy, socket, sys
from unittest.mock import patch
worker = runpy.run_path(sys.argv[1])
for argv, payload, kind in [
        (['shell-prompt', '1', '0'], {}, 'shell-prompt'),
        (['codex-started', '', 'codex', '["resume","--last"]'], {}, 'codex-started'),
        (['claude-hook', 'stop'], {'session_id':'fixture'}, 'agent-activity'),
        (['notify', '{"type":"agent-turn-complete","thread-id":"t","turn-id":"r"}'], {}, 'turn-complete')]:
    with patch.object(socket, 'socket') as connect, patch.object(socket, 'AF_UNIX', 1, create=True), \
         patch.object(sys, 'argv', ['notify.py'] + argv), patch.object(sys, 'stdin', io.StringIO(json.dumps(payload))), \
         patch.dict(os.environ, AGENTRIX_TOKEN='fixture', AGENTRIX_SOCKET='fixture'):
        exec(worker['NOTIFY_SOURCE'], {})
    sent = connect.return_value.__enter__.return_value.sendall.call_args[0][0]
    assert sent.endswith(b'\n')
    event = json.loads(sent)
    assert (event['v'], event['type'], event['token']) == (1, kind, 'fixture')
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
import contextlib, io, json, os, pathlib, runpy, socket, sys, tempfile
from unittest.mock import patch
module = runpy.run_path(sys.argv[1])
source = module['NOTIFY_SOURCE']
def invoke(case, globals=None):
    with patch.object(socket, 'socket') as connect, patch.object(socket, 'AF_UNIX', 1, create=True), patch.object(sys, 'argv', ['notify', 'claude-seat']), \
         patch.object(sys, 'stdin', io.StringIO(json.dumps(case['hook']))), contextlib.redirect_stdout(io.StringIO()) as out, \
         patch.dict(os.environ, AGENTRIX_TOKEN='fixture', AGENTRIX_SOCKET='fixture', AGENTRIX_SEATS=case['snapshot']):
        try: exec(source, globals or {})
        except SystemExit as e: assert e.code == 0
    event = connect.return_value.__enter__.return_value.sendall
    result = {}
    if out.getvalue(): result['output'] = json.loads(out.getvalue())
    if event.called:
        observed = json.loads(event.call_args[0][0])
        assert observed['v'] == 1
        result['observed'] = {key: observed[key] for key in ('toolUseId','sessionId','model','effort','phase')}
        if 'expected' in observed: result['observed']['expected'] = observed['expected']
    return result
cases = json.loads(${JSON.stringify(JSON.stringify(cases))})
for case in cases:
    assert invoke(case) == case['expected'], case
with tempfile.TemporaryDirectory(prefix='live-ssh-seats-') as directory:
    messages = []
    channel = module['Channel'](1, messages.append)
    channel.worker.temp = directory
    folder = pathlib.Path(directory)
    hook_globals = {'__file__': str(folder / 'notify.py')}
    sidecar = folder / 'dispatch.json.seats'
    old = cases[0]
    new = {'reviewer': {'model': 'sonnet', 'effort': 'medium'}}
    channel.receive({'op': 'claude-lead', 'id': 1, 'claudeLead': {'seatsMap': new}})
    assert messages[-1]['ok']
    assert json.loads(sidecar.read_bytes()) == {'format':'agentrix.seat-map', 'version':1, 'seats':new}
    if os.name != 'nt': assert sidecar.stat().st_mode & 0o777 == 0o600
    assert invoke(old, hook_globals) == cases[2]['expected']
    coder = {'reviewer': {'model': 'gpt-6.2-sol', 'effort': 'high', 'fast': True}}
    channel.receive({'op': 'claude-lead', 'id': 2, 'claudeLead': {'seatsMap': coder}})
    assert messages[-1]['ok']
    warning = invoke(old, hook_globals)
    assert 'dispatch helper' in warning['output']['systemMessage']
    assert warning['observed']['expected'] == coder['reviewer']
    sidecar.write_text(json.dumps({'format':'agentrix.seat-map', 'version':2, 'seats':new}))
    assert invoke(old, hook_globals) == {}
    sidecar.write_text(json.dumps(new))
    assert invoke(old, hook_globals) == cases[2]['expected']
    sidecar.write_text('{"reviewer":{"model":"-bad","effort":"medium"}}')
    assert invoke(old, hook_globals) == old['expected']
    channel.close()
`);
});

test('SSH keeps the versioned launch snapshot fixed while the live seat map changes', t => {
  pythonProbe(t, String.raw`
import contextlib, json, pathlib, runpy, socket, sys, tempfile
from unittest.mock import patch
module = runpy.run_path(sys.argv[1])
new = {'reviewer': {'model': 'sonnet', 'effort': 'medium'}}
coder = {'reviewer': {'model': 'gpt-6.2-sol', 'effort': 'high', 'fast': True}}
with tempfile.TemporaryDirectory(prefix='ssh-launch-seats-') as directory:
    worker = module['Worker'](lambda event: None)
    folder = pathlib.Path(directory)
    worker.coding_root, worker.token = directory, 'fixture'
    worker.claude_lead = {'seatsMap': new, 'launchSeatsMap': coder}
    def install_note(note, native):
        (folder / 'skill-key.txt').write_text('fixture')
        worker.dispatch_server = {'env': {'AGENTRIX_BOOTSTRAP': str(folder / 'dispatch.json')}}
        (folder / 'events.sock').touch()
        return note
    fixtures = (patch.object(worker, 'startup_note', install_note), patch.object(tempfile, 'mkdtemp', return_value=directory),
                patch.object(socket, 'socket'), patch.object(socket, 'AF_UNIX', 1, create=True),
                patch.object(module['threading'], 'Thread'), patch.dict(worker.agent_environment.__globals__, prune_skill_state=lambda *_: None))
    with contextlib.ExitStack() as stack:
        for fixture in fixtures: stack.enter_context(fixture)
        env, _ = worker.agent_environment('', native=True)
    bootstrap = pathlib.Path(env['AGENTRIX_BOOTSTRAP'])
    assert json.loads(bootstrap.with_suffix('.json.seats').read_bytes())['seats'] == new
    launch = bootstrap.with_suffix('.json.launch-seats')
    encoded = {'format':'agentrix.seat-map', 'version':1, 'seats':coder}
    assert json.loads(launch.read_bytes()) == json.loads(env['AGENTRIX_SEATS']) == encoded
    worker.write_claude_lead({'seatsMap': {}})
    assert json.loads(launch.read_bytes()) == encoded
`);
});

const bashSeatProbe = String.raw`
import json, os, pathlib, runpy, shutil, subprocess, sys, tempfile
module = runpy.run_path(sys.argv[1])
bash = os.environ.get('AGENTRIX_TEST_BASH') or shutil.which('bash', path='/usr/bin:/bin')
if not bash:
    print('SKIP Bash missing')
    sys.exit(0)
with tempfile.TemporaryDirectory(prefix='remote-lead-shell-') as directory:
    root = pathlib.Path(directory)
    notify = root / 'notify'
    notify.write_bytes(module['NOTIFY_SOURCE'].encode('utf-8'))
    (root / 'terminal-wire.json').write_text(sys.argv[2], encoding='utf-8')
    stub = root / 'claude'
    stub.write_bytes('''#!/bin/sh
IFS= read -r settings < "$2" || :
fast=0
ultra=0
case $settings in *'"fastMode": true'*) fast=1;; esac
case $settings in *'"ultracode": true'*) ultra=1;; esac
printf 'settings=%s|%s\\n' "$fast" "$ultra"
printf "values=%s|%s|%s" "$ANTHROPIC_DEFAULT_HAIKU_MODEL" "$CLAUDE_CODE_SUBAGENT_MODEL" "$AGENTRIX_SEATS"
shift 2
printf "|%s" "$@"
printf "\\n"
'''.encode('utf-8'))
    stub.chmod(0o700)
    worker = module['Worker'](lambda _event: None)
    worker.temp = directory
    worker.write_claude_lead({'model':'sonnet', 'effort':'high', 'fast':True, 'ultracode':True, 'seatsMap':{}})
    rc = root / 'agentrix.bash'
    rc.write_bytes(module['BASH_SOURCE'].encode('utf-8'))
    probe = '''
source "$1"
__pg_emit() { :; }
PATH="$PWD:$PATH"
[[ $(type -P claude) -ef ./claude ]] || exit 87
claude --resume fixture
claude
claude --version
__pg_role_tools='--mcp-config=fixture'
printf '\\357\\273\\277' > "$AGENTRIX_CLAUDE_LEAD_FILE.env"
printf '%s\\n' 'seats={}' 'ultracode=0' 'effort=medium' 'format=agentrix.lead-seat' 'model=opus' 'version=1' >> "$AGENTRIX_CLAUDE_LEAD_FILE.env"
printf %s 'fast=1' >> "$AGENTRIX_CLAUDE_LEAD_FILE.env"
printf '%s\\n' 'mode=conductor' 'format=agentrix.session-mode' 'version=1' > dispatch.json.mode.env
claude
printf '%s\\n' sonnet high 0 opus haiku '{}' > "$AGENTRIX_CLAUDE_LEAD_FILE"
printf '%s\\n' 'seats={}' 'ultracode=1' 'effort=high' 'format=agentrix.lead-seat' 'model=opus' 'version=71' 'fast=1' > "$AGENTRIX_CLAUDE_LEAD_FILE.env"
printf '%s\\n' 'version=71' 'mode=conductor' 'format=agentrix.session-mode' > dispatch.json.mode.env
claude
rm -- "$AGENTRIX_CLAUDE_LEAD_FILE.env" dispatch.json.mode.env
claude
printf '%s\\n' sonnet high 0 > "$AGENTRIX_CLAUDE_LEAD_FILE"
claude
: > "$AGENTRIX_CLAUDE_LEAD_FILE"
claude
'''
    env = {key: value for key, value in os.environ.items() if not key.startswith(('AGENTRIX_', 'CLAUDE_', 'ANTHROPIC_')) and key != 'BASH_ENV'}
    env.update(HOME=root.as_posix(), AGENTRIX_ROOT=root.as_posix(), AGENTRIX_PYTHON=pathlib.Path(sys.executable).as_posix(),
               AGENTRIX_NOTIFY_FILE=(root/'notify').as_posix(), AGENTRIX_READING_NOTE_FILE=(root/'note').as_posix(),
               AGENTRIX_CLAUDE_LEAD_FILE=(root/'dispatch.json.lead').as_posix(), AGENTRIX_CLAUDE_BACKGROUND_FILE=(root/'policy').as_posix())
    result = subprocess.run([bash, '--noprofile', '--norc', '-c', probe, 'probe', rc.as_posix()], cwd=directory,
                            env=env, encoding='utf-8', stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=90 if sys.platform == 'win32' else 40)
    assert result.returncode == 0, result.stderr
    conversation = ['--model', 'sonnet', '--effort', 'high']
    def seat_map(seats):
        return json.dumps({'format':'agentrix.seat-map', 'version':1, 'seats':seats}, separators=(',', ':'))
    assert [line.split('|') for line in result.stdout.splitlines() if line.startswith('values=')] == [
        ['values=', '', seat_map({}), *conversation, '--resume', 'fixture'],
        ['values=', '', seat_map({}), *conversation],
        ['values=', '', seat_map(None), '--version'],
        ['values=', '', seat_map({}), '--model', 'opus', '--effort', 'medium', '--mcp-config=fixture'],
        ['values=', '', seat_map(None), ''],
        ['values=', '', seat_map({}), *conversation],
        ['values=', '', seat_map(None), *conversation],
        ['values=', '', seat_map(None), ''],
    ], result.stdout
    assert [line for line in result.stdout.splitlines() if line.startswith('settings=')] == [
        'settings=1|1', 'settings=1|1', 'settings=0|0', 'settings=1|0', 'settings=0|0', 'settings=0|0', 'settings=0|0', 'settings=0|0',
    ], result.stdout + result.stderr
    assert result.stderr.splitlines().count('座位文件版本不受支持') == 1, result.stderr
`;

test('SSH Bash applies Fast and Ultracode on conversation launches and reads legacy lead files', {
  skip: process.platform === 'win32' && !process.env.AGENTRIX_TEST_BASH,
}, t => {
  const output = pythonProbe(t, bashSeatProbe, process.platform === 'win32' ? 110_000 : 50_000);
  if (output?.includes('SKIP Bash missing')) t.skip('Bash missing');
});

test('SSH transcript records deliver Ultracode attachments and effort echoes to agent settings', t => {
  const output = pythonProbe(t, String.raw`
import json, pathlib, runpy, sys, tempfile
module = runpy.run_path(sys.argv[1])
worker = module['Worker'](lambda _event: None)
with tempfile.TemporaryDirectory() as directory:
    worker.claude_home = directory
    filename = pathlib.Path(directory, 'projects', 'fixture.jsonl')
    filename.parent.mkdir()
    records = [
        {'type': 'attachment', 'isSidechain': True, 'attachment': {'type': 'ultra_effort_exit'}},
        {'type': 'attachment', 'attachment': {'type': 'ultra_effort_enter', 'private': 'excluded'}},
        {'type': 'user', 'message': {'content': [{'type': 'text', 'text': '<local-command-stdout>Ultracode off. Effort stays max.</local-command-stdout>'}]}},
        {'type': 'user', 'message': {'content': '<local-command-stdout>Set effort level to max (for this session only) · Ultracode on</local-command-stdout>'}},
        {'type': 'attachment', 'attachment': {'type': 'ultra_effort_exit'}},
    ]
    filename.write_text(''.join(json.dumps(row)+'\n' for row in records), encoding='utf-8')
    print(json.dumps(worker.claude_status(str(filename), 1000)['records']))
`);
  if (output == null) return;
  const records = JSON.parse(output);
  assert.deepEqual(records[0].attachment, { type: 'ultra_effort_enter' });
  let state = null;
  assert.deepEqual(records.map(record => (state = agentSettings(state, 'claude', record)).ultracode), [true, false, true, false]);
  assert.equal(state.effort, 'max');
});

test('SSH open carries the background switch and Claude seat, and changes use separate control messages', async t => {
  for (const allow of [false, true]) {
    const sent = [];
    let remote;
    const link = { attach: () => 1, detach() {}, open: message => sent.push(message), send: message => {
      sent.push(message); remote.receive({ type: 'response', id: message.id, ok: true, value: true });
    } };
    const claudeLead = allow ? { model: 'opus', effort: 'high', fast: true, ultracode: true } : null;
    const deliveries = [];
    remote = new RemoteConnection({ path: '/fixture', id: 'fixture', ssh: {} }, {
      auth: {}, integrationDir: path.join(__dirname, '../integration'), allowBackgroundTasks: allow, claudeLead, onEvent: (...args) => deliveries.push(args) }, () => link);
    t.after(() => remote.close());
    assert.equal(sent[0].allowBackgroundTasks, allow);
    assert.deepEqual(sent[0].claudeLead, claudeLead);
    assert.deepEqual(Object.keys(sent[0].dispatchCompanions), ['role-tools.cjs', 'role-artifacts.cjs']);
    assert.ok(Object.keys(sent[0].dispatchCompanions).every(name => !(name in sent[0].dispatchModules)));
    remote.receive({ type: 'ready', info: { root: '/fixture', cwd: '/fixture' } });
    await remote.setBackgroundTasks(!allow);
    assert.equal(sent[1].op, 'claude-background');
    assert.equal(sent[1].allow, !allow);
    const nextLead = { model: 'sonnet', effort: 'low', fast: false };
    await remote.setClaudeLead(nextLead);
    assert.equal(sent[2].op, 'claude-lead');
    assert.deepEqual(sent[2].claudeLead, nextLead);
    const event = { type: 'dispatch-end', seq: 1 }, ack = { type: 'dispatch-ack', seq: 1 };
    remote.receive({ type: 'event', event });
    assert.deepEqual(deliveries, [[event, remote]]);
    remote.ackDispatch(ack);
    assert.equal(sent[3].op, 'dispatch-ack');
    assert.equal(sent[3].ack, ack);
    assert.equal(sent[3].channel, remote.channel);
  }
});

test('routing saves queue only the latest connecting-host update and bound ready-host requests', async () => {
  const { refreshRemoteRouting } = require('../electron/features/ssh/routing.cjs');
  const ready = Promise.withResolvers(), changed = Promise.withResolvers(), requests = [];
  const remote = { connected: false, ready: ready.promise, request: async (...args) => requests.push(args) };
  const callbacks = { bound: () => true, changed: changed.resolve, failed: () => assert.fail('unexpected routing failure') };
  const old = { seatsMap: { designer: { model: 'opus' } } }, next = { seatsMap: { designer: { model: 'sonnet' } } };
  const routing = { effective: next.seatsMap, roles: [] };
  assert.equal(refreshRemoteRouting(remote, old, null, callbacks), null);
  assert.equal(refreshRemoteRouting(remote, next, routing, callbacks), null);
  assert.deepEqual(requests, []);
  remote.connected = true;
  ready.resolve();
  await changed.promise;
  assert.deepEqual(requests, [['claude-lead', { claudeLead: next }, { timeout: 3000 }]]);
  assert.deepEqual(remote.appliedRouting, routing);

  const receipt = Promise.withResolvers(), failed = [];
  remote.request = () => receipt.promise;
  const pending = refreshRemoteRouting(remote, old, null, { ...callbacks, failed: () => failed.push('failed') });
  assert.ok(pending instanceof Promise);
  receipt.reject(new Error('synthetic timeout'));
  await pending;
  assert.deepEqual(failed, ['failed']);
  assert.deepEqual(remote.appliedRouting, routing);

  const modeChanges = [];
  remote.request = async () => {};
  const modeCallbacks = { ...callbacks, changed: modeChanged => modeChanges.push(modeChanged) };
  for (const conductor of [false, true, true, false]) await refreshRemoteRouting(remote, { ...next, conductor }, routing, modeCallbacks);
  assert.deepEqual(modeChanges, [false, true, false, true]);
});
