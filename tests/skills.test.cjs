const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SkillsStore, MAX_SSH_BUNDLE_BYTES } = require('../electron/features/skills/store.cjs');
const { metadata, draftText, importFiles, MAX_IMPORT_BYTES, MAX_IMPORT_FILES } = require('../electron/features/skills/files.cjs');
const { safeId, MAX_VERSIONS, TEXT_VERSIONS } = require('../electron/features/skills/history.cjs');
const { startupNote } = require('../electron/features/agents/handoff.cjs');
const { MAX_NOTE } = require('../electron/features/skills/delivery.cjs');
const { ActionLog, TranscriptTail, claudeRecord, codexRecord, skillDescription } = require('../electron/agent-actions.cjs');
const { CodexActivityReader } = require('../electron/codex-activity.cjs');

const text = (name, body = 'Use this procedure.', description = 'A tested procedure.') => `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n${body}\n`;
const put = (file, body) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); };
const draft = (name, scope = 'global', projectId = null, body = 'First version.') => ({ name, description: 'A tested procedure.', text: body, scope, projectId });

test('metadata and activity descriptions share front-matter decoding for BOM, quotes and folded scalars', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentrix-front-matter-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'SKILL.md');
  for (const description of ['"Read \\"quoted\\" paths"', "'Read the project''s own procedure'", '>\n  Read the project\n  before changing code']) {
    const source = `\uFEFF---\nname: example\ndescription: ${description}\n---\nBody.\n`;
    put(file, source);
    assert.equal(await skillDescription('example', root, file), metadata(source).description);
  }
});

function fixture(t, setup = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentrix-skills-'));
  const dataDir = path.join(root, 'profile'), builtinDir = path.join(root, 'resources', 'skills');
  const projects = [{ id: 'p1', name: 'First', path: path.join(root, 'first') }, { id: 'p2', name: 'Second', path: path.join(root, 'second') }, { id: 'ssh', name: 'Remote', kind: 'ssh', path: '/srv/app' }];
  for (const project of projects.filter(p => p.kind !== 'ssh')) fs.mkdirSync(project.path);
  put(path.join(builtinDir, 'model-routing', 'SKILL.md'), fs.readFileSync(path.join(__dirname, '../resources/skills/model-routing/SKILL.md'), 'utf8'));
  const changed = [], changes = [], errors = [], active = [];
  const options = { dataDir, builtinDir, getProjects: () => projects, getAgents: () => ({ claude: { installed: true }, codex: { installed: false } }), activeProjects: () => active,
    changed: (value, change) => { changed.push(value); changes.push(change); }, report: error => errors.push(error) };
  setup({ root, dataDir, builtinDir, projects, active });
  const store = new SkillsStore(options);
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, dataDir, builtinDir, projects, store, changed, changes, errors, active, options };
}

const until = async (check, label) => {
  const deadline = Date.now() + 10000;
  while (!check()) { if (Date.now() > deadline) throw new Error(`Timed out: ${label}`); await new Promise(resolve => setTimeout(resolve, 30)); }
};

test('skill defaults, exact public shape, read-only built-ins and local-only project scopes', async t => {
  const { store } = fixture(t), builtin = store.list()[0];
  assert.deepEqual(Object.keys(builtin).sort(), ['id', 'name', 'description', 'title', 'summary', 'when', 'yieldsTo', 'source', 'scope', 'projectId', 'projectName', 'path', 'enabled', 'trigger', 'autoOptimize', 'confirmChanges', 'version', 'updatedAt', 'updatedBy', 'updatedIn', 'createdByAgent', 'pending', 'requires', 'lastUsed'].sort());
  assert.deepEqual([builtin.id, builtin.enabled, builtin.trigger, builtin.autoOptimize], ['builtin:model-routing', true, 'always', false]);
  assert.deepEqual(builtin.requires, { claude: true, codex: false });
  await assert.rejects(() => store.save(builtin.id, draft('model-routing')), /只读/);
  for (const action of [() => store.delete(builtin.id), () => store.revert(builtin.id, 1), () => store.resolveChange(builtin.id, true), () => store.setOptions(builtin.id, { autoOptimize: true })]) assert.throws(action, /只读/);
  await assert.rejects(() => store.save(null, draft('remote', 'project', 'ssh')), /本地/);
  const user = await store.save(null, draft('mine'));
  assert.deepEqual([user.enabled, user.trigger, user.autoOptimize, user.confirmChanges, user.createdByAgent], [true, 'auto', true, false, false]);
  const scoped = await store.save(null, draft('mine', 'project', 'p1'));
  assert.equal(scoped.id, 'project:p1:mine');
  assert.equal(scoped.projectName, 'First');
});

