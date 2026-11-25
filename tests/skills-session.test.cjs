const { bootstrapScript, runPowerShellHook } = require('./helpers/powershell-hook.cjs');
const { dispatchEnvironment } = require('./fixtures/team-isolation.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { WorkspaceStore } = require('../electron/state.cjs');
const { SkillsStore } = require('../electron/features/skills/store.cjs');
const { startupNote, startupNoteFields } = require('../electron/features/agents/handoff.cjs');
const { READING_NOTE } = require('../electron/features/agents/reading-note.cjs');
const { digest, deliveryMarker, readDelivery, sessionContext } = require('../electron/features/skills/session.cjs');
const receiptFixture = require('./fixtures/skill-receipts/lifecycle.json');
const { terminalHooks } = require('../electron/features/terminal-events/hook-channel.cjs');

// A terminal's hooks as main writes them (hook-channel.cjs), for a wrapper run outside Agentrix.
const hooksFor = shell => terminalHooks({ port: 4242, terminalId: 'project', sessionKey: 'key', eventServer: { name: 'absent', address: '/absent.sock' }, env: {},
  cwd: os.tmpdir(), shell, platform: process.platform, home: os.tmpdir(), read: () => '{}' });
// The PowerShell session object a wrapper reads, with its command hooks only: these wrapper tests are about the note and arguments.
const powershellSession = bootstrap => fs.writeFileSync(bootstrap, JSON.stringify({
  nodePath: process.execPath,
  hooks: { channel: 'command', settings: { fallback: hooksFor({ posix: false, powershellPath: 'powershell.exe', script: 'fixture.ps1' }).settings.fallback } },
}));

async function fixture(t, routingNote = () => '') {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'agentrix-skills-'));
  const root = fs.realpathSync.native(temporary);
  const project = { id: 'project', path: path.join(root, 'project'), name: 'Isolated' };
  fs.mkdirSync(project.path);
  const store = new SkillsStore({ dataDir: root, builtinDir: path.join(root, 'builtins'), getProjects: () => [project], routingNote });
  t.after(async () => { store.close(); await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const draft = { name: 'sample', scope: 'global', projectId: null, description: 'Use when testing 中文说明.', text: 'First body.' };
  await store.save(null, draft);
  const delivery = id => store.delivery(project, false, id, { agent: 'claude', started: true });
  const noteFields = id => startupNoteFields(READING_NOTE, path.join(root, 'handoff.md'), path.join(project.path, 'skills'),
    delivery(id), path.join(root, 'dispatch.cjs'));
  const note = id => noteFields(id).full;
  return { root, store, project, draft, delivery, note, noteFields };
}

test('startup/resume deduplicate CLI session plus content fingerprint, compact/clear always deliver', async t => {
  const f = await fixture(t), first = f.note('terminal-first');
  const context = source => sessionContext({ session_id: 'cli-session', source }, first);
  assert.equal(context('startup').hookSpecificOutput.additionalContext, `Agentrix skill instructions:\n${readDelivery(first).instructions}`);
  assert.equal(context('resume'), null);
  assert.equal(context('startup'), null);
  assert.ok(context('compact')); assert.ok(context('clear')); assert.equal(context('resume'), null);
  const second = f.note('terminal-second');
  assert.equal(f.delivery('terminal-first').fingerprint, f.delivery('terminal-second').fingerprint, 'terminal-specific paths do not change content identity');
  assert.equal(sessionContext({ session_id: 'cli-session', source: 'resume' }, second), null);
  assert.ok(sessionContext({ session_id: 'different-cli', source: 'startup' }, second));
  await f.store.save('user:sample', { ...f.draft, text: 'Changed body, same description.' });
  const changed = f.note('terminal-third');
  assert.notEqual(readDelivery(changed).fingerprint, readDelivery(first).fingerprint);
  assert.ok(sessionContext({ session_id: 'cli-session', source: 'resume' }, changed));
  assert.ok(sessionContext({ session_id: 'cli-session', source: 'compact' }, changed));
  await f.store.save('user:sample', f.draft);
  assert.ok(sessionContext({ session_id: 'cli-session', source: 'resume' }, f.note('reverted')), 'compaction invalidates receipts for previous manifests too');
  assert.equal(sessionContext({ session_id: '../../escape', source: 'startup' }, changed), null);
  assert.equal(sessionContext({ session_id: 'cli-session', source: 'unexpected' }, changed), null);
});

test('routing note is optional, current on a new delivery and included in bounded SSH manifests', async t => {
  let routing = '';
  const f = await fixture(t, () => routing), before = f.delivery('lead');
  assert.doesNotMatch(fs.readFileSync(before.manifest, 'utf8'), /weight recommendation/);
  routing = 'Adopted routing weight recommendation: sample x code = 0.8.';
  const after = f.delivery('lead');
  assert.match(fs.readFileSync(after.manifest, 'utf8'), /weight recommendation/);
  assert.notEqual(after.fingerprint, before.fingerprint);
  const remote = f.store.delivery({ id: 'ssh', path: '/remote/project', kind: 'ssh' }, true, 'lead-ssh');
  assert.match(remote.bundle.instructions, /weight recommendation/);
  assert.doesNotMatch(remote.bundle.instructions, new RegExp(f.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.deepEqual(Object.keys(remote.bundle).sort(), ['files', 'instructions', 'key']);
  const [startup, instructions] = startupNote(READING_NOTE, null, null, remote).split(' Agentrix skill delivery: ');
  assert.match(startup, /^You run inside Agentrix/);
  assert.ok(startup.includes(`Current project skills manifest: ${remote.manifest}.`));
  assert.equal(instructions, `remote. ${remote.bundle.instructions}`);
});

test('worker seat changes reach running sessions while Claude instructions stay frozen through compact and clear', async t => {
  const f = await fixture(t), file = path.join(f.store.builtinDir, 'model-routing', 'SKILL.md');
  const shared = require('./fixtures/team-seats.json'), skill = 'builtin:model-routing';
  assert.equal(f.store.seatsInfo(f.project.id), null, 'no declaring skill means no chooser');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, fs.readFileSync(path.join(__dirname, '../resources/skills/model-routing/SKILL.md'), 'utf8'));
  f.store.getAgents = () => ({ claude: { installed: true }, codex: { installed: true } });
  f.store.getModels = () => shared.catalog; f.store.refresh();
  f.store.seatSession = id => ['terminal', 'next-terminal'].includes(id) ? { projectId: f.project.id, sessionId: id === 'terminal' ? 'running' : 'next' } : null;
  const choice = model => ({ model, effort: 'high' });
  const saveResearcher = model => f.store.setRouting('project', f.project.id, { roles: model ? { researcher: choice(model) } : {}, conductor: true },
    f.store.seatsInfo(f.project.id).routing.digest);
  assert.deepEqual(saveResearcher(null), { ok: true });
  const original = f.note('running'), launch = f.delivery('running'), launchBytes = fs.readFileSync(launch.sessionManifest, 'utf8');
  assert.equal(launch.rendered[skill].path, file, 'the default fixture reproduces shipped bytes and path');
  assert.equal(launch.rendered[skill].text, fs.readFileSync(file, 'utf8'));
  const instructions = fs.readFileSync(launch.sessionManifest, 'utf8');
  const allText = launch.skills.filter(item => item.enabled).map(item => [item.id, f.store.entry(item.id).text]);
  assert.equal(launch.fingerprint, digest(JSON.stringify([instructions, allText])));
  assert.deepEqual(saveResearcher('haiku'), { ok: true });
  assert.equal(f.store.seatsInfo(f.project.id, 'terminal').current.researcher.model, 'haiku');
  assert.equal(f.store.seatsInfo(null, 'terminal').current.researcher.model, 'haiku');
  assert.equal(f.store.seatsInfo(f.project.id, 'other').current, null);
  assert.equal(fs.readFileSync(launch.sessionManifest, 'utf8'), launchBytes);
  for (const source of ['compact', 'clear']) {
    const context = sessionContext({ session_id: 'running-cli', source }, original).hookSpecificOutput.additionalContext;
    assert.ok(context.includes(file.replace(/\\/g, '/')));
  }
  const nextNote = f.note('next'), next = f.delivery('next');
  const rendered = next.rendered[skill];
  assert.match(rendered.path.replace(/\\/g, '/'), /skill-delivery\/rendered\/[a-f0-9]{32}\/model-routing\/SKILL\.md$/);
  assert.match(fs.readFileSync(rendered.path, 'utf8'), /\| researcher \|.*\| haiku · high \| start_role seat researcher, or Agent call/);
  const expired = new Date(Date.now() - 31 * 86400000);
  fs.utimesSync(rendered.path, expired, expired);
  assert.equal(f.delivery('reuse').rendered[skill].path, rendered.path);
  f.store.endSession(f.project.id, 'reuse');
  assert.ok(fs.statSync(rendered.path).mtimeMs > expired.getTime(), 'reusing a rendered skill renews its retention');
  assert.notEqual(next.fingerprint, launch.fingerprint);
  const selectedBytes = fs.readFileSync(next.sessionManifest, 'utf8');
  assert.deepEqual(saveResearcher('opus'), { ok: true });
  assert.equal(f.store.seatsInfo(f.project.id, 'next-terminal').current.researcher.model, 'opus');
  for (const source of ['compact', 'clear']) {
    const context = sessionContext({ session_id: 'next-cli', source }, nextNote).hookSpecificOutput.additionalContext;
    assert.ok(context.includes(rendered.path.replace(/\\/g, '/')));
    assert.match(fs.readFileSync(rendered.path, 'utf8'), /\| researcher \|.*\| haiku · high \|/);
  }
  assert.equal(fs.readFileSync(next.sessionManifest, 'utf8'), selectedBytes);
  assert.match(f.delivery('later').rendered[skill].text, /\| researcher \|.*\| opus · high \|/);
  const remote = { id: 'ssh', path: '/remote/project', kind: 'ssh' };
  const bundle = id => f.store.delivery(remote, true, id, { agent: 'claude', started: true }).bundle;
  assert.deepEqual(f.store.setRouting('template', null, { roles: { researcher: choice('opus') }, conductor: true }, null), { ok: true });
  const remoteFirst = bundle('remote-first');
  assert.match(remoteFirst.files.find(item => item.id === skill).text, /\| researcher \|.*\| opus · high \|/);
  assert.match(remoteFirst.instructions, /\{AGENTRIX_SKILLS\}\/builtin\/model-routing\/SKILL\.md/);
  f.store.setRouting('template', null, { roles: { researcher: choice('haiku') }, conductor: true }, null);
  assert.notEqual(bundle('remote-next').key, remoteFirst.key);

  const reopened = new SkillsStore({ dataDir: f.root, builtinDir: f.store.builtinDir, getProjects: () => [f.project], getAgents: f.store.getAgents });
  t.after(() => reopened.close());
  reopened.recordAction({ kind: 'skill', done: true, at: Date.now(), skillFile: rendered.path }, { cwd: f.project.path, project: f.project.id, agent: 'claude' });
  assert.equal(reopened.info(reopened.entry(skill)).lastUsed?.agent, 'claude');
  fs.utimesSync(rendered.path, expired, expired);
  reopened.pruneDeliveryFiles(); assert.equal(fs.existsSync(rendered.path), true);
  f.store.endSession(f.project.id, 'next');
  reopened.pruneDeliveryFiles(); assert.equal(fs.existsSync(rendered.path), false);
});

test('Codex resume keeps the current project manifest across terminal exits and app restarts', async t => {
  const f = await fixture(t), launch = id => f.store.delivery(f.project, false, id, { agent: 'codex', started: true });
  const first = launch('terminal-one'), originalNote = startupNote('Read.', null, null, first);
  assert.ok(originalNote.includes(first.manifest.replace(/\\/g, '/')));
  assert.match(originalNote, /do not reload instructions already present/);
  const originalSnapshot = fs.readFileSync(first.sessionManifest, 'utf8');
  f.store.endSession(f.project.id, 'terminal-one'); f.store.close();
  const reopened = new SkillsStore({ dataDir: f.store.dataDir, builtinDir: f.store.builtinDir, getProjects: () => [f.project] });
  t.after(() => reopened.close());
  assert.equal(fs.existsSync(first.manifest), true);
  assert.equal(fs.existsSync(first.sessionManifest), false, 'startup prunes snapshots with no live session reference');
  await reopened.save('user:sample', { ...f.draft, description: 'Updated current instructions.' });
  const second = reopened.delivery(f.project, false, 'terminal-two', { agent: 'codex', started: true });
  assert.equal(second.manifest, first.manifest);
  assert.match(fs.readFileSync(first.manifest, 'utf8'), /Updated current instructions/);
  assert.equal(fs.readFileSync(second.sessionManifest, 'utf8').includes('Updated current instructions.'), true);
  const current = fs.readFileSync(first.manifest, 'utf8');
  reopened.delivery(f.project, false, 'idle-shell');
  reopened.delivery(f.project, false, 'unobserved-codex', { agent: 'codex' });
  const claude = reopened.delivery(f.project, false, 'claude-launch', { agent: 'claude', started: true });
  assert.notEqual(claude.manifest, first.manifest);
  assert.equal(fs.readFileSync(first.manifest, 'utf8'), current, 'previews and other agents do not replace the current Codex delivery');
  reopened.endSession(f.project.id, 'terminal-two');
  assert.equal(fs.readFileSync(first.manifest, 'utf8'), current);
  assert.match(originalSnapshot, /First body|sample/);
});

test('startup prunes unused and 30-day-old snapshots and receipts while keeping current manifests and live snapshots', async t => {
  const f = await fixture(t), live = f.delivery('live'), ended = f.delivery('ended');
  f.store.endSession(f.project.id, 'ended');
  const folder = path.dirname(live.manifest), now = Date.now(), old = new Date(now - 31 * 24 * 60 * 60 * 1000);
  const expired = f.delivery('expired');
  for (const file of [expired.sessionManifest, `${expired.sessionManifest}.json`]) fs.utimesSync(file, old, old);
  sessionContext({ session_id: 'old-cli', source: 'startup' }, f.note('receipt'));
  sessionContext({ session_id: 'recent-cli', source: 'startup' }, f.note('receipt'));
  const oldReceiptFolder = path.join(folder, 'receipts/claude', digest('old-cli').slice(0, 32));
  const oldReceipt = path.join(oldReceiptFolder, fs.readdirSync(oldReceiptFolder)[0]); fs.utimesSync(oldReceipt, old, old);
  f.store.pruneDeliveryFiles(now);
  for (const snapshot of [ended, expired]) {
    assert.equal(fs.existsSync(snapshot.sessionManifest), false);
    assert.equal(fs.existsSync(`${snapshot.sessionManifest}.json`), false);
  }
  assert.equal(fs.existsSync(live.sessionManifest), true);
  assert.equal(fs.existsSync(`${live.sessionManifest}.json`), true);
  assert.equal(fs.existsSync(oldReceiptFolder), false);
  const recentFolder = path.join(folder, 'receipts/claude', digest('recent-cli').slice(0, 32));
  assert.equal(fs.readdirSync(recentFolder).length, 1);
  f.store.close();
  const restarted = new SkillsStore({ dataDir: f.store.dataDir, builtinDir: f.store.builtinDir, getProjects: () => [f.project] });
  t.after(() => restarted.close());
  assert.equal(fs.existsSync(live.sessionManifest), true, 'recreating a watcher in the same process preserves still-live CLI references');
  for (const session of ['live', 'expired', 'receipt']) restarted.endSession(f.project.id, session);
  restarted.pruneDeliveryFiles();
  assert.equal(fs.existsSync(live.sessionManifest), false);
  assert.equal(fs.existsSync(live.manifest), true, 'stable current manifests survive restarts');
  assert.equal(fs.readdirSync(recentFolder).length, 1);
});

function receiptPaths(folder) {
  const result = [];
  if (fs.existsSync(folder)) for (const session of fs.readdirSync(folder)) {
    for (const key of fs.readdirSync(path.join(folder, session))) result.push(`${session}/${key}`);
  }
  return result.sort();
}

function expectedReceipts(step) {
  return step.receipts.map(value => {
    const [session, key] = value.split('/');
    return `${digest(session).slice(0, 32)}/${receiptFixture.manifests[key].slice(0, 32)}`;
  }).sort();
}

test('shared receipt lifecycle fixture matches Node SessionStart delivery and every remaining receipt', async t => {
  const f = await fixture(t), folder = path.join(f.root, 'shared-receipts'); fs.mkdirSync(folder);
  const notes = {};
  for (const [name, fingerprint] of Object.entries(receiptFixture.manifests)) {
    const manifest = path.join(folder, `${name}.md`); fs.writeFileSync(manifest, 'Shared instructions.');
    notes[name] = `Note. ${deliveryMarker({ manifest, fingerprint })}`;
  }
  for (const step of receiptFixture.steps) {
    const result = sessionContext({ session_id: step.session, source: step.source }, notes[step.key]);
    assert.equal(Boolean(result), step.deliver, JSON.stringify(step));
    if (result) assert.equal(result.hookSpecificOutput.additionalContext, 'Agentrix skill instructions:\nShared instructions.');
    assert.deepEqual(receiptPaths(path.join(folder, 'receipts/claude')), expectedReceipts(step));
  }
});

test('first-open launch snapshots stay correct when later sessions rewrite the current manifest', async t => {
  const f = await fixture(t);
  f.store.setOptions('user:sample', { trigger: 'first-open' });
  const first = f.delivery('first-launch'), firstNote = startupNote('Read.', null, null, first);
  const second = f.delivery('second-launch'), secondNote = startupNote('Read.', null, null, second);
  assert.equal(first.manifest, second.manifest);
  assert.equal(f.store.options['user:sample'].firstOpenedProjects[f.project.id], 'first-launch');
  assert.equal(first.skills[0].trigger, 'auto'); assert.equal(first.skills[0].firstOpenRun, true);
  assert.equal(first.skills[0].firstRun, true); assert.equal(second.skills[0].firstRun, false);
  assert.doesNotMatch(fs.readFileSync(first.manifest, 'utf8'), /this is its first run/);
  const firstContext = sessionContext({ session_id: 'first-cli', source: 'startup' }, firstNote);
  assert.match(firstContext.hookSpecificOutput.additionalContext, /this is its first run/);
  const secondContext = sessionContext({ session_id: 'second-cli', source: 'startup' }, secondNote);
  assert.doesNotMatch(secondContext.hookSpecificOutput.additionalContext, /this is its first run/);
  assert.equal(sessionContext({ session_id: 'first-cli', source: 'resume' }, firstNote), null);
  assert.equal(sessionContext({ session_id: 'second-cli', source: 'resume' }, secondNote), null);
});

test('routing discards first-run claims while other built-ins keep them through migration, resume and restart', async t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentrix-skills-')));
  const project = { id: 'project', path: path.join(root, 'project'), name: 'Long-running project' };
  const workspaceFile = path.join(root, 'workspace.json'), skillsFile = path.join(root, 'skills.json');
  const code = 'builtin:code-standard', ui = 'builtin:ui-standard', routing = 'builtin:model-routing';
  const claims = { [code]: { [project.id]: 'old-code-launch' }, [ui]: { [project.id]: 'old-ui-launch' } };
  const visual = { model: 'opus', effort: 'high' };
  const seats = { global: { lookup: { model: 'haiku', effort: 'high' } }, projects: { [project.id]: { visual } } };
  const migratedRoles = { designer: visual, qa: visual, researcher: seats.global.lookup };
  fs.mkdirSync(project.path);
  fs.writeFileSync(workspaceFile, JSON.stringify({ version: 2, projects: [project] }));
  fs.writeFileSync(skillsFile, JSON.stringify({
    [code]: { firstOpenedProjects: claims[code] },
    [ui]: { trigger: 'first-open', firstOpenedProjects: claims[ui] },
    [routing]: { enabled: false, trigger: 'auto', firstOpenRun: true, firstOpenedProjects: { [project.id]: 'old-routing-launch' }, seats },
  }));

  let store;
  t.after(async () => { store?.close(); await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const errors = [];
  const open = () => {
    const workspace = new WorkspaceStore(workspaceFile);
    assert.equal(workspace.warning, null);
    assert.equal(workspace.projects[0].id, project.id);
    store = new SkillsStore({ dataDir: root, builtinDir: path.join(__dirname, '../resources/skills'), getProjects: () => workspace.projects,
      getAgents: () => ({ claude: { installed: true } }), report: error => errors.push(error) });
    store.syncWatchers();
    return workspace.projects[0];
  };
  const saved = () => JSON.parse(fs.readFileSync(skillsFile, 'utf8'));
  const verifyClaims = () => {
    const persisted = saved();
    for (const [id, claim] of Object.entries(claims)) {
      assert.deepEqual(store.options[id].firstOpenedProjects, claim, id);
      assert.deepEqual(persisted[id].firstOpenedProjects, claim, id);
    }
  };
  for (const phase of ['upgraded', 'restarted']) {
    const current = open();
    verifyClaims();
    const options = saved();
    assert.deepEqual(options[routing].seats, seats);
    assert.equal(options[routing].team, undefined);
    const { local, trust } = options[routing].routing;
    const { routing: source } = store.seatsInfo(project.id);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(current.path, '.agentrix', 'routing.json'), 'utf8')).roles, migratedRoles);
    assert.equal(local[project.id], undefined);
    assert.deepEqual([source.layer, source.state], ['file', 'trusted']);
    assert.equal(trust[project.id].digest, source.digest);
    assert.deepEqual(trust[project.id].config.roles, migratedRoles);
    assert.equal(options[ui].trigger, 'auto');
    assert.equal(options[ui].firstOpenRun, true);
    for (const key of ['enabled', 'trigger', 'firstOpenRun', 'firstOpenedProjects']) assert.equal(Object.hasOwn(options[routing], key), false);
    store.setOptions(ui, { firstOpenRun: true });
    await store.refreshSeats(project.id);
    for (const source of ['resume', 'startup']) {
      const launchId = `${phase}-${source}`;
      const cliId = source === 'resume' ? 'resumed-claude-session' : `${launchId}-cli`;
      const preview = store.delivery(current, false, `${launchId}-shell`, { agent: 'claude' });
      assert.doesNotMatch(startupNote('Read.', null, null, preview), /this is its first run in this project/);
      store.endSession(current.id, `${launchId}-shell`);
      const launch = store.delivery(current, false, launchId, { agent: 'claude', started: true });
      for (const id of [code, ui]) assert.equal(launch.skills.find(skill => skill.id === id).firstRun, false, id);
      assert.equal(launch.skills.some(skill => skill.id === routing), false, 'native mode sends no routing, so it claims no first run');
      const note = startupNote('Read.', null, null, launch);
      assert.doesNotMatch(note, /this is its first run in this project/);
      const instructions = readDelivery(note).instructions;
      assert.match(instructions, /Before any task, read and follow [^;]+\/code-standard\/SKILL\.md\./);
      assert.doesNotMatch(instructions, /this is its first run in this project/);
      const context = sessionContext({ session_id: cliId, source }, note);
      if (source === 'resume' && phase === 'restarted') assert.equal(context, null, 'the unchanged delivery was already received');
      else assert.equal(context.hookSpecificOutput.additionalContext, `Agentrix skill instructions:\n${instructions}`);
      for (const hookSource of ['compact', 'clear']) {
        const { additionalContext } = sessionContext({ session_id: cliId, source: hookSource }, note).hookSpecificOutput;
        assert.doesNotMatch(additionalContext, /this is its first run in this project/);
      }
      store.endSession(current.id, launchId);
      verifyClaims();
    }
    store.close();
  }
  assert.deepEqual(errors, []);
});

