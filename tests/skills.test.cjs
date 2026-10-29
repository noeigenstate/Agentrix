const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SkillsStore } = require('../electron/features/skills/store.cjs');
const { startupNote } = require('../electron/features/agents/handoff.cjs');
const { MAX_NOTE } = require('../electron/features/skills/delivery.cjs');
const { ActionLog, TranscriptTail, claudeRecord, codexRecord } = require('../electron/agent-actions.cjs');
const { CodexActivityReader } = require('../electron/codex-activity.cjs');

const text = (name, body = 'Use this procedure.', description = 'A tested procedure.') => `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n${body}\n`;
const put = (file, body) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); };
const draft = (name, scope = 'global', projectId = null, body = 'First version.') => ({ name, description: 'A tested procedure.', text: body, scope, projectId });

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentrix-skills-'));
  const dataDir = path.join(root, 'profile'), builtinDir = path.join(root, 'resources', 'skills');
  const projects = [{ id: 'p1', name: 'First', path: path.join(root, 'first') }, { id: 'p2', name: 'Second', path: path.join(root, 'second') }, { id: 'ssh', name: 'Remote', kind: 'ssh', path: '/srv/app' }];
  for (const project of projects.filter(p => p.kind !== 'ssh')) fs.mkdirSync(project.path);
  put(path.join(builtinDir, 'model-routing', 'SKILL.md'), text('model-routing'));
  const changed = [], errors = [], active = [];
  const options = { dataDir, builtinDir, getProjects: () => projects, getAgents: () => ({ claude: { installed: true }, codex: { installed: false } }), activeProjects: () => active, changed: value => changed.push(value), report: error => errors.push(error) };
  const store = new SkillsStore(options);
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, dataDir, builtinDir, projects, store, changed, errors, active, options };
}

const until = async (check, label) => {
  const deadline = Date.now() + 10000;
  while (!check()) { if (Date.now() > deadline) throw new Error(`Timed out: ${label}`); await new Promise(resolve => setTimeout(resolve, 30)); }
};

test('skill defaults, exact public shape, read-only built-ins and local-only project scopes', t => {
  const { store } = fixture(t), builtin = store.list()[0];
  assert.deepEqual(Object.keys(builtin).sort(), ['id', 'name', 'description', 'source', 'scope', 'projectId', 'projectName', 'path', 'enabled', 'trigger', 'autoOptimize', 'confirmChanges', 'version', 'updatedAt', 'updatedBy', 'updatedIn', 'createdByAgent', 'pending', 'requires', 'lastUsed'].sort());
  assert.deepEqual([builtin.id, builtin.enabled, builtin.trigger, builtin.autoOptimize], ['builtin:model-routing', true, 'always', false]);
  assert.deepEqual(builtin.requires, { claude: true, codex: false });
  for (const action of [() => store.save(builtin.id, draft('model-routing')), () => store.delete(builtin.id), () => store.revert(builtin.id, 1), () => store.resolveChange(builtin.id, true), () => store.setOptions(builtin.id, { autoOptimize: true })]) assert.throws(action, /只读/);
  assert.throws(() => store.save(null, draft('remote', 'project', 'ssh')), /本地/);
  const user = store.save(null, draft('mine'));
  assert.deepEqual([user.enabled, user.trigger, user.autoOptimize, user.confirmChanges, user.createdByAgent], [true, 'auto', true, false, false]);
  const scoped = store.save(null, draft('mine', 'project', 'p1'));
  assert.equal(scoped.id, 'project:p1:mine');
  assert.equal(scoped.projectName, 'First');
});

