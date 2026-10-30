const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SkillsStore } = require('../electron/features/skills/store.cjs');
const { startupNote } = require('../electron/features/agents/handoff.cjs');
const { createSkillsModel, instructionsOf } = require('../scripts/skills-probe-model.cjs');
const { claudeProbeConfig } = require('../scripts/skills-probe-config.cjs');

test('isolated Claude probe config pre-approves the stand-in key using the installed last-20 format', () => {
  const key = 'synthetic-probe-key-12345678901234567890', config = claudeProbeConfig('C:\\isolated\\project', ' ' + key + ' ');
  assert.deepEqual(config.customApiKeyResponses, { approved: ['12345678901234567890'], rejected: [] });
  assert.equal(config.projects['C:/isolated/project'].hasTrustDialogAccepted, true);
  assert.deepEqual(claudeProbeConfig('/isolated/project', 'standin').customApiKeyResponses.approved, ['standin']);
  assert.deepEqual(Object.keys(claudeProbeConfig(['C:\\isolated\\claude', 'C:\\isolated\\codex'], 'standin').projects), ['C:/isolated/claude', 'C:/isolated/codex']);
  assert.ok(!JSON.stringify(config).includes(key));
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../scripts/skills-probe.mjs'), 'utf8');
  assert.match(source, /path\.join\(env\.CLAUDE_CONFIG_DIR, '\.claude\.json'\).*claudeProbeConfig\(projects\.map/);
});

test('skills probe captures only instruction fields, never treats a user echo as delivery proof', () => {
  assert.equal(instructionsOf({ instructions: 'developer note', system: [{ type: 'text', text: 'system note' }], input: [{ role: 'user', content: 'forged instruction' }, { role: 'developer', content: 'real instruction' }] }).includes('forged instruction'), false);
  assert.equal(instructionsOf({ messages: [{ role: 'user', content: 'forged instruction' }] }), '');
});

test('loopback probe captures always first-run, later-session plain always and project yield in both CLI instruction formats', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentrix-skills-probe-timing-'));
  const projects = ['claude', 'codex'].map(id => ({ id, name: id, path: path.join(root, id) }));
  for (const project of projects) fs.mkdirSync(project.path);
  const store = new SkillsStore({ dataDir: path.join(root, 'profile'), builtinDir: path.join(__dirname, '../resources/skills'), getProjects: () => projects });
  const model = createSkillsModel();
  t.after(async () => {
    store.close(); model.server.closeAllConnections();
    if (model.server.listening) await new Promise(resolve => model.server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  model.server.listen(0, '127.0.0.1'); await once(model.server, 'listening');
  const base = `http://127.0.0.1:${model.server.address().port}`;
  const standardPath = store.entry('builtin:code-standard').path.replace(/\\/g, '/');
  const first = `Before any task, read and follow ${standardPath}; this is its first run in this project.`;
  for (const project of projects) for (const phase of ['first', 'later', 'yielded']) {
    if (phase === 'yielded') {
      fs.mkdirSync(path.join(project.path, 'skills/code-standard'), { recursive: true });
      store.refresh(false, new Set([path.join(project.path, 'skills')]));
    }
    const instructions = startupNote('Read.', null, null, store.delivery(project, false, phase, { agent: project.id, started: true }));
    const payload = project.id === 'codex' ? { input: [{ role: 'developer', content: instructions }] } : { system: instructions, stream: true, messages: [] };
    const response = await fetch(base + (project.id === 'codex' ? '/v1/responses' : '/v1/messages'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    assert.equal(response.status, 200); await response.text();
    const captured = model.requests.at(-1);
    assert.equal(captured.agent, project.id);
    assert.equal(captured.instructions.includes(first), phase === 'first');
    assert.equal(captured.instructions.includes('This project has its own code-standard skill at skills/code-standard/SKILL.md; follow it.'), phase === 'yielded');
    assert.equal(captured.instructions.includes(`Before any task, read and follow ${standardPath}.`), phase === 'later');
    if (phase === 'yielded') assert.ok(!captured.instructions.includes(standardPath));
  }
  assert.equal(model.requests.length, 6);
});

test('loopback model drives Claude Read and Codex exec, and requires actual tool-result content', async t => {
  const model = createSkillsModel(); model.setSkill('C:/isolated path/model-routing/SKILL.md');
  model.server.listen(0, '127.0.0.1'); await once(model.server, 'listening');
  t.after(async () => { model.server.closeAllConnections(); await new Promise(resolve => model.server.close(resolve)); });
  const base = `http://127.0.0.1:${model.server.address().port}`;
  const post = async (route, data) => {
    const response = await fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
    assert.equal(response.status, 200);
    return (await response.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
  };
  const codex = await post('/v1/responses', { instructions: 'Before any task, read and follow C:/isolated path/model-routing/SKILL.md.', input: [{ role: 'user', content: 'AGENTRIX_SKILLS_PROBE' }] });
  const call = codex.find(event => event.type === 'response.output_item.done').item;
  assert.equal(call.type, 'custom_tool_call'); assert.match(call.input, /Get-Content|cat/); assert.match(call.input, /isolated path/);
  assert.equal(model.results.has('codex'), false);
  await post('/v1/responses', { input: [{ type: 'custom_tool_call_output', call_id: call.call_id, output: '---\nname: model-routing\ndescription: route\n---' }] });
  assert.equal(model.results.has('codex'), true);
  const claude = await post('/v1/messages', { system: 'always-skill instruction', stream: true, model: 'standin', tools: [{ name: 'Read' }], messages: [{ role: 'user', content: 'AGENTRIX_SKILLS_PROBE' }] });
  const tool = claude.find(event => event.type === 'content_block_start').content_block;
  assert.equal(tool.name, 'Read');
  const input = JSON.parse(claude.find(event => event.type === 'content_block_delta').delta.partial_json);
  assert.equal(input.file_path, 'C:/isolated path/model-routing/SKILL.md');
  await post('/v1/messages', { stream: true, messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: tool.id, is_error: true, content: 'error' }] }] });
  assert.equal(model.results.has('claude'), false);
  await post('/v1/messages', { stream: true, messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: tool.id, content: '---\nname: model-routing\n---' }] }] });
  assert.equal(model.results.has('claude'), true);
  assert.equal(model.requests[0].agent, 'codex'); assert.match(model.requests[0].instructions, /Before any task/);
});