for (const trigger of ['always', 'first-open']) test(`${trigger} live Claude sessions keep first-run instructions only for their claimant after compact/clear`, async t => {
  const f = await fixture(t);
  f.store.setOptions('user:sample', { trigger });
  const first = f.note('live-first'), second = f.note('live-second');
  const initial = readDelivery(first).instructions;
  assert.match(sessionContext({ session_id: 'first-cli', source: 'startup' }, first).hookSpecificOutput.additionalContext, /this is its first run/);
  assert.doesNotMatch(sessionContext({ session_id: 'second-cli', source: 'startup' }, second).hookSpecificOutput.additionalContext, /this is its first run/);
  await f.store.save('user:sample', { ...f.draft, description: 'Updated live instructions.' });
  for (const source of ['compact', 'clear']) for (const [note, id] of [[first, 'first-cli'], [second, 'second-cli']]) {
    const context = sessionContext({ session_id: id, source }, note).hookSpecificOutput.additionalContext;
    assert.equal(context.includes('this is its first run'), id === 'first-cli');
    assert.equal(sessionContext({ session_id: id, source: 'resume' }, note), null);
  }
  assert.equal(readDelivery(first).instructions, initial, 'the original launch snapshot is immutable');
  assert.equal(f.store.options['user:sample'].firstOpenedProjects[f.project.id], 'live-first');
  f.store.setOptions('user:sample', { trigger: 'auto', firstOpenRun: false });
  for (const [note, id] of [[first, 'first-cli'], [second, 'second-cli']]) {
    const context = sessionContext({ session_id: id, source: 'compact' }, note).hookSpecificOutput.additionalContext;
    assert.match(context, /Updated live instructions/); assert.doesNotMatch(context, /this is its first run/);
  }
  f.store.setOptions('user:sample', { enabled: false });
  const disabled = sessionContext({ session_id: 'first-cli', source: 'compact' }, first).hookSpecificOutput.additionalContext;
  assert.doesNotMatch(disabled, /Updated live instructions/);
  const metadata = JSON.parse(fs.readFileSync(`${readDelivery(first).manifest}.json`, 'utf8'));
  assert.match(path.basename(metadata.current), /^[a-f0-9]{32}-[a-f0-9]{32}\.md$/);
  assert.ok(metadata.current.length < 260);
});

