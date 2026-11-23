// CI only (set AGENTRIX_REAL_CLAUDE): the real Claude Code as a worker terminal, offline. A throwaway profile with a fake
// key, the stub API of claude-real.cjs, and the real hook server; nothing of the owner's is read or written.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const skip = !process.env.AGENTRIX_REAL_CLAUDE && 'set AGENTRIX_REAL_CLAUDE';

test('a real Claude Code worker terminal reports through its hooks and gives its final text', { skip, timeout: 90000 }, async t => {
  const { harness, opening, textBlock, finish } = require('./fixtures/claude-real.cjs');
  const { createWorkerTerminals } = require('../electron/features/worker-terminals/worker-terminals.cjs');
  const { createEventStream } = require('../electron/features/native-session/events.cjs');
  const { createHookServer } = require('../electron/features/terminal-events/hook-server.cjs');
  const { createHookIngest } = require('../electron/features/terminal-events/hook-ingest.cjs');
  const { terminalHooks } = require('../electron/features/terminal-events/hook-channel.cjs');
  const { createEventServer } = require('../electron/events.cjs');
  const pty = require('node-pty');
  const f = await harness(t, data => [opening(data), ...textBlock(0, 'REAL WORKER ANSWER'), ...finish('end_turn')]);
  const env = { ...f.env }; delete env.CI;
  const run = { runId: 'offline-run', projectId: 'terminal', agent: 'claude', cwd: f.cwd, local: true, leadMode: 'terminal' };
  const runtimeDir = path.join(path.dirname(f.cwd), 'runtime'), integration = path.join(__dirname, '../integration');
  const brief = path.join(runtimeDir, `worker-${run.runId}`, 'brief');
  // The throwaway profile answers the CLI's onboarding, the fake key and the folder's trust in advance (claude-terminal.cjs).
  const projects = Object.fromEntries([f.cwd, brief].map(folder => [folder.replaceAll('\\', '/'),
    { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true }]));
  fs.writeFileSync(path.join(env.CLAUDE_CONFIG_DIR, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, lastOnboardingVersion: '2.1.318', theme: 'dark',
    customApiKeyResponses: { approved: [env.ANTHROPIC_API_KEY.slice(-20)], rejected: [] },
    projects }));
  fs.mkdirSync(runtimeDir);
  const bootstrapFile = path.join(runtimeDir, 'bootstrap.json');
  fs.writeFileSync(bootstrapFile, JSON.stringify({ shims: path.join(integration, 'shims') }));
  let terminals, eventServer, hookServer;
  // The harness drains these before removing the profile. Also covers setup/assertion failures, while the CLI's hook
  // endpoints stay available until its PTY and ConPTY resources have actually gone.
  f.cleanup(async () => {
    try { await terminals?.closeAll(); }
    finally { await Promise.all([hookServer?.close(), eventServer?.close()]); }
  });
  eventServer = await createEventServer(event => terminals.event(event));
  hookServer = await createHookServer(createHookIngest({ keyOf: id => terminals.keyOf(id), deliver: event => terminals.hook(event) }));
  let workerPty, exited = false, screen = '';
  terminals = createWorkerTerminals({ spawn: (file, args, options) => {
    workerPty = pty.spawn(file, args, options);
    workerPty.onExit(() => { exited = true; });
    workerPty.onData(chunk => { screen = (screen + chunk).slice(-3000); });
    return workerPty;
  }, claudeFile: () => process.env.AGENTRIX_REAL_CLAUDE,
    parent: () => ({ env, sessionKey: 'offline-owner', bootstrapFile }), calls: () => ({ setAwaiting() {} }), runtimeDir: () => runtimeDir,
    claudeHome: () => env.CLAUDE_CONFIG_DIR,
    hooks: ({ terminalId, sessionKey, env: workerEnv, cwd }) => terminalHooks({ port: hookServer.port, terminalId, sessionKey, eventServer, env: workerEnv, cwd,
      workerPermission: true,
      shell: { posix: process.platform !== 'win32', script: path.join(integration, 'claude-hook.ps1'), node: process.execPath, helper: path.join(integration, 'agent-event.cjs'),
        powershellPath: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') } }) });
  const spec = { agent: 'claude', projectId: 'terminal', terminalId: 'offline-run', runtimeSessionId: 'offline-run', runId: 'offline-run', cwd: f.cwd,
    model: 'claude-sonnet-4-5', permission: 'acceptEdits' };
  const events = [];
  const runtime = terminals.create(run, spec, createEventStream(spec, event => events.push(event)));
  await runtime.start();
  await runtime.send({ clientMessageId: 'brief', text: 'Answer with the stub reply.' });
  for (let n = 0; n < 600 && !events.some(event => event.type === 'turn.completed'); n++) await new Promise(resolve => setTimeout(resolve, 100));
  const types = events.map(event => event.type);
  assert.ok(types.includes('turn.started') && types.includes('turn.completed'), `events: ${types.join(', ')}\n${JSON.stringify(screen)}`);
  assert.ok(events.some(event => event.type === 'transcript.record'), 'the transcript reaches the meter');
  assert.equal(events.find(event => event.type === 'item.upsert' && event.payload.kind === 'agent-message')?.payload.content.text, 'REAL WORKER ANSWER');
  assert.equal(events.find(event => event.type === 'path.changed').payload.selected, 'terminal-worker');
  assert.ok(f.stats.keys.every(key => key === env.ANTHROPIC_API_KEY), 'the worker used the throwaway profile\'s key only');
  await runtime.close();
  assert.ok(exited, 'close waits for the PTY exit, not just the shutdown deadline');
  if (process.platform === 'win32') {
    const agent = workerPty._agent;
    assert.equal(agent._conoutSocketWorker._worker.threadId, -1, 'the ConPTY output worker terminated');
    assert.ok(agent._inSocket.destroyed && agent._outSocket.destroyed, 'both ConPTY sockets closed');
  }
});
