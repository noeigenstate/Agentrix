const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { Readable, Writable } = require('node:stream');
const { createRoleArtifacts, stampRoleArtifacts, trackRoleProcess, sweepRoleArtifacts, RETENTION, ORPHAN_RETENTION,
  ROLE_RESULT_SERVER, roleResultServer, createRoleResultTools, readRoleResultFile, settleRoleResult,
  roleNeedsDecision, roleResultFields } = require('../integration/role-artifacts.cjs');
const { createRoleTools, serve } = require('../integration/role-tools.cjs');
const { startDetached, dispatchEvent } = require('../integration/dispatch.cjs');
const { WorkerSkillProposals } = require('../electron/features/skills/worker-proposals.cjs');
const { createCodexRuntime } = require('../electron/features/codex-app-server/index.cjs');
const { started, ended } = require('./helpers/dispatch-events.cjs');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agx-artifacts-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'temp');
  await fs.mkdir(root);
  return { directory, root };
}

test('finish_role validates UTF-8 bytes, findings and nested fields before writing', async t => {
  const { root } = await fixture(t), { folder } = await createRoleArtifacts(root), runId = randomUUID();
  const { tools } = createRoleResultTools({ folder, runId });
  for (const args of [
    {}, { answer: '' }, { answer: ' ' }, { answer: '答'.repeat(69_000) }, { answer: 'ok', findings: Array(21).fill('a') },
    { answer: 'ok', findings: ['𠮷'.repeat(1001)] }, { answer: 'ok', findings: [42] },
    { answer: 'ok', needsDecision: null }, { answer: 'ok', needsDecision: [{ question: 'Q', options: [{ label: 'A' }], recommendation: 'A' }] },
    { answer: 'ok', needsApproval: [{ action: 'Publish' }] }, { answer: 'ok', skillProposals: [42] },
    { answer: 'ok', verification: { ran: [{ command: 'test', result: 'unknown', note: 'why' }], unverified: [] } },
  ]) await assert.rejects(tools.finish_role(args), /Invalid finish_role arguments/);
  assert.equal(await readRoleResultFile(folder, runId), null);
  await tools.finish_role({ answer: 'a'.repeat(200 * 1024), findings: Array(20).fill('𠮷'.repeat(1000)) });
  assert.equal((await readRoleResultFile(folder, runId)).calls, 1);
});

test('the role result MCP exposes one tool and stores a single versioned JSON line', async t => {
  const { root } = await fixture(t), { folder } = await createRoleArtifacts(root), runId = randomUUID();
  const roleServer = roleResultServer(path.join(root, 'dispatch.cjs'), runId, folder);
  assert.deepEqual(roleServer, { command: process.execPath, args: [path.join(root, 'dispatch.cjs'), 'mcp-role', runId, folder],
    env: { ELECTRON_RUN_AS_NODE: '1' } });
  const roles = createRoleResultTools({ folder, runId, now: () => 123 });
  const args = { answer: '# Answer\nA line', findings: ['checked'],
    needsDecision: [{ question: 'Proceed?', options: [{ label: 'Yes', effect: 'Publish' }], recommendation: 'Yes' }],
    needsApproval: [{ action: 'Publish', reason: 'Needs approval' }],
    skillProposals: ['Clarify examples'], verification: { ran: [{ command: 'node --test', result: 'pass', note: 'offline' }], unverified: ['production'] } };
  const requests = [{ id: 0, method: 'initialize' },
    { id: 1, method: 'tools/list' }, { id: 2, method: 'tools/call', params: { name: 'finish_role', arguments: args } }];
  const input = Readable.from(requests.map(request => JSON.stringify({ jsonrpc: '2.0', ...request }) + '\n'));
  const responses = [];
  const output = new Writable({ write(chunk, _encoding, done) { responses.push(JSON.parse(chunk)); done(); } });
  await serve({ roles, input, output, name: ROLE_RESULT_SERVER });
  assert.equal(responses[0].result.serverInfo.name, ROLE_RESULT_SERVER);
  assert.deepEqual(responses[1].result.tools.map(tool => tool.name), ['finish_role']);
  assert.deepEqual(JSON.parse(responses[2].result.content[0].text), { saved: true, calls: 1 });
  const text = await fs.readFile(path.join(folder, 'result.json'), 'utf8');
  assert.equal(text.match(/\n/g).length, 1);
  const expected = { format: 'agentrix.role-result', version: 1, runId, source: 'finish-role', ...args, calls: 1, at: 123 };
  assert.deepEqual(JSON.parse(text), expected);
  assert.deepEqual(await readRoleResultFile(folder, runId), expected);
  await assert.rejects(readRoleResultFile(folder, randomUUID()), /different run/);
});

