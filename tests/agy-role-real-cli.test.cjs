const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { adapterOf, adapterOfModel } = require('../electron/features/cli-adapters/registry.cjs');
const { AgentCalls } = require('../electron/features/agents/agent-calls.cjs');
const { createDispatchControl } = require('../electron/features/agents/dispatch-control.cjs');
const { createDispatchIntake } = require('../electron/features/agents/dispatch-intake.cjs');
const { resolveRegistration } = require('../electron/features/agents/dispatch-registration.cjs');
const { createInterventions } = require('../electron/features/agents/interventions.cjs');
const { locateTeam } = require('../electron/features/team/team-locate.cjs');
const { registerAgyWorker } = require('../electron/features/native-session/worker.cjs');
const { createEventServer } = require('../electron/events.cjs');
const { run } = require('../integration/dispatch.cjs');
const { createRoleArtifacts, readRoleResultFile, roleResultServer } = require('../integration/role-artifacts.cjs');
const { temporary, recordEvents, projectExtensions, processTree } = require('./helpers/agy-runtime.cjs');

const exec = promisify(execFile), agy = adapterOf('agy');
const MODEL = 'gemini-3.8-flash', EFFORT = 'low';
const DISPATCH = path.resolve(__dirname, '../integration/dispatch.cjs');

async function fixture(t, install, { readOnly, prompt, captureTree, extensions }) {
  let runtime, control, eventServer, settled, inbox, intake, calls;
  t.after(async () => {
    control?.close();
    await runtime?.close();
    await settled;
    await eventServer?.close();
    await inbox?.work;
    intake?.disposeDispatchInbox();
    calls?.reset();
  });
  const root = await temporary(t);
  const cwd = path.join(root, 'project'), dataDir = path.join(root, 'data'), geminiDir = path.join(dataDir, 'agy', 'role');
  const brief = path.join(root, 'brief.md'), out = path.join(root, 'answer.md'), bootstrap = path.join(root, 'bootstrap.json');
  const owner = { terminalId: 'terminal', sessionKey: randomUUID(), controlCapability: randomUUID(), agent: 'claude', nativeStructured: true, bootstrapFile: bootstrap };
  const project = { path: cwd, kind: 'local' };
  await fs.promises.mkdir(cwd);
  await exec('git', ['init', '-q'], { cwd, windowsHide: true });
  if (extensions) await projectExtensions(cwd, root);
  await fs.promises.writeFile(brief, prompt);
  const deps = { sessions: new Map([[owner.terminalId, owner]]), store: { findTerminal: () => ({ project }) }, locateTeam };
  const signed = recordEvents();
  calls = new AgentCalls({ local: false, dispatchAlive: () => true });
  intake = createDispatchIntake({ ...deps, callsOf: () => calls, broadcast() {}, roleEnded: (_owner, _project, event) => signed.emit(event) });
  inbox = intake.bindDispatchInbox(owner, project);
  control = createDispatchControl({ resolveRun: registration => resolveRegistration(deps, registration) });
  eventServer = await createEventServer(event => intake.acceptDispatchEvent(owner, project, event));
  const { address } = await control.listen();
  await fs.promises.writeFile(bootstrap, JSON.stringify({ projectId: owner.terminalId, sessionKey: owner.sessionKey, controlCapability: owner.controlCapability,
    controlAddress: address, pipeName: eventServer.address }));
  const roleArtifacts = await createRoleArtifacts(root);
  const create = await agy.native.load(), factory = create({ dataDir, resolveExecutable: () => install.file });
  const events = recordEvents(), dispatch = recordEvents();
  const pids = Promise.withResolvers();
  registerAgyWorker({ control, adapterOf, adapterOfModel, geminiDir, env: () => ({ ...process.env, AGENTRIX_DATA_DIR: dataDir }),
    roleResultServer: (id, folder) => roleResultServer(DISPATCH, id, folder),
    readRoleResult: readRoleResultFile,
    runtimeOf: () => ({ create(spec, emit) {
      runtime = factory.create(spec, event => { events.emit(event); emit(event); });
      if (captureTree) {
        const start = runtime.start.bind(runtime);
        runtime.start = async options => {
          const identity = await start(options);
          pids.resolve(await processTree(runtime.pid));
          return identity;
        };
      }
      return runtime;
    } }),
  });
  const args = ['agy', '--small', '--role', 'exec', '--title', 'ACP smoke', '--cwd', cwd, '--brief', brief, '--out', out,
    '--model', MODEL, '--effort', EFFORT, ...(readOnly ? ['--read-only'] : ['--allow', 'allowed.txt'])];
  settled = run(args, { env: { PATH: process.env.PATH, AGENTRIX_BOOTSTRAP: bootstrap }, roleArtifacts,
    onEvent: dispatch.emit, launch: () => assert.fail('the dispatch helper must use the local broker') });
  const stop = id => createInterventions({ pushControl: control.pushControl, resolve: () => ({
    terminalId: owner.terminalId, callId: 'dispatch:' + id, parentSessionId: 'planner', confirmed: true,
    route: 'dispatch', runId: id, title: 'ACP smoke', cwd, projectPath: cwd, local: true,
  }) }).stopAgent(owner.terminalId, 'dispatch:' + id);
  return { cwd, out, events, dispatch, settled, pids: pids.promise, roleArtifacts, stop, signed, calls, inbox };
}

function authRequired(f) {
  return f.events.all.some(({ payload }) => [payload?.code, payload?.error, payload?.reason].includes('agy_auth_required'));
}

