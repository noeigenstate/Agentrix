const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveRegistration } = require('../electron/features/agents/dispatch-registration.cjs');
const { createTeamLocator } = require('../electron/features/team/team-locate.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-registration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = { id: 'project', kind: 'local', path: path.join(root, 'main') };
  const session = { sessionKey: 'synthetic-session', controlCapability: 'synthetic-capability', agent: 'claude', nativeStructured: false };
  const worker = { id: 'worker', cwd: path.join(root, 'worktree'), agent: 'claude', role: '执行', allow: ['src/**'] };
  fs.mkdirSync(project.path); fs.mkdirSync(worker.cwd);
  const common = path.join(root, '.git'), team = { live: () => [worker] }, asked = [];
  const locations = new Map([project.path, worker.cwd].map(cwd => [cwd, { status: 'found', common, team }]));
  const deps = { sessions: new Map([['terminal', session]]), store: { findTerminal: () => ({ project }) },
    locateTeam: async (cwd, options) => { asked.push(cwd); const result = locations.get(cwd); return options?.details ? result : result?.team || null; } };
  const registration = { runId: worker.id, projectId: 'terminal', sessionKey: session.sessionKey, capability: session.controlCapability,
    cwd: worker.cwd, agent: worker.agent, allow: worker.allow, readOnly: false, roundtable: false };
  return { root, project, session, worker, common, locations, deps, registration, asked };
}

test('a worker in a worktree registers against the board its helper admitted it on; a board from another Git common directory is refused with project_mismatch; a worker outside Git is bound from its authenticated declaration and no wider', async t => {
  const f = fixture(t);
  const first = await resolveRegistration(f.deps, f.registration);
  assert.equal(first.run.cwd, f.worker.cwd); assert.ok(f.asked.includes(f.worker.cwd), 'look up the board from the worker cwd');
  assert.equal(first.run.leadMode, 'terminal');
  f.locations.set(f.worker.cwd, { status: 'found', common: path.join(f.root, 'other.git'), team: { live: () => [f.worker] } });
  assert.deepEqual(await resolveRegistration(f.deps, f.registration), { refused: 'dispatch.project_mismatch', leadMode: 'terminal' });
  f.locations.set(f.worker.cwd, { status: 'outside_git', common: null, team: null });
  const declared = { ...f.registration, readOnly: true, allow: ['docs/**'], leadMode: 'native', local: false, worktree: f.root };
  const outside = (await resolveRegistration(f.deps, declared)).run;
  assert.deepEqual(outside, { runId: declared.runId, projectId: declared.projectId, agent: 'claude', cwd: declared.cwd,
    worktree: declared.cwd, allow: ['docs/**'], readOnly: true, roundtable: false, local: true, leadMode: 'terminal' });
  declared.allow.push('**'); assert.deepEqual(outside.allow, ['docs/**'], 'later declaration mutations cannot widen a binding');
});

test('registration checks current authentication before and after the asynchronous board lookup', async t => {
  const f = fixture(t);
  assert.deepEqual(await resolveRegistration(f.deps, { ...f.registration, sessionKey: 'stale' }), { refused: 'dispatch.session_mismatch' });
  assert.deepEqual(await resolveRegistration(f.deps, { ...f.registration, capability: 'wrong' }), { refused: 'dispatch.control_unbound' });
  assert.deepEqual(f.asked, []);
  const locate = f.deps.locateTeam;
  f.deps.locateTeam = async (...args) => { const result = await locate(...args); f.session.sessionKey = 'rotated'; return result; };
  assert.deepEqual(await resolveRegistration(f.deps, f.registration), { refused: 'dispatch.session_mismatch' });
});

