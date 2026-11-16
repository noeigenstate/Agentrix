// A Claude runtime and its native sessions on fakes only: a temporary home, project and data folder, a fake SDK whose
// initialize reports the billing source it is given, a fake API that answers the key check, and a CLI check that says
// what it is told. Nothing reaches the real API, the real CLI or the owner's ~/.claude.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createClaudeRuntime } = require('../../electron/features/claude-sdk/index.cjs');
const { createNativeSessions } = require('../../electron/features/native-session/index.cjs');
const { fakeSdk } = require('./claude-sdk.cjs');
const { terminalPreparation } = require('./native-switch.cjs');

const KEY = 'sk-ant-api03-route-offline-only';
const safeStorage = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value).reverse(), decryptString: value => Buffer.from(value).reverse().toString() };
// What the fake API answers the key check with: its status code (null: it never answers) and body.
const ANSWERS = {
  ok: [200, '{"data":[{"id":"synthetic"}]}'],
  invalid: [401, '{"error":{"type":"authentication_error","message":"invalid x-api-key"}}'],
  credits: [400, '{"error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}'],
  unreachable: [null, null],
};

// key: 'ok', 'missing' (none saved), 'invalid', 'credits' or 'unreachable'; cli: what the CLI check returns; billing: the
// apiKeySource the SDK's initialize reports.
function routeFixture(t, { mode = 'api-then-terminal', key = 'ok', cli = { status: 'ok', version: '2.1.318' }, billing = 'ANTHROPIC_API_KEY' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-route-')), home = path.join(root, 'home'), project = path.join(root, 'project');
  const data = path.join(root, 'data'), fake = fakeSdk(), terminals = [];
  for (const folder of [home, project, data]) fs.mkdirSync(folder, { recursive: true });
  let source = billing;
  const query = fake.sdk.query;
  fake.sdk.query = input => ({ ...query(input), initializationResult: async () => ({ account: { apiKeySource: source, tokenSource: 'none' } }) });
  const spec = { agent: 'claude', owner: 'gui', projectId: 'p', terminalId: 't', runtimeSessionId: 'r', cwd: project,
    env: { PATH: '', HOME: home, USERPROFILE: home, APPDATA: home } };
  const request = (_url, _options, callback) => {
    const req = new EventEmitter(); req.destroy = () => {};
    req.end = () => queueMicrotask(() => {
      const [status, body] = ANSWERS[key] || ANSWERS.ok;
      if (status === null) { req.emit('error', new Error('offline')); return; }
      const response = new PassThrough(); response.statusCode = status; callback(response); response.end(body);
    });
    return req;
  };
  const runtime = createClaudeRuntime({ directory: data, safeStorage, loadSdk: async () => fake.sdk, resolveExecutable: async () => 'synthetic-only',
    inspectCli: async () => cli, connectionSpec: projectId => ({ ...spec, projectId }), request });
  if (key !== 'missing') runtime.credentials.save(KEY);
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ claudePath: mode, codexView: 'native' }));
  const native = createNativeSessions({ directory: data, claude: runtime, prepareTerminal: terminalPreparation(() => {}),
    resolveSpec: id => ({ ...spec, terminalId: id }), terminal: async (value, reason) => terminals.push({ spec: value, reason }), emit() {} });
  t.after(async () => { await native.close(); await runtime.close(); fs.rmSync(root, { recursive: true, force: true }); });
  // The path a new session takes ('api', 'terminal', or null when it is refused) and the reason it was told.
  async function newSession(id) {
    let started;
    try { started = await native.start(id, { agent: 'claude' }); } catch (error) { return { path: null, reason: error.message }; }
    const changed = native.snapshot(id).events.findLast(event => event.type === 'path.changed').payload;
    return { path: changed.selected === 'api' ? 'api' : 'terminal', reason: changed.reason, runtimeSessionId: started.runtimeSessionId };
  }
  return { root, home, project, spec, fake, runtime, native, terminals, newSession, billing: value => { source = value; } };
}

module.exports = { routeFixture };