test('shipped code standard defaults to first-open locally and over SSH', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentrix-shipped-skills-'));
  const project = { id: 'p1', name: 'First', path: path.join(root, 'project') };
  const remote = { id: 'ssh', name: 'Remote', kind: 'ssh', path: '/srv/app' };
  fs.mkdirSync(project.path);
  const store = new SkillsStore({ dataDir: path.join(root, 'profile'), builtinDir: path.join(__dirname, '../resources/skills'),
    getProjects: () => [project, remote], getAgents: () => ({ claude: { installed: true }, codex: { installed: true } }) });
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });

  const skill = store.list().find(item => item.id === 'builtin:code-standard');
  assert.ok(skill);
  assert.deepEqual([skill.name, skill.title, skill.source, skill.enabled, skill.trigger], ['code-standard', '代码规范', 'builtin', true, 'first-open']);
  const note = startupNote('Read.', null, null, store.delivery(project, false, 'first-session'));
  assert.ok(note.includes('Before the first task of this session, read and follow ' + skill.path.replace(/\\/g, '/') + '; this is its first run in this project.'));
  const delivery = store.delivery(remote, true, 'remote-session');
  const shipped = delivery.bundle.files.find(file => file.id === skill.id);
  assert.ok(shipped);
  assert.equal(shipped.text, fs.readFileSync(skill.path, 'utf8'));
  assert.ok(delivery.bundle.instructions.includes('Before the first task of this session, read and follow {AGENTRIX_SKILLS}/builtin/code-standard/SKILL.md; this is its first run in this project.'));
});

test('save, independent history, revert, options persistence, import and delete', async t => {
  const { store, root, options } = fixture(t);
  const first = await store.save(null, draft('release'));
  await store.save(first.id, draft('release', 'global', null, 'Second version.'));
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
  const info = await store.import(imported, 'project', 'p2');
  assert.equal(info.id, 'project:p2:imported'); assert.match(store.read(info.id).text, /Imported body/);
  assert.equal(fs.readFileSync(path.join(path.dirname(info.path), 'scripts', 'check.cjs'), 'utf8'), 'console.log("check");');
  await assert.rejects(() => store.import(imported, 'project', 'p2'), /同名/);
  assert.equal(store.delete(first.id), true);
  assert.ok(!fs.existsSync(first.path));
  assert.ok(!store.list().some(s => s.id === first.id));
  assert.throws(() => store.read('user:../../outside'), /不存在/);
});

test('renaming and moving between global/project scopes preserve versions, resources and options', async t => {
  const { store } = fixture(t);
  const original = await store.save(null, draft('original'));
  store.setOptions(original.id, { trigger: 'always', confirmChanges: true });
  put(path.join(path.dirname(original.path), 'templates', 'example.md'), 'Template.');
  put(path.join(path.dirname(original.path), '.resources', 'keep.md'), 'Keep on move.');
  const moved = await store.save(original.id, draft('renamed', 'project', 'p2', 'New scoped version.'));
  assert.equal(moved.id, 'project:p2:renamed'); assert.equal(moved.version, 2);
  assert.equal(moved.trigger, 'always'); assert.equal(moved.confirmChanges, true);
  assert.equal(store.read(moved.id).versions[0].by, 'user');
  assert.equal(fs.readFileSync(path.join(path.dirname(moved.path), 'templates/example.md'), 'utf8'), 'Template.');
  assert.equal(fs.readFileSync(path.join(path.dirname(moved.path), '.resources/keep.md'), 'utf8'), 'Keep on move.');
  assert.ok(!fs.existsSync(original.path));
  assert.ok(!store.list().some(skill => skill.id === original.id));
  await store.save(null, draft('collision'));
  await assert.rejects(() => store.save(moved.id, draft('collision')), /同名/);
  assert.ok(fs.existsSync(moved.path));
});

