const { test } = require('node:test');
const assert = require('node:assert/strict');
const { LOOKUP_AGENT_NAME, LOOKUP_AGENT, lookupDecision } = require('../electron/features/claude-sdk/lookup-agent.cjs');
const { queryOptions } = require('../electron/features/claude-sdk/query.cjs');

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
      const options = queryOptions({ owner, cwd: process.cwd() }, { abort, key: 'sk-ant-offline-only', executable: 'offline-only',
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
