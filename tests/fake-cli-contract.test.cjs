// G5: a fake CLI only proves what it was made to answer, so every program in this repository that stands in for Claude Code
// or Codex is found by what it says (tests/helpers/stand-ins.cjs), listed in tests/fixtures/stand-ins.json, and made to answer
// what it is asked: --version at once with nothing written, the --settings and hooks it is given (Claude Code), and the sandbox
// and approvals of thread/start (Codex). A new stand-in fails here until it is registered; there is no list to forget.
// Only offline child processes in a temporary folder run here.
require('./fixtures/team-isolation.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), readline = require('node:readline');
const { spawn, spawnSync } = require('node:child_process');
const { root, SIGNATURE, discover, registry } = require('./helpers/stand-ins.cjs');

const VERSION = { claude: /^\d+\.\d+\.\d+ \(Claude Code\)\r?\n$/, codex: /^codex-cli \d+\.\d+\.\d+\r?\n$/ };
const TYPES = { 'read-only': 'readOnly', 'workspace-write': 'workspaceWrite', 'danger-full-access': 'dangerFullAccess' };
// What the CLI gets from Agentrix: HTTP hooks, except SessionStart, which stays a command.
const SETTINGS = { hooks: {
  SessionStart: [{ hooks: [{ type: 'command', command: 'powershell.exe -File claude-hook.ps1 -Kind session', timeout: 10 }] }],
  UserPromptSubmit: [{ hooks: [{ type: 'http', url: 'http://127.0.0.1:1/h/terminal-1/UserPromptSubmit', headers: { 'X-Agentrix-Key': 'key-1' }, timeout: 10 }] }],
  PermissionRequest: [{ hooks: [{ type: 'http', url: 'http://127.0.0.1:1/h/terminal-1/PermissionRequest', headers: { 'X-Agentrix-Key': 'key-1' }, timeout: 600 }] }],
} };
const { standIns: entries, notStandIns } = registry();
const csc = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
const compiled = new Map();

const live = Object.entries(entries).filter(([, entry]) => !entry.pending);
const folder = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const remove = directory => fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
// The environment a stand-in gets: nothing of the real machine, every home inside the throwaway folder.
const environment = (home, extra = {}) => ({ PATH: path.dirname(process.execPath), SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home,
  CODEX_HOME: home, CLAUDE_CONFIG_DIR: home, AGENTRIX_FAKE_OUTPUT: home, ...extra });

// A node stand-in runs as `node <file> <args>`; a C# one is compiled once into a folder of its own and runs as the program.
function command(t, file, entry) {
  if (entry.build === 'node') return { file: process.execPath, prefix: [path.join(root, file)] };
  if (process.platform !== 'win32' || !fs.existsSync(csc)) return null;
  if (!compiled.has(file)) {
    const output = folder('agx-standin-cs-'); t.after(() => remove(output));
    const exe = path.join(output, path.basename(file, '.cs') + '.exe');
    const built = spawnSync(csc, ['/nologo', '/target:exe', '/reference:System.Web.Extensions.dll', `/out:${exe}`, path.join(root, file)], { windowsHide: true, encoding: 'utf8' });
    assert.equal(built.status, 0, `${file} does not compile: ${built.stdout}${built.stderr}`);
    compiled.set(file, exe);
  }
  return { file: compiled.get(file), prefix: [] };
}

function run(t, file, entry, args, extra = {}) {
  const how = command(t, file, entry);
  if (!how) { t.skip(`${file} is compiled with csc.exe, which is on Windows only`); return null; }
  const home = folder('agx-standin-'), echo = path.join(folder('agx-echo-'), 'echo.json');
  t.after(async () => { await remove(home); await remove(path.dirname(echo)); });
  const result = spawnSync(how.file, [...how.prefix, ...args], { cwd: home, env: environment(home, { AGENTRIX_STAND_IN_ECHO: echo, ...extra }), encoding: 'utf8', windowsHide: true, input: '', timeout: 30000 });
  return { ...result, home, echo: fs.existsSync(echo) ? JSON.parse(fs.readFileSync(echo, 'utf8')) : null, left: fs.readdirSync(home) };
}

test('every Claude and Codex stand-in found under tests/ and scripts/ is registered in tests/fixtures/stand-ins.json and echoes the settings, hooks, sandbox and approvals it is given', () => {
  const found = discover(), listed = [...Object.keys(entries), ...Object.keys(notStandIns)].sort();
  // Discovery itself must work: the stand-ins known today are found, so an empty scan cannot pass for a full registry.
  for (const file of ['tests/fixtures/codex-app-server.cjs', 'tests/fixtures/gui-codex-app-server.cjs', 'tests/fixtures/claude-sdk-cli.cjs', 'tests/fixtures/restore-codex.cs', 'tests/fixtures/dispatch-worker.cjs']) assert.ok(found.includes(file), `${file} is no longer found`);
  assert.deepEqual(found.filter(file => !listed.includes(file)), [], 'stand-ins found but not registered in tests/fixtures/stand-ins.json');
  assert.deepEqual(listed.filter(file => !found.includes(file)), [], 'registered files that are no stand-in any more, or are gone');
  // A smoke script cannot be run alone (running it starts the app), so a stand-in written out by one lives in tests/fixtures and the script points at it.
  assert.deepEqual(found.filter(file => !file.startsWith('tests/fixtures/')), [], 'move these stand-ins into tests/fixtures');
  for (const [file, entry] of Object.entries(entries)) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.ok(['node', 'csc'].includes(entry.build), `${file}: build is node or csc`);
    if (entry.pending) { assert.match(entry.note || '', /\S/, `${file} is pending without saying why`); continue; }
    // The checks below run from the registry, so an entry that names none would pass by doing nothing.
    assert.ok(entry.recorder || entry.launches?.length, `${file} names no launch to check --version and the echo on`);
    // Answering thread/start is a fact about the source, so the registry cannot leave out the sandbox check.
    assert.equal(Boolean(entry.appServer), /['"]thread\/start['"]/.test(source), `${file}: appServer is listed exactly when the file answers thread/start`);
    for (const mode of Object.keys(entry.deliberate || {})) assert.ok(source.includes(mode.split('=')[1]), `${file} is excused for mode ${mode}, which it no longer has`);
    for (const launch of entry.launches || []) assert.ok(VERSION[launch.product], `${file}: unknown product ${launch.product}`);
  }
  for (const [file, reason] of Object.entries(notStandIns)) assert.match(reason, /\S/, `${file} is excused without a reason`);
  assert.ok(SIGNATURE.test("send({ method: 'thread/start' })") && SIGNATURE.test('class X { static void Main() {} }'), 'the signature sees both kinds of stand-in');
});

for (const [file, entry] of live.filter(([, entry]) => entry.launches)) for (const launch of entry.launches) {
  test(`${file} ${launch.args.join(' ')}: answers its ${launch.product} version at once and writes nothing`, t => {
    const result = run(t, file, entry, launch.args);
    if (!result) return;
    assert.equal(result.status, 0, `${file}: ${result.stderr}`);
    assert.match(result.stdout, VERSION[launch.product]);
    assert.equal(result.stderr, '');
    assert.deepEqual(result.left, [], `${file} wrote to its own folder while answering --version`);
  });

  if (entry.build !== 'node') continue;
  if (launch.product === 'claude') for (const form of ['file', 'inline']) test(`${file} ${launch.args.join(' ')}: echoes the --settings it is given as ${form === 'file' ? 'a file' : 'inline JSON'}, and the hooks in them`, t => {
    const settingsFile = path.join(folder('agx-settings-'), 'settings.json'); t.after(() => remove(path.dirname(settingsFile)));
    fs.writeFileSync(settingsFile, JSON.stringify(SETTINGS));
    const given = form === 'file' ? settingsFile : JSON.stringify(SETTINGS);
    const result = run(t, file, entry, [...launch.args, '--settings', given]);
    assert.equal(result.status, 0, `${file}: ${result.stderr}`);
    assert.deepEqual(result.echo, { argv: [...launch.args, '--settings', given], settings: SETTINGS, hooks: SETTINGS.hooks });
    // The hooks echoed are the ones Agentrix generates: HTTP everywhere except the SessionStart command.
    assert.deepEqual(Object.entries(result.echo.hooks).flatMap(([event, groups]) => groups.flatMap(group => group.hooks.map(hook => [event, hook.type]))),
      [['SessionStart', 'command'], ['UserPromptSubmit', 'http'], ['PermissionRequest', 'http']]);
  });
  else test(`${file} ${launch.args.join(' ')}: echoes the arguments it is given and has no hooks`, t => {
    const result = run(t, file, entry, launch.args);
    assert.deepEqual(result.echo, { argv: launch.args, settings: null, hooks: null });
  });
}

// What a Codex app-server stand-in answers to thread/start: the sandbox and approvals it was asked for, as Codex does. The runtime
// stops a start whose sandbox differs from the request, so a stand-in that answers one fixed sandbox fails a smoke only on the
// platform that runs it (1.4.2's macOS packaged smoke). Modes that answer another sandbox on purpose are named in the registry.
async function startAppServer(t, file, entry) {
  const home = folder('agx-standin-'), fixture = path.join(home, 'dispatch-fixture.json');
  fs.writeFileSync(fixture, JSON.stringify({ sessionId: '11111111-1111-4111-8111-111111111111' }));
  // Every input a stand-in here reads, each inside the temporary folder.
  const env = environment(home, { AGENTRIX_FAKE_OUTPUT: home, DISPATCH_FIXTURE: fixture, DISPATCH_CAPTURE: path.join(home, 'capture.json'),
    AGENTRIX_QUESTION_TRIGGER: path.join(home, 'never'), AGENTRIX_QUESTION_ANSWERED: path.join(home, 'answered.json') });
  const child = spawn(process.execPath, [path.join(root, file), ...entry.appServer], { cwd: home, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = new Promise(resolve => child.once('close', resolve));
  // The folder is the stand-in's working directory: it goes once the process has closed.
  t.after(async () => { child.stdin.end(); child.kill(); await closed; await remove(home); });
  const waiting = new Map(); let next = 0, stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  readline.createInterface({ input: child.stdout }).on('line', line => {
    let message; try { message = JSON.parse(line); } catch { return; }
    if (message.id != null && !message.method) waiting.get(message.id)?.(message);
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++next; waiting.set(id, resolve);
    closed.then(() => reject(new Error(`${file} exited before answering ${method}: ${stderr.slice(-400)}`)));
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  await request('initialize', { clientInfo: { name: 'standin-guard', version: '1.0.0' }, capabilities: { experimentalApi: true } });
  child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
  return { request, home };
}

for (const [file, entry] of live.filter(([, entry]) => entry.appServer)) test(`${file} answers thread/start with the sandbox and approvals asked for`, async t => {
  const { request, home } = await startAppServer(t, file, entry);
  for (const [sandbox, approvalPolicy] of [['danger-full-access', 'never'], ['workspace-write', 'on-request'], ['read-only', 'on-request']]) {
    const { result, error } = await request('thread/start', { cwd: home, sandbox, approvalPolicy, approvalsReviewer: 'user' });
    assert.equal(error, undefined, `${file}: ${JSON.stringify(error)}`);
    assert.equal(result.sandbox?.type, TYPES[sandbox], `${file} answers ${sandbox} as ${result.sandbox?.type}`);
    assert.equal(result.approvalPolicy, approvalPolicy, `${file} answers approval ${approvalPolicy} as ${result.approvalPolicy}`);
  }
  // A request without a sandbox ("config") is answered with the stand-in's own configuration, which is one of Codex's sandboxes.
  const { result } = await request('thread/start', { cwd: home, approvalsReviewer: 'user' });
  assert.ok(Object.values(TYPES).includes(result.sandbox?.type), `${file} answers a request without a sandbox with ${JSON.stringify(result.sandbox)}`);
});

test('the argument recorder echoes every argument it is started with, and nothing else, in the file it is told', t => {
  const [file, entry] = Object.entries(entries).find(([, item]) => item.recorder);
  const how = command(t, file, entry);
  if (!how) return t.skip(`${file} is compiled with csc.exe, which is on Windows only`);
  const home = folder('agx-standin-'); t.after(() => remove(home));
  const record = path.join(home, 'argv.jsonl'), args = ['--version', '--settings', '{"hooks":{}}', 'app-server', '中文'];
  const result = spawnSync(how.file, args, { cwd: home, env: environment(home, { ARGV_RECORDER_FILE: record }), encoding: 'utf8', windowsHide: true, input: '', timeout: 30000 });
  assert.equal(result.status, 7);
  // The recorder escapes every character as \uXXXX, so reading it back is JSON.parse.
  assert.deepEqual(fs.readFileSync(record, 'utf8').trim().split('\n').map(line => JSON.parse(line).args), [args]);
  assert.deepEqual(fs.readdirSync(home), ['argv.jsonl']);
});

test('a stand-in that lane L-c is still changing is registered with its reason, and its checks run once L-c merges', t => {
  const pending = Object.entries(entries).filter(([, entry]) => entry.pending);
  for (const [file, entry] of pending) t.diagnostic(`${file}: pending ${entry.pending}`);
  assert.deepEqual(pending.map(([, entry]) => entry.pending), pending.map(() => 'L-c'), 'only lane L-c has stand-ins pending');
});