test('pending proposals do not change the active file; accept, reject and agent-created review', async t => {
  const { store, dataDir, active } = fixture(t);
  const info = await store.save(null, draft('proposed'));
  store.setOptions(info.id, { confirmChanges: true });
  const proposal = path.join(dataDir, 'skill-pending', 'proposed', 'SKILL.md');
  put(proposal, text('proposed', 'Agent proposal.'));
  assert.equal(store.list().find(s => s.id === info.id).pending, true);
  assert.match(store.read(info.id).pending, /Agent proposal/);
  assert.match(store.read(info.id).text, /First version/);
  active.push('p1');
  const accepted = store.resolveChange(info.id, true);
  assert.deepEqual([accepted.version, accepted.updatedBy, accepted.updatedIn, accepted.pending], [2, 'agent', 'First', false]);
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
  const info = await store.save(null, draft('watched'));
  active.push('p2');
  store.syncWatchers();
  put(info.path, text('watched', 'Changed by an agent.'));
  await until(() => store.history.latest(info.id)?.version === 2, 'agent version');
  assert.equal(store.history.latest(info.id).project, 'Second');
  assert.equal(store.history.latest(info.id).by, 'agent');
  active.push('p1');
  put(path.join(projects[0].path, 'skills', 'learned', 'SKILL.md'), text('learned'));
  await until(() => store.entries.has('project:p1:learned'), 'new project skill');
  assert.equal(store.info(store.entry('project:p1:learned')).createdByAgent, true);
  assert.equal(store.info(store.entry('project:p1:learned')).updatedIn, 'First');
  put(path.join(dataDir, 'skill-pending', 'watched', 'SKILL.md'), text('watched', 'Pending.'));
  await until(() => changed.at(-1)?.find(s => s.id === info.id)?.pending, 'pending event');
  await store.save(info.id, draft('watched', 'global', null, 'Saved by user.'));
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(store.history.latest(info.id).version, 3);
  assert.equal(store.history.latest(info.id).by, 'user');
  assert.deepEqual(errors, []);
});

test('startup notes deliver always/auto/disabled and every optimization permission with TOML-safe text', async t => {
  const { store, projects, dataDir } = fixture(t);
  for (const name of ['always', 'automatic', 'disabled', 'confirm', 'fixed']) await store.save(null, draft(name));
  await store.save(null, draft('disabled-project', 'project', 'p1'));
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

test('all option combinations and large libraries keep the complete instructions in a bounded manifest', async t => {
  const { store, projects } = fixture(t);
  await store.save(null, draft('matrix'));
  for (const enabled of [false, true]) for (const trigger of ['always', 'auto', 'first-open']) for (const autoOptimize of [false, true]) for (const confirmChanges of [false, true]) {
    store.setOptions('user:matrix', { enabled, trigger, autoOptimize, confirmChanges });
    const delivery = store.delivery(projects[0]), note = startupNote('Read.', null, null, delivery);
    const file = store.entry('user:matrix').path.replace(/\\/g, '/');
    assert.equal(note.includes(file), enabled);
    if (enabled) {
      assert.equal(note.includes(`Before any task, read and follow ${file}.`), trigger === 'always');
      assert.equal(note.includes(`Before the first task of this session, read and follow ${file}; this is its first run in this project.`), trigger === 'first-open');
      assert.ok(note.includes(!autoOptimize ? 'must not change it' : confirmChanges ? 'propose edits only to' : 'may update it in place'));
    }
  }
  for (let i = 0; i < 12; i++) await store.save(null, { ...draft(`long-${i}`), description: 'long description '.repeat(100) });
  const delivery = store.delivery(projects[0]), note = startupNote('Read.', null, null, delivery);
  assert.ok(note.length <= MAX_NOTE); assert.ok(note.includes(delivery.manifest.replace(/\\/g, '/')));
  assert.match(fs.readFileSync(delivery.manifest, 'utf8'), /long-11/);
});

test('SSH bundle contains only enabled built-in/global files, never project skills or local paths', async t => {
  const { store, projects, root } = fixture(t);
  await store.save(null, draft('global')); await store.save(null, draft('local-only', 'project', 'p1'));
  await store.save(null, draft('off')); store.setOptions('user:off', { enabled: false });
  put(path.join(path.dirname(store.entry('user:global').path), 'templates/example.md'), 'Remote template.');
  const delivery = store.delivery(projects[2], true), note = startupNote('Read.', '{AGENTRIX_HANDOFF}', null, delivery);
  assert.deepEqual(delivery.bundle.files.map(s => s.id), ['builtin:model-routing', 'user:global']);
  assert.ok(delivery.bundle.files.every(file => !('assets' in file)));
  assert.match(note, /read-only reference copies/);
  assert.doesNotMatch(note, /may update it in place|propose edits only/);
  assert.ok(note.includes('{AGENTRIX_SKILLS}/builtin/model-routing/SKILL.md'));
  assert.ok(note.includes('{AGENTRIX_AGENTS}'));
  assert.ok(!note.includes(root.replace(/\\/g, '/')) && !note.includes('local-only'));
});

test('PowerShell wrappers reread the refreshed startup note before another CLI session', { skip: process.platform !== 'win32' }, async t => {
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

test('successful Claude/Codex skill reads record lastUsed, failed/settled/mentioned/unrelated paths do not', async t => {
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
  assert.deepEqual({ ...store.list()[0].lastUsed, at: 0 }, { at: 0, project: 'First', agent: 'claude' });
  assert.ok(changed.at(-1)[0].lastUsed);
  agent = 'codex';
  const at = Date.now() + 50;
  const item = payload => codexRecord(log, { type: 'response_item', timestamp: new Date(at).toISOString(), payload }, cwd);
  item({ type: 'function_call', call_id: 'mention', name: 'exec_command', arguments: JSON.stringify({ cmd: `echo '${skill.path}'` }) });
  item({ type: 'function_call_output', call_id: 'mention', output: 'Exit code: 0' });
  assert.equal(store.list()[0].lastUsed.agent, 'claude');
  item({ type: 'function_call', call_id: 'read', name: 'exec_command', arguments: JSON.stringify({ cmd: `Get-Content -LiteralPath '${skill.path}'` }) });
  item({ type: 'function_call_output', call_id: 'read', output: 'Exit code: 0\nSkill body' });
  assert.deepEqual(store.list()[0].lastUsed, { at, project: 'First', agent: 'codex' });
  const remoteFile = '/tmp/agentrix-test/skills/builtin/model-routing/SKILL.md';
  store.recordAction({ kind: 'skill', skillFile: remoteFile, done: true, at: at + 50 }, { cwd: '/srv/app', project: 'ssh', agent: 'claude', remotePaths: { [skill.id]: remoteFile } });
  assert.equal(store.list()[0].lastUsed.project, 'Remote');
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
    const expected = { at, project: 'First', agent: 'codex' };
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
  const expected = { at, project: 'First', agent: 'claude' };
  assert.deepEqual(store.list()[0].lastUsed, expected);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'skills.json'), 'utf8'))[skill.id].lastUsed, expected);
});

