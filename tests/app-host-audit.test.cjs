const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WorkspaceStore } = require('../electron/state.cjs');
const { retryFileOperation } = require('../electron/file-retry.cjs');
const { writeFileAtomic } = require('../electron/atomic-write.cjs');
const { registerAgentLaunch } = require('../electron/app/application-ipc.cjs');
const { adapterOf } = require('../electron/features/cli-adapters/registry.cjs');
const { createPublicState } = require('../electron/app/public-state.cjs');
const { registerQuit, cleanStaleRuntimeFolders, startNativeWithWarnings } = require('../electron/app/process-lifecycle.cjs');
const { createCloseGuards, createTerminalLifecycle, launchAfterPrompt } = require('../electron/app/terminal-lifecycle.cjs');
const { registerWindowLifecycle } = require('../electron/app/window-events.cjs');
const { createWindowHost, createTranslator } = require('../electron/app/window-host.cjs');
const { createImageTools } = require('../electron/app/images.cjs');
const { RemoteConnection } = require('../electron/remote-connection.cjs');

function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentrix-host-audit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('A1 repeated crashes back off and stop after three reloads with one native notice', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.mock.method(console, 'error', () => {});
  const window = new EventEmitter();
  window.webContents = new EventEmitter();
  const reloads = [], notices = [];
  window.isDestroyed = () => false;
  window.reload = () => reloads.push(Date.now());
  registerWindowLifecycle({ window, getSettings: () => ({ terminalRenderer: 'gpu' }), isQuitting: () => false, showRendererFailure: () => notices.push(true) });
  const gone = (reason = 'crashed') => window.webContents.emit('render-process-gone', null, { reason, exitCode: 1 });
  gone('clean-exit');
  gone(); gone(); t.mock.timers.tick(249);
  assert.deepEqual(reloads, []);
  t.mock.timers.tick(1); gone(); t.mock.timers.tick(500); gone(); t.mock.timers.tick(1000);
  gone(); gone(); t.mock.timers.tick(5000);
  assert.deepEqual(reloads, [250, 750, 1750]);
  assert.deepEqual(notices, [true]);
});

test('A2 an already running terminal cannot keep a plan to launch after its next prompt', async () => {
  const handlers = new Map(), launchPlans = new Map();
  const session = { terminalId: 'fixture', status: 'shell', ready: true, claudeAvailable: true, gate: { afterPrompt: assert.fail } };
  const project = { kind: 'local' };
  registerAgentLaunch({ findProject: () => project, adapterOf, launchPlans, sessions: new Map([['fixture', session]]),
    launchCommand: () => 'claude', startTerminal: () => assert.fail('The terminal already exists.'), broadcast() {} },
  (name, handler) => handlers.set(name, handler));
  assert.equal(await handlers.get('agent:launch')('fixture', 'claude', 'new'), false);
  launchAfterPrompt(project, session, { launchPlans });
  assert.equal(launchPlans.size, 0);
  assert.equal(session.ready, true);
});

test('A4 concurrent quit requests share one confirmation', async () => {
  const answer = Promise.withResolvers(), quits = [], dialogs = [];
  const { requestQuit } = createCloseGuards({ app: { quit: () => quits.push(true) }, sessions: new Map([['fixture', { status: 'shell' }]]),
    dialog: { showMessageBox: () => { dialogs.push(true); return answer.promise; } }, getWindow: () => ({}), t: text => text,
    allowEditorClose: async () => true, setQuitting() {} });
  const first = requestQuit(), second = requestQuit();
  assert.equal(first, second);
  answer.resolve({ response: 1 });
  assert.equal(await second, true);
  assert.deepEqual(dialogs, [true]);
  assert.deepEqual(quits, [true]);
});

