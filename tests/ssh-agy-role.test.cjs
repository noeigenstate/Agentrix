const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { temporary } = require('./helpers/agy-runtime.cjs');
const { runtimeFiles, dispatchCompanions } = require('../integration/dispatch.cjs');

const exec = promisify(execFile);
const integration = path.resolve(__dirname, '../integration');
const server = path.resolve(__dirname, 'fixtures/agy-acp/server.cjs');

async function installHelper(folder) {
  await fs.promises.mkdir(folder);
  for (const file of ['dispatch.cjs', ...dispatchCompanions]) await fs.promises.copyFile(path.join(integration, file), path.join(folder, file));
  for (const [name, source] of Object.entries(runtimeFiles())) {
    const file = path.join(folder, 'electron', name);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, source);
  }
  return path.join(folder, 'dispatch.cjs');
}

const runRole = `
  const { spawn } = require('node:child_process');
  const { run } = require(process.argv[1]);
  const [helper, cwd, server, trace, brief] = process.argv.slice(1);
  const events = [];
  run(['agy', '--role', 'exec', '--title', 'SSH role', '--cwd', cwd, '--brief', brief, '--out', 'answer.md',
    '--model', 'gemini-3.8-flash', '--effort', 'low', '--allow', 'allowed.txt'], {
    env: process.env,
    onEvent: event => events.push(event),
    resolveExecutable: (agent, args) => {
      if (agent !== 'agy') throw new Error('another CLI was selected');
      return { file: process.execPath, args: [server, trace, 'ssh-role', ...args] };
    },
    launch: (file, args, options) => spawn(file, args, options),
  }).then(status => console.log(JSON.stringify({ status, events, node: process.versions.node })), error => {
    console.error(error); process.exitCode = 1;
  });
`;

test('the carried SSH helper runs agy without a broker and enforces role scope in a private profile', { timeout: 15000 }, async t => {
  const root = await temporary(t), cwd = path.join(root, 'project'), home = path.join(root, 'home');
  const dataDir = path.join(home, '.local', 'state', 'agentrix', 'ssh-dispatch');
  const trace = path.join(root, 'acp.jsonl'), brief = path.join(root, 'brief.md');
  await Promise.all([fs.promises.mkdir(cwd), fs.promises.mkdir(dataDir, { recursive: true }), fs.promises.writeFile(brief, 'Make only the permitted edit.')]);
  const helper = await installHelper(path.join(dataDir, 'a'.repeat(64)));
  const node = process.env.AGENTRIX_TEST_NODE20 || process.execPath;
  const env = { ...process.env, HOME: home, USERPROFILE: home, TEMP: root, TMP: root, TMPDIR: root,
    GIT_CEILING_DIRECTORIES: root, AGENTRIX_BOOTSTRAP: '', AGENTRIX_REMOTE_ROLE_TOOLS: '1' };
  const result = await exec(node, ['-e', runRole, helper, cwd, server, trace, brief], { cwd, env });
  const { status, events, node: version } = JSON.parse(result.stdout);
  if (process.env.AGENTRIX_TEST_NODE20) assert.equal(version, '20.3.0');
  assert.equal(status, 0, JSON.stringify(events));
  const rows = (await fs.promises.readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(events.some(event => event.type === 'dispatch.started'));
  const end = events.find(event => event.type === 'dispatch.ended');
  assert.equal(end.reason, 'permission');
  assert.equal(end.refused.first.reason, 'outside_scope', JSON.stringify(end));
  assert.equal(end.result.source, 'finish-role');
  assert.equal(rows[0].launch.autoUpdate, 'true');
  assert.equal(fs.realpathSync.native(rows[0].launch.profile), fs.realpathSync.native(path.join(dataDir, 'agy', 'role')));
  await assert.rejects(fs.promises.stat(path.join(home, '.gemini')), { code: 'ENOENT' });
  assert.ok(rows.some(row => row.result?.outcome?.optionId === 'deny'));
  const launch = rows.find(row => row.method === 'session/new');
  assert.equal(launch.params.mcpServers[0].name, 'agentrix_role');
  assert.equal(launch.params.mcpServers[0].args[0], helper);
  const prompts = rows.filter(row => row.method === 'session/prompt');
  assert.equal(prompts.length, 2);
  assert.match(prompts[1].params.prompt[0].text, /Agentrix denied this operation.*finish_role/);
});