test('Codex puts the result MCP in the read-only worker thread configuration', async t => {
  const { directory, root } = await fixture(t), { folder } = await createRoleArtifacts(root), runId = randomUUID();
  const log = path.join(directory, 'rpc.jsonl'), roleServer = roleResultServer(path.join(directory, 'dispatch.cjs'), runId, folder);
  const runtime = createCodexRuntime({
    resolveExecutable: async () => 'synthetic-only',
    spawnProcess: (_file, _args, options) => spawn(process.execPath, [path.join(__dirname, 'fixtures/codex-app-server.cjs')], {
      ...options, env: { ...options.env, SYNTHETIC_CODEX_LOG: log },
    }),
  }).create({ owner: 'dispatch', projectId: 'project', terminalId: runId, runtimeSessionId: runId, runId,
    cwd: root, env: { CODEX_HOME: directory }, readOnly: true, roleServer }, () => {});
  try {
    await runtime.start();
    const rows = (await fs.readFile(log, 'utf8')).trimEnd().split('\n').map(JSON.parse);
    const config = rows.find(row => row.method === 'thread/start').params;
    assert.equal(config.sandbox, 'danger-full-access');
    assert.equal(config.approvalPolicy, 'untrusted');
    assert.deepEqual(config.config.mcp_servers, { agentrix_role: { ...roleServer, tools: { finish_role: { approval_mode: 'approve' } } } });
  } finally { await runtime.close(); }
});

test('finish_role serializes requests, replaces the answer and counts successful calls across server launches', async t => {
  const { root } = await fixture(t), { folder } = await createRoleArtifacts(root), runId = randomUUID();
  const { tools } = createRoleResultTools({ folder, runId });
  const calls = await Promise.allSettled([tools.finish_role({ answer: 'first', findings: ['old'] }),
    tools.finish_role({}), tools.finish_role({ answer: 'second' })]);
  assert.deepEqual(calls.map(call => call.value?.calls ?? call.status), [1, 'rejected', 2]);
  assert.deepEqual((await readRoleResultFile(folder, runId)).findings, []);
  const next = createRoleResultTools({ folder, runId });
  assert.equal((await next.tools.finish_role({ answer: 'last' })).calls, 3);
  const result = await settleRoleResult({ folder, runId, answer: 'short acknowledgement', legacyDecision: () => assert.fail('already finished') });
  assert.equal(result.answer, 'last');
  assert.equal(roleNeedsDecision(result), false);
});

test('settlement preserves final text, unknown decisions and the 1.6.4 legacy decision signal', async t => {
  const { root } = await fixture(t);
  for (const legacy of [false, true]) {
    const { folder } = await createRoleArtifacts(root), runId = randomUUID(), answer = 'The final text.';
    const result = await settleRoleResult({ folder, runId, answer, now: () => 123, legacyDecision: text => legacy && text === answer });
    assert.deepEqual(result, { format: 'agentrix.role-result', version: 1, runId, source: legacy ? 'legacy-heading' : 'final-text',
      answer, needsDecision: null, needsApproval: [], findings: [], calls: 0, at: 123 });
    assert.equal(roleNeedsDecision(result), legacy ? true : null);
    assert.deepEqual(await readRoleResultFile(folder, runId), result);
    const fields = roleResultFields(result);
    assert.equal(fields.notice, '未调用 finish_role');
    assert.equal(fields.needsDecision, null);
    assert.equal(fields.legacyNeedsDecision, legacy ? true : undefined);
  }
});

test('role cleanup protects live folders and retained unread answers, and caps read answers oldest first', async t => {
  const { root } = await fixture(t);
  const now = RETENTION * 2;
  const active = await createRoleArtifacts(root);
  const [expired, unread, oldestRead, newestRead] = await Promise.all(Array.from({ length: 4 }, () => createRoleArtifacts(root)));
  for (const [role, ended] of [[expired, now - RETENTION], [unread, now - 3], [oldestRead, now - 2], [newestRead, now - 1]]) {
    await stampRoleArtifacts(role, 'ended', ended);
  }
  await stampRoleArtifacts(oldestRead, 'read');
  await stampRoleArtifacts(newestRead, 'read');
  await sweepRoleArtifacts(root, { now, maxFolders: 3 });
  assert.deepEqual((await fs.readdir(root)).sort(), [active, unread, newestRead].map(role => path.basename(role.folder)).sort());
});