test('B1 and B5 native errors are logged and every warning reaches the workspace snapshot', async t => {
  const file = path.join(temp(t), 'workspace.json');
  fs.writeFileSync(file, '{cut');
  const store = new WorkspaceStore(file), backup = store.warnings[0], tText = createTranslator(() => store);
  const error = new Error('unavailable'), reported = [], failed = [];
  await startNativeWithWarnings({ store, start: async () => { throw error; }, onFailure: () => failed.push(true),
    recover: () => ['recovery warning'], report: issue => reported.push(issue) });
  store.warning = 'upgrade warning';
  store.warning = 'upgrade warning';
  const { publicState } = createPublicState({ store, app: { getVersion: () => 'test' }, t: tText, localShell: () => ({ kind: 'bash' }) });
  assert.deepEqual(reported, [error]);
  assert.deepEqual(failed, [true]);
  assert.deepEqual(store.warnings, [backup, '原生会话暂不可用，已保留终端模式。', 'recovery warning', 'upgrade warning']);
  assert.equal(publicState().warning, store.warnings.map(tText).join(' '));
});

test('A3, B2 and B6 shutdown continues after individual errors and stops waiting for a hung worker', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const directory = temp(t), runtimeDir = fs.mkdtempSync(path.join(directory, 'runtime-'));
  const reports = [], actions = [], completed = Promise.withResolvers();
  const app = new EventEmitter();
  app.getPath = () => directory;
  app.quit = () => completed.resolve();
  const locked = Object.assign(new Error('runtime locked'), { code: 'EPERM' });
  const fakeFs = { ...fs, rmSync: () => { throw locked; } };
  registerQuit({ app, platform: 'win32', runtimeDir, path, fs: fakeFs, quitTimeout: 100,
    retryFileOperation: operation => retryFileOperation(operation, { platform: 'win32' }),
    report: error => reports.push(error), disposeDispatchInbox: () => { throw new Error('inbox'); },
    nativeSessions: { close: () => { throw new Error('native'); } }, claudeRuntime: { close: () => Promise.reject(new Error('runtime')) },
    projectAccounts: { close: () => actions.push('accounts') }, disposeClaudeAccounts() {}, codexAccounts: { dispose() {} }, claudeAccounts: { dispose() {} },
    sessions: new Map([['a', {}], ['b', {}]]), disposeTerminal: id => { actions.push(id); if (id === 'a') throw new Error('terminal'); },
    workerTerminals: { closeAll: () => { actions.push('workers'); return new Promise(() => {}); } },
    eventServer: { close: () => actions.push('event server') }, cleanupAskpass: () => actions.push('askpass'), dashboard: { waitForQuit: () => null } });
  let prevented = 0;
  const beforeQuit = () => app.emit('before-quit', { preventDefault: () => prevented++ });
  beforeQuit(); beforeQuit(); t.mock.timers.tick(100);
  await completed.promise;
  beforeQuit();
  assert.equal(prevented, 2);
  assert.deepEqual(actions, ['accounts', 'a', 'b', 'workers', 'event server', 'askpass']);
  assert.deepEqual(reports.map(error => error.message).sort(), ['Timed out waiting for shutdown cleanup.', 'inbox', 'native', 'runtime', 'runtime locked', 'terminal']);
});

test('C1 and F1 stale runtime files are removed while this run, ordinary files and junctions are preserved', t => {
  const directory = temp(t), current = path.join(directory, 'runtime-Current'), old = path.join(directory, 'runtime-Old');
  const unrelated = path.join(directory, 'saved'), link = path.join(directory, 'runtime-Link');
  for (const folder of [current, old, unrelated]) fs.mkdirSync(folder);
  fs.symlinkSync(unrelated, link, 'junction');
  fs.writeFileSync(path.join(old, 'bootstrap.json'), 'synthetic fixture');
  fs.writeFileSync(path.join(current, 'bootstrap.json'), 'current launch');
  fs.writeFileSync(path.join(unrelated, 'keep'), 'outside runtime');
  fs.writeFileSync(path.join(directory, 'runtime-File'), 'regular file');
  cleanStaleRuntimeFolders({ fs, path, retryFileOperation, report: assert.fail }, directory, current);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.readFileSync(path.join(current, 'bootstrap.json'), 'utf8'), 'current launch');
  assert.equal(fs.readFileSync(path.join(link, 'keep'), 'utf8'), 'outside runtime');
  assert.equal(fs.readFileSync(path.join(directory, 'runtime-File'), 'utf8'), 'regular file');
});

