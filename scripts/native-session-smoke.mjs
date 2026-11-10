// Isolated desktop checks: default mode feeds renderer events for UI acceptance; --runtime drives the actual main,
// SDK import and provider adapters against offline native executable fixtures. Neither mode uses real credentials or accounts.
import { testRun } from './test-output.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import { _electron as electron } from 'playwright-core';
import { waitFor, timeoutScale } from './wait.mjs';
import { withGuiLock } from './gui-lock.mjs';
import { chooseFromAppMenu } from './app-menu-helper.mjs';

const require = createRequire(import.meta.url), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { isolatedEnvironment } = require('./native-approval-probe.cjs');
const { createSmokeStages, closeSmokeApplication, offlineStorage } = require('../tests/fixtures/claude-sdk-smoke.cjs');
const packaged = process.argv.includes('--packaged');
const coldStart = process.argv.includes('--cold-start');

// xvfb-run supplies display access; credential isolation must not strip it before Electron starts.
export function displayEnvironment(inherited = process.env, platform = process.platform) {
  return platform === 'linux' ? Object.fromEntries(['DISPLAY', 'XAUTHORITY'].filter(name => inherited[name]).map(name => [name, inherited[name]])) : {};
}
export const desktopEnvironment = (home, inherited = process.env, platform = process.platform) =>
  ({ ...isolatedEnvironment(home, inherited), ...displayEnvironment(inherited, platform) });