test('save, independent history, revert, options persistence, import and delete', t => {
  const { store, root, options } = fixture(t);
  const first = store.save(null, draft('release'));
  store.save(first.id, draft('release', 'global', null, 'Second version.'));
  assert.equal(store.read(first.id).versions.length, 2, 'app writes are not also recorded as agent writes');
  const reverted = store.revert(first.id, 1);
  assert.equal(reverted.version, 3);
  assert.match(store.read(first.id).text, /First version/);
  assert.deepEqual(store.read(first.id).versions.map(v => v.by), ['user', 'user', 'user']);
  store.setOptions(first.id, { enabled: false, trigger: 'always', confirmChanges: true, autoOptimize: false });
  const reopened = new SkillsStore(options); t.after(() => reopened.close());
  assert.equal(reopened.list().find(s => s.id === first.id).enabled, false);
  assert.equal(reopened.read(first.id).versions.length, 3);
  const imported = path.join(root, 'imported');
  put(path.join(imported, 'SKILL.md'), text('imported', 'Imported body.'));
  put(path.join(imported, 'scripts', 'check.cjs'), 'console.log("check");');
  const info = store.import(imported, 'project', 'p2');
  assert.equal(info.id, 'project:p2:imported'); assert.match(store.read(info.id).text, /Imported body/);
  assert.equal(fs.readFileSync(path.join(path.dirname(info.path), 'scripts', 'check.cjs'), 'utf8'), 'console.log("check");');
  assert.throws(() => store.import(imported, 'project', 'p2'), /同名/);
  assert.equal(store.delete(first.id), true);
  assert.ok(!fs.existsSync(first.path));
  assert.ok(!store.list().some(s => s.id === first.id));
  assert.throws(() => store.read('user:../../outside'), /不存在/);
});

test('renaming and moving between global/project scopes preserve versions, resources and options', t => {
  const { store } = fixture(t);
  const original = store.save(null, draft('original'));
  store.setOptions(original.id, { trigger: 'always', confirmChanges: true });
  put(path.join(path.dirname(original.path), 'templates', 'example.md'), 'Template.');
  const moved = store.save(original.id, draft('renamed', 'project', 'p2', 'New scoped version.'));
  assert.equal(moved.id, 'project:p2:renamed'); assert.equal(moved.version, 2);
  assert.equal(moved.trigger, 'always'); assert.equal(moved.confirmChanges, true);
  assert.equal(store.read(moved.id).versions[0].by, 'user');
  assert.equal(fs.readFileSync(path.join(path.dirname(moved.path), 'templates/example.md'), 'utf8'), 'Template.');
  assert.ok(!fs.existsSync(original.path));
  assert.ok(!store.list().some(skill => skill.id === original.id));
  store.save(null, draft('collision'));
  assert.throws(() => store.save(moved.id, draft('collision')), /同名/);
  assert.ok(fs.existsSync(moved.path));
});

test('pending proposals do not change the active file; accept, reject and agent-created review', t => {
  const { store, dataDir, active } = fixture(t);
  const info = store.save(null, draft('proposed'));
  store.setOptions(info.id, { confirmChanges: true });
  const proposal = path.join(dataDir, 'skill-pending', 'proposed', 'SKILL.md');
  put(proposal, text('proposed', 'Agent proposal.'));
  assert.equal(store.list().find(s => s.id === info.id).pending, true);
  assert.match(store.read(info.id).pending, /Agent proposal/);
  assert.match(store.read(info.id).text, /First version/);
  active.push('p1');
  const accepted = store.resolveChange(info.id, true);
  assert.deepEqual([accepted.version, accepted.updatedBy, accepted.updatedIn, accepted.pending], [2, 'agent', 'p1', false]);
  put(proposal, text('proposed', 'Rejected proposal.'));
  store.resolveChange(info.id, false);
  assert.equal(store.read(info.id).pending, null); assert.equal(store.read(info.id).versions.length, 2);
  put(path.join(dataDir, 'skills', 'new-agent', 'SKILL.md'), text('new-agent'));
  assert.equal(store.list().find(s => s.id === 'user:new-agent').createdByAgent, true);
  assert.equal(store.resolveChange('user:new-agent', true).createdByAgent, false);
  put(path.join(dataDir, 'skills', 'rejected-agent', 'SKILL.md'), text('rejected-agent'));
  store.list(); assert.equal(store.resolveChange('user:rejected-agent', false), null);
  assert.ok(!fs.existsSync(path.join(dataDir, 'skills', 'rejected-agent')));
});

test('watchers debounce external agent versions, observe new project folders and pending files, ignore app writes', async t => {
  const { store, dataDir, projects, changed, errors, active } = fixture(t);
  const info = store.save(null, draft('watched'));
  active.push('p2');
  store.syncWatchers();
  put(info.path, text('watched', 'Changed by an agent.'));
  await until(() => store.history.latest(info.id)?.version === 2, 'agent version');
  assert.equal(store.history.latest(info.id).project, 'p2');
  assert.equal(store.history.latest(info.id).by, 'agent');
  put(path.join(projects[0].path, 'skills', 'learned', 'SKILL.md'), text('learned'));
  await until(() => store.entries.has('project:p1:learned'), 'new project skill');
  assert.equal(store.info(store.entry('project:p1:learned')).createdByAgent, true);
  assert.equal(store.info(store.entry('project:p1:learned')).updatedIn, 'p1');
  put(path.join(dataDir, 'skill-pending', 'watched', 'SKILL.md'), text('watched', 'Pending.'));
  await until(() => changed.at(-1)?.find(s => s.id === info.id)?.pending, 'pending event');
  store.save(info.id, draft('watched', 'global', null, 'Saved by user.'));
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(store.history.latest(info.id).version, 3);
  assert.equal(store.history.latest(info.id).by, 'user');
  assert.deepEqual(errors, []);
});

