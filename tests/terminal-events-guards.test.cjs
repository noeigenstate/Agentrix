const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { HTTP_EVENTS, COMMAND_KINDS, terminalHooks } = require('../electron/features/terminal-events/hook-channel.cjs');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const eventsDir = 'electron/features/terminal-events';
const wrappers = ['integration/bootstrap.ps1', 'integration/bash-integration.bash', 'integration/zsh-integration.zsh'];

test('additionalContext, systemMessage, displayContent, continue and decision:block appear only in hook-response.cjs', () => {
  const answers = /additionalContext|systemMessage|displayContent|["']?\bcontinue["']?\s*:|decision["']?\s*:\s*["']?block/;
  const hookSources = fs.readdirSync(path.join(root, eventsDir)).filter(name => name.endsWith('.cjs') && name !== 'hook-response.cjs');
  const hookPath = [...hookSources.map(name => `${eventsDir}/${name}`), 'electron/features/claude-runtime/hooks.cjs', ...wrappers];
  for (const file of hookPath) assert.doesNotMatch(read(file), answers, file);
  // The pipe's command hook answers only SessionStart, the one place skills enter the context.
  const command = read('integration/claude-hook.ps1');
  const session = command.slice(command.indexOf('function Get-AgentrixSessionContext'), command.indexOf('\ntry {'));
  assert.doesNotMatch(command.replace(session, ''), answers);
  assert.match(command, /if \(\$Kind -eq 'session'\) \{\s*try \{\s*(?:\$context = )?Get-AgentrixSessionContext \$hook\b/);
  assert.equal(command.match(/Get-AgentrixSessionContext \$hook\b/g).length, 1, 'only the session kind reads the skill context');
});

test('the settings generators emit only http hooks but SessionStart, or the declared command fallback', () => {
  const eventServer = { name: 'agentrix-pipe', address: '/tmp/agentrix.sock' };
  const shells = { powershell: { posix: false, powershellPath: 'C:\\Windows\\powershell.exe', script: 'C:\\agentrix\\claude-hook.ps1' },
    posix: { posix: true, node: '/agentrix/node', helper: '/agentrix/agent-event.cjs', noteFile: '/runtime/s-skills.txt' } };
  for (const platform of ['win32', 'darwin', 'linux']) for (const [kind, shell] of Object.entries(shells)) {
    const hooks = terminalHooks({ port: 4242, terminalId: 'term 1', sessionKey: 'session-key', eventServer, env: {}, cwd: '/project', shell, platform, home: '/home', read: () => '{}' });
    const label = `${platform} ${kind}`;
    assert.equal(hooks.channel, 'http', label);
    assert.equal(hooks.fallback, platform === 'win32' ? 'command-async' : 'command', label);
    assert.equal(hooks.url, 'http://127.0.0.1:4242/h/term%201', label);
    const sessionStart = settings => {
      const [entry] = settings.hooks.SessionStart;
      assert.equal(entry.hooks.length, 1);
      assert.equal(entry.hooks[0].type, 'command');
      assert.equal(entry.hooks[0].async, undefined, `${label}: SessionStart delivers skills before the session starts`);
      assert.match(entry.hooks[0].command, kind === 'posix' ? / 'claude-hook' .* session '\/runtime\/s-skills\.txt'$/ : /claude-hook\.ps1" .* -Kind session$/);
    };
    const http = JSON.parse(hooks.settings.http);
    assert.deepEqual(Object.keys(http.hooks).sort(), [...HTTP_EVENTS, 'SessionStart'].sort(), label);
    for (const event of HTTP_EVENTS) {
      assert.deepEqual(http.hooks[event], [{ hooks: [{ type: 'http', url: `${hooks.url}/${event}`, headers: { 'X-Agentrix-Key': hooks.key },
        timeout: ['PermissionRequest', 'Elicitation'].includes(event) ? 600 : 10 }] }], `${label}: ${event}`);
    }
    sessionStart(http);
    const fallback = JSON.parse(hooks.settings.fallback);
    assert.deepEqual(Object.keys(fallback.hooks).sort(), Object.keys(COMMAND_KINDS).sort(), label);
    for (const [event, commandKind] of Object.entries(COMMAND_KINDS)) {
      const [hook] = fallback.hooks[event][0].hooks;
      assert.equal(hook.type, 'command');
      assert.ok(hook.command.endsWith(kind === 'posix' ? ` ${commandKind}` : ` -Kind ${commandKind}`) || commandKind === 'session', `${label}: ${event}`);
      assert.equal(hook.async === true, commandKind === 'progress' || platform === 'win32' && !['session', 'permission', 'stop-failed'].includes(commandKind), `${label}: ${event} async`);
    }
    sessionStart(fallback);
    assert.equal(hooks.settings.http.includes(hooks.key), true);
    assert.equal(hooks.settings.fallback.includes('session-key'), true, `${label}: a command hook carries the session key like before`);
  }
  // The wrappers write no hook settings of their own: they pass one of the two main wrote.
  for (const file of wrappers) assert.doesNotMatch(read(file), /claude-hook|type\s*=\s*'command'|\\"hooks\\"|\\"timeout\\"/, file);
});

test('command-async runs asynchronously only what K0b proved, besides the progress hooks every command channel runs so, and never a dialog hook', () => {
  // K0b's set, from the real-CLI tests' one definition.
  const { ASYNC_OK } = require('./fixtures/claude-hooks-real.cjs');
  const asyncOf = platform => {
    const { settings } = terminalHooks({ terminalId: 't', sessionKey: 'k', eventServer: { name: 'pipe' }, env: {}, cwd: '/project', platform, home: '/home', read: () => '{}',
      shell: { posix: false, powershellPath: 'C:\\Windows\\powershell.exe', script: 'C:\\agentrix\\claude-hook.ps1' } });
    return new Set(Object.entries(JSON.parse(settings.fallback).hooks).filter(([, [entry]]) => entry.hooks[0].async).map(([event]) => event));
  };
  const command = asyncOf('linux'), commandAsync = asyncOf('win32');
  // The command channel is 1.4's configuration: only the tool observations run async.
  assert.deepEqual([...command].sort(), Object.keys(COMMAND_KINDS).filter(event => COMMAND_KINDS[event] === 'progress').sort());
  assert.deepEqual([...commandAsync].sort(), [...new Set([...ASYNC_OK, ...command])].sort());
  for (const event of ['PermissionRequest', 'Elicitation', 'SessionStart']) assert.equal(commandAsync.has(event), false, event);
});