test('a claiming session keeps its pending first-run review across compact and store recreation', async t => {
  const f = await fixture(t);
  await f.store.save('user:sample', { ...f.draft, description: 'On its first run, change nothing until the user agrees.' });
  f.store.setOptions('user:sample', { trigger: 'always' });
  const first = f.note('claimant');
  sessionContext({ session_id: 'claimant-cli', source: 'startup' }, first);
  f.store.close();
  const reopened = new SkillsStore({ dataDir: f.store.dataDir, builtinDir: f.store.builtinDir, getProjects: () => [f.project] });
  t.after(() => reopened.close());
  await reopened.save('user:sample', { ...f.draft, description: 'On its first run, change nothing until the user agrees. Updated review.' });
  const later = startupNote('Read.', null, null, reopened.delivery(f.project, false, 'later', { agent: 'claude', started: true }));
  for (const source of ['compact', 'clear']) {
    const context = sessionContext({ session_id: 'claimant-cli', source }, first).hookSpecificOutput.additionalContext;
    assert.match(context, /this is its first run/);
    assert.doesNotMatch(sessionContext({ session_id: 'later-cli', source }, later).hookSpecificOutput.additionalContext, /this is its first run/);
  }
  assert.equal(reopened.options['user:sample'].firstOpenedProjects[f.project.id], 'claimant');
  reopened.setOptions('user:sample', { trigger: 'auto' });
  assert.doesNotMatch(sessionContext({ session_id: 'claimant-cli', source: 'compact' }, first).hookSpecificOutput.additionalContext, /this is its first run/);
});