test('startup notes deliver always/auto/disabled and every optimization permission with TOML-safe text', t => {
  const { store, projects, dataDir } = fixture(t);
  for (const name of ['always', 'automatic', 'disabled', 'confirm', 'fixed']) store.save(null, draft(name));
  store.save(null, draft('disabled-project', 'project', 'p1'));
  store.setOptions('user:always', { trigger: 'always' });
  store.setOptions('user:disabled', { enabled: false });
  store.setOptions('project:p1:disabled-project', { enabled: false });
  store.setOptions('user:confirm', { confirmChanges: true });
  store.setOptions('user:fixed', { autoOptimize: false });
  const delivery = store.delivery(projects[0]);
  const note = startupNote('Reading note.', 'C:\\handoff\\one.md', path.join(projects[0].path, 'skills'), delivery);
  const normalPath = value => value.replace(/\\/g, '/');
  assert.ok(note.includes(`Before any task, read and follow ${normalPath(store.entry('user:always').path)}.`));
  assert.ok(note.includes('automatic: A tested procedure. ('));
  assert.ok(!note.includes('/skills/disabled/SKILL.md'));
  assert.ok(note.includes('do not use these: disabled-project'));
  assert.ok(note.includes(`${normalPath(store.entry('user:fixed').path)}: must not change it`));
  assert.ok(note.includes(`${normalPath(store.entry('user:automatic').path)}: may update it in place`));
  assert.ok(note.includes(`${normalPath(dataDir)}/skill-pending/confirm/SKILL.md`));
  assert.ok(note.includes('Claude Code installed; Codex missing'));
  assert.ok(!/["\\\r\n]/.test(note));
});

test('all option combinations and large libraries keep the complete instructions in a bounded manifest', t => {
  const { store, projects } = fixture(t);
  store.save(null, draft('matrix'));
  for (const enabled of [false, true]) for (const trigger of ['always', 'auto']) for (const autoOptimize of [false, true]) for (const confirmChanges of [false, true]) {
    store.setOptions('user:matrix', { enabled, trigger, autoOptimize, confirmChanges });
    const delivery = store.delivery(projects[0]), note = startupNote('Read.', null, null, delivery);
    const file = store.entry('user:matrix').path.replace(/\\/g, '/');
    assert.equal(note.includes(file), enabled);
    if (enabled) {
      assert.equal(note.includes(`Before any task, read and follow ${file}.`), trigger === 'always');
      assert.ok(note.includes(!autoOptimize ? 'must not change it' : confirmChanges ? 'propose edits only to' : 'may update it in place'));
    }
  }
  for (let i = 0; i < 12; i++) store.save(null, { ...draft(`long-${i}`), description: 'long description '.repeat(100) });
  const delivery = store.delivery(projects[0]), note = startupNote('Read.', null, null, delivery);
  assert.ok(note.length <= MAX_NOTE); assert.ok(note.includes(delivery.manifest.replace(/\\/g, '/')));
  assert.match(fs.readFileSync(delivery.manifest, 'utf8'), /long-11/);
});

test('SSH bundle contains only enabled built-in/global files, never project skills or local paths', t => {
  const { store, projects, root } = fixture(t);
  store.save(null, draft('global')); store.save(null, draft('local-only', 'project', 'p1'));
  store.save(null, draft('off')); store.setOptions('user:off', { enabled: false });
  put(path.join(path.dirname(store.entry('user:global').path), 'templates/example.md'), 'Remote template.');
  const delivery = store.delivery(projects[2], true), note = startupNote('Read.', '{AGENTRIX_HANDOFF}', null, delivery);
  assert.deepEqual(delivery.bundle.files.map(s => s.id), ['builtin:model-routing', 'user:global']);
  assert.equal(Buffer.from(delivery.bundle.files[1].assets[0].data, 'base64').toString(), 'Remote template.');
  assert.ok(note.includes('{AGENTRIX_SKILLS}/builtin/model-routing/SKILL.md'));
  assert.ok(note.includes('{AGENTRIX_AGENTS}'));
  assert.ok(!note.includes(root.replace(/\\/g, '/')) && !note.includes('local-only'));
});

test('PowerShell wrappers reread the refreshed startup note before another CLI session', { skip: process.platform !== 'win32' }, t => {
  const { root } = fixture(t), file = path.join(root, 'current-note.txt');
  const source = fs.readFileSync(path.join(__dirname, '../integration/bootstrap.ps1'), 'utf8');
  const helper = source.slice(source.indexOf('function global:Get-AgentrixReadingNote'), source.indexOf('# Windows PowerShell 5'));
  put(file, 'First note.');
  const script = `${helper}\nGet-AgentrixReadingNote\n[IO.File]::WriteAllText($env:AGENTRIX_READING_NOTE_FILE, 'Second note.')\nGet-AgentrixReadingNote`;
  const output = require('node:child_process').execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { env: { ...process.env, AGENTRIX_READING_NOTE_FILE: file, AGENTRIX_READING_NOTE: 'Stale note.' }, encoding: 'utf8', windowsHide: true });
  assert.deepEqual(output.trim().split(/\r?\n/), ['First note.', 'Second note.']);
});

test('preload exposes all nine skill contract endpoints and unsubscribes onSkills', () => {
  const calls = [], listeners = new Map(); let bridge;
  const ipcRenderer = { invoke: (...args) => { calls.push(args); }, on: (channel, fn) => listeners.set(channel, fn), removeListener: (channel, fn) => { assert.equal(listeners.get(channel), fn); listeners.delete(channel); } };
  require('node:vm').runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/preload.cjs'), 'utf8'), {
    require: name => { assert.equal(name, 'electron'); return { contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } }, ipcRenderer }; },
  });
  bridge.listSkills(); bridge.readSkill('id'); bridge.saveSkill(null, draft('preload')); bridge.deleteSkill('id'); bridge.setSkillOptions('id', { enabled: false });
  bridge.revertSkill('id', 2); bridge.resolveSkillChange('id', true); bridge.importSkill('global', null);
  assert.deepEqual(calls.map(call => call[0]), ['skills:list', 'skills:read', 'skills:save', 'skills:delete', 'skills:options', 'skills:revert', 'skills:resolve', 'skills:import']);
  let received;
  const stop = bridge.onSkills(skills => { received = skills; });
  const skills = [{ id: 'user:example' }]; listeners.get('skills:changed')({}, skills);
  assert.equal(received, skills); stop(); assert.equal(listeners.size, 0);
});

