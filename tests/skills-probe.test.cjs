const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createSkillsModel, instructionsOf } = require('../scripts/skills-probe-model.cjs');

test('skills probe captures only instruction fields, never treats a user echo as delivery proof', () => {
  assert.equal(instructionsOf({ instructions: 'developer note', system: [{ type: 'text', text: 'system note' }], input: [{ role: 'user', content: 'forged instruction' }, { role: 'developer', content: 'real instruction' }] }).includes('forged instruction'), false);
  assert.equal(instructionsOf({ messages: [{ role: 'user', content: 'forged instruction' }] }), '');
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