test('startup removes abandoned worker hook settings with their runtime and preserves the current runtime', t => {
  const directory = temp(t);
  const [old, current] = ['runtime-Old', 'runtime-Current'].map(name => path.join(directory, name));
  const settings = runtime => path.join(runtime, 'worker-synthetic', 'settings.json');
  for (const runtime of [old, current]) {
    fs.mkdirSync(path.dirname(settings(runtime)), { recursive: true });
    fs.writeFileSync(settings(runtime), '{"hooks":"private fixture"}');
  }
  cleanStaleRuntimeFolders({ fs, path, retryFileOperation, report: assert.fail }, directory, current);
  assert.equal(fs.existsSync(settings(old)), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(settings(current), 'utf8')), { hooks: 'private fixture' });
});

test('B7 a continuation error is reported without recording a session startup failure', async () => {
  const opened = { runtimeSessionId: 'fixture' }, error = new Error('continuation failed'), reported = [], startupErrors = new Map();
  const lifecycle = createTerminalLifecycle({ store: { findTerminal: () => ({ project: { path: 'fixture' }, record: {
    restore: { nativeTransport: 'claude-sdk', threadId: 'thread', interrupted: true, agent: 'claude' },
  } }) }, adapterOf: () => ({ nativePolicy: { canContinueInterrupted: true } }), restorePlans: new Map(),
  nativeSessions: { start: async () => opened, continueInterrupted: async () => { throw error; } },
  startupErrors, report: failure => reported.push(failure), broadcast() {} });
  assert.equal(await lifecycle.restoreTerminal('fixture'), opened);
  assert.deepEqual(reported, [error]);
  assert.equal(startupErrors.size, 0);
});

test('C3 unreadable dispatch files are detected before attaching an SSH connection', t => {
  const directory = temp(t), dispatch = path.join(directory, 'dispatch.cjs');
  fs.writeFileSync(dispatch, "exports.runtimeFiles = () => ({}); exports.dispatchCompanions = ['missing.cjs'];");
  let connects = 0;
  assert.throws(() => new RemoteConnection({ path: '/fixture', ssh: {} }, { integrationDir: directory }, () => { connects++; }), { code: 'ENOENT' });
  assert.equal(connects, 0);
});

test('C6 oversized network images cancel before decoding, including without Content-Length', async () => {
  const { pictureFrom } = createImageTools({ nativeImage: { createFromBuffer: () => assert.fail('Oversized image was decoded.') },
    previewResources: { hasUrl: () => false } });
  for (const declared of [true, false]) {
    const chunk = new Uint8Array(10 * 1024 * 1024);
    let pulls = 0, cancels = 0;
    const stream = new ReadableStream({ pull(controller) { pulls++; controller.enqueue(chunk); }, cancel() { cancels++; } }, { highWaterMark: 0 });
    const response = new Response(stream, { headers: declared ? { 'content-length': String(chunk.length * 6) } : {} });
    assert.equal(await pictureFrom({ session: { fetch: async () => response } }, 'https://example.invalid/image'), null);
    assert.equal(pulls, declared ? 0 : 6);
    assert.equal(cancels, 1);
  }
});

test('E3 atomic replacement retries transient Windows rename failures', { skip: process.platform !== 'win32' }, t => {
  const directory = temp(t), file = path.join(directory, 'note'), rename = fs.renameSync;
  fs.writeFileSync(file, 'old');
  let attempts = 0;
  t.mock.method(fs, 'renameSync', (source, target) => {
    if (++attempts < 3) throw Object.assign(new Error('locked'), { code: 'EPERM' });
    return rename(source, target);
  });
  writeFileAtomic(file, 'new');
  assert.equal(fs.readFileSync(file, 'utf8'), 'new');
  assert.deepEqual(fs.readdirSync(directory), ['note']);
  assert.equal(attempts, 3);
});

test('H1 a destroyed window is never flashed and the completion notification still appears', () => {
  const seen = [];
  class Notification {
    static isSupported() { return true; }
    constructor(options) { this.options = options; }
    on() {}
    show() { seen.push(this.options.title); }
  }
  const host = createWindowHost({ window: { isDestroyed: () => true, isFocused: assert.fail, flashFrame: assert.fail },
    store: { settings: { notifications: true } }, Notification, t: (text, values) => text.replace('{name}', values?.name ?? ''), path, root: os.tmpdir() });
  host.notifyCompletion({ name: 'Example' });
  assert.deepEqual(seen, ['Example · 本轮已完成']);
});
