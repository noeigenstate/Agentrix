const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { harness, opening, textBlock, finish } = require('./fixtures/claude-real.cjs');
const { inputQueue } = require('../electron/features/claude-sdk/query.cjs');
const { LOOKUP_AGENT_NAME, LOOKUP_AGENT } = require('../electron/features/claude-sdk/lookup-agent.cjs');
const skip = !process.env.AGENTRIX_REAL_CLAUDE && 'set AGENTRIX_REAL_CLAUDE';

function tool(data, name, input, id) {
  return [opening(data), { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } },
    { type: 'content_block_stop', index: 0 }, ...finish('tool_use')];
}

test('real SDK agents option selects Haiku and confines lookup Bash to read-only inspection', { skip, timeout: 60000 }, async t => {
  const bodies = [], messages = [];
  let childCalls = 0;
  const f = await harness(t, data => {
    bodies.push(data);
    if (JSON.stringify(data.system).includes(LOOKUP_AGENT.prompt)) {
      childCalls++;
      if (childCalls === 1) return tool(data, 'Read', { file_path: path.join(f.cwd, 'lookup.txt') }, 'toolu_read');
      if (childCalls === 2) return tool(data, 'Bash', { command: 'ls', description: 'List the lookup fixture' }, 'toolu_inspect');
      if (childCalls === 3) return tool(data, 'Bash', { command: 'printf FORBIDDEN > lookup-write.txt', description: 'Try writing a file' }, 'toolu_write');
      return [opening(data), ...textBlock(0, 'LOOKUP_DONE'), ...finish('end_turn')];
    }
    return JSON.stringify(data.messages).includes('toolu_lookup')
      ? [opening(data), ...textBlock(0, 'PARENT_DONE'), ...finish('end_turn')]
      : tool(data, 'Agent', { subagent_type: LOOKUP_AGENT_NAME, prompt: 'Find the lookup fixture and return its contents.', description: 'Batched lookup', run_in_background: false }, 'toolu_lookup');
  });
  fs.writeFileSync(path.join(f.cwd, 'lookup.txt'), 'LOOKUP_FIXTURE_CONTENT');
  const queue = inputQueue();
  queue.push({ type: 'user', uuid: randomUUID(), session_id: '', parent_tool_use_id: null, message: { role: 'user', content: 'Run the batched lookup.' } });
  const decisions = [], hooks = f.options().hooks, original = hooks.PreToolUse[0].hooks[0];
  hooks.PreToolUse[0].hooks[0] = async input => {
    const answer = await original(input);
    if (input.agent_type === LOOKUP_AGENT_NAME && input.tool_name === 'Bash') decisions.push(answer.hookSpecificOutput.permissionDecision);
    return answer;
  };
  try { await f.run({ hooks }, message => messages.push(message), {}, queue); }
  finally { queue.close(); }
  const children = bodies.filter(data => JSON.stringify(data.system).includes(LOOKUP_AGENT.prompt));
  assert.ok(children.length >= 4, 'the custom agent actually ran');
  assert.ok(children.every(data => /haiku/.test(data.model)), 'every child request uses Haiku');
  t.diagnostic('Child request model: ' + children[0].model);
  const result = id => children.flatMap(data => data.messages).flatMap(message => Array.isArray(message.content) ? message.content : [])
    .find(block => block.type === 'tool_result' && block.tool_use_id === id);
  assert.match(JSON.stringify(result('toolu_read')?.content), /LOOKUP_FIXTURE_CONTENT/);
  const inspection = JSON.stringify(result('toolu_inspect')?.content);
  if (process.env.AGENTRIX_TEST_EXPECT_SPAWN_EPERM === '1') {
    assert.match(inspection, /EPERM.*uv_spawn/);
    t.diagnostic('Read-only Bash was authorized; this sandbox denies the real CLI shell subprocess.');
  } else assert.match(inspection, /lookup\.txt/);
  assert.deepEqual(decisions, ['allow', 'deny']);
  assert.equal(result('toolu_write')?.is_error, true, 'a writing Bash command was explicitly refused');
  assert.equal(fs.existsSync(path.join(f.cwd, 'lookup-write.txt')), false, 'lookup cannot write through Bash');
  const names = children[0].tools.map(row => row.name);
  assert.deepEqual(names.filter(name => ['Write', 'Edit', 'NotebookEdit', 'Agent'].includes(name)), []);
  assert.deepEqual(names.filter(name => ['Read', 'Grep', 'Glob', 'Bash'].includes(name)).sort(), ['Bash', 'Glob', 'Grep', 'Read']);
  assert.ok(messages.some(message => message.type === 'result' && message.subtype === 'success'));
  assert.equal(fs.existsSync(path.join(f.env.CLAUDE_CONFIG_DIR, 'agents')), false, 'no user-level agent was persisted');
});

test('real lookup preset preserves the existing system and tool parity whitelist', { skip, timeout: 60000 }, async t => {
  const bodies = [], catalogs = [];
  const f = await harness(t, data => { bodies.push(data); return [opening(data), ...textBlock(0, 'PARITY_DONE'), ...finish('end_turn')]; });
  for (const options of [{ agents: {} }, {}]) {
    let catalog;
    await f.run(options, (message, query) => {
      if (message.type === 'system' && message.subtype === 'init') catalog = query.supportedAgents();
    });
    catalogs.push((await catalog).map(row => row.name).sort());
  }
  assert.deepEqual(catalogs[1], [...catalogs[0], LOOKUP_AGENT_NAME].sort());
  const { compareSystem, compareTools } = require('./fixtures/claude-parity.cjs');
  const version = compareSystem(bodies[0].system, bodies[1].system, { sdkOwner: 'gui', tuiOwner: 'gui' });
  compareTools(bodies[0].tools, bodies[1].tools, version);
});