test('native SDK and app-server reads share the successful-result usage path', async t => {
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

test('invalid names, imports and symlinked skill folders cannot escape managed storage', async t => {
  const { store, root, dataDir } = fixture(t);
  for (const name of ['../escape', 'bad/name', 'bad\\name', '.', 'CON', 'trailing.', 'quoted"']) await assert.rejects(() => store.save(null, draft(name)), /名称/);
  const bad = path.join(root, 'bad'); put(path.join(bad, 'SKILL.md'), 'Missing front matter');
  await assert.rejects(() => store.import(bad, 'global', null), /front matter/);
  const outside = path.join(root, 'outside'); put(path.join(outside, 'SKILL.md'), text('linked'));
  fs.symlinkSync(outside, path.join(dataDir, 'skills', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(() => store.save(null, draft('linked')), /符号链接/);
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

test('SSH bounds escaped JSON, skips oversized skills with a note, and never reads attachments', async t => {
  const { store, projects } = fixture(t);
  for (let i = 0; i < 5; i++) await store.save(null, { ...draft('large-' + i, 'global', null, '"\\\n中'.repeat(20000)), description: 'Described. '.repeat(180) });
  const info = await store.save(null, { ...draft('small'), description: 'Described. '.repeat(180) });
  put(path.join(path.dirname(info.path), 'huge.bin'), '');
  fs.truncateSync(path.join(path.dirname(info.path), 'huge.bin'), MAX_IMPORT_BYTES + 1);
  const delivery = store.delivery(projects[2], true);
  assert.ok(Buffer.byteLength(JSON.stringify(delivery.bundle)) <= MAX_SSH_BUNDLE_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify({ channel: 1, op: 'open', skills: delivery.bundle, readingNote: startupNote('Read.', null, '/srv/app/skills', delivery) })) < 2 * 1024 * 1024);
  assert.ok(delivery.bundle.files.some(file => file.id === info.id), 'a large earlier skill does not block later small ones');
  assert.ok(delivery.bundle.files.length < 7);
  assert.match(delivery.bundle.instructions, /enabled skills were omitted.*size limit/);
  assert.ok(delivery.bundle.files.every(file => !file.assets));
  for (const skill of store.infos()) if (!delivery.skills.some(item => item.id === skill.id)) {
    assert.ok(!delivery.bundle.instructions.includes('/' + skill.name + '/SKILL.md'));
  }
  const note = startupNote('Read.', '{AGENTRIX_HANDOFF}', '/srv/app/skills', delivery);
  assert.ok(note.includes(delivery.manifest), 'large instruction lists use a manifest');
  assert.ok(note.includes(delivery.skippedNote), 'the startup note discloses omissions even when using a manifest');
  assert.match(note, /This project keeps its skills in \/srv\/app\/skills/);
  assert.match(note, /create or update a skill there/);
  assert.match(note, /no names of people, email addresses, phone numbers/);
  assert.match(note, /read-only reference copies/);
  assert.doesNotMatch(note, /may update it in place|propose edits only/);
});

test('idle metadata polls read no bodies and refresh only the root that actually changed', async t => {
  const { store, projects } = fixture(t);
  const global = await store.save(null, draft('polled'));
  await store.save(null, draft('other', 'project', 'p1'));
  await Promise.all([...store.watchers.values()].map(watcher => watcher.poll()));
  await new Promise(resolve => setTimeout(resolve, 250));
  const refreshes = [], reads = [], refresh = store.refresh.bind(store), readFile = fs.readFileSync;
  store.refresh = (...args) => { refreshes.push(args[1]); return refresh(...args); };
  t.mock.method(fs, 'readFileSync', (file, ...args) => { if (String(file).endsWith('SKILL.md')) reads.push(file); return readFile(file, ...args); });
  for (let i = 0; i < 3; i++) await Promise.all([...store.watchers.values()].map(watcher => watcher.poll()));
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.deepEqual(refreshes, []); assert.deepEqual(reads, []);
  put(global.path, text('polled', 'Changed outside the app.'));
  await store.watchers.get(store.globalFolder).poll();
  await until(() => refreshes.length > 0, 'one changed-root refresh');
  assert.ok(refreshes.every(roots => roots instanceof Set && [...roots].every(root => root === store.globalFolder)));
  assert.ok(reads.every(file => !String(file).startsWith(projects[0].path)));
});

test('startup, offline edits and newly added projects are app baselines; invalid/reappearing files retain identity', async t => {
  const { store, options, dataDir, projects, active } = fixture(t, ({ dataDir }) => {
    put(path.join(dataDir, 'skills', 'existing', 'SKILL.md'), text('existing'));
    put(path.join(dataDir, 'skills', 'invalid-at-start', 'SKILL.md'), 'incomplete front matter');
  });
  let skill = store.list().find(item => item.id === 'user:existing');
  assert.deepEqual([skill.version, skill.updatedBy, skill.createdByAgent], [1, 'app', false]);
  const original = store.read(skill.id).text;
  assert.equal(JSON.parse(fs.readFileSync(path.join(store.history.folder(skill.id), 'index.json'), 'utf8')).lastSeenHash, safeId(original));
  active.push('p1');
  put(path.join(dataDir, 'skills', 'invalid-at-start', 'SKILL.md'), text('invalid-at-start'));
  const repaired = store.list().find(item => item.name === 'invalid-at-start');
  assert.deepEqual([repaired.updatedBy, repaired.createdByAgent], ['app', false]);
  put(skill.path, '---\nname: existing\n');
  assert.equal(store.list().find(item => item.id === skill.id).version, 1);
  assert.equal(store.read(skill.id).text, original);
  put(skill.path, original);
  assert.equal(store.list().find(item => item.id === skill.id).version, 1);
  const hidden = path.join(dataDir, 'temporarily-away');
  fs.renameSync(path.dirname(skill.path), hidden); store.list();
  fs.renameSync(hidden, path.dirname(skill.path));
  skill = store.list().find(item => item.id === skill.id);
  assert.deepEqual([skill.version, skill.createdByAgent], [1, false]);
  store.close(); put(skill.path, text('existing', 'Edited while closed.'));
  const reopened = new SkillsStore(options); t.after(() => reopened.close());
  skill = reopened.list().find(item => item.id === skill.id);
  assert.deepEqual([skill.version, skill.updatedBy, skill.createdByAgent], [2, 'app', false]);
  const added = { id: 'added', name: 'Added', path: path.join(dataDir, 'added-project') };
  put(path.join(added.path, 'skills', 'present', 'SKILL.md'), text('present'));
  projects.push(added); active.push('added');
  const baseline = reopened.list().find(item => item.id === 'project:added:present');
  assert.deepEqual([baseline.version, baseline.updatedBy, baseline.createdByAgent], [1, 'app', false]);
});

test('only active sessions in the matching project attribute changes and new skills to an agent', async t => {
  const { store, active, dataDir, projects } = fixture(t);
  const local = await store.save(null, draft('local', 'project', 'p1'));
  active.push('p2');
  put(local.path, text('local', 'External editor in an inactive folder.'));
  assert.equal(store.list().find(item => item.id === local.id).updatedBy, 'user');
  put(path.join(projects[0].path, 'skills', 'external', 'SKILL.md'), text('external'));
  assert.equal(store.list().find(item => item.name === 'external').createdByAgent, false);
  active.push('p1');
  put(local.path, text('local', 'Changed during an active session in this folder.'));
  const changed = store.list().find(item => item.id === local.id);
  assert.deepEqual([changed.updatedBy, changed.updatedIn], ['agent', 'First']);
  put(path.join(dataDir, 'skills', 'ambiguous', 'SKILL.md'), text('ambiguous'));
  assert.equal(store.list().find(item => item.name === 'ambiguous').updatedBy, 'user', 'multiple active projects provide no unique global attribution');
  const global = store.entry('user:ambiguous');
  put(global.path, text('ambiguous', 'Successful tool edit supplies the missing evidence.'));
  store.recordAction({ kind: 'edit', done: true, at: Date.now(), files: [{ path: global.path }] }, { cwd: projects[1].path, project: 'p2', agent: 'claude' });
  active.length = 0;
  assert.equal(store.list().find(item => item.name === 'ambiguous').updatedBy, 'agent', 'a proven edit outlives its session until the watcher catches up');
  assert.equal(store.list().find(item => item.name === 'ambiguous').updatedIn, 'Second');
  put(global.path, text('ambiguous', 'External edit after the session and proven write have finished.'));
  assert.equal(store.list().find(item => item.name === 'ambiguous').updatedBy, 'user');
});

test('corrupt JSON is backed up and bad skills roots are warned about without breaking construction or delivery', t => {
  const corrupt = '{"broken":';
  const { store, dataDir, errors, projects } = fixture(t, ({ dataDir }) => {
    put(path.join(dataDir, 'skills.json'), corrupt);
    put(path.join(dataDir, 'skill-history', safeId('builtin:model-routing'), 'index.json'), corrupt);
    put(path.join(dataDir, 'skills'), 'a file, not a directory');
  });
  assert.doesNotThrow(() => store.delivery(projects[0]));
  assert.doesNotThrow(() => store.delivery(projects[2], true));
  for (const file of [path.join(dataDir, 'skills.json'), path.join(store.history.folder('builtin:model-routing'), 'index.json')]) {
    const backup = fs.readdirSync(path.dirname(file)).find(name => name.startsWith(path.basename(file) + '.corrupt-'));
    assert.ok(backup); assert.equal(fs.readFileSync(path.join(path.dirname(file), backup), 'utf8'), corrupt);
  }
  assert.ok(errors.some(error => error.message.includes('skills.json')));
  assert.ok(errors.some(error => error.message.includes('index.json')));
  assert.ok(errors.some(error => error.message.includes('skills')));
});

test('inaccessible roots and skill files are skipped with warnings and valid siblings still deliver', async t => {
  const { store, options, projects, errors } = fixture(t);
  const info = await store.save(null, draft('denied'));
  store.close();
  const readDir = fs.readdirSync, readFile = fs.readFileSync;
  t.mock.method(fs, 'readdirSync', (root, ...args) => {
    if (root === path.join(projects[0].path, 'skills')) throw Object.assign(new Error('synthetic EACCES root'), { code: 'EACCES' });
    return readDir(root, ...args);
  });
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (file === info.path) throw Object.assign(new Error('synthetic EACCES file'), { code: 'EACCES' });
    return readFile(file, ...args);
  });
  fs.mkdirSync(path.join(projects[0].path, 'skills'), { recursive: true });
  const reopened = new SkillsStore(options); t.after(() => reopened.close());
  assert.equal(reopened.list().length, 1);
  assert.doesNotThrow(() => reopened.delivery(projects[0]));
  assert.ok(errors.some(error => error.message === 'synthetic EACCES root'));
  assert.ok(errors.some(error => error.message === 'synthetic EACCES file'));
});

test('display metadata stays separate from agent metadata and project names follow renames', async t => {
  const { store, projects } = fixture(t);
  const builtinText = fs.readFileSync(path.join(__dirname, '../resources/skills/model-routing/SKILL.md'), 'utf8');
  const builtin = metadata(builtinText);
  assert.equal(builtin.name, 'model-routing'); assert.equal(builtin.title, '模型路由');
  assert.equal(builtin.summary.split('。').filter(Boolean).length, 2);
  const raw = '\uFEFF---\r\nname: old\r\ndescription: old description\r\ntitle: "显示名"\r\nsummary: >\r\n  第一行。\r\n  第二行。\r\n---\r\nBody stays.\r\n';
  const saved = draftText({ ...draft('user-name'), text: raw });
  assert.equal(metadata(saved).title, '显示名'); assert.match(saved, /Body stays\.\r\n$/);
  const user = await store.save(null, { ...draft('user-name', 'project', 'p1'), text: raw });
  assert.deepEqual([user.title, user.summary, user.updatedIn], ['user-name', 'A tested procedure.', 'First']);
  const at = Date.now();
  store.recordAction({ kind: 'skill', done: true, at, skillFile: user.path }, { cwd: projects[0].path, project: 'p1', agent: 'claude' });
  projects[0].name = 'Renamed project';
  const renamed = store.list().find(item => item.id === user.id);
  assert.equal(renamed.updatedIn, 'Renamed project'); assert.equal(renamed.lastUsed.project, 'Renamed project');
  assert.equal(store.read(user.id).versions[0].project, 'Renamed project');
  assert.deepEqual(Object.keys(store.read(user.id).versions[0]).sort(), ['version', 'at', 'by', 'project', 'text'].sort());
});

test('history moves once, deletes with the skill, caps versions, and loads only recent bodies', async t => {
  const { store } = fixture(t);
  let info = await store.save(null, draft('history'));
  for (let i = 2; i <= 25; i++) info = await store.save(info.id, draft('history', 'global', null, 'Version ' + i));
  let versions = store.read(info.id).versions;
  assert.equal(versions.length, MAX_VERSIONS);
  assert.deepEqual(versions.map(item => item.version), Array.from({ length: 20 }, (_, i) => i + 6));
  assert.equal(versions.filter(item => item.text).length, TEXT_VERSIONS);
  assert.equal(fs.readdirSync(store.history.folder(info.id)).filter(name => name.endsWith('.md')).length, MAX_VERSIONS);
  const oldId = info.id, oldHistory = store.history.folder(oldId);
  info = await store.save(info.id, draft('moved-history', 'project', 'p2', 'Moved version'));
  versions = store.read(info.id).versions;
  assert.equal(versions.length, MAX_VERSIONS); assert.equal(new Set(versions.map(item => item.version)).size, MAX_VERSIONS);
  assert.ok(!fs.existsSync(oldHistory)); assert.equal(store.history.latest(oldId), null);
  store.revert(info.id, versions[0].version);
  assert.match(store.read(info.id).text, /Version 7/);
  const folder = store.history.folder(info.id);
  store.delete(info.id);
  assert.ok(!fs.existsSync(folder)); assert.equal(store.history.latest(info.id), null);
});

test('legacy history is capped on startup and cross-volume moves carry versions once without app-write races', async t => {
  const { store, projects } = fixture(t, ({ dataDir }) => {
    const id = 'user:legacy', folder = path.join(dataDir, 'skill-history', safeId(id)), versions = [];
    for (let version = 1; version <= 25; version++) {
      versions.push({ version, at: version, by: 'user', project: null });
      put(path.join(folder, 'v' + version + '.md'), text('legacy', 'Version ' + version));
    }
    put(path.join(folder, 'index.json'), JSON.stringify(versions));
    put(path.join(dataDir, 'skills', 'legacy', 'SKILL.md'), text('legacy', 'Version 25'));
  });
  const original = store.entry('user:legacy'), oldFolder = store.history.folder(original.id);
  assert.equal(store.read(original.id).versions.length, MAX_VERSIONS);
  assert.equal(fs.readdirSync(oldFolder).filter(name => name.endsWith('.md')).length, MAX_VERSIONS);
  const rename = fs.promises.rename.bind(fs.promises);
  t.mock.method(fs.promises, 'rename', async (from, to) => {
    if (from === path.dirname(original.path)) {
      assert.equal(store.refresh().find(item => item.id === original.id).version, 25);
      const concurrent = await store.save(null, draft('concurrent'));
      assert.deepEqual([concurrent.title, concurrent.summary, concurrent.source], ['concurrent', 'A tested procedure.', 'user']);
      throw Object.assign(new Error('synthetic cross-volume move'), { code: 'EXDEV' });
    }
    return rename(from, to);
  });
  const moved = await store.save(original.id, draft('legacy-moved', 'project', projects[0].id));
  assert.equal(moved.version, 26); assert.equal(store.read(moved.id).versions.length, MAX_VERSIONS);
  assert.ok(!fs.existsSync(oldFolder));
});

test('delivery is reused until relevant changes and successful reads publish usage without refreshing notes', async t => {
  const { store, projects, changes } = fixture(t);
  const info = await store.save(null, draft('cached'));
  const refresh = t.mock.method(store, 'refresh', store.refresh.bind(store));
  const delivery = store.delivery(projects[0]), manifestTime = fs.statSync(delivery.manifest).mtimeMs;
  assert.equal(store.delivery(projects[0]), delivery);
  store.recordAction({ kind: 'skill', done: true, at: Date.now(), skillFile: info.path }, { cwd: projects[0].path, project: 'p1', agent: 'claude' });
  assert.equal(changes.at(-1).deliveryChanged, false);
  assert.equal(store.delivery(projects[0]), delivery);
  assert.equal(fs.statSync(delivery.manifest).mtimeMs, manifestTime);
  assert.equal(refresh.mock.callCount(), 0, 'starts and usage publications do not scan every project');
  store.setOptions(info.id, { trigger: 'always' });
  assert.notEqual(store.delivery(projects[0]), delivery);
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  const notes = source.slice(source.indexOf('function refreshSkillNotes()'), source.indexOf('// Claude Code writes'));
  const sessions = new Map([['one', { projectId: 'p1', terminalId: 'one', sessionId: 'first', skillNoteFile: 'one.txt' }], ['two', { projectId: 'p1', terminalId: 'two', sessionId: 'later', skillNoteFile: 'two.txt' }]]);
  let deliveries = 0, writes = 0;
  const refreshNotes = require('node:vm').runInNewContext('(' + notes + ')', { sessions, store: { projects }, skills: { delivery: (project, remote, sessionId) => { assert.equal(project.id, 'p1'); assert.equal(remote, false); assert.ok(['first', 'later'].includes(sessionId)); deliveries++; return {}; } }, startupNote: () => 'Current instructions.', path,
    integrationDir: '/synthetic/integration', handoffFile: id => id, READING_NOTE: 'Read.', writeSkillFile: () => writes++ });
  refreshNotes(); assert.equal(deliveries, 2); assert.equal(writes, 2);
  refreshNotes(); assert.equal(writes, 2, 'unchanged notes are not rewritten');
});

test('imports skip dependency and dot folders, enforce total/count limits, and yield to the event loop', async t => {
  const { root, store } = fixture(t), folder = path.join(root, 'bounded-import');
  put(path.join(folder, 'SKILL.md'), text('bounded-import'));
  for (const skipped of ['.git', 'node_modules', '.hidden']) put(path.join(folder, skipped, 'too-big.bin'), '');
  fs.truncateSync(path.join(folder, '.git', 'too-big.bin'), MAX_IMPORT_BYTES + 1);
  for (let i = 0; i < 60; i++) put(path.join(folder, 'asset-' + i), 'small');
  let ticked = false;
  const importing = importFiles(folder); setImmediate(() => { ticked = true; });
  const files = await importing;
  assert.equal(ticked, true); assert.equal(files.length, 61);
  assert.ok(files.every(file => !/\.git|node_modules|\.hidden/.test(file.relative)));
  const imported = await store.import(folder, 'global', null);
  assert.ok(!fs.existsSync(path.join(path.dirname(imported.path), '.git')));
  put(path.join(folder, 'oversized.bin'), ''); fs.truncateSync(path.join(folder, 'oversized.bin'), MAX_IMPORT_BYTES + 1);
  await assert.rejects(() => importFiles(folder), /8 MB/);
  fs.unlinkSync(path.join(folder, 'oversized.bin'));
  for (let i = 60; i <= MAX_IMPORT_FILES; i++) put(path.join(folder, 'asset-' + i), '');
  await assert.rejects(() => importFiles(folder), /128/);
});