test('successful Claude/Codex skill reads record lastUsed, failed/settled/mentioned/unrelated paths do not', t => {
  const { store, projects, changed } = fixture(t), skill = store.list()[0], cwd = projects[0].path;
  let agent = 'claude';
  const log = new ActionLog(change => { if (change.finished) store.recordAction(change.action, { cwd, project: 'p1', agent }); });
  const feed = record => claudeRecord(log, { timestamp: new Date().toISOString(), ...record }, cwd);
  const read = (id, file) => feed({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: file } }] } });
  const result = (id, is_error = false) => feed({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'skill body', is_error }] } });
  read('failed', skill.path); result('failed', true); assert.equal(store.list()[0].lastUsed, null);
  read('settled', skill.path); log.settle(); assert.equal(store.list()[0].lastUsed, null);
  read('unrelated', path.join(cwd, 'elsewhere', 'model-routing', 'SKILL.md')); result('unrelated'); assert.equal(store.list()[0].lastUsed, null);
  read('ok', skill.path); result('ok');
  assert.deepEqual({ ...store.list()[0].lastUsed, at: 0 }, { at: 0, project: 'p1', agent: 'claude' });
  assert.ok(changed.at(-1)[0].lastUsed);
  agent = 'codex';
  const at = Date.now() + 50;
  const item = payload => codexRecord(log, { type: 'response_item', timestamp: new Date(at).toISOString(), payload }, cwd);
  item({ type: 'function_call', call_id: 'mention', name: 'exec_command', arguments: JSON.stringify({ cmd: `echo '${skill.path}'` }) });
  item({ type: 'function_call_output', call_id: 'mention', output: 'Exit code: 0' });
  assert.equal(store.list()[0].lastUsed.agent, 'claude');
  item({ type: 'function_call', call_id: 'read', name: 'exec_command', arguments: JSON.stringify({ cmd: `Get-Content -LiteralPath '${skill.path}'` }) });
  item({ type: 'function_call_output', call_id: 'read', output: 'Exit code: 0\nSkill body' });
  assert.deepEqual(store.list()[0].lastUsed, { at, project: 'p1', agent: 'codex' });
  const remoteFile = '/tmp/agentrix-test/skills/builtin/model-routing/SKILL.md';
  store.recordAction({ kind: 'skill', skillFile: remoteFile, done: true, at: at + 50 }, { cwd: '/srv/app', project: 'ssh', agent: 'claude', remotePaths: { [skill.id]: remoteFile } });
  assert.equal(store.list()[0].lastUsed.project, 'ssh');
});

