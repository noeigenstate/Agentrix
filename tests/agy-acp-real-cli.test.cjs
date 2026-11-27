const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { adapterOf } = require('../electron/features/cli-adapters/registry.cjs');
const { createInstall } = require('../electron/features/agy-acp/adapter.cjs');
const { createRoleArtifacts, readRoleResultFile, roleResultServer } = require('../integration/role-artifacts.cjs');
const { temporary, session, projectExtensions } = require('./helpers/agy-runtime.cjs');

const AUTH = 'agy_auth_required';
const realAgy = { skip: !process.env.AGENTRIX_REAL_AGY && 'set AGENTRIX_REAL_AGY to use the installed CLI', timeout: 120000 };

async function turn(runtime, events, text) {
  const done = events.wait(event => event.type === 'turn.completed');
  await runtime.send({ clientMessageId: randomUUID(), text });
  return (await done).payload;
}

async function run(dataDir, install, spec, text, verify) {
  const { runtime, events } = session(dataDir, { ...spec, readOnly: true, decidePermission: () => 'unexpected_tool',
    model: 'gemini-3.8-flash', effort: 'low', turnTimeoutMs: 45000 }, { resolveExecutable: () => install.file });
  try {
    const { providerSessionId } = await runtime.start();
    const reply = await turn(runtime, events, text);
    if (reply.error === AUTH) return false;
    assert.equal(reply.status, 'completed', JSON.stringify(reply));
    assert.equal(reply.terminalReason, 'end_turn');
    await verify(events.all);
    assert.equal(await runtime.readActualModel(), 'gemini-3.8-flash-low');
    return providerSessionId;
  } catch (error) { if (error.code === AUTH) return false; throw error; }
  finally { await runtime.close(); }
}

test('real agy runs Flash Low and saves an Agentrix role result', realAgy, async t => {
  const install = await createInstall().locate();
  if (!install.installed) return t.skip('agy is not installed');
  assert.ok(install.version, 'Installed agy must report its version');
  const dataDir = await temporary(t), cwd = path.join(dataDir, 'workspace'), runId = randomUUID();
  await fs.promises.mkdir(cwd);
  const extensions = await projectExtensions(cwd);
  const { folder } = await createRoleArtifacts(dataDir);
  const roleServer = roleResultServer(path.resolve(__dirname, '../integration/dispatch.cjs'), runId, folder);
  const plain = await run(dataDir, install, { cwd }, 'Reply OK.', events => {
    assert.ok(events.some(event => event.type === 'item.upsert' && event.payload.kind === 'agent-message'
      && event.payload.status === 'completed' && /\bOK\b/.test(event.payload.content.text)));
  });
  if (!plain) return t.skip('agy is not signed in');
  assert.equal(await fs.promises.readFile(extensions.hook, 'utf8'), 'SessionStart');
  assert.equal(await fs.promises.readFile(extensions.mcp, 'utf8'), 'tools/list');
  t.diagnostic('project hooks.json ran SessionStart and mcp_config.json received tools/list with private --gemini-dir');
  const resumed = session(dataDir, { cwd, providerSessionId: plain, model: 'gemini-3.8-flash', effort: 'low' },
    { resolveExecutable: () => install.file }).runtime;
  try {
    assert.deepEqual(await resumed.resume(), { providerSessionId: plain });
    assert.equal(await resumed.readActualModel(), 'gemini-3.8-flash-low');
  } finally { await resumed.close(); }
  const tool = await run(dataDir, install, { cwd, runId, ...adapterOf('agy').roleTools.config(roleServer) }, 'Call finish_role once with answer OK.', async events => {
    assert.ok(events.some(event => event.type === 'item.upsert' && event.payload.content?.tool === 'mcp_agentrix_role_finish_role'
      && event.payload.status === 'completed'));
    const result = await readRoleResultFile(folder, runId);
    assert.equal(result?.calls, 1);
    assert.equal(result.answer, 'OK');
  });
  if (!tool) return t.skip('agy is not signed in');
  t.diagnostic(`agy ${install.version}, two end_turn responses, session resumed, finish_role saved OK, transcript model gemini-3.8-flash-low`);
});