test('live current snapshots survive watcher recreation, refresh external edits, and stop updating after session end', async t => {
  const f = await fixture(t), note = f.note('live');
  sessionContext({ session_id: 'cli', source: 'startup' }, note);
  const metadata = JSON.parse(fs.readFileSync(`${readDelivery(note).manifest}.json`, 'utf8'));
  f.store.close();
  const reopened = new SkillsStore({ dataDir: f.store.dataDir, builtinDir: f.store.builtinDir, getProjects: () => [f.project] });
  t.after(() => reopened.close());
  const file = reopened.entry('user:sample').path;
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Use when testing 中文说明.', 'External update.'));
  reopened.refresh();
  assert.match(sessionContext({ session_id: 'cli', source: 'compact' }, note).hookSpecificOutput.additionalContext, /External update/);
  reopened.endSession(f.project.id, 'live');
  const settled = fs.readFileSync(metadata.current, 'utf8');
  await reopened.save('user:sample', { ...f.draft, description: 'After session end.' });
  assert.equal(fs.readFileSync(metadata.current, 'utf8'), settled);
});

function hookProcess(file, args, input, noteFile) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env: { ...dispatchEnvironment(), AGENTRIX_READING_NOTE_FILE: noteFile }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
    child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

function powershellProbe(folder, script, noteFile) {
  const file = path.join(folder, 'probe.ps1');
  fs.writeFileSync(file, '\uFEFF' + script); // Windows PowerShell requires the BOM for UTF-8 source.
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  return hookProcess(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], {}, noteFile);
}