// Also runs before either desktop mode. This exercises the real coordinator/router and provider adapters with local
// peers, including real main input/activation callbacks, handoff timeouts, policy retirement and N3/N5/N6.
export async function switchContracts(output, stages) {
  // A10 adds SSH transport, standalone helper startup and retired-path guards.
  // Keep a bounded process deadline with five seconds for diagnostics/cleanup.
  const timeout = 45000;
  // Git-backed worker fixtures must fit Windows path limits even when the
  // checkout and its .test-output live below a long dispatch scratch path.
  const temporaryRoot = await fs.realpath(os.tmpdir());
  const home = await fs.mkdtemp(path.join(temporaryRoot, 'agx-switch-'));
  const files = (await fs.readdir(path.join(root, 'tests'))).filter(name => /^native-switch-.*\.test\.cjs$/.test(name)
    || ['native-worker-finish.test.cjs', 'claude-sdk-switch.test.cjs', 'codex-app-server-sandbox.test.cjs',
      'native-session-ui.test.cjs', 'prompt-source.test.cjs', 'codex-only-main.test.cjs', 'native-codex-path.test.cjs',
      'agent-calls-liveness.test.cjs', 'usage-refresh.test.cjs', 'claude-sdk-rereview2.test.cjs', 'claude-sdk-review3.test.cjs', 'claude-sdk-review4.test.cjs',
      'native-project-accounts.test.cjs', 'native-router-usage.test.cjs', 'native-worker-claude.test.cjs',
      'native-worker-codex-finish.test.cjs', 'dispatch-interventions.test.cjs', 'dispatch-events.test.cjs',
      'native-commands.test.cjs', 'native-commands-codex.test.cjs', 'claude-sdk-provenance.test.cjs', 'native-api-quota.test.cjs',
      'codex-auto-reset.test.cjs', 'codex-auto-reset-runtime.test.cjs', 'codex-auto-reset-main.test.cjs',
      'r13-history.test.cjs', 'r13-review2.test.cjs', 'restore-owner-stop.test.cjs', 'shell-delivery.test.cjs', 'native-large-frames.test.cjs', 'native-parity-backend.test.cjs', 'native-parity-review.test.cjs', 'native-ui-backend.test.cjs', 'native-shell.test.cjs', 'session-restore.test.cjs', 'agent-calls.test.cjs',
      'ssh-codex.test.cjs', 'codex-app-server-only.test.cjs', 'dispatch-startup.test.cjs'].includes(name));
  await stages.run('switch contracts: Claude handoffs, Codex app-server only, drafts, rollback and no duplicate notifications', async () => {
    const child = spawn(process.execPath, ['--test', ...files.map(name => path.join(root, 'tests', name))], {
      cwd: root, windowsHide: true, env: { ...desktopEnvironment(home), TEMP: home, TMP: home, GIT_CEILING_DIRECTORIES: home }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', data => { log += data; }); child.stderr.on('data', data => { log += data; });
    const timer = setTimeout(() => {
      if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 3000 });
      else child.kill('SIGKILL');
    }, timeout);
    try {
      const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
      await fs.writeFile(path.join(output, 'switch-contracts.log'), log);
      assert.equal(code, 0, log.slice(-6000));
    } finally {
      clearTimeout(timer);
      assert.equal(path.dirname(home), temporaryRoot);
      await fs.rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }, timeout + 5000);
}

export async function prepareProviders(directory) {
  const bin = path.join(directory, 'bin'), cli = path.join(directory, 'fake-cli.cjs');
  await fs.mkdir(bin, { recursive: true });
  await fs.copyFile(path.join(root, 'tests/fixtures/claude-sdk-cli.cjs'), cli);
  if (process.platform === 'win32') {
    const compiler = path.join(process.env.SystemRoot || 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
    const source = path.join(directory, 'launcher.cs');
    await fs.writeFile(source, require('../tests/fixtures/claude-sdk-launcher.cjs').source);
    const result = spawnSync(compiler, ['/nologo', '/target:exe', `/out:${path.join(bin, 'claude.exe')}`, source], { windowsHide: true, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    await fs.copyFile(path.join(bin, 'claude.exe'), path.join(bin, 'codex.exe'));
  } else for (const name of ['claude', 'codex']) {
    await fs.writeFile(path.join(bin, name), `#!/bin/sh\nexec "$AGENTRIX_FAKE_NODE" "$AGENTRIX_FAKE_CLI" ${name} "$@"\n`, { mode: 0o755 });
    await fs.chmod(path.join(bin, name), 0o755);
  }
  return { bin, cli };
}
async function executable() {
  const supplied = process.argv.indexOf('--executable');
  if (supplied >= 0) return path.resolve(process.argv[supplied + 1]);
  if (!packaged) return require('electron');
  const candidates = process.platform === 'win32' ? ['release/win-unpacked/Agentrix.exe']
    : process.platform === 'darwin' ? [`release/mac-${process.arch}/Agentrix.app/Contents/MacOS/Agentrix`]
      : ['release/linux-unpacked/agentrix', `release/linux-${process.arch}-unpacked/agentrix`];
  for (const candidate of candidates) try { await fs.access(path.join(root, candidate)); return path.join(root, candidate); } catch { }
  throw new Error('Packaged app was not found');
}
async function runtimeSmoke(output, stages) {
  const stage = stages.run;
  const runtime = await stage('prepare isolated runtime', () => fs.mkdtemp(path.join(os.tmpdir(), 'agx-native-')));
  stages.runtime(runtime);
  const profile = path.join(runtime, 'profile'), projectPath = path.join(runtime, 'project');
  const projectId = randomUUID(), checks = [];
  let app;
  try {
    for (const folder of [profile, projectPath]) await fs.mkdir(folder, { recursive: true });
    const { bin, cli } = await stage('prepare fake native executables', () => prepareProviders(runtime), 35000);
    await fs.writeFile(path.join(profile, 'workspace.json'), JSON.stringify({ version: 2,
      projects: [{ id: projectId, name: 'Offline providers', path: projectPath, kind: 'local', restore: { terminal: false, codex: false } }],
      settings: { language: 'zh', restoreSessions: false, closeToTray: false, notifications: false } }));
    await fs.mkdir(path.join(profile, 'native-session'), { recursive: true });
    await fs.writeFile(path.join(profile, 'native-session/usage.json'), '{broken-offline-fixture');
    const env = { ...isolatedEnvironment(runtime), ...displayEnvironment(), PATH: bin, AGENTRIX_DATA_DIR: profile,
      AGENTRIX_FAKE_NODE: await fs.realpath(process.execPath), AGENTRIX_FAKE_CLI: cli, AGENTRIX_FAKE_OUTPUT: runtime };
    if (coldStart) env.PSModuleAnalysisCachePath = path.join(runtime, 'cold-module-cache');
    delete env.ELECTRON_RUN_AS_NODE; delete env.AGENTRIX_DEV_URL;
    if (process.platform === 'win32') delete env.Path;
    for (const name of ['claude', 'codex']) {
      await stage(`probe fake ${name} executable`, async () => {
        const file = path.join(bin, name + (process.platform === 'win32' ? '.exe' : ''));
        await fs.access(file, fs.constants.X_OK);
        console.log(`[native-smoke] executable=${file} mode=${((await fs.stat(file)).mode & 0o777).toString(8)} node=${env.AGENTRIX_FAKE_NODE}`);
        if (process.platform === 'darwin') {
          const attrs = spawnSync('/usr/bin/xattr', [file], { encoding: 'utf8', timeout: 2000 });
          console.log(`[native-smoke] ${name} xattr status=${attrs.status} quarantine=${attrs.stdout?.includes('com.apple.quarantine') === true}`);
        }
        const result = spawnSync(file, ['--version'], { env, encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL', windowsHide: true });
        assert.equal(result.status, 0, `fake ${name} probe failed: code=${result.error?.code} signal=${result.signal}`);
        assert.match(result.stdout, name === 'claude' ? /2\.1\.317/ : /0\.166\.0/);
      });
    }
    const executablePath = await stage('find application executable', executable);
    app = await stage('launch application', () => electron.launch({ executablePath, args: packaged ? [] : [root], cwd: root, env, timeout: 25000 }), 30000);
    await fs.writeFile(path.join(output, 'owned-app-pid.json'), JSON.stringify({ pid: app.process().pid, isolatedProfile: profile }));
    stages.attach(app);
    const page = await stage('find main window', async () => { const page = await app.firstWindow(); await page.waitForSelector('.project-panel', { timeout: 20000 }); return page; }, 25000);
    await stage('locate SDK', async () => {
      const resources = await app.evaluate(() => process.resourcesPath);
      const entry = packaged ? path.join(resources, 'app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs') : require.resolve('@anthropic-ai/claude-agent-sdk');
      await fs.access(entry); console.log(`[native-smoke] SDK entry=${entry} bytes=${(await fs.stat(entry)).size}`);
      await app.evaluate((_electron, bin) => { process.env.PATH = bin; }, bin);
      if (process.env.NODE_PATH) await app.evaluate((_electron, modules) => {
        process.env.NODE_PATH = modules; process.getBuiltinModule('module').Module._initPaths();
      }, process.env.NODE_PATH);
    });
    if (coldStart) {
      assert.equal(process.platform, 'win32', '--cold-start measures Windows PowerShell');
      const { installColdPowerShell } = require('../tests/fixtures/powershell-cold.cjs');
      await stage('prepare owned cold PowerShell load', () => app.evaluate(installColdPowerShell,
        { node: env.AGENTRIX_FAKE_NODE, cache: env.PSModuleAnalysisCachePath }), 20000);
    }
    const recovered = await stage('read recovered settings', () => page.evaluate(() => window.agentrix.nativeSession.getSettings()));
    assert.equal(recovered.value.claudePath, 'api-then-terminal');
    assert.ok((await fs.readdir(path.join(profile, 'native-session'))).some(name => name.includes('.corrupt')));
    checks.push('corrupt usage is quarantined without blocking the real main window');
    // Always use the isolated fake backend, including macOS where a real Keychain prompt can block main IPC.
    await stage('install offline credential backend', () => app.evaluate(offlineStorage));
    const fakeKey = 'sk-ant-api03-packaged-offline-only-not-a-real-key';
    await stage('save isolated fake key and settings', async () => {
      assert.equal((await page.evaluate(key => window.agentrix.nativeSession.keySave(key), fakeKey)).ok, true);
      assert.equal((await page.evaluate(() => window.agentrix.nativeSession.setSettings({ claudePath: 'api-only', monthlyBudgetUsd: 10 }))).ok, true);
    });
    await stage('stub model-list HTTP in this isolated application', () => app.evaluate(() => {
      const https = process.getBuiltinModule('https');
      const { EventEmitter } = process.getBuiltinModule('events'), { PassThrough } = process.getBuiltinModule('stream');
      https.request = (url, _options, callback) => {
        if (url !== 'https://api.anthropic.com/v1/models?limit=100') throw new Error('Unexpected offline connection request');
        const req = new EventEmitter(); req.destroy = () => {};
        req.end = () => queueMicrotask(() => {
          const response = new PassThrough(); response.statusCode = 200; callback(response);
          response.end('{"data":[{"id":"fake-claude"}]}');
        });
        return req;
      };
    }));
    await stage('check billing without input and cache competing token sources', async () => {
      const testConnection = () => page.evaluate(id => window.agentrix.nativeSession.testConnection(id), projectId);
      const good = await testConnection();
      assert.equal(good.ok, true); assert.deepEqual(good.value.billing, { status: 'ok', source: 'ANTHROPIC_API_KEY' }, JSON.stringify(good.value));
      assert.equal(good.value.path, 'api');
      await app.evaluate(() => { process.env.AGENTRIX_FAKE_TOKEN_SOURCE = 'apiKeyHelper'; });
      const blocked = await testConnection();
      assert.equal(blocked.value.billing.status, 'mismatch'); assert.equal(blocked.value.path, null);
      assert.match(blocked.value.reason, /tokenSource=apiKeyHelper/);
      assert.equal((await page.evaluate(id => window.agentrix.nativeSession.usage(id), projectId)).value.agents.claude.next.path, null);
      assert.equal((await page.evaluate(() => window.agentrix.nativeSession.usage())).value.agents.claude.next.path, 'api', 'one project cannot poison another scope');
      await app.evaluate(() => { delete process.env.AGENTRIX_FAKE_TOKEN_SOURCE; });
      assert.equal((await testConnection()).value.billing.status, 'ok');
      assert.equal((await page.evaluate(id => window.agentrix.nativeSession.usage(id), projectId)).value.agents.claude.next.path, 'api', 'successful identity probe clears this project immediately');
      await app.evaluate(() => { process.env.AGENTRIX_FAKE_TOKEN_SOURCE = 'apiKeyHelper'; });
      await page.evaluate(() => window.agentrix.nativeSession.setSettings({ claudePath: 'api-then-terminal' }));
      const fallback = await testConnection();
      assert.equal(fallback.value.path, 'terminal');
      assert.equal((await page.evaluate(id => window.agentrix.nativeSession.usage(id), projectId)).value.agents.claude.next.path, 'terminal');
      await app.evaluate(() => { delete process.env.AGENTRIX_FAKE_TOKEN_SOURCE; process.env.AGENTRIX_FAKE_INIT_FAILURE = '1'; });
      await page.evaluate(() => window.agentrix.nativeSession.setSettings({ claudePath: 'api-only' }));
      const refused = await testConnection();
      assert.equal(refused.value.billing.status, 'unknown'); assert.equal(refused.value.path, null);
      assert.equal(refused.value.reason, 'Claude API 启动失败，尚未发送消息。');
      await app.evaluate(() => { delete process.env.AGENTRIX_FAKE_INIT_FAILURE; });
      await page.evaluate(key => window.agentrix.nativeSession.keySave(key), fakeKey);
      assert.equal((await page.evaluate(() => window.agentrix.nativeSession.usage())).value.agents.claude.next.path, 'api');
      const wire = (await fs.readFile(path.join(runtime, 'claude-wire.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
      assert.equal(wire.some(row => row.user), false);
      assert.equal(await fs.access(path.join(runtime, 'fake-costs.json')).then(() => true, () => false), false);
      checks.push('connection checks send no user turn; token sources and startup errors select a safe path; cached identity failures reset on key/settings changes');
    });
    const terminalId = (await stage('read terminal identity', () => page.evaluate(() => window.agentrix.getState()))).value.projects[0].terminals[0].id;
    // Keep PTY startup evidence even when preparation rolls back before the
    // terminal is published, or main stops answering a later snapshot request.
    let terminalOutput = '';
    await page.exposeFunction('__nativeSmokeTerminal', packet => {
      if (packet.id !== terminalId) return;
      terminalOutput = (terminalOutput + packet.data).slice(-8192);
      stages.observe('terminal', { sessionId: packet.sessionId, seq: packet.seq, data: terminalOutput });
    });
    await page.evaluate(() => { window.agentrix.onTerminalData(packet => { void window.__nativeSmokeTerminal(packet); }); });
    for (const agent of ['claude', 'codex']) {
      const first = await stage(`start fake ${agent === 'claude' ? 'claude SDK' : 'codex app-server'}`, () => page.evaluate(({ terminalId, agent }) => window.agentrix.nativeSession.start(terminalId, { agent }), { terminalId, agent }), 30000);
      assert.equal(first.ok, true, JSON.stringify(first));
      let id = first.value.runtimeSessionId;
      const texts = agent === 'claude' ? ['first', 'second', 'BUDGET_TURN', 'BUDGET_TURN', 'BUDGET_TURN'] : ['first', 'second'];
      for (const text of texts) {
        const marker = agent === 'claude' ? 'PACKAGED_CLAUDE_OK' : 'PACKAGED_CODEX_OK';
        const messageId = randomUUID();
        const sent = await stage(`${agent} send ${text}`, () => page.evaluate(p => window.agentrix.nativeSession.send(p.terminalId, p.id, p.messageId, p.text), { terminalId, id, messageId, text }));
        assert.equal(sent.ok, true, JSON.stringify(sent));
        await stage(`${agent} await ${text} result`, () => waitFor(async () => {
          const value = await page.evaluate(id => window.agentrix.nativeSession.snapshot(id), terminalId);
          return value.ok && value.value?.state === 'idle' && value.value.events.some(event => event.type === 'item.upsert' && event.payload.content.text === marker);
        }, `${agent} real main received the fake provider result`, 20000), 25000);
        const completed = await stage(`${agent} read completion`, () => page.evaluate(id => window.agentrix.nativeSession.snapshot(id), terminalId));
        assert.equal(completed.value.events.findLast(event => event.type === 'turn.completed').payload.status, 'completed', `${agent} turn must not hit a stale cumulative query cap`);
        if (text === 'first') {
          const state = await stage(`${agent} read native terminal usage`, () => page.evaluate(() => window.agentrix.getState()));
          const usage = state.value.projects[0].terminals.find(item => item.id === terminalId).agentUsage;
          assert.deepEqual(usage.context, agent === 'claude' ? { used: 3, window: 100 } : { used: 13, window: 456789 });
          assert.deepEqual(usage.round, agent === 'claude' ? { input: 1, cached: 0, output: 2 } : { input: 10, cached: 2, output: 3 });
          checks.push(`${agent} structured usage reaches terminal.agentUsage with the reported context window and round tokens`);
          assert.equal((await stage(`${agent} stop before resume`, () => page.evaluate(p => window.agentrix.nativeSession.stop(p.terminalId, p.id), { terminalId, id }))).ok, true);
          const resumed = await stage(`${agent} resume`, () => page.evaluate(p => window.agentrix.nativeSession.start(p.terminalId, { agent: p.agent, resume: true }), { terminalId, agent }));
          assert.equal(resumed.ok, true, JSON.stringify(resumed)); id = resumed.value.runtimeSessionId;
          const afterResume = (await page.evaluate(id => window.agentrix.nativeSession.snapshot(id), terminalId)).value;
          assert.equal(afterResume.events.findLast(event => event.providerSessionId)?.providerSessionId, completed.value.events.findLast(event => event.providerSessionId)?.providerSessionId, 'resume keeps the exact provider thread');
        }
      }
      if (agent === 'claude') {
        const before = await page.evaluate(id => window.agentrix.nativeSession.snapshot(id), terminalId);
        const provider = before.value.events.findLast(event => event.providerSessionId)?.providerSessionId;
        for (const [mode, expected] of [['terminal-only', 'terminal'], ['api-only', 'api']]) {
          const switchTimeout = coldStart ? 90000 : 30000;
          await stage(`switch actual main to ${expected}`, async () => {
            stages.observe('switchRequest', { expected, operation: 'settings' });
            assert.equal((await page.evaluate(mode => window.agentrix.nativeSession.setSettings({ claudePath: mode }), mode)).ok, true);
            let observed;
            await waitFor(async () => {
              stages.observe('switchRequest', { expected, operation: 'snapshot' });
              const snapshot = await page.evaluate(id => window.agentrix.nativeSession.snapshot(id), terminalId);
              const value = snapshot.value, state = value?.switchState;
              const diagnostic = JSON.stringify({ ok: snapshot.ok, error: snapshot.error, state: value?.state, switchState: state });
              stages.observe('switch', JSON.parse(diagnostic));
              assert.equal(snapshot.ok, true, diagnostic);
              if (diagnostic !== observed) { observed = diagnostic; console.log(`[native-smoke] switch observation ${diagnostic}`); }
              if (state?.phase === 'stable' && state.outcome === 'failed') {
                const host = (await page.evaluate(() => window.agentrix.getState())).value.projects
                  .flatMap(project => project.terminals).find(terminal => terminal.id === terminalId);
                const terminal = await page.evaluate(id => window.agentrix.attachTerminal(id), terminalId);
                throw new Error(`switch failed: ${JSON.stringify({ state, host, terminal })}`);
              }
              if (state?.phase === 'stable' && state.current === expected) {
                id = value.runtimeSessionId;
                if (coldStart && expected === 'terminal') {
                  const cold = await app.evaluate(() => process.__agxColdPowerShellClose());
                  stages.observe('coldStartup', cold);
                  assert.ok(cold.startupMs > 15000, `cold startup must cross the old product deadline: ${cold.startupMs}ms`);
                  checks.push(`cold PowerShell resumed after ${cold.startupMs}ms without abandoning the API source`);
                }
                return true;
              }
              if (['awaiting-choice', 'waiting-background'].includes(state?.phase)) {
                stages.observe('switchRequest', { expected, operation: 'choice' });
                await page.evaluate(p => window.agentrix.nativeSession.answer(p.terminalId, p.runtime, p.state.requestId,
                  { switch: { changeId: p.state.changeId, requestId: p.state.requestId, action: 'now' } }), { terminalId, runtime: value.runtimeSessionId, state });
              } else if (state?.phase === 'preparing') {
                stages.observe('switchRequest', { expected, operation: 'handoff' });
                const receipt = await page.evaluate(p => window.agentrix.nativeSession.answer(p.terminalId, p.runtime, `handoff-${p.state.changeId}`,
                  { handoff: { changeId: p.state.changeId, draft: { version: p.version, text: '', images: [], undelivered: [] } } }),
                { terminalId, runtime: value.runtimeSessionId, state, version: (value.handoff?.draft.version || 0) + 1 });
                stages.observe('handoff', receipt);
              }
              return false;
            }, `actual main switched to ${expected}`, switchTimeout - 5000);
          }, switchTimeout * timeoutScale);
        }
        const after = await page.evaluate(id => window.agentrix.nativeSession.snapshot(id), terminalId);
        assert.equal(after.value.events.findLast(event => event.providerSessionId)?.providerSessionId, provider);
        assert.equal(after.value.events.some(event => event.type === 'turn.started' && !event.replay), false);
        checks.push('actual main SDK to PTY terminal to SDK, authenticated SessionStart, InputGate, activation and persisted history without a new turn');
        await stage('G1 failed PTY switch retains a usable API host without retry on send', async () => {
          const launches = async () => (await fs.readFile(path.join(runtime, 'claude-wire.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
            .filter(row => row.spawn && !row.args.some(arg => arg === '--input-format' || arg.startsWith('--input-format='))).length;
          const previousLaunches = await launches();
          await fs.writeFile(path.join(runtime, 'exit-terminal'), 'owned offline failure');
          await page.evaluate(() => window.agentrix.nativeSession.setSettings({ claudePath: 'terminal-only' }));
          await waitFor(async () => {
            const value = (await page.evaluate(id => window.agentrix.nativeSession.snapshot(id), terminalId)).value;
            if (value?.switchState?.phase === 'preparing') await page.evaluate(p => window.agentrix.nativeSession.answer(p.terminalId, p.runtimeSessionId, `handoff-${p.changeId}`,
              { handoff: { changeId: p.changeId, draft: { version: 1, text: '', images: [], undelivered: [] } } }), { terminalId, runtimeSessionId: value.runtimeSessionId, changeId: value.switchState.changeId });
            return value?.switchState?.phase === 'stable' && value.switchState.outcome === 'failed';
          }, 'failed terminal switched back to API', 20000);
          const kept = (await page.evaluate(id => window.agentrix.nativeSession.snapshot(id), terminalId)).value;
          id = kept.runtimeSessionId; assert.equal(kept.switchState.current, 'api');
          const messageId = randomUUID();
          const receipt = await page.evaluate(p => window.agentrix.nativeSession.send(p.terminalId, p.id, p.messageId, 'AFTER_FAILED_SWITCH'), { terminalId, id, messageId });
          assert.equal(receipt.ok, true); assert.notEqual(receipt.value.status, 'rejected');
          await waitFor(async () => (await page.evaluate(id => window.agentrix.nativeSession.snapshot(id), terminalId)).value.events.some(event => event.type === 'input.receipt' && event.payload.clientMessageId === messageId && event.payload.status === 'consumed'), 'retained API consumes the new message', 10000);
          assert.equal(await launches(), previousLaunches + 1, 'sending cannot start a second failed terminal');
          const host = (await page.evaluate(() => window.agentrix.getState())).value.projects[0].terminals.find(item => item.id === terminalId);
          assert.equal(host.nativeMode, 'claude-sdk'); assert.equal(host.status, 'codex');
          const raw = await page.evaluate(id => window.agentrix.attachTerminal(id), terminalId);
          assert.equal(raw.ok, true, JSON.stringify(raw));
          assert.deepEqual(raw.value, { sessionId: null, seq: 0, data: '' }, 'a restored native host has no raw PTY snapshot');
          await fs.unlink(path.join(runtime, 'exit-terminal'));
          await page.evaluate(() => window.agentrix.nativeSession.setSettings({ claudePath: 'api-only' }));
        }, 30000);
        checks.push('G1 actual main rolls back an immediately exiting PTY; the next input stays on API and starts no second TUI');
      }
      const hold = await stage(`${agent} send active turn to stop`, () => page.evaluate(p => window.agentrix.nativeSession.send(p.terminalId, p.id, p.messageId, 'HOLD'), { terminalId, id, messageId: randomUUID() }));
      assert.equal(hold.ok, true);
      assert.equal((await stage(`${agent} stop active turn`, () => page.evaluate(p => window.agentrix.nativeSession.stop(p.terminalId, p.id), { terminalId, id }))).ok, true);
      const snapshot = await stage(`${agent} read stopped state`, () => page.evaluate(id => window.agentrix.nativeSession.snapshot(id), terminalId));
      assert.equal(snapshot.value.state, 'stopped');
      checks.push(`${agent}: main IPC, native executable discovery, wire handshake, send, resume and stop`);
      if (agent === 'claude') checks.push('fresh turn reservations exceed $5 across one logical owner session without a stale query cap');
    }
    const claude = (await fs.readFile(path.join(runtime, 'claude-wire.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(claude.some(row => row.control === 'initialize'), 'the packaged SDK performs its real initialize handshake');
    assert.ok(claude.some(row => row.args?.some(arg => arg === '--resume' || arg.startsWith('--resume='))));
    assert.equal(new Set(claude.filter(row => row.user).map(row => row.sessionId)).size, 1, 'Claude resumes its original provider session');
    assert.ok(claude.filter(row => row.spawn).every(row => !row.scrub));
    assert.ok(claude.some(row => row.childResults?.length === 3));
    assert.ok(claude.filter(row => row.childResults).every(row => row.childResults.every(child => child.keyPresent)));
    const ownerPids = new Set(claude.filter(row => row.user).map(row => row.pid));
    assert.ok(claude.filter(row => row.spawn).every(row => row.configDir === (env.CLAUDE_CONFIG_DIR || null)), 'SDK queries inherit the owner config without substituting a directory');
    assert.ok(claude.filter(row => row.spawn && ownerPids.has(row.pid)).every(row => row.hasBootstrap), 'GUI planners retain the helper bootstrap');
    assert.equal(await fs.access(path.join(profile, 'native-session/sdk-config')).then(() => true, () => false), false);
    assert.equal(await fs.access(path.join(profile, 'native-session/sdk-session-configs.json')).then(() => true, () => false), false);
    checks.push('GUI planners keep their bootstrap and config; streamed command_lifecycle frames before init do not fail startup');
    if (packaged) {
      const resources = await stage('verify SDK resources path', () => app.evaluate(() => process.resourcesPath));
      const entry = path.join(resources, 'app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs');
      await fs.access(entry); checks.push('SDK loaded from the packaged unpacked dependency graph');
    }
    for (const directory of [path.join(profile, 'native-session'), path.join(runtime, 'claude')]) {
      for (const file of await fs.readdir(directory, { recursive: true })) {
        const absolute = path.join(directory, file), stat = await fs.stat(absolute);
        if (stat.isFile()) assert.ok(!(await fs.readFile(absolute)).includes(Buffer.from(fakeKey)), `key persisted in ${path.basename(file)}`);
      }
    }
    checks.push('owner tool/hook/MCP children retain the owner environment; persisted SDK profile contains no key');
    // Dispatched workers scrub credentials in the independent claude-sdk-wire test.
    await stage('capture runtime evidence', () => page.screenshot({ path: path.join(output, 'runtime-providers.png'), timeout: 5000 }));
  } finally {
    let coldCleanupError;
    if (coldStart && app) await stage('stop owned cold PowerShell load', async () => {
      const cold = await app.evaluate(() => process.__agxColdPowerShellClose?.());
      if (cold) stages.observe('coldStartup', cold);
    }, 10000).catch(error => { coldCleanupError = error; });
    try { await closeSmokeApplication(app, stages); if (coldCleanupError) throw coldCleanupError; }
    finally {
      await stage('write runtime results', () => fs.writeFile(path.join(output, 'runtime-results.json'), JSON.stringify({ checks, stages: stages.history }, null, 2)), 3000);
      await stage('remove isolated runtime', () => fs.rm(runtime, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }), 5000);
    }
  }
}

// Result panel (information slash commands) acceptance: main's answers to `native:send` / `native:run-options` are replaced by canned `local` facts inside
// this isolated application, the panel is opened by typing the command in the real message box, and every state is screenshotted and measured from the DOM.
// Nothing here presses the panel's copy button or Ctrl+C (both write the system clipboard).
async function panelStage({ app, page, view, box, emit, event, output, checks, agent }) {
  const measures = {}, shot = async name => { await page.waitForTimeout(400); await page.screenshot({ path: path.join(output, `panel-${name}.png`) }); };
  const now = Date.now(), DAY = 86400000, HOUR = 3600000;
  const codexFacts = (command, week = 100) => ({ command, session: { model: 'gpt-6.1-terra', effort: 'high', fast: true, approval: 'never', sandbox: 'dangerFullAccess', cwd: 'C:\\Users\\ylc\\Desktop\\a-rather-long-project-folder-name\\packages\\native-session-workbench' },
    account: { provider: 'openai', kind: 'subscription' }, tokens: { total: 208228, input: 207377, output: 851, cachedInput: 141056, reasoning: 47, context: 32803, window: 475000 },
    limits: [{ id: '5h', usedPercent: 0, resetsAtMs: now + 5 * HOUR }, { id: 'week', usedPercent: week, resetsAtMs: now + 3 * DAY }], errors: [] });
  const claudeContext = { command: 'context', context: { model: 'claude-opus-5-5', tokens: 58400, window: 1000000, autoCompact: true, autoCompactThreshold: 830000,
    categories: [{ id: 'free-space', name: 'Free space', tokens: 941600, kind: 'free' }, { id: 'messages', name: 'Messages', tokens: 25800, kind: 'used' }, { id: 'system-prompt', name: 'System prompt', tokens: 14200, kind: 'used' },
      { id: 'system-tools', name: 'System tools', tokens: 12100, kind: 'used' }, { id: 'memory-files', name: 'Memory files', tokens: 6300, kind: 'used' }],
    memory: [{ name: 'MEMORY.md', tokens: 3100 }], mcp: [{ name: 'playwright', tokens: 6800 }], skills: [{ name: 'model-routing', tokens: 2400 }] } };
  const claudeCost = { command: 'cost', costUsdMicros: 1840000, durationMs: 1390000, apiDurationMs: 402000, month: { spentMicros: 36520000, budgetUsd: 100 },
    models: [{ model: 'claude-opus-5-5', costUsdMicros: 1620000, input: 412000, output: 9800, cacheRead: null, cacheWrite: null }, { model: 'claude-haiku-5-5', costUsdMicros: 220000, input: 188000, output: 4100, cacheRead: null, cacheWrite: null }] };
  const claudeUsage = { command: 'usage', month: { spentMicros: 36520000, budgetUsd: 100 }, today: { spentMicros: 1840000 }, tokens: { input: 600000, output: 13900, cacheRead: null, cacheWrite: null }, notice: null,
    limits: [{ id: 'five_hour', usedPercent: 100, resetsAtMs: now + 2 * HOUR }, { id: 'seven_day', usedPercent: 40, resetsAtMs: now + 2 * DAY }] };
  const claudeStatus = { command: 'status', context: claudeContext.context, errors: [], account: { kind: 'api' }, session: { model: 'claude-opus-5-5', effort: 'high', cwd: 'C:\\work', sessionId: 'abc-123', version: '2.1.318', permission: 'default', mcp: [{ name: 'playwright', status: 'connected' }] } };

  // Main side: canned answers; mode 'hold' keeps the next answer back until released so the loading state can be seen.
  await app.evaluate(({ ipcMain }) => {
    globalThis.__panel = { answers: {}, mode: 'ok', error: '' };
    ipcMain.removeHandler('native:send'); ipcMain.removeHandler('native:run-options');
    ipcMain.handle('native:send', (_event, _terminal, _runtime, _id, text) => {
      const cfg = globalThis.__panel, result = cfg.mode === 'fail' ? { ok: false, error: cfg.error } : { ok: true, value: { status: 'consumed', local: cfg.answers[String(text).slice(1)] } };
      return cfg.mode === 'hold' ? new Promise(resolve => { globalThis.__panelRelease = () => resolve(result); }) : result;
    });
    ipcMain.handle('native:run-options', (_event, _terminal, _runtime, patch) => ({ ok: true, value: { model: patch?.model ?? 'opus', effort: patch?.effort ?? 'high', fast: false } }));
  });
  const configure = (answers, mode = 'ok', error = '') => app.evaluate((_e, cfg) => { globalThis.__panel = cfg; }, { answers, mode, error });
  // A terminal's native identity is fixed by its first event, so the Codex pass runs in an application of its own (panelCodexApp).
  const provider = async () => {
    if (agent === 'codex') await emit([event('session.state', { state: 'idle', reason: null }, { provider: 'codex', transport: 'codex-app-server', runtimeSessionId: 'rs-panel-codex' })]);
    await view.waitFor({ timeout: 10000 });
  };
  const open = async command => { await box.click(); await box.fill(`/${command}`); await page.keyboard.press('Enter'); await page.locator('dialog.native-panel').waitFor({ timeout: 8000 }); };
  const ready = () => page.waitForFunction(() => document.querySelector('dialog.native-panel') && !document.querySelector('dialog.native-panel .native-panel-skeleton'), null, { timeout: 8000 });
  const close = async () => { await page.keyboard.press('Escape'); await page.locator('dialog.native-panel').waitFor({ state: 'detached', timeout: 3000 }); };

  // All geometry and style in one read, so the report is numbers and not impressions.
  const measure = () => page.evaluate(() => {
    const d = document.querySelector('dialog.native-panel'); if (!d) return null;
    const r = el => { const b = el.getBoundingClientRect(); return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1), r: +b.right.toFixed(1), b: +b.bottom.toFixed(1) }; };
    const cs = (el, ...props) => { const c = getComputedStyle(el); return Object.fromEntries(props.map(p => [p, c[p]])); };
    const q = sel => d.querySelector(sel), qa = sel => [...d.querySelectorAll(sel)];
    const area = d.closest('.reading-scroll-area') ?? d.parentElement, scrim = d.parentElement, composer = d.closest('.reading-view').querySelector('textarea');
    const panel = r(d), rel = e => +(r(e).x - panel.x).toFixed(1);
    return {
      panel, scrim: r(scrim), area: r(area), composer: composer ? r(composer) : null, viewport: { w: innerWidth, h: innerHeight },
      centredOffset: +((panel.x + panel.w / 2) - (r(area).x + r(area).w / 2)).toFixed(1),
      gapAboveComposer: composer ? +(r(composer).y - panel.b).toFixed(1) : null, overlapsComposer: composer ? panel.b > r(composer).y + 0.5 && panel.y < r(composer).b : null,
      panelStyle: cs(d, 'borderRadius', 'borderTopWidth', 'maxHeight', 'backgroundColor', 'borderTopColor', 'boxShadow', 'fontSize'),
      body: (b => b && { ...cs(b, 'overflowY', 'maxHeight'), scrollHeight: b.scrollHeight, clientHeight: b.clientHeight })(q('.native-panel-body')),
      head: { title: (e => e && { ...cs(e, 'fontSize', 'fontWeight', 'color'), x: rel(e) })(q('.native-panel-title')), mark: (e => e && { x: rel(e), w: r(e).w })(q('.native-panel-mark')),
        cmd: (e => e && cs(e, 'borderRadius', 'fontSize', 'backgroundColor', 'color'))(q('.native-panel-cmd')) },
      buttons: qa('.native-panel-head .icon-button').map(b => ({ title: b.title, w: r(b).w, h: r(b).h, radius: getComputedStyle(b).borderRadius, disabled: b.disabled, icon: r(b.querySelector('svg')).w })),
      hero: (e => e && { ...cs(e, 'fontSize', 'fontWeight', 'color'), x: rel(e) })(q('.native-panel-big')),
      heroCap: (e => e && cs(e, 'fontSize', 'color'))(q('.native-panel-cap')),
      heroBar: (e => e && { h: r(e).h, w: r(e).w, radius: getComputedStyle(e).borderRadius, fill: getComputedStyle(e.firstElementChild).backgroundColor, track: getComputedStyle(e).backgroundColor, x: rel(e) })(q('.native-panel-hero-bar .native-panel-meter')),
      alert: (e => e && { h: r(e).h, x: rel(e), w: r(e).w, radius: getComputedStyle(e).borderRadius, border: getComputedStyle(e).borderTopColor, icon: getComputedStyle(e.querySelector('svg')).color, strong: getComputedStyle(e.querySelector('b')).color, bg: getComputedStyle(e).backgroundColor, size: getComputedStyle(e).fontSize })(q('.native-panel-alert')),
      groupTitles: qa('.native-panel-group-title').map(e => ({ text: e.textContent, ...cs(e, 'fontSize', 'color'), x: rel(e) })),
      groups: qa('.native-panel-group').map(e => ({ borderTop: getComputedStyle(e).borderTopWidth, pad: getComputedStyle(e).padding, h: r(e).h, x: rel(e), w: r(e).w })),
      rows: qa('.native-panel-rows').map(g => ({ cols: getComputedStyle(g).gridTemplateColumns, gap: getComputedStyle(g).gap,
        dt: [...g.querySelectorAll('dt')].map(e => ({ text: e.textContent, w: r(e).w, x: rel(e), fontSize: getComputedStyle(e).fontSize, color: getComputedStyle(e).color })),
        dd: [...g.querySelectorAll('dd')].map(e => ({ text: e.textContent, x: rel(e), w: r(e).w, fontSize: getComputedStyle(e).fontSize, color: getComputedStyle(e).color, ellipsis: e.scrollWidth > e.clientWidth + 1, textOverflow: getComputedStyle(e).textOverflow, noteColor: e.querySelector('span') && getComputedStyle(e.querySelector('span')).color })) })),
      chips: qa('.native-panel-chip').map(e => ({ text: e.textContent, radius: getComputedStyle(e).borderRadius, fontSize: getComputedStyle(e).fontSize, color: getComputedStyle(e).color, bg: getComputedStyle(e).backgroundColor, border: getComputedStyle(e).borderTopWidth + ' ' + getComputedStyle(e).borderTopColor, x: rel(e) })),
      quotas: qa('.native-panel-quota').map(e => ({ out: e.classList.contains('is-out'), pct: getComputedStyle(e.querySelector('b')).color, fill: e.querySelector('.native-panel-meter > i') && getComputedStyle(e.querySelector('.native-panel-meter > i')).backgroundColor,
        meterH: e.querySelector('.native-panel-meter') && r(e.querySelector('.native-panel-meter')).h, meterRadius: e.querySelector('.native-panel-meter') && getComputedStyle(e.querySelector('.native-panel-meter')).borderRadius,
        when: e.querySelector('.native-panel-when') && cs(e.querySelector('.native-panel-when'), 'fontSize', 'color'), x: rel(e), nameSize: getComputedStyle(e.querySelector('.native-panel-quota-top')).fontSize })),
      stack: (e => e && { h: r(e).h, radius: getComputedStyle(e).borderRadius, segs: [...e.children].map(i => ({ w: +r(i).w.toFixed(1), bg: getComputedStyle(i).backgroundColor })) })(q('.native-panel-meter.is-stack')),
      legend: qa('.native-panel-legend li').map(li => ({ text: li.textContent, size: getComputedStyle(li).fontSize, sw: r(li.firstElementChild).w, swRadius: getComputedStyle(li.firstElementChild).borderRadius, nameColor: getComputedStyle(li.children[1]).color })),
      foot: (e => e && { ...cs(e, 'fontSize', 'color', 'borderTopWidth', 'padding'), h: r(e).h })(q('.native-panel-foot')),
      skeleton: qa('.native-panel-skeleton > i').length,
      allText: [...new Set(qa('*').filter(e => [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())).map(e => getComputedStyle(e).color))],
      allBg: [...new Set(qa('*').map(e => getComputedStyle(e).backgroundColor).filter(c => c !== 'rgba(0, 0, 0, 0)'))],
      allBorder: [...new Set(qa('*').filter(e => parseFloat(getComputedStyle(e).borderTopWidth) > 0).map(e => getComputedStyle(e).borderTopColor))],
      doubleBorders: qa('*').filter(e => parseFloat(getComputedStyle(e).borderTopWidth) > 0 && e.parentElement && Math.abs(r(e.parentElement).y - r(e).y) < 1 && parseFloat(getComputedStyle(e.parentElement).borderTopWidth) > 0).map(e => e.className),
      tokens: Object.fromEntries(['--bg-menu', '--border', '--divider', '--text-1', '--text-2', '--text-3', '--usage', '--danger', '--warning', '--success', '--bg-selected', '--bg-hover', '--bg-app'].map(n => [n, getComputedStyle(document.documentElement).getPropertyValue(n).trim()])),
      activeTag: document.activeElement && (document.activeElement.tagName + '.' + document.activeElement.className),
    };
  });
  const record = async name => { await page.waitForTimeout(400); measures[name] = await measure(); await shot(name); };

  const bubblesBefore = await view.locator('.reading-user').count();

  await provider();
  if (agent === 'codex') {
  await configure({ status: codexFacts('status'), usage: codexFacts('usage') });
  await open('status'); await ready();
  await record('codex-status-dark');
  // Keyboard: Tab visits the three header buttons and wraps.
  const tabs = [];
  for (let i = 0; i < 4; i++) { await page.keyboard.press('Tab'); tabs.push(await page.evaluate(() => document.activeElement?.title || document.activeElement?.tagName)); }
  measures.tabOrder = tabs;
  await shot('codex-status-dark-tab-focus');
  // Grayscale: the hierarchy must survive without colour.
  await page.evaluate(() => { document.documentElement.style.filter = 'grayscale(1)'; }); await shot('codex-status-dark-gray'); await page.evaluate(() => { document.documentElement.style.filter = ''; });
  // Esc closes and the box has the cursor again.
  await close();
  measures.escFocus = await page.evaluate(() => document.activeElement?.tagName + ':' + (document.activeElement?.closest('.reading-view') ? 'in-reading-view' : 'elsewhere'));
  // A press on the scrim closes.
  await open('status'); await ready();
  const corner = await page.locator('dialog.native-panel').evaluate(d => { const b = d.closest('.native-panel-scrim').getBoundingClientRect(); return { x: b.x + 6, y: b.y + 6 }; });
  await page.mouse.click(corner.x, corner.y);
  await page.waitForTimeout(300);
  measures.scrimClosed = (await page.locator('dialog.native-panel').count()) === 0;
  measures.scrimFocus = await page.evaluate(() => document.activeElement?.tagName);

  await open('usage'); await ready(); await record('codex-usage-dark'); await close();

  // Loading state, then a failed read.
  await configure({ status: codexFacts('status') }, 'hold');
  await open('status'); await page.locator('dialog.native-panel .native-panel-skeleton').first().waitFor({ timeout: 4000 }); await record('codex-loading-dark');
  await app.evaluate(() => globalThis.__panelRelease()); await ready(); await close();
  await configure({}, 'fail', '会话正在切换，请稍后重试。');
  await open('status'); await page.locator('dialog.native-panel [role="alert"]').waitFor({ timeout: 4000 }); await record('codex-failed-dark'); await close();

  // A quota below 100%: no alert line.
  await configure({ status: codexFacts('status', 40) }); await open('status'); await ready(); await record('codex-status-dark-week40'); await close();

  // Light theme and the narrow window for Codex /status.
  await configure({ status: codexFacts('status') });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await open('status'); await ready(); await record('codex-status-light'); await close();
  await page.evaluate(() => { document.documentElement.dataset.theme = 'mono'; });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(820, 640)); await page.waitForTimeout(400);
  await open('status'); await ready(); await record('codex-status-dark-narrow');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; }); await record('codex-status-light-narrow');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'mono'; }); await close();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 900)); await page.waitForTimeout(400);

  } else {
  await configure({ context: claudeContext, cost: claudeCost, usage: claudeUsage, status: claudeStatus });
  await open('context'); await ready(); await record('claude-context-dark');
  measures.bubblesBefore = bubblesBefore; measures.bubblesWhileOpen = await view.locator('.reading-user').count();
  measures.thinkingRows = await page.locator('.reading-view[data-native-session] [class*="thinking"]').count();
  await close();
  await open('cost'); await ready(); await record('claude-cost-dark'); await close();
  await open('usage'); await ready(); await record('claude-usage-dark'); await close();
  await open('status'); await ready(); await record('claude-status-dark'); await close();

  // The note after a setting change, timed.
  await box.click(); await box.fill('/model opus'); await page.keyboard.press('Enter');
  const toast = page.locator('.native-toast'); await toast.waitFor({ timeout: 4000 });
  const shown = Date.now();
  measures.toast = await page.evaluate(() => {
    const t = document.querySelector('.native-toast'), b = t.getBoundingClientRect(), c = getComputedStyle(t), a = t.closest('.reading-scroll-area').getBoundingClientRect(), field = t.closest('.reading-view').querySelector('textarea').getBoundingClientRect();
    return { w: b.width, h: b.height, centreOffset: (b.x + b.width / 2) - (a.x + a.width / 2), gapAboveComposer: field.y - b.bottom, radius: c.borderRadius, fontSize: c.fontSize, text: t.textContent, iconColor: getComputedStyle(t.querySelector('svg')).color, bg: c.backgroundColor, border: c.borderTopColor, shadow: c.boxShadow };
  });
  await page.waitForTimeout(300); await shot('claude-toast-dark');
  await toast.waitFor({ state: 'detached', timeout: 4000 }); measures.toast.visibleMs = Date.now() - shown;
  measures.toastBubbles = await view.locator('.reading-user').count();
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await box.click(); await box.fill('/effort max'); await page.keyboard.press('Enter'); await toast.waitFor({ timeout: 4000 }); await page.waitForTimeout(300); await shot('claude-toast-light');
  await toast.waitFor({ state: 'detached', timeout: 4000 }); await page.evaluate(() => { document.documentElement.dataset.theme = 'mono'; });

  }
  await fs.writeFile(path.join(output, `panel-measures-${agent}.json`), JSON.stringify(measures, null, 2));
  checks.push('result panel: every command, loading, failure, toast, light and narrow captured and measured');
}

// The Codex pass of the result panel runs in its own isolated application: a terminal's native identity is fixed by its first event.
async function panelCodexApp(output, stages, checks) {
  const profile = path.join(output, 'panel-codex-profile'), home = path.join(output, 'panel-codex-home'), project = { id: randomUUID(), name: 'Codex 面板', path: path.join(output, 'panel-codex-project'), kind: 'local', restore: { terminal: false, codex: false } };
  for (const dir of [profile, home, project.path]) await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(profile, 'workspace.json'), JSON.stringify({ version: 2, projects: [project], settings: { language: 'zh', terminalRenderer: 'dom', restoreSessions: false, closeToTray: false, notifications: false, fontSize: 14 } }));
  const env = { ...isolatedEnvironment(home), ...displayEnvironment(), AGENTRIX_DATA_DIR: profile }; delete env.ELECTRON_RUN_AS_NODE; delete env.AGENTRIX_DEV_URL;
  let app;
  try {
    app = await stages.run('launch Codex panel application', async () => electron.launch({ executablePath: await executable(), args: packaged ? [] : [root], cwd: root, env, timeout: 25000 }), 30000);
    stages.attach(app);
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 900));
    await page.waitForSelector('.project-panel');
    const terminalId = (await page.evaluate(() => window.agentrix.getState())).value.projects[0].terminals[0].id;
    let sequence = 0;
    const event = (type, payload = {}, extra = {}) => ({ schemaVersion: 1, eventId: `panel-${++sequence}`, sequence, connectionEpoch: 'smoke', provider: 'codex', transport: 'codex-app-server', projectId: project.id, terminalId,
      runtimeSessionId: 'rs-panel-codex', providerSessionId: null, runId: null, turnId: 'turn-1', itemId: null, receivedAtMs: Date.now(), occurredAtMs: Date.now(), replay: false, type, payload, ...extra });
    const emit = events => app.evaluate(({ BrowserWindow }, list) => { for (const item of list) BrowserWindow.getAllWindows()[0].webContents.send('native:event', item); }, events);
    const view = page.locator(`[data-terminal-id="${terminalId}"] .reading-view[data-native-session]`);
    await emit([event('turn.started', { origin: 'user', clientMessageId: 'c1' }), event('item.upsert', { kind: 'user-message', status: 'completed', content: { text: '帮我把生成的图片再调亮一点', clientMessageId: 'c1' } }, { itemId: 'u1' }),
      event('item.delta', { channel: 'text', text: '已经把亮度提高了 15%，新文件保存为 cover-bright.png。' }, { itemId: 'm1' }), event('turn.completed', { status: 'completed', error: null }), event('session.state', { state: 'idle', reason: null })]);
    await view.waitFor({ timeout: 15000 });
    await panelStage({ app, page, view, box: view.locator('textarea'), emit, event, output, checks, agent: 'codex' });
  } catch (error) {
    if (app) await stages.run('capture Codex panel failure', async () => { const page = await app.firstWindow(); await page.screenshot({ path: path.join(output, 'failure-codex-panel.png'), timeout: 2000 }); }, 3000).catch(() => {});
    throw error;
  } finally {
    await closeSmokeApplication(app, stages);
    for (const directory of [profile, home, project.path]) await fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

async function run(output, stages) {
  const profile = path.join(output, 'profile'), home = path.join(output, 'ui-home'), project = { id: randomUUID(), name: '原生会话', path: path.join(output, 'project'), kind: 'local', restore: { terminal: false, codex: false } };
  for (const dir of [profile, home, project.path]) await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(profile, 'workspace.json'), JSON.stringify({ version: 2, projects: [project], settings: { language: 'zh', terminalRenderer: 'dom', restoreSessions: false, closeToTray: false, notifications: false, fontSize: 14 } }));
  const env = { ...isolatedEnvironment(home), ...displayEnvironment(), AGENTRIX_DATA_DIR: profile }; delete env.ELECTRON_RUN_AS_NODE; delete env.AGENTRIX_DEV_URL;
  const errors = [], checks = [];
  let app;
  await panelCodexApp(output, stages, checks);
  try {
    app = await stages.run('launch UI application', async () => electron.launch({ executablePath: await executable(), args: packaged ? [] : [root], cwd: root, env, timeout: 25000 }), 30000);
    stages.attach(app);
    const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 900));
    await page.waitForSelector('.project-panel');
    const terminalId = (await page.evaluate(() => window.agentrix.getState())).value.projects[0].terminals[0].id;
    const card = page.locator(`[data-terminal-id="${terminalId}"]`), view = card.locator('.reading-view[data-native-session]'), box = view.locator('textarea');

    // The contract's event envelope (contract §1); one stream, sequence counting up.
    let sequence = 0;
    const event = (type, payload = {}, extra = {}) => ({ schemaVersion: 1, eventId: `smoke-${++sequence}`, sequence, connectionEpoch: 'smoke', provider: 'claude', transport: 'claude-sdk', projectId: project.id, terminalId,
      runtimeSessionId: 'rs-smoke', providerSessionId: null, runId: null, turnId: 'turn-1', itemId: null, receivedAtMs: Date.now(), occurredAtMs: Date.now(), replay: false, type, payload, ...extra });
    const emit = events => app.evaluate(({ BrowserWindow }, list) => { for (const item of list) BrowserWindow.getAllWindows()[0].webContents.send('native:event', item); }, events);

    assert.equal(await page.locator('.activity-pane').count(), 0, 'a small card has no activity pane');
    const opening = [
      event('session.state', { state: 'running', reason: null }), event('turn.started', { origin: 'user', clientMessageId: 'c1' }),
      event('item.upsert', { kind: 'user-message', status: 'completed', content: { text: 'fix the test', clientMessageId: 'c1' } }, { itemId: 'u1' }),
      event('item.upsert', { kind: 'command', status: 'in_progress', content: { command: 'npm test', cwd: project.path } }, { itemId: 'k1' }), event('item.delta', { channel: 'output', text: 'FAIL a.test.js' }, { itemId: 'k1' }),
    ];
    const reply = event('item.delta', { channel: 'text', text: 'Done: it passes now.' }, { itemId: 'm1' });
    await emit([...opening, reply, event('request.opened', { requestId: 'r1', kind: 'command', blocking: true, title: 'Run rm -rf build', preview: 'rm -rf build', actions: [], providerData: {} })]);
    await view.waitFor({ timeout: 15000 });
    await waitFor(async () => (await view.locator('.reading-user p').allInnerTexts()).includes('fix the test'), 'your message is drawn');
    await waitFor(async () => (await view.locator('.reading-assistant').allInnerTexts()).some(text => text.includes('it passes now')), 'the agent’s words are drawn');
    await view.locator('.reading-tools-head').first().click();
    assert.equal(await view.locator('.reading-tool-output').count(), 0, 'native steps keep action and path and hide the output box'); await view.getByText('npm test').first().waitFor();
    const request = view.locator('.native-request');
    await request.getByRole('button', { name: '允许本次', exact: true }).waitFor(); await request.getByRole('button', { name: '拒绝', exact: true }).waitFor();
    assert.equal(await box.isEnabled(), true, 'the message box stays usable while the agent works');
    checks.push('events drawn: message, words, running command, request card, usable composer');

    // Typing and sending in a small card never expands the project; a refused send keeps the words and says why.
    await box.click(); await box.fill('hello'); await page.keyboard.press('Enter');
    await waitFor(async () => (await box.inputValue()) === 'hello' && await view.locator('.native-error').count() > 0, 'the refused send brings the words back with its reason');
    assert.equal(await page.locator('.activity-pane').count(), 0, 'typing in the card did not expand the project');
    await request.getByRole('button', { name: '允许本次', exact: true }).click();
    await waitFor(async () => request.locator('[role="alert"]').count().then(count => count > 0), 'an answer the main process refuses shows its reason and the card stays');
    await page.screenshot({ path: path.join(output, 'native-small-card.png') });
    checks.push('small card: typing and a refused send keep the words, the project stays small, a refused answer keeps the card');

    // A replay adds nothing; the request resolves and the card goes.
    const assistantBefore = await view.locator('.reading-assistant').count();
    await emit([{ ...reply, replay: true }, event('request.resolved', { requestId: 'r1', resolution: 'cancelled', reason: null }), event('turn.completed', { status: 'completed', error: null }), event('session.state', { state: 'idle', reason: null })]);
    await waitFor(async () => (await view.locator('.native-request').count()) === 0, 'the resolved request is gone');
    assert.equal(await view.locator('.reading-assistant').count(), assistantBefore, 'a replayed event adds nothing');
    assert.equal(await view.locator('button[title="中断（Esc）"]').count(), 0, 'no Stop once idle');
    checks.push('replay adds nothing; resolved request leaves; Stop only while working');

    await panelStage({ app, page, view, box, emit, event, output, checks, agent: 'claude' });

    // Expanded: the activity pane shows the path and API usage card.
    await page.locator(`[data-project-id="${project.id}"] .panel-name`).click();
    await page.locator('.activity-api').waitFor({ timeout: 15000 });
    assert.match(await page.locator('.activity-api').innerText(), /运行方式与额度/); assert.doesNotMatch(await page.locator('.activity-api').innerText(), /最近切换/, 'a switch that never happened has no row');
    await page.screenshot({ path: path.join(output, 'native-expanded.png') });
    checks.push('activity pane shows the usage card');

    // The settings page: the key field is a password field, nothing is saved here.
    await chooseFromAppMenu(page, '设置');
    const settings = page.locator('dialog.settings-dialog');
    await settings.locator('[data-settings-tab="runtime"]').click();
    await settings.getByRole('heading', { name: '运行方式', exact: true }).waitFor();
    assert.equal(await settings.locator('input[type="password"]').count(), 1);
    assert.ok((await settings.locator('.select-trigger').count()) >= 2, 'Claude’s path and Codex’s view');
    await waitFor(async () => /已保存|未保存/.test(await settings.locator('.runtime-key-row small[role="status"]').innerText()), 'the key status has been read');
    await settings.getByText('你自己的 API 会话里运行的命令能读到密钥；这些命令产生的花费不计入这里的预算估算。', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, 'native-settings.png') });
    checks.push('运行方式 settings page');
    assert.deepEqual(errors, []);
  } catch (error) {
    if (app) {
      await stages.run('capture UI failure', async () => { const page = await app.firstWindow(); await page.screenshot({ path: path.join(output, 'failure.png'), timeout: 2000 }); }, 3000).catch(() => {});
    }
    throw error;
  } finally {
    await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ checks, errors }, null, 2));
    await closeSmokeApplication(app, stages);
    for (const directory of [profile, home, project.path]) await fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const stages = createSmokeStages(coldStart ? { totalMs: 210000 } : {});
  try {
    const contractsOnly = process.argv.includes('--switch-contracts');
    const output = await stages.run('prepare output', async () => {
      return testRun(contractsOnly ? 'native-session-contracts' : 'native-session',
        process.env.AGENTRIX_TEST_OUTPUT_ROOT ? { root: process.env.AGENTRIX_TEST_OUTPUT_ROOT } : {});
    }); stages.output(output);
    // The contracts are tests/ files that `npm test` already runs: only the run that names them runs them here, and the desktop runs go straight to the GUI.
    if (contractsOnly) await switchContracts(output, stages);
    else await stages.run('GUI lock and native suite', () => withGuiLock('native-session', () => process.argv.includes('--runtime') ? runtimeSmoke(output, stages) : run(output, stages)), 140000);
    console.log('PASS: native session smoke. Evidence: ' + output);
    process.exitCode = 0;
  } catch (error) { console.error('[native-smoke] FAIL ' + String(error.message).replace(/sk-ant-[\w-]+/g, '<offline-key>')); stages.force(); process.exitCode = 1; }
  finally {
    stages.dispose();
  }
  process.exit(process.exitCode);
}