async function verifyResult(t, f, answer, reason) {
  const code = await f.settled;
  if (authRequired(f)) return false;
  const end = f.dispatch.all.find(event => event.type === 'dispatch.ended');
  assert.equal(code, 0, JSON.stringify(f.dispatch.all));
  const tools = f.events.all.filter(event => event.type === 'item.upsert' && event.payload.content?.tool)
    .map(({ payload }) => [payload.content.tool, payload.status]);
  const approvals = f.events.all.filter(event => event.type === 'request.resolved').map(event => event.payload);
  const diagnostic = JSON.stringify({ end, tools, approvals, written: fs.readdirSync(f.cwd) });
  assert.equal(end?.reason, 'permission', diagnostic);
  assert.equal(end.refused.first.reason, reason, diagnostic);
  assert.deepEqual([end.model, end.effort, end.routing], [MODEL, EFFORT, 'ok']);
  assert.equal(end.result.source, 'finish-role');
  const inputs = f.events.all.filter(event => event.type === 'item.upsert' && event.payload.kind === 'user-message');
  assert.equal(inputs.length, 2, JSON.stringify(inputs));
  assert.equal(inputs[0].providerSessionId, inputs[1].providerSessionId);
  assert.match(inputs[1].payload.content.text, new RegExp(`denied this operation: .*\\(${reason}\\).*call finish_role`));
  assert.equal(end.interventions, 0);
  await f.inbox.sweep(end.id);
  const recorded = f.signed.all.find(event => event.id === end.id);
  assert.deepEqual([recorded?.model, recorded?.effort, recorded?.verdict], [MODEL, EFFORT, 'ok']);
  assert.equal(f.calls.byId('dispatch:' + end.id)?.agent, 'Antigravity');
  assert.equal(await fs.promises.readFile(f.out, 'utf8'), answer);
  assert.equal((await readRoleResultFile(f.roleArtifacts.folder, end.id))?.answer, answer);
  t.diagnostic(`dispatch exit ${code}, denied ${reason}, automatically continued in the same session, finish_role ${answer}, routing ${end.routing}`);
  return true;
}

test('real agy role uses the dispatch broker and enforces its file scope', {
  skip: !process.env.AGENTRIX_REAL_AGY && 'set AGENTRIX_REAL_AGY to use the installed CLI', timeout: 180000,
}, async t => {
  const install = await agy.install.locate();
  if (!install.installed) return t.skip('agy is not installed');
  assert.ok(agy.install.stateOf(install).version);
  const root = await temporary(t);
  const models = await agy.modelProbe({ dataDir: root }, root, () => true).catch(error => {
    if (error.code === 'agy_auth_required') return null;
    throw error;
  });
  if (!models) return t.skip('agy is not signed in');
  assert.deepEqual(models.find(row => row.model === MODEL)?.efforts, ['low', 'medium', 'high']);
  t.diagnostic(`agy ${install.version}, ${models.length} live models, Flash supports low/medium/high`);
  let signedIn = true;
  await t.test('read-only write is refused and finish_role saves the result', async child => {
    const f = await fixture(child, install, { readOnly: true,
      prompt: 'Acceptance test: use write_file to request blocked.txt with contents OK. The host must deny it. Then call finish_role with answer READ_OK.' });
    signedIn = await verifyResult(child, f, 'READ_OK', 'read_only');
    if (!signedIn) return child.skip('agy is not signed in');
    assert.equal(fs.existsSync(path.join(f.cwd, 'blocked.txt')), false);
  });
  if (!signedIn) return t.skip('agy is not signed in');
  await t.test('allowed file is written and the other write is refused', async child => {
    const f = await fixture(child, install, { readOnly: false, extensions: true,
      prompt: 'Use write_file to write OK to allowed.txt. Then request the same write to blocked.txt. After denial, call finish_role with answer WRITE_OK.' });
    assert.equal(await verifyResult(child, f, 'WRITE_OK', 'outside_scope'), true);
    assert.equal((await fs.promises.readFile(path.join(f.cwd, 'allowed.txt'), 'utf8')).trim(), 'OK');
    assert.equal(fs.existsSync(path.join(f.cwd, 'blocked.txt')), false);
    const end = f.dispatch.all.find(event => event.type === 'dispatch.ended');
    const result = await readRoleResultFile(f.roleArtifacts.folder, end.id);
    assert.match(result.warnings?.[0], /agy hooks and MCP servers.*approvals may have bypassed Agentrix/);
    child.diagnostic(result.warnings[0]);
  });
  await t.test('stop waits for the agy process and its children to exit', async child => {
    const f = await fixture(child, install, { readOnly: true, captureTree: true, prompt: 'Count to 500.' });
    const delivered = event => event.type === 'input.receipt' && event.payload.status === 'delivered';
    const started = await Promise.race([f.dispatch.wait(event => event.type === 'dispatch.started'), f.settled.then(() => null)]);
    assert.ok(started, JSON.stringify(f.dispatch.all));
    const written = f.events.all.find(delivered) ?? await Promise.race([f.events.wait(delivered), f.settled.then(() => null)]);
    assert.ok(written, 'the prompt must be sent before the stop');
    const pids = await f.pids;
    assert.ok(pids.size > 1, 'the test must observe a live child process');
    const receipt = await f.stop(started.id);
    await f.settled;
    assert.equal(receipt.status, 'delivered');
    const end = f.dispatch.all.find(event => event.type === 'dispatch.ended');
    assert.equal(end.reason, 'killed');
    assert.equal(end.treeStopFailure, undefined);
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    child.diagnostic(`stop receipt ${receipt.status}, dispatch ${end.reason}, all ${pids.size} processes exited`);
  });
});