test('cleanup ignores unmarked folders and junctions, and backs off a locked artifact across sweeps', async t => {
  const { directory, root } = await fixture(t);
  const outside = await createRoleArtifacts(directory);
  await stampRoleArtifacts(outside, 'ended', 1);
  const log = path.join(outside.folder, 'untouched.log');
  await fs.writeFile(log, 'outside the sweep');
  const directoryLink = path.join(root, 'agentrix-role-linked');
  await fs.symlink(outside.folder, directoryLink, process.platform === 'win32' ? 'junction' : 'dir');
  const legacy = path.join(root, 'agentrix-role-legacy');
  await fs.mkdir(legacy);
  const ended = await createRoleArtifacts(root);
  await stampRoleArtifacts(ended, 'ended', 1);
  await fs.mkdir(path.join(ended.folder, 'nested'));
  await fs.symlink(outside.folder, path.join(ended.folder, 'nested', 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  const now = RETENTION + 1;
  await sweepRoleArtifacts(root, { now, remove: async () => { throw Object.assign(new Error('locked'), { code: 'EBUSY' }); } });
  assert.ok((await fs.stat(ended.folder)).isDirectory());
  await sweepRoleArtifacts(root, { now });
  assert.ok((await fs.stat(ended.folder)).isDirectory());
  await sweepRoleArtifacts(root, { now: now + 60000 });
  assert.deepEqual((await fs.readdir(root)).sort(), [legacy, directoryLink].map(folder => path.basename(folder)).sort());
  assert.equal(await fs.readFile(log, 'utf8'), 'outside the sweep');
});

test('the cleanup limit counts removals, and old marked folders survive while their recorded process is alive', async t => {
  const { root } = await fixture(t);
  const roles = await Promise.all(Array.from({ length: 34 }, () => createRoleArtifacts(root)));
  for (const [index, role] of roles.entries()) {
    await fs.writeFile(path.join(role.folder, 'answer.md'), 'answer');
    await stampRoleArtifacts(role, 'ended', index + 1);
  }
  const live = await createRoleArtifacts(root), unstarted = await createRoleArtifacts(root);
  trackRoleProcess(live, process.pid);
  const now = Date.now() + ORPHAN_RETENTION + 1000;
  let failures = 0;
  await sweepRoleArtifacts(root, { now, remove: async (file, options) => {
    if (path.dirname(file) === roles[0].folder) { failures++; throw new Error('locked'); }
    await fs.rm(file, options);
  } });
  assert.deepEqual((await fs.readdir(root)).sort(), [roles[0], roles[33], live, unstarted].map(role => path.basename(role.folder)).sort());
  await sweepRoleArtifacts(root, { now, remove: async (file, options) => {
    assert.notEqual(path.dirname(file), roles[0].folder);
    await fs.rm(file, options);
  } });
  assert.equal(failures, 1);
  assert.deepEqual((await fs.readdir(root)).sort(), [roles[0], live].map(role => path.basename(role.folder)).sort());
});

test('shared temp cleanup refuses a foreign owner or writable mode and checks mode again before removal', { skip: !process.getuid }, async t => {
  const { root } = await fixture(t);
  const [unsafe, changed] = await Promise.all([createRoleArtifacts(root), createRoleArtifacts(root)]);
  for (const role of [unsafe, changed]) await stampRoleArtifacts(role, 'ended', 1);
  await fs.chmod(unsafe.folder, 0o722);
  const getuid = process.getuid;
  t.mock.method(process, 'getuid', () => getuid() + 1);
  await sweepRoleArtifacts(root, { now: RETENTION + 1 });
  assert.ok((await fs.stat(changed.folder)).isDirectory());
  t.mock.restoreAll();
  await fs.writeFile(path.join(changed.folder, 'answer.md'), 'answer');
  await sweepRoleArtifacts(root, { now: RETENTION + 1, remove: async (file, options) => {
    assert.equal(path.dirname(file), changed.folder);
    await fs.rm(file, options);
    await fs.chmod(changed.folder, 0o722);
  } });
  assert.ok((await fs.stat(unsafe.folder)).isDirectory());
  assert.ok((await fs.stat(changed.folder)).isDirectory());
});

for (const expired of [false, true]) test(`role_result explains removal by ${expired ? 'age' : 'the folder cap'}`, async t => {
  const { directory, root } = await fixture(t);
  const bootstrap = path.join(directory, 'boot.json');
  await fs.writeFile(bootstrap + '.mode', 'conductor');
  await fs.writeFile(bootstrap + '.seats', JSON.stringify({ developer: { model: 'opus', effort: 'high' } }));
  let now = Date.now();
  const runId = randomUUID();
  const { tools } = createRoleTools({ env: { AGENTRIX_BOOTSTRAP: bootstrap }, cwd: directory, tempRoot: root, now: () => now,
    engine: async (args, { onEvent, roleArtifacts }) => {
      if (args.includes('--detach')) {
        await fs.writeFile(path.join(roleArtifacts.folder, 'answer.md'), expired ? 'result' : 'fallback');
        if (!expired) await createRoleResultTools({ folder: roleArtifacts.folder, runId }).tools.finish_role({ answer: 'result', findings: ['checked'] });
        await stampRoleArtifacts(roleArtifacts, 'ended', now - 1);
        onEvent(started(runId, 'claude'));
      } else onEvent(ended(runId, 'exit', { agent: 'claude', result: { source: expired ? 'final-text' : 'finish-role', out: 'answer.md' } }));
    } });
  const { id } = await tools.start_role({ seat: 'developer', title: 'Read files', brief: 'Read the docs', readOnly: true });
  await sweepRoleArtifacts(root, { now, maxFolders: 0 });
  assert.equal((await fs.readdir(root)).length, 1);
  const result = await tools.role_result({ id });
  assert.equal(result.answer, 'result');
  if (!expired) assert.deepEqual([result.source, result.calls, result.findings], ['finish-role', 1, ['checked']]);
  if (expired) now += RETENTION + 1000;
  await sweepRoleArtifacts(root, { now, maxFolders: expired ? 256 : 0 });
  assert.deepEqual(await fs.readdir(root), []);
  const removed = await tools.role_result({ id });
  assert.equal(removed.answer, expired ? 'Answer removed by cleanup after 7 days.' : 'Answer removed by cleanup to make room for newer role folders.');
  assert.equal(removed.answerRemoved, true);
});

test('a detached launch rejected before a helper exists can expire without a receipt', async t => {
  const { root } = await fixture(t);
  const roleArtifacts = await createRoleArtifacts(root);
  await assert.rejects(startDetached(['codex', '--detach'], { env: {}, roleArtifacts, launch: () => assert.fail('invalid launch') }));
  await sweepRoleArtifacts(root, { now: Date.now() + RETENTION });
  assert.deepEqual(await fs.readdir(root), []);
});

for (const receiptExpired of [false, true]) test(`role_result recovers all skill previews after cleanup (receipt expired: ${receiptExpired})`, async t => {
  const { directory, root } = await fixture(t);
  const project = path.join(directory, 'project'), skills = path.join(project, 'skills');
  const bootstrap = path.join(directory, 'boot.json'), env = { AGENTRIX_BOOTSTRAP: bootstrap, AGENTRIX_DATA_DIR: path.join(directory, 'profile') };
  await fs.mkdir(project);
  await fs.writeFile(bootstrap + '.mode', 'conductor');
  await fs.writeFile(bootstrap + '.seats', JSON.stringify({ developer: { model: 'opus', effort: 'high' } }));
  const runId = randomUUID(), endedAt = Date.now();
  let details;
  const { tools } = createRoleTools({ env, cwd: project, tempRoot: root, now: () => endedAt + RETENTION + 1,
    engine: async (args, { onEvent, onTiming, roleArtifacts }) => {
      if (!args.includes('--detach')) {
        onTiming({ id: runId, endedAt });
        onEvent(receiptExpired ? dispatchEvent('unknown-run', runId) : ended(runId, 'exit', {
          result: { source: 'final-text', out: 'answer.md', skillProposalDetails: details },
        }));
        return;
      }
      const guard = new WorkerSkillProposals({ cwd: project, allow: ['skills/**'] }, env, null);
      for (let n = 0; n < 240; n++) {
        const folder = path.join(skills, `proposal-${n}`);
        await fs.mkdir(folder, { recursive: true });
        await fs.writeFile(path.join(folder, 'SKILL.md'), 'x'.repeat(2050));
      }
      guard.finish(runId);
      details = guard.details;
      assert.equal(details.previewsInIndex, true);
      assert.equal(details.proposals.length, details.count);
      assert.ok(details.proposals.some(proposal => proposal.text === undefined), 'the receipt gives metadata priority over previews');
      await stampRoleArtifacts(roleArtifacts, 'ended', endedAt);
      onEvent(started(runId, 'claude'));
    } });
  const { id } = await tools.start_role({ seat: 'developer', title: 'Propose skills', brief: 'Write proposals', allow: ['skills/**'] });
  await sweepRoleArtifacts(root, { now: endedAt + RETENTION + 1 });
  assert.deepEqual(await fs.readdir(root), []);
  const result = await tools.role_result({ id });
  if (!receiptExpired) assert.equal(result.answerRemoved, true);
  assert.equal(result.skillProposalDetails.indexPath, details.indexPath);
  assert.equal(result.skillProposalDetails.proposals.length, 240);
  const proposal = result.skillProposalDetails.proposals.at(-1);
  assert.equal(proposal.operation, 'create');
  assert.equal(proposal.text, 'x'.repeat(2048));
  assert.equal(proposal.truncated, true);
  assert.equal(await fs.readFile(proposal.savedPath, 'utf8'), 'x'.repeat(2050));
});