test('Node SessionStart writes one JSON context even without Agentrix; other hooks remain silent', async t => {
  const f = await fixture(t), noteFile = path.join(f.root, 'note.txt');
  fs.writeFileSync(noteFile, f.note('hook'));
  const args = [path.join(__dirname, '../integration/agent-event.cjs'), 'claude-hook', process.platform === 'win32' ? '\\\\.\\pipe\\absent-agentrix-skill-test' : path.join(f.root, 'absent.sock'), 'project', 'key'];
  const first = await hookProcess(process.execPath, [...args, 'session'], { session_id: 'hook-cli', source: 'startup' }, noteFile);
  assert.equal(first.code, 0); assert.equal(first.stderr, '');
  const output = JSON.parse(first.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.equal(output.hookSpecificOutput.additionalContext, `Agentrix skill instructions:\n${readDelivery(fs.readFileSync(noteFile, 'utf8')).instructions}`);
  const second = await hookProcess(process.execPath, [...args, 'session'], { session_id: 'hook-cli', source: 'resume' }, noteFile);
  assert.equal(second.stdout, '');
  const notify = await hookProcess(process.execPath, [...args, 'notify'], { session_id: 'hook-cli', notification_type: 'permission_prompt' }, noteFile);
  assert.equal(notify.stdout, '');
  const simultaneous = await Promise.all([1, 2].map(() => hookProcess(process.execPath, [...args, 'session'], { session_id: 'concurrent-cli', source: 'startup' }, noteFile)));
  assert.equal(simultaneous.filter(result => result.stdout).length, 1, 'concurrent hook processes share the exclusive receipt');
});

test('SessionStart reports a missing manifest and delivers it when the session resumes', async t => {
  const f = await fixture(t), noteFile = path.join(f.root, 'note.txt'), manifest = path.join(f.root, 'late.md');
  fs.writeFileSync(noteFile, 'Note. ' + deliveryMarker({ manifest, fingerprint: digest('late') }));
  const hook = path.join(__dirname, '../integration/agent-event.cjs');
  const address = process.platform === 'win32' ? '\\\\.\\pipe\\absent-agentrix-skill' : path.join(f.root, 'absent.sock');
  const commands = [[process.execPath, [hook, 'claude-hook', address, 'project', 'key', 'session']]];
  if (process.platform === 'win32') commands.push([
    path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, '../integration/claude-hook.ps1'),
      '-PipeName', 'absent-agentrix-skill', '-ProjectId', 'project', '-SessionKey', 'key', '-Kind', 'session'],
  ]);
  for (const [index, [file, args]] of commands.entries()) {
    const payload = { session_id: 'fixture-' + index, source: 'startup' };
    const failed = await hookProcess(file, args, payload, noteFile);
    assert.equal(failed.code, 0);
    assert.match(JSON.parse(failed.stdout).systemMessage, /无法读取会话说明/);
    fs.writeFileSync(manifest, 'Recovered instructions.');
    const recovered = await hookProcess(file, args, { ...payload, source: 'resume' }, noteFile);
    assert.equal(JSON.parse(recovered.stdout).hookSpecificOutput.additionalContext, 'Agentrix skill instructions:\nRecovered instructions.');
    fs.unlinkSync(manifest);
  }
});

