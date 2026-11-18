const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');

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
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', script,
    path.join(__dirname, '../integration/remote-worker.py')], { encoding: 'utf8', timeout: 20000, windowsHide: true });
  if (result.error?.code === 'ENOENT') { t.skip('Python missing'); return; }
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  if (result.stdout.includes('SKIP Bash Windows')) t.diagnostic('Bash stand-in skipped on Windows: the remote worker runs only on POSIX hosts; policy error and recovery assertions passed');
  if (result.stdout.includes('SKIP Bash missing')) t.diagnostic('Bash missing: policy operation tested; shell check skipped');
});

test('SSH open carries the switch and later changes use the remote control message', async t => {
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
    remote = new module.exports.RemoteConnection({ path: '/fixture', id: 'fixture', ssh: {} }, {
      auth: {}, integrationDir: path.join(__dirname, '../integration'), allowBackgroundTasks: allow });
    t.after(() => remote.close());
    assert.equal(sent[0].allowBackgroundTasks, allow);
    remote.receive({ type: 'ready', info: { root: '/fixture', cwd: '/fixture' } });
    await remote.setBackgroundTasks(!allow);
    assert.equal(sent[1].op, 'claude-background');
    assert.equal(sent[1].allow, !allow);
  }
});
