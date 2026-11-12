// Every program in this repository that stands in for the Codex app-server answers thread/start with the sandbox and approvals it was asked
// for, as Codex does. The runtime stops a start whose sandbox differs from the request, so a stand-in that answers one fixed sandbox fails a
// smoke only on the platform that runs it (1.4.2's macOS packaged smoke). Stand-ins are found by what they answer, not by a list: a new one
// is checked as soon as it exists. Only offline child processes in a temporary folder run here.
require('./fixtures/team-isolation.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), readline = require('node:readline');
const { spawn } = require('node:child_process');

const root = path.join(__dirname, '..');
const TYPES = { 'read-only': 'readOnly', 'workspace-write': 'workspaceWrite', 'danger-full-access': 'dangerFullAccess' };
// How a stand-in is started when it needs more than `node <file> app-server --listen stdio://`. A new stand-in runs with the default.
const LAUNCH = { 'tests/fixtures/claude-sdk-cli.cjs': ['codex', 'app-server', '--listen', 'stdio://'] };
// Modes that answer another sandbox on purpose; the default mode, checked here, echoes. They are named so a reader knows they are not a slip.
const DELIBERATE = {
  'tests/fixtures/codex-app-server.cjs': {
    'SYNTHETIC_CODEX_MODE=windows-sandbox': 'answers read-only until the request carries the unelevated Windows sandbox, for the retry tests',
    'SYNTHETIC_CODEX_MODE=sandbox-persist': 'keeps the sandbox of an earlier start for a resume that asks none, for the stored-policy test',
  },
};
// Files that name thread/start without answering it (none yet).
const NOT_STANDINS = {};

function standIns() {
  const found = [];
  for (const folder of ['tests/fixtures', 'scripts']) {
    for (const name of fs.readdirSync(path.join(root, folder), { recursive: true })) {
      const file = path.posix.join(folder, String(name).replaceAll('\\', '/'));
      if (!/\.(c|m)?js$/.test(file) || Object.hasOwn(NOT_STANDINS, file)) continue;
      if (/['"]thread\/start['"]/.test(fs.readFileSync(path.join(root, file), 'utf8'))) found.push(file);
    }
  }
  return found.sort();
}

async function ask(t, file) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-standin-'));
  const fixture = path.join(home, 'dispatch-fixture.json');
  fs.writeFileSync(fixture, JSON.stringify({ sessionId: '11111111-1111-4111-8111-111111111111' }));
  // Every input a stand-in here reads, each inside the temporary folder.
  const env = { PATH: path.dirname(process.execPath), SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home, CODEX_HOME: home,
    AGENTRIX_FAKE_OUTPUT: home, DISPATCH_FIXTURE: fixture, DISPATCH_CAPTURE: path.join(home, 'capture.json'),
    AGENTRIX_QUESTION_TRIGGER: path.join(home, 'never'), AGENTRIX_QUESTION_ANSWERED: path.join(home, 'answered.json') };
  const child = spawn(process.execPath, [path.join(root, file), ...(LAUNCH[file] || ['app-server', '--listen', 'stdio://'])], { cwd: home, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = new Promise(resolve => child.once('close', resolve));
  // The folder is the stand-in's working directory: it goes once the process has closed.
  t.after(async () => { child.stdin.end(); child.kill(); await closed; await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
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

test('every Codex app-server stand-in is found, and only deliberate modes are excused', () => {
  const found = standIns();
  // The stand-ins known today must be among those found, or discovery itself is broken.
  for (const file of ['tests/fixtures/codex-app-server.cjs', 'tests/fixtures/gui-codex-app-server.cjs', 'tests/fixtures/claude-sdk-cli.cjs']) assert.ok(found.includes(file), file);
  for (const file of Object.keys(DELIBERATE)) assert.ok(found.includes(file), `${file} is excused for a mode but is no stand-in any more`);
  // A stand-in written out by a smoke script cannot be run alone (running the script would start the app): it lives in tests/fixtures, as
  // native-question-smoke's does, and the script points at it.
  assert.deepEqual(found.filter(file => !file.startsWith('tests/fixtures/')), [], 'move these stand-ins into tests/fixtures');
});

for (const file of standIns().filter(file => file.startsWith('tests/fixtures/'))) test(`${file} answers thread/start with the sandbox and approvals asked for`, async t => {
  const { request, home } = await ask(t, file);
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