test('Unix Claude wrapper keeps the startup note on the command line, with skills only in SessionStart; the shell never runs Codex', { skip: process.platform === 'win32' }, async t => {
  const terminalSession = '11111111-1111-4111-8111-111111111111';
  const f = await fixture(t), bin = path.join(f.root, 'bin'), home = path.join(f.root, 'home'), noteFile = path.join(f.root, `${terminalSession}-skills.txt`);
  const note = f.noteFields('unix'), bootstrap = path.join(f.root, 'terminal.json');
  fs.mkdirSync(bin); fs.mkdirSync(home); fs.writeFileSync(noteFile, note.full);
  fs.writeFileSync(bootstrap + '.launch-note', note.launch);
  const script = path.join(f.root, 'fake.cjs');
  fs.writeFileSync(script, `const fs=require('node:fs'),args=process.argv.slice(3);fs.writeFileSync(require('node:path').join(process.env.CAPTURE_ROOT, process.argv[2]+'.json'),JSON.stringify({note:process.env.AGENTRIX_READING_NOTE_FILE,args,settings:process.argv[2]==='claude'?JSON.parse(fs.readFileSync(args[1],'utf8')):null}));`);
  const quote = value => `'${value.replace(/'/g, "'\\''")}'`;
  for (const agent of ['claude', 'codex']) fs.writeFileSync(path.join(bin, agent), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} ${agent} "$@"\n`, { mode: 0o700 });
  const shell = process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
  const source = path.join(__dirname, process.platform === 'darwin' ? '../integration/zsh-integration.zsh' : '../integration/bash-integration.bash');
  const env = { HOME: home, ZDOTDIR: home, AGENTRIX_USER_ZDOTDIR: home, PATH: `${bin}:/usr/bin:/bin`, CODEX_HOME: path.join(home, 'codex'), CLAUDE_CONFIG_DIR: path.join(home, 'claude'),
    CAPTURE_ROOT: f.root, AGENTRIX_BOOTSTRAP: bootstrap, AGENTRIX_NODE: process.execPath, AGENTRIX_READING_NOTE_FILE: noteFile,
    AGENTRIX_EVENT_HELPER: path.join(__dirname, '../integration/agent-event.cjs') };
  const hooks = hooksFor({ posix: true, node: process.execPath, helper: env.AGENTRIX_EVENT_HELPER, noteFile });
  Object.assign(env, { AGENTRIX_HOOK_PORT: String(hooks.port), AGENTRIX_HOOK_CHANNEL: hooks.channel, AGENTRIX_HOOK_SETTINGS: hooks.settings.http, AGENTRIX_HOOK_FALLBACK: hooks.settings.fallback });
  await new Promise((resolve, reject) => {
    const child = spawn(shell, ['-c', 'source "$1" zshrc; claude hello; codex hello', '_', source], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = ''; child.stderr.on('data', bytes => { errors += bytes; }); child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(errors)));
  });
  const claude = JSON.parse(fs.readFileSync(path.join(f.root, 'claude.json')));
  // Typing codex asks for a native session, whose start carries the note: the executable on PATH is never run.
  assert.equal(fs.existsSync(path.join(f.root, 'codex.json')), false);
  assert.equal(claude.note, noteFile);
  assert.equal(claude.args[2], '--append-system-prompt');
  assert.equal(claude.args[3], note.launch);
  assert.match(claude.args[3], /^You run inside Agentrix/);
  assert.deepEqual(claude.args.slice(4), ['hello']);
  assert.ok(!JSON.stringify(claude.args).includes('中文说明'));
  assert.ok(claude.settings.hooks.SessionStart[0].hooks[0].command.includes(noteFile));
  assert.equal(path.dirname(claude.args[1]), f.root);
  assert.ok(path.basename(claude.args[1]).startsWith(`${terminalSession}-claude-settings-`));
  assert.equal(fs.existsSync(claude.args[1]), false, 'settings file is removed after exit');
});

test('PowerShell Claude wrapper keeps the startup note and fallback before intact resume arguments', { skip: process.platform !== 'win32' }, async t => {
  const terminalSession = '11111111-1111-4111-8111-111111111111';
  const f = await fixture(t), noteFile = path.join(f.root, `${terminalSession}-skills.txt`), note = f.noteFields('wrapper');
  const bootstrap = path.join(f.root, 'terminal.json');
  fs.writeFileSync(noteFile, note.full);
  fs.writeFileSync(bootstrap + '.launch-note', note.launch);
  const command = path.join(f.root, 'claude.ps1');
  fs.writeFileSync(command, "@{ args = @($args); settings = (Get-Content -LiteralPath $args[1] -Raw | ConvertFrom-Json) } | ConvertTo-Json -Depth 10 -Compress\n");
  powershellSession(bootstrap);
  const script = `
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
${bootstrapScript(bootstrap)}
function global:Send-AgentrixEvent {}
function global:Get-AgentrixCommand {}
$global:AgentrixClaudeExecutable = $global:AgentrixClaudeCommand = '${command.replace(/'/g, "''")}'
claude --resume fixture '继续'`;
  const result = await powershellProbe(f.root, script, noteFile);
  assert.equal(result.stderr, ''); assert.equal(result.code, 0);
  const { args, settings } = JSON.parse(result.stdout);
  assert.equal(args[0], '--settings'); assert.ok(settings.hooks.SessionStart);
  assert.equal(path.dirname(args[1]), f.root);
  assert.match(path.basename(args[1]), new RegExp(`^${terminalSession}-claude-settings-[0-9a-f]{32}\\.json$`));
  assert.equal(fs.existsSync(args[1]), false);
  assert.equal(args[2], '--append-system-prompt');
  assert.equal(args[3], note.launch);
  assert.match(args[3], /^You run inside Agentrix/);
  assert.doesNotMatch(args[3], /中文说明|Agentrix skill delivery:/);
  assert.deepEqual(args.slice(4), ['--resume', 'fixture', '继续']);
});

test('PowerShell and Node share receipts and force a delivery after compact/clear', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), noteFile = path.join(f.root, 'note.txt'), note = f.note('powershell');
  fs.writeFileSync(noteFile, note);
  sessionContext({ session_id: 'same-cli', source: 'startup' }, note);
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const args = ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, '../integration/claude-hook.ps1'),
    '-PipeName', 'absent-agentrix-skill-test', '-ProjectId', 'project', '-SessionKey', 'key', '-Kind', 'session'];
  const resumed = await hookProcess(powershell, args, { session_id: 'same-cli', source: 'resume' }, noteFile);
  assert.deepEqual(resumed, { code: 0, stdout: '', stderr: '' });
  for (const source of ['compact', 'clear']) {
    const result = await hookProcess(powershell, args, { session_id: 'same-cli', source }, noteFile);
    assert.equal(result.stderr, ''); assert.equal(result.code, 0);
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, `Agentrix skill instructions:\n${readDelivery(note).instructions}`);
    assert.equal(sessionContext({ session_id: 'same-cli', source: 'resume' }, note), null);
  }
});

test('PowerShell compact/clear reads updated per-session instructions and keeps startup/resume receipts', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t); f.store.setOptions('user:sample', { trigger: 'first-open' });
  const note = f.note('live-powershell'), noteFile = path.join(f.root, 'note.txt'); fs.writeFileSync(noteFile, note);
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const args = ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, '../integration/claude-hook.ps1'),
    '-PipeName', 'absent-agentrix-skill-test', '-ProjectId', 'project', '-SessionKey', 'key', '-Kind', 'session'];
  const launch = await hookProcess(powershell, args, { session_id: 'ps-cli', source: 'startup' }, noteFile);
  assert.match(JSON.parse(launch.stdout).hookSpecificOutput.additionalContext, /this is its first run/);
  await f.store.save('user:sample', { ...f.draft, description: 'Updated Windows hook instructions.' });
  for (const source of ['compact', 'clear']) {
    const result = await hookProcess(powershell, args, { session_id: 'ps-cli', source }, noteFile);
    assert.equal(result.stderr, ''); assert.equal(result.code, 0);
    const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    assert.match(context, /this is its first run/);
    assert.equal(sessionContext({ session_id: 'ps-cli', source: 'resume' }, note), null);
  }
  f.store.setOptions('user:sample', { firstOpenRun: false });
  const updated = await hookProcess(powershell, args, { session_id: 'ps-cli', source: 'compact' }, noteFile);
  assert.equal(updated.code, 0); assert.equal(updated.stderr, '');
  const context = JSON.parse(updated.stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /Updated Windows hook instructions/); assert.doesNotMatch(context, /this is its first run/);
});

test('PowerShell 5.1 fallback passes a settings file through a real fake claude.cmd with the startup note intact', { skip: process.platform !== 'win32' }, async t => {
  const terminalSession = '11111111-1111-4111-8111-111111111111';
  const f = await fixture(t), bin = path.join(f.root, 'shim with spaces'), noteFile = path.join(f.root, `${terminalSession}-skills.txt`); fs.mkdirSync(bin);
  const note = f.noteFields('cmd'), bootstrap = path.join(f.root, 'terminal.json');
  fs.writeFileSync(noteFile, note.full);
  fs.writeFileSync(bootstrap + '.launch-note', note.launch);
  const captureFile = path.join(f.root, 'argv.json'), fake = path.join(bin, 'capture.cjs'), command = path.join(bin, 'claude.cmd');
  fs.writeFileSync(fake, `const fs=require('node:fs'),args=process.argv.slice(2);fs.writeFileSync(${JSON.stringify(captureFile)},JSON.stringify({args,settings:JSON.parse(fs.readFileSync(args[1],'utf8'))}));`);
  fs.writeFileSync(command, `@echo off\r\n"${process.execPath}" "${fake}" %*\r\n`);
  powershellSession(bootstrap);
  const quote = value => `'${value.replace(/'/g, "''")}'`;
  const script = `$ProgressPreference = 'SilentlyContinue'\n${bootstrapScript(bootstrap)}\nfunction global:Send-AgentrixEvent {}\nfunction global:Get-AgentrixCommand {}
$global:AgentrixClaudeExecutable = ${quote(command)}
$global:AgentrixClaudeCommand = ${quote(command)}
claude --resume fixture 'next task'`;
  const result = await powershellProbe(f.root, script, noteFile);
  assert.equal(result.stderr, ''); assert.equal(result.code, 0);
  const { args, settings } = JSON.parse(fs.readFileSync(captureFile));
  assert.equal(args[0], '--settings'); assert.equal(path.dirname(args[1]), f.root);
  assert.match(path.basename(args[1]), new RegExp(`^${terminalSession}-claude-settings-[0-9a-f]{32}\\.json$`));
  assert.ok(settings.hooks.SessionStart[0].hooks[0].command.includes('fixture.ps1'));
  assert.equal(args[2], '--append-system-prompt');
  assert.equal(args[3], note.launch);
  assert.deepEqual(args.slice(4), ['--resume', 'fixture', 'next task']);
  assert.equal(fs.existsSync(args[1]), false);
});