test('a Git error, timeout, missing team or missing run cannot become a boardless registration', async t => {
  const f = fixture(t);
  for (const status of ['git_error', 'no_team']) {
    f.locations.set(f.worker.cwd, { status, common: f.common, team: null });
    assert.deepEqual(await resolveRegistration(f.deps, f.registration), { refused: status === 'no_team' ? 'dispatch.unknown_run' : 'dispatch.project_mismatch', leadMode: 'terminal' });
  }
  f.locations.set(f.worker.cwd, { status: 'found', common: f.common, team: { live: () => [] } });
  assert.deepEqual(await resolveRegistration(f.deps, f.registration), { refused: 'dispatch.unknown_run', leadMode: 'terminal' });
  f.locations.set(f.worker.cwd, { status: 'found', common: f.common, team: { live() { throw new Error('synthetic board loss'); } } });
  assert.deepEqual(await resolveRegistration(f.deps, f.registration), { refused: 'dispatch.unknown_run', leadMode: 'terminal' });
  f.locations.set(f.project.path, { status: 'git_error', common: null, team: null });
  f.locations.set(f.worker.cwd, { status: 'found', common: f.common, team: { live: () => [f.worker] } });
  assert.deepEqual(await resolveRegistration(f.deps, f.registration), { refused: 'dispatch.project_mismatch', leadMode: 'terminal' });
});

test('board scope and lead mode come from main and the admitted run, never a wider declaration', async t => {
  const f = fixture(t);
  f.worker.readOnly = true;
  for (const [agent, nativeStructured, leadMode] of [['claude', false, 'terminal'], ['claude', true, 'native'], ['codex', true, 'codex']]) {
    Object.assign(f.session, { agent, nativeStructured });
    const { run } = await resolveRegistration(f.deps, { ...f.registration, allow: ['**'], readOnly: false, leadMode: 'forged' });
    assert.equal(run.leadMode, leadMode); assert.deepEqual(run.allow, ['src/**']); assert.equal(run.readOnly, true);
    assert.equal(run.agent, 'claude'); assert.equal(run.projectId, 'terminal');
  }
  assert.deepEqual(await resolveRegistration(f.deps, { ...f.registration, agent: 'codex' }), { refused: 'dispatch.control_unbound', leadMode: 'codex' });
});

test('outside-Git declarations require a bounded relative scope and cannot claim a roundtable or another worktree', async t => {
  const f = fixture(t); f.locations.set(f.worker.cwd, { status: 'outside_git', common: null, team: null });
  for (const patch of [{ cwd: 'relative' }, { agent: 'other' }, { allow: ['../outside/**'] }, { allow: ['/absolute/**'] },
    { allow: ['C:/absolute/**'] }, { allow: ['src\n/**'] }, { allow: [null] }, { allow: 'src/**' }, { roundtable: true }, { readOnly: 'false' }]) {
    assert.deepEqual(await resolveRegistration(f.deps, { ...f.registration, ...patch }), { refused: 'dispatch.control_unbound', leadMode: 'terminal' });
  }
  const { run } = await resolveRegistration(f.deps, { ...f.registration, allow: [], worktree: f.root });
  assert.equal(run.readOnly, true, 'without a declared write scope a boardless run is read-only');
  assert.equal(run.worktree, f.worker.cwd);
});

