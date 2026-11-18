const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { realpath } = require('node:fs');
const { promisify } = require('node:util');
const path = require('node:path');
const os = require('node:os');
const { listAgentCommands, isLocalAgentCommand, agentCommand } = require('../electron/agent-commands.cjs');

async function fixture(t) {
  const root = await promisify(realpath.native)(await fs.mkdtemp(path.join(os.tmpdir(), 'pg-commands-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectPath = path.join(root, 'project'), home = path.join(root, 'home');
  const write = async (file, text) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); };
  return { root, projectPath, home, write };
}

test('builtins have the requested views and sorted names; no project means builtins only', async t => {
  const { projectPath, home, write } = await fixture(t);
  await write(path.join(home, '.claude/commands/local.md'), '# Local');
  await write(path.join(home, '.codex/prompts/local.md'), '# Local');
  for (const [agent, count, reading] of [['claude', 30, ['/btw', '/init', '/review', '/security-review']], ['codex', 50, ['/goal', '/init', '/plan', '/review', '/side']]]) {
    const commands = await listAgentCommands({ agent, home });
    assert.equal(commands.length, count);
    assert.deepEqual(commands.map(item => item.name), commands.map(item => item.name).sort((a, b) => a.localeCompare(b)));
    assert.deepEqual(commands.filter(item => item.view === 'reading').map(item => item.name), reading);
    assert.ok(commands.every(item => item.source === 'builtin' && item.description && item.name.startsWith('/')));
    assert.equal(commands.find(item => item.name === '/compact').view, 'terminal');
    assert.deepEqual(await listAgentCommands({ agent, home: path.join(home, 'missing'), projectPath }), commands, 'missing folders are ignored');
  }
});

test('Claude picker keeps the other commands and omits the routing controls', async () => {
  const commands = await listAgentCommands({ agent: 'claude' });
  const terminal = ['help', 'resume', 'status', 'config', 'permissions', 'mcp', 'hooks',
    'memory', 'context', 'cost', 'usage', 'doctor', 'clear', 'compact', 'rewind', 'export', 'add-dir',
    'login', 'logout', 'bashes', 'plugin', 'output-style', 'statusline', 'terminal-setup', 'release-notes', 'exit'];
  const reading = ['init', 'review', 'security-review', 'btw'];
  assert.deepEqual(commands.map(({ name, view }) => ({ name, view })),
    [...terminal.map(name => ({ name: '/' + name, view: 'terminal' })),
      ...reading.map(name => ({ name: '/' + name, view: 'reading' }))].sort((a, b) => a.name.localeCompare(b.name)));
  for (const [name, description] of [['doctor', '检查安装'], ['statusline', '状态栏']]) {
    assert.deepEqual(commands.find(command => command.name === '/' + name),
      { name: '/' + name, description, source: 'builtin', view: 'terminal' });
    assert.equal(isLocalAgentCommand('claude', '/' + name), false, 'picker placement does not make a model prompt local');
  }
});

test('Codex 0.161.0 lists canonical popup commands with terminal and prompt views', async t => {
  const { home } = await fixture(t);
  const commands = await listAgentCommands({ agent: 'codex', home });
  const terminal = [
    'ide', 'permissions', 'keymap', 'vim', 'experimental', 'approve',
    'memories', 'skills', 'import', 'hooks', 'rename', 'new', 'archive', 'delete', 'resume',
    'fork', 'worktree', 'app', 'compact', 'recap', 'voice', 'agents', 'subagents',
    'copy', 'export', 'raw', 'tui', 'diff', 'mention', 'status', 'daemon', 'warnings',
    'cd', 'pwd', 'usage', 'title', 'statusline', 'theme', 'pets', 'mcp', 'plugins',
    'feedback', 'ps', 'stop', 'clear',
  ];
  assert.deepEqual(commands.filter(item => item.view === 'terminal').map(item => item.name),
    terminal.map(name => '/' + name).sort((a, b) => a.localeCompare(b)));
  for (const name of terminal) assert.equal(isLocalAgentCommand('codex', '/' + name), true, name);
  for (const name of ['model', 'effort', 'fast']) {
    assert.ok(!commands.some(command => command.name === '/' + name));
    assert.equal(isLocalAgentCommand('codex', '/' + name), true, name);
  }
  for (const text of ['/review find regressions', '/init', '/plan investigate', '/goal fix tests', '/side why']) {
    assert.equal(isLocalAgentCommand('codex', text), false, text);
  }
  // Exclude retired names, hidden/development/recovery actions, exits and duplicate aliases.
  for (const name of ['approvals', 'apps', 'debug-config', 'debug-m-drop', 'debug-m-update',
    'rollout', 'test-approval', 'daybreak', 'setup-default-sandbox', 'btw', 'quit', 'exit', 'logout',
    'cwd', 'pet', 'clean']) {
    assert.ok(!commands.some(item => item.name === '/' + name), name);
    assert.equal(isLocalAgentCommand('codex', '/' + name), false, name);
  }
  for (const text of ['/permissions', ' /status ', '/mcp verbose', '/mcp login server', '/raw on', '/resume saved']) {
    assert.equal(isLocalAgentCommand('codex', text), true, text);
  }
  for (const text of ['/permissions-extra', 'explain /status', '']) {
    assert.equal(isLocalAgentCommand('codex', text), false, text);
  }
});

test('Claude commands and skills preserve metadata, precedence and sorted source groups', async t => {
  const { projectPath, home, write } = await fixture(t);
  for (const [file, text] of [
    [path.join(projectPath, '.claude/commands/z.md'), '\n## Project body\nmore'],
    [path.join(projectPath, '.claude/commands/frontend/review.md'), '---\ndescription: "Frontend review"\n---\n# ignored'],
    [path.join(projectPath, '.claude/commands/shared.md'), '---\ndescription: Project wins\n---\n'],
    [path.join(projectPath, '.claude/commands/help.md'), '# Cannot override builtin'],
    [path.join(home, '.claude/commands/shared.md'), '# User loses'],
    [path.join(home, '.claude/commands/a.md'), '# ' + 'a'.repeat(100)],
    [path.join(home, '.claude/commands/oversized.md'), 'x'.repeat(64 * 1024 + 1)],
    [path.join(home, '.claude/commands/boundary.md'), 'x'.repeat(64 * 1024)],
    [path.join(home, '.claude/skills/reviewer/SKILL.md'), "---\nname: 'frontend:skill'\ndescription: >\n  Review carefully\n  and explain\n---\n"],
    [path.join(projectPath, '.claude/skills/folder-name/SKILL.md'), '---\ndescription: ' + 's'.repeat(100) + '\n---\n'],
    [path.join(projectPath, '.claude/skills/ignored/nested/SKILL.md'), '---\nname: ignored\n---\n'],
    [path.join(projectPath, '.claude/skills/shared/SKILL.md'), '---\nname: shared\ndescription: Skill loses\n---\n'],
  ]) await write(file, text);
  const commands = await listAgentCommands({ agent: 'claude', projectPath, home });
  const custom = commands.filter(item => item.source !== 'builtin');
  assert.deepEqual(custom.map(item => [item.name, item.source]), [
    ['/frontend:review', 'project'], ['/shared', 'project'], ['/z', 'project'],
    ['/a', 'user'], ['/boundary', 'user'], ['/folder-name', 'skill'], ['/frontend:skill', 'skill'],
  ]);
  assert.ok(custom.every(item => item.view === 'reading'));
  assert.equal(commands.length, new Set(commands.map(item => item.name)).size);
  assert.equal(commands.find(item => item.name === '/help').source, 'builtin');
  assert.equal(custom.find(item => item.name === '/frontend:review').description, 'Frontend review');
  assert.equal(custom.find(item => item.name === '/shared').description, 'Project wins');
  assert.equal(custom.find(item => item.name === '/z').description, 'Project body');
  assert.equal(custom.find(item => item.name === '/frontend:skill').description, 'Review carefully and explain');
  assert.equal(custom.find(item => item.name === '/a').description.length, 80);
  assert.equal(custom.find(item => item.name === '/folder-name').description.length, 80);
});

test('Codex reads only top-level user prompts, with descriptions and reading views', async t => {
  const { projectPath, home, write } = await fixture(t);
  await write(path.join(home, '.codex/prompts/fix.md'), "---\ndescription: 'Fix it'\n---\n# ignored");
  await write(path.join(home, '.codex/prompts/a.md'), '\n# Body description');
  await write(path.join(home, '.codex/prompts/nested/ignored.md'), '# ignored');
  await write(path.join(home, '.codex/prompts/oversized.md'), '长'.repeat(22000));
  await write(path.join(projectPath, '.claude/commands/ignored.md'), '# ignored');
  const commands = await listAgentCommands({ agent: 'codex', projectPath, home });
  assert.deepEqual(commands.filter(item => item.source !== 'builtin'), [
    { name: '/prompts:a', description: 'Body description', source: 'user', view: 'reading' },
    { name: '/prompts:fix', description: 'Fix it', source: 'user', view: 'reading' },
  ]);
});

test('the 300-file read budget is shared across roots and includes duplicate commands', async t => {
  const { projectPath, home, write } = await fixture(t);
  for (let i = 0; i < 298; i++) await write(path.join(projectPath, `.claude/commands/p${String(i).padStart(3, '0')}.md`), '# Project');
  await write(path.join(projectPath, '.claude/commands/help.md'), '# Duplicate builtin');
  await write(path.join(home, '.claude/commands/a.md'), '# Last read');
  await write(path.join(home, '.claude/commands/b.md'), '# Over budget');
  await write(path.join(home, '.claude/skills/skill/SKILL.md'), '---\ndescription: Over budget\n---\n');
  const commands = await listAgentCommands({ agent: 'claude', projectPath, home });
  assert.equal(commands.filter(item => item.source !== 'builtin').length, 299);
  assert.ok(commands.some(item => item.name === '/a'));
  assert.ok(!commands.some(item => ['/b', '/skill'].includes(item.name)));
});

test('a linked commands root is read, but linked folders inside it are not followed', async t => {
  const { root, projectPath, home, write } = await fixture(t);
  const external = path.join(root, 'external');
  await write(path.join(external, 'hidden.md'), '# Hidden');
  await write(path.join(projectPath, '.claude/commands/local.md'), '# Local');
  await fs.symlink(external, path.join(projectPath, '.claude/commands/linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await fs.mkdir(path.join(home, '.claude'), { recursive: true });
  await fs.symlink(external, path.join(home, '.claude/commands'), process.platform === 'win32' ? 'junction' : 'dir');
  await write(path.join(external, 'commands/ancestor.md'), '# Hidden ancestor');
  const linkedProject = path.join(root, 'linked-project');
  await fs.mkdir(linkedProject);
  await fs.symlink(external, path.join(linkedProject, '.claude'), process.platform === 'win32' ? 'junction' : 'dir');
  // ~/.claude/commands is a link (as with dotfile managers): its commands count; the linked subfolder does not.
  const commands = await listAgentCommands({ agent: 'claude', projectPath, home });
  assert.deepEqual(commands.filter(item => item.source !== 'builtin').map(item => item.name), ['/local', '/commands:ancestor', '/hidden']);
  assert.ok(!commands.some(item => item.name.startsWith('/linked')), 'a link inside a commands folder is not followed');
  // A project whose whole .claude folder is linked is read through the link.
  assert.deepEqual((await listAgentCommands({ agent: 'claude', projectPath: linkedProject, home: path.join(root, 'empty-home') })).filter(item => item.source !== 'builtin').map(item => item.name), ['/ancestor']);
});

test('local slash commands (no model turn) are told apart from prompts and prompt commands', () => {
  for (const text of ['/context', '/compact', '/model', '/model opus', '/fast', '/effort high', ' /status ']) assert.equal(isLocalAgentCommand('claude', text), true, text);
  for (const text of ['/init', '/review', '/doctor', '/statusline', '/btw why', '/fork task', '/subtask task', '/fix-issue 3', 'fix /context parsing', '/contextual', '']) assert.equal(isLocalAgentCommand('claude', text), false, text);
  assert.equal(isLocalAgentCommand('codex', '/status'), true);
  assert.equal(isLocalAgentCommand('codex', '/init'), false);
});

test('Claude 2.1.326 settings commands and aliases are local without a CLI or account lookup', () => {
  // Names and aliases read from the installed executable's command descriptors, not inferred from a slash.
  const names = ['theme', 'ide', 'sandbox', 'privacy-settings', 'feedback', 'bug', 'upgrade',
    'cd', 'color', 'copy', 'desktop', 'diff', 'keybindings', 'install-github-app', 'install-slack-app',
    'mobile', 'voice', 'rename', 'session', 'scroll-speed', 'skills', 'tasks', 'skill-doctor', 'tui',
    'reload-plugins', 'reload-skills', 'chrome', 'stickers', 'radio', 'advisor', 'remote-env', 'use-case',
    'usage-credits', 'rate-limit-options', 'focus', 'cloud-plugins', 'artifacts',
    'allowed-tools', 'settings', 'reset', 'new', 'share', 'app', 'ios', 'android', 'name', 'continue',
    'remote', 'stats', 'plugins', 'marketplace', 'checkpoint', 'undo', 'quit', 'extra-usage'];
  for (const name of names) {
    assert.equal(isLocalAgentCommand('claude', '/' + name), true, name);
    assert.equal(isLocalAgentCommand('claude', '/' + name + ' argument'), true, name);
    assert.equal(isLocalAgentCommand('claude', '/' + name + '-unknown'), false, name);
  }
});

test('command names are read anywhere in the leading wrapper block, never from quoted prompt tags', () => {
  for (const name of ['model', 'theme', 'custom.plugin:review']) {
    const wrapped = `<command-message>${name}</command-message>\n<command-args>argument</command-args>\n<command-name>/${name}</command-name>`;
    assert.equal(agentCommand(wrapped), '/' + name);
    assert.equal(isLocalAgentCommand('claude', wrapped), name !== 'custom.plugin:review');
    assert.equal(agentCommand('Explain this:\n' + wrapped), '');
  }
  assert.equal(agentCommand('<command-message>quoted <command-name>/theme</command-name></command-message>'), '');
});