for (const shell of ['Get-Content', 'cat']) {
  test(`Codex ${shell} skill reads in JSON-keyed exec scripts persist usage from text-block results`, async t => {
    const { store, projects, root, dataDir, changed } = fixture(t), skill = store.list()[0], cwd = projects[0].path;
    const at = Date.now(), timestamp = new Date(at).toISOString(), id = '00000000-0000-4000-8000-000000000001';
    const home = path.join(root, 'codex'), filename = path.join(home, 'sessions', `rollout-${id}.jsonl`);
    const cmd = shell === 'cat' ? "cat './SKILL.md'" : `Get-Content -LiteralPath '${skill.path.replace(/\\/g, '/')}'`;
    const record = payload => JSON.stringify({ type: 'response_item', timestamp, payload }) + '\n';
    const call = callId => record({ type: 'custom_tool_call', id: `ct_${callId}`, call_id: callId, name: 'exec', namespace: 'functions',
      input: `text(await tools.exec_command(${JSON.stringify({ cmd, workdir: path.dirname(skill.path) })}));` });
    const result = (callId, exitCode) => record({ type: 'custom_tool_call_output', call_id: callId, output: [
      { type: 'input_text', text: 'Script completed\nWall time 0.3 seconds\nOutput:\n' },
      { type: 'input_text', text: JSON.stringify({ chunk_id: 'synthetic', exit_code: exitCode, output: exitCode ? 'Read failed' : text('model-routing') }) },
    ] });
    put(filename, JSON.stringify({ type: 'session_meta', timestamp, payload: { id, cwd, source: 'cli', originator: 'codex-tui' } }) + '\n'
      + call('failed') + result('failed', 1) + call('read'));
    const log = new ActionLog(change => { if (change.finished) store.recordAction(change.action, { cwd, project: 'p1', agent: 'codex', since: at }); });
    const reader = new CodexActivityReader(cwd, home, at, { onRecord: value => codexRecord(log, value, cwd) });
    await reader.read();
    assert.deepEqual(log.list.map(action => [action.kind, action.done, action.failed]), [['skill', true, true], ['skill', false, false]]);
    assert.equal(store.list()[0].lastUsed, null, 'a failed read and a pending read prove no successful usage');
    fs.appendFileSync(filename, result('read', 0));
    await reader.read();
    const expected = { at, project: 'p1', agent: 'codex' };
    assert.deepEqual(store.list()[0].lastUsed, expected);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'skills.json'), 'utf8'))[skill.id].lastUsed, expected);
    const count = changed.length;
    await reader.read();
    assert.equal(changed.length, count, 'idle polls do not record usage again');
  });
}

test('Claude transcript Read and tool_result record usage across Windows slash and case variants', async t => {
  const { store, projects, root, dataDir } = fixture(t), skill = store.list()[0], cwd = projects[0].path;
  const at = Date.now(), timestamp = new Date(at).toISOString(), filename = path.join(root, 'claude', 'session.jsonl');
  const file = process.platform === 'win32' ? skill.path.replace(/\\/g, '/').toUpperCase() : skill.path;
  const log = new ActionLog(change => { if (change.finished) store.recordAction(change.action, { cwd, project: 'p1', agent: 'claude', since: at }); });
  const tail = new TranscriptTail(filename), read = () => tail.read(record => claudeRecord(log, record, cwd));
  put(filename, JSON.stringify({ type: 'assistant', timestamp, cwd, isSidechain: false, message: { role: 'assistant',
    content: [{ type: 'tool_use', id: 'tool_skills_read', name: 'Read', input: { file_path: file } }] } }) + '\n');
  await read();
  assert.equal(store.list()[0].lastUsed, null);
  fs.appendFileSync(filename, JSON.stringify({ type: 'user', timestamp, cwd, isSidechain: false, message: { role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'tool_skills_read', content: [{ type: 'text', text: text('model-routing') }] }] } }) + '\n');
  await read();
  const expected = { at, project: 'p1', agent: 'claude' };
  assert.deepEqual(store.list()[0].lastUsed, expected);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'skills.json'), 'utf8'))[skill.id].lastUsed, expected);
});

