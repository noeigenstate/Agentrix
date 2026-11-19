const { test } = require('node:test');
const assert = require('node:assert/strict');
const { LOOKUP_AGENT_NAME, LOOKUP_AGENT, lookupDecision } = require('../electron/features/claude-sdk/lookup-agent.cjs');
const { queryOptions, nativeContext, NATIVE_CONTEXT } = require('../electron/features/claude-sdk/query.cjs');
const { levers } = require('../electron/features/skills/operation-slots.cjs');

test('lookup Bash accepts only fixed inspection forms for its host-identified subagent', () => {
  const input = command => ({ agent_id: 'child', agent_type: LOOKUP_AGENT_NAME, tool_name: 'Bash', tool_input: { command } });
  for (const command of ['pwd', 'ls', 'ls -a', 'ls -l', 'ls -la']) assert.equal(lookupDecision(input(command)), 'allow', command);
  for (const command of ['ls > file', 'ls; touch file', 'ls $(touch file)', 'ls\ntouch file', 'ls `touch file`', 'ls -la /tmp', 'pwd && git status', 'npm test', '']) {
    assert.equal(lookupDecision(input(command)), 'deny', command);
  }
  assert.equal(lookupDecision({ ...input('ls'), agent_id: undefined }), null);
  assert.equal(lookupDecision({ ...input('ls'), agent_type: 'other-agent' }), null);
  assert.equal(lookupDecision({ ...input('ls'), tool_name: 'Read' }), null);
});

test('only GUI queries receive the lookup preset and the parent keeps its tool policy', async () => {
  for (const owner of ['gui', 'dispatch']) {
    const abort = new AbortController(), seen = [];
    try {
      const options = queryOptions({ owner, cwd: process.cwd(), env: {} }, { abort, key: 'sk-ant-offline-only', executable: 'offline-only',
        policy: name => { seen.push(name); return { behavior: 'deny', reason: 'Parent policy' }; } });
      assert.deepEqual(options.agents, owner === 'gui' ? { [LOOKUP_AGENT_NAME]: LOOKUP_AGENT } : undefined);
      const answer = await options.hooks.PreToolUse[0].hooks[0]({ tool_name: 'Bash', tool_input: { command: 'ls' } });
      assert.equal(answer.hookSpecificOutput.permissionDecision, 'deny');
      assert.deepEqual(seen, ['Bash']);
      assert.equal(options.permissionMode, 'bypassPermissions');
      assert.equal(options.tools, undefined, 'the owner retains the CLI tool inventory');
    } finally { abort.abort(); }
  }
});

test('the native lookup preset uses the operation model and effort in its agent and context', t => {
  const abort = new AbortController();
  t.after(() => abort.abort());
  const lookupAgent = { model: 'sonnet', effort: 'medium' };
  const options = queryOptions({ owner: 'gui', cwd: process.cwd(), env: {}, operations: { lookupAgent } },
    { abort, key: 'synthetic', executable: 'offline-only' });
  assert.deepEqual(options.agents[LOOKUP_AGENT_NAME], { ...LOOKUP_AGENT, ...lookupAgent });
  assert.match(options.systemPrompt.append, /agentrix-lookup sonnet subagent/);
  assert.doesNotMatch(options.systemPrompt.append, /Haiku/);
  assert.equal(nativeContext(), NATIVE_CONTEXT);
});

test('a Codex lookup in a native Claude conversation follows the routing row without registering a Claude lookup agent', async t => {
  const abort = new AbortController();
  t.after(() => abort.abort());
  const { claude: operations } = levers({ lookup: { model: 'gpt-6.3-sol', effort: 'medium' } }, {}, [], { claude: true, codex: true });
  const options = queryOptions({ owner: 'gui', cwd: process.cwd(), env: {}, operations }, {
    abort, key: 'synthetic', executable: 'offline-only', policy: () => ({ behavior: 'deny', reason: 'Parent policy' }),
  });
  assert.equal(options.agents, undefined);
  assert.match(options.systemPrompt.append, /routing skill's lookup row/);
  assert.doesNotMatch(options.systemPrompt.append, /agentrix-lookup|Haiku/);
  const answer = await options.hooks.PreToolUse[0].hooks[0]({
    agent_id: 'child', agent_type: LOOKUP_AGENT_NAME, tool_name: 'Bash', tool_input: { command: 'ls' },
  });
  assert.equal(answer.hookSpecificOutput.permissionDecision, 'deny');
});

test('lookup overrides keep the preset policy and accept only a valid Claude model and effort', t => {
  const abort = new AbortController();
  t.after(() => abort.abort());
  const agent = lookupAgent => queryOptions({ owner: 'gui', cwd: process.cwd(), env: {}, operations: { lookupAgent } },
    { abort, key: 'synthetic', executable: 'offline-only' }).agents[LOOKUP_AGENT_NAME];
  assert.deepEqual(agent({ model: 'opus', effort: 'xhigh', prompt: 'override', tools: ['Write'], permissionMode: 'bypassPermissions' }),
    { ...LOOKUP_AGENT, model: 'opus', effort: 'xhigh' });
  for (const model of ['gpt-6.3-sol', '--invalid', 'claude-' + 'x'.repeat(155), null]) {
    assert.deepEqual(agent({ model, effort: 'invalid effort' }), LOOKUP_AGENT);
  }
});