test('one asynchronous team lookup distinguishes outside Git, failed Git and a repository without team state', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-registration-locate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.git'));
  let answer = { error: Object.assign(new Error('synthetic'), { code: 128 }), stderr: 'fatal: not a git repository (or any of the parent directories): .git\n' };
  const calls = [], locate = createTeamLocator({ execFile(file, args, options, done) {
    calls.push({ file, args, options }); queueMicrotask(() => done(answer.error || null, answer.stdout || '', answer.stderr || ''));
  } });
  assert.equal((await locate(root, { details: true })).status, 'outside_git');
  answer = { error: Object.assign(new Error('synthetic'), { code: 128 }), stderr: 'fatal: detected dubious ownership in repository\n' };
  assert.equal((await locate(root, { details: true })).status, 'git_error');
  answer = { error: Object.assign(new Error('synthetic'), { killed: true, signal: 'SIGTERM' }) };
  assert.equal((await locate(root, { details: true })).status, 'git_error');
  answer = { stdout: '.git\n' };
  const missing = await locate(root, { details: true });
  assert.equal(missing.status, 'no_team'); assert.equal(missing.common, fs.realpathSync.native(path.join(root, '.git')));
  assert.equal(await locate(root), null, 'existing readers still receive a team or null');
  fs.mkdirSync(path.join(root, '.git', 'agentrix'));
  assert.equal((await locate(root, { details: true })).status, 'no_team', 'an incomplete team folder is not an admission board');
  fs.mkdirSync(path.join(root, '.git', 'agentrix', 'board'), { recursive: true });
  const [found, team] = await Promise.all([locate(root, { details: true }), locate(root)]);
  assert.equal(found.status, 'found'); assert.equal(found.team.board, team.board); assert.equal(calls.length, 4);
  assert.ok(calls.every(call => call.file === 'git' && call.args.join(' ') === 'rev-parse --git-common-dir'));
});

test('a synchronous Git launch error is a status and is never cached as outside Git', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-registration-launch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let calls = 0;
  const locate = createTeamLocator({ execFile() { calls++; throw new Error('synthetic launch failure'); } });
  assert.equal((await locate(root, { details: true })).status, 'git_error');
  assert.equal(await locate(root), null); assert.equal(calls, 2);
});

test('outside-Git cwd cannot equal or contain the owning project, even with a relative write glob', async t => {
  const f = fixture(t);
  for (const cwd of [f.root, f.project.path]) {
    f.locations.set(cwd, { status: 'outside_git', common: null, team: null });
    const result = await resolveRegistration(f.deps, { ...f.registration, cwd, allow: ['main/electron/**'] });
    assert.equal(result.refused, 'dispatch.project_mismatch', 'an ancestor declaration could write into the project without its board');
  }
  f.locations.set(f.worker.cwd, { status: 'outside_git', common: null, team: null });
  const allowed = await resolveRegistration(f.deps, f.registration);
  assert.equal(allowed.run.cwd, f.worker.cwd, 'a separate outside-Git folder keeps its admitted scope');
});

test('an undetected terminal agent uses the Codex lead mode and therefore the Settings path', async t => {
  const f = fixture(t); delete f.session.agent;
  const result = await resolveRegistration(f.deps, f.registration);
  assert.equal(result.run?.leadMode, 'codex'); assert.equal(f.session.agent, undefined);
});

test('legacy team lookup retains an incomplete team while registration details require a board', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-registration-legacy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.git', 'agentrix'), { recursive: true });
  let calls = 0;
  const locate = createTeamLocator({ execFile(_file, _args, _options, done) { calls++; queueMicrotask(() => done(null, '.git\n')); } });
  const team = await locate(root);
  assert.ok(team, 'the sub-agent feed must not cache null solely because the board is absent');
  assert.equal(team.board, path.join(fs.realpathSync.native(root), '.git', 'agentrix', 'board'));
  assert.equal((await locate(root, { details: true })).status, 'no_team');
  assert.equal(calls, 1, 'both views share the same Git lookup');
});

test('Dispatch names its agent imports and stays within the boundary caps', () => {
  const { parseBoundary } = require('../scripts/module-boundaries.cjs');
  const boundary = parseBoundary('integration/BOUNDARY.md', fs.readFileSync(path.join(__dirname, '../integration/BOUNDARY.md'), 'utf8'));
  const imports = boundary.sections['May import'].map(line => /`([^`]+)`/.exec(line)[1]);
  for (const file of ['token-rate.cjs', 'agent-settings.cjs', 'codex-account-usage.cjs']) assert.ok(imports.includes(`electron/features/agents/${file}`), file);
  assert.ok(!imports.some(file => file.startsWith('electron/features/agents/') && file.includes('*')));
  assert.ok(imports.length <= 12); assert.deepEqual(boundary.errors, []);
});