test('native SDK and app-server reads share the successful-result usage path', t => {
  const { store, projects } = fixture(t), skill = store.list()[0], cwd = projects[0].path;
  const { nativeSkillActions } = require('../electron/features/skills/native-actions.cjs');
  let agent = 'claude';
  const log = new ActionLog(change => { if (change.finished) store.recordAction(change.action, { cwd, project: 'p1', agent }); });
  const at = Date.now();
  nativeSkillActions(log, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'native-read', name: 'Read', input: { file_path: skill.path } }] } }, cwd, at);
  assert.equal(store.list()[0].lastUsed, null);
  nativeSkillActions(log, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'native-read', content: 'body' }] } }, cwd, at + 1);
  assert.equal(store.list()[0].lastUsed.agent, 'claude');
  agent = 'codex';
  nativeSkillActions(log, { method: 'item/completed', params: { item: { id: 'native-shell', type: 'commandExecution', command: `cat '${skill.path}'`, exitCode: 0, status: 'completed' } } }, cwd, at + 2);
  assert.equal(store.list()[0].lastUsed.agent, 'codex');
  nativeSkillActions(log, { method: 'item/completed', params: { item: { id: 'failed-shell', type: 'commandExecution', command: `cat '${skill.path}'`, exitCode: 1, status: 'completed' } } }, cwd, at + 3);
  assert.equal(store.list()[0].lastUsed.at, at + 2);
});

test('invalid names, imports and symlinked skill folders cannot escape managed storage', t => {
  const { store, root, dataDir } = fixture(t);
  for (const name of ['../escape', 'bad/name', 'bad\\name', '.', 'CON', 'trailing.', 'quoted"']) assert.throws(() => store.save(null, draft(name)), /名称/);
  const bad = path.join(root, 'bad'); put(path.join(bad, 'SKILL.md'), 'Missing front matter');
  assert.throws(() => store.import(bad, 'global', null), /front matter/);
  const outside = path.join(root, 'outside'); put(path.join(outside, 'SKILL.md'), text('linked'));
  fs.symlinkSync(outside, path.join(dataDir, 'skills', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => store.save(null, draft('linked')), /符号链接/);
  assert.match(fs.readFileSync(path.join(outside, 'SKILL.md'), 'utf8'), /Use this procedure/);
});

test('skills IPC delegates contract arguments and import cancellation without side effects', async () => {
  const handles = new Map(), calls = [], methods = ['list', 'read', 'save', 'delete', 'setOptions', 'revert', 'resolveChange', 'target', 'import'];
  const skills = Object.fromEntries(methods.map(method => [method, (...args) => { calls.push([method, ...args]); return method; }]));
  let canceled = true;
  require('../electron/features/skills/ipc.cjs').registerSkillsIpc({ handle: (channel, fn) => handles.set(channel, fn), skills, getWindow: () => 'window',
    dialog: { showOpenDialog: async window => { assert.equal(window, 'window'); return { canceled, filePaths: ['/chosen/skill'] }; } } });
  for (const [channel, args] of [['list', []], ['read', ['id']], ['save', [null, draft('ipc')]], ['delete', ['id']], ['options', ['id', { enabled: false }]], ['revert', ['id', 2]], ['resolve', ['id', true]]]) await handles.get(`skills:${channel}`)(...args);
  assert.equal(await handles.get('skills:import')('global', null), null);
  canceled = false; assert.equal(await handles.get('skills:import')('project', 'p1'), 'import');
  assert.deepEqual(calls.at(-1), ['import', '/chosen/skill', 'project', 'p1']);
  assert.deepEqual(calls.slice(0, 7).map(call => call[0]), ['list', 'read', 'save', 'delete', 'setOptions', 'revert', 'resolveChange']);
});