test('shared receipt lifecycle fixture matches PowerShell SessionStart delivery and every remaining receipt', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), folder = path.join(f.root, 'powershell-receipts'); fs.mkdirSync(folder);
  const notes = {};
  for (const [key, fingerprint] of Object.entries(receiptFixture.manifests)) {
    const manifest = path.join(folder, `${key}.md`), noteFile = path.join(folder, `${key}.txt`);
    fs.writeFileSync(manifest, 'Shared instructions.'); fs.writeFileSync(noteFile, `Note. ${deliveryMarker({ manifest, fingerprint })}`);
    notes[key] = noteFile;
  }
  const receiptsRoot = path.join(folder, 'receipts/claude');
  for (const step of receiptFixture.steps) {
    const result = await runPowerShellHook('session', { session_id: step.session, source: step.source }, { noteFile: notes[step.key] });
    assert.equal(result.code, 0); assert.equal(result.stderr, '');
    assert.equal(Boolean(result.stdout), step.deliver, JSON.stringify(step));
    if (result.stdout) assert.equal(JSON.parse(result.stdout).hookSpecificOutput.hookEventName, 'SessionStart');
    const receipts = fs.existsSync(receiptsRoot) ? fs.readdirSync(receiptsRoot).flatMap(session =>
      fs.readdirSync(path.join(receiptsRoot, session)).map(file => session + '/' + file)).sort() : [];
    assert.deepEqual(receipts, expectedReceipts(step), JSON.stringify(step));
  }
});
