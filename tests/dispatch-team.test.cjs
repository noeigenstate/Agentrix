const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const sync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { run, argumentsOf, commandOf, briefOf } = require('../integration/dispatch.cjs');
const { createRequire } = require('node:module');
const vm = require('node:vm');
const { projectTeam, understandingOf, confirmationOf, memoryExcerpt, minutesMarkdown } = require('../electron/features/team/team.cjs');
const { createEventServer } = require('../electron/events.cjs');
const { minutesPage } = require('../electron/features/team/minutes-page.cjs');

const helper = path.resolve(__dirname, '../integration/dispatch.cjs');
const worker = path.resolve(__dirname, 'fixtures/dispatch-worker.cjs');
const scale = Math.max(1, Number(process.env.AGENTRIX_TEST_TIMEOUT_SCALE) || 1);
const staleTime = new Date('2000-01-01T00:00:00Z');
const understanding = '# Task A\n\n## Roundtable understanding\n- Goal: Coordinate safely\n- Files: src/a.js\n- Provides: team state\n- Uses: minutesPage(minutes)\n- Done when: tests pass\n- Questions and risks: none\n';
const confirmation = '## Roundtable confirmation\nStatus: confirmed\n';
const summary = '### Results\n\nWorkers and tests passed.\n\n### Architecture changes\n\nNone: the agreed modules still fit.\n';
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const exists = file => sync.existsSync(file);
const output = async running => { const result = await running.finished; await delay(30); return result; };
async function until(predicate) {
  const end = Date.now() + 5000 * scale;
  while (!await predicate()) { if (Date.now() > end) throw new Error('Timed out waiting for fake dispatch'); await delay(10); }
}

async function lab(t, inGit = true) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentrix-team-')));
  const repo = path.join(directory, 'repo'), runtime = path.join(directory, 'runtime');
  await fs.mkdir(path.join(repo, 'src'), { recursive: true }); await fs.mkdir(runtime);
  await fs.writeFile(path.join(repo, 'src/a.js'), 'base\n'); await fs.writeFile(path.join(repo, 'src/b.js'), 'base\n');
  await fs.writeFile(path.join(repo, '.gitignore'), '.dispatch/\n');
  if (inGit) {
    git(repo, 'init', '-q'); git(repo, 'add', '-A');
    git(repo, '-c', 'user.email=test@example.invalid', '-c', 'user.name=Test', 'commit', '-qm', 'base');
  }
  const events = [], server = await createEventServer(event => events.push(event)), runs = [], releases = [];
  const bootstrap = path.join(runtime, 'bootstrap.json'), runner = path.join(runtime, 'runner.cjs');
  await fs.writeFile(bootstrap, JSON.stringify({ pipeName: server.address, sessionKey: 'team-test', projectId: 'project' }));
  await fs.writeFile(runner, `const {run}=require(${JSON.stringify(helper)});
process.on('message', signal => process.emit(signal));
run(process.argv.slice(2), {resolveExecutable:(_,args)=>({file:process.env.DISPATCH_MISSING || process.execPath,args:[${JSON.stringify(worker)},...args]})})
.then(code=>{process.exitCode=code;process.disconnect?.();});\n`);
  t.after(async () => {
    for (const release of releases) await fs.writeFile(release, '').catch(() => {});
    await Promise.all(runs);
    await delay(50); server.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, repo, runtime, bootstrap, runner, events, runs, releases };
}

async function start(f, { cwd = f.repo, role = 'exec', meeting, resume, allow = ['src/a.js'], skip, answer = understanding,
  edits = [], exitCode = 0, release = false, session = randomUUID(), agent = 'codex', title = 'Task A', missing = false, ledger, brief = 'Whole plan.\n' } = {}) {
  const id = randomUUID(), capture = path.join(f.runtime, id + '-capture.json'), fixture = path.join(f.runtime, id + '.json');
  const out = path.join(cwd, '.dispatch', id + '.md'), prompt = path.join(f.runtime, id + '-brief.md'), home = path.join(f.runtime, id + '-codex');
  await fs.mkdir(path.dirname(out), { recursive: true }); await fs.mkdir(home);
  await fs.writeFile(prompt, brief);
  const rollout = (await fs.readFile(path.join(__dirname, 'fixtures/codex-dispatch-rollout.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  rollout[0].payload.id = session;
  const lines = agent === 'codex'
    ? [{ record: { type: 'thread.started', thread_id: session } }, ...rollout.map(record => ({ rollout: record }))]
    : [{ record: { type: 'system', subtype: 'init', session_id: session, model: 'claude-sonnet-5-5', effort: 'high', fast_mode_state: 'off' } }];
  for (const [file, text] of edits) lines.push({ write: path.resolve(cwd, file), text });
  if (agent === 'codex') lines.push({ write: out, text: answer }, { record: { type: 'turn.completed', usage: { output_tokens: 150 } } });
  else lines.push({ record: { type: 'result', session_id: session, result: answer, usage: { output_tokens: 150 }, duration_api_ms: 1000 } });
  const releaseFile = release ? path.join(f.runtime, id + '-release') : null;
  if (releaseFile) f.releases.push(releaseFile);
  await fs.writeFile(fixture, JSON.stringify({ lines, exitCode, sessionId: session, ...(releaseFile ? { release: releaseFile } : {}) }));
  const args = [agent, '--role', role, '--title', title, '--model', agent === 'codex' ? 'gpt-6.1-sol' : 'claude-sonnet-5-5',
    '--effort', agent === 'codex' ? 'max' : 'high', '--cwd', cwd, '--brief', prompt, '--out', out,
    ...(agent === 'codex' ? ['--fast'] : ['--permission', meeting ? 'plan' : 'acceptEdits']),
    ...allow.flatMap(glob => ['--allow', glob]), ...(meeting ? ['--meeting', meeting] : []), ...(resume ? ['--resume', resume] : []),
    ...(skip ? ['--skip-meeting', skip] : []), ...(ledger ? ['--ledger', ledger] : [])];
  const env = { ...process.env, CODEX_HOME: home, AGENTRIX_BOOTSTRAP: f.bootstrap, DISPATCH_FIXTURE: fixture, DISPATCH_CAPTURE: capture };
  if (missing) env.DISPATCH_MISSING = path.join(f.runtime, 'no-such-cli');
  else delete env.DISPATCH_MISSING;
  const child = spawn(process.execPath, [f.runner, ...args], { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const finished = once(child, 'close').then(([code]) => ({ code, stdout, stderr }));
  f.runs.push(finished);
  return { child, finished, capture, out, args, env, prompt, session, releaseFile, stdout: () => stdout, release: () => fs.writeFile(releaseFile, '') };
}

function options(cwd, extra = []) {
  return argumentsOf(['codex', '--role', 'exec', '--title', 'Owner of A', '--model', 'gpt-6.1-sol', '--effort', 'max', '--fast',
    '--cwd', cwd, '--brief', 'brief.md', '--out', 'answer.md', ...extra]);
}

test('team records every role end and validates incidents and findings before consolidation writes', async t => {
  const f = await lab(t), team = projectTeam(f.repo, true), meeting = 'ledger-r1';
  for (const role of ['执行', '审查', '调查']) {
    await team.finish({ role, title: 't'.repeat(400), allow: [], agent: 'codex' }, { id: randomUUID(), session: randomUUID(), meeting,
      model: 'gpt-6.1-sol', kind: role === '审查' ? 'review' : 'core', reason: 'exit', outputTokens: 25, totalOutputTokens: 40, activeMs: 2000, answer: '', header: '' });
  }
  const ends = team.entries().filter(entry => entry.type === 'end');
  assert.deepEqual(ends.map(entry => entry.role), ['执行', '审查', '调查']);
  assert.ok(ends.every(entry => entry.title.length === 240 && entry.model === 'gpt-6.1-sol' && entry.reason === 'exit' && entry.outputTokens === 25 && entry.totalOutputTokens === 40 && entry.activeMs === 2000));
  team.append({ type: 'meeting', meeting, status: 'confirmed' });
  const incident = { model: 'gpt-6.1-sol', kind: 'test', cause: 'path assumption', fix: 'use native realpath', lead: 'missed', weight: { kind: 'test', from: 1, to: 0.5 } };
  const finding = { author: 'gpt-6.1-sol', reviewer: 'claude-opus-5-5', category: 'boundary', severity: 'high', fixed: true, title: 't'.repeat(240) };
  const before = [await fs.readFile(team.journal, 'utf8'), await fs.readFile(team.memory, 'utf8')];
  for (const records of [{ incidents: {} }, { incidents: [{ ...incident, kind: 'invalid' }] }, { incidents: [{ ...incident, lead: 'unknown' }] },
    { incidents: [{ ...incident, weight: { ...incident.weight, to: -1 } }] }, { incidents: [{ ...incident, secret: 'must not be stored' }] },
    { incidents: [incident], findings: [{ ...finding, severity: 'critical' }] }, { findings: [{ ...finding, fixed: 'yes' }] },
    { findings: [{ ...finding, category: 'other' }] }, { findings: [{ ...finding, title: 't'.repeat(241) }] },
    { incidents: [{ ...incident, cause: 't'.repeat(241) }] }, { incidents: [{ ...incident, fix: 't'.repeat(241) }] }]) {
    await assert.rejects(team.consolidate(meeting, summary, records), /incidents|findings/);
    assert.deepEqual([await fs.readFile(team.journal, 'utf8'), await fs.readFile(team.memory, 'utf8')], before);
  }
  await team.consolidate(meeting, summary, { incidents: [incident], findings: [finding] });
  const additions = team.entries().slice(-3);
  assert.deepEqual(additions.map(entry => entry.type), ['incident', 'finding', 'consolidate']);
  assert.ok(additions.every(entry => entry.meeting === meeting));
  assert.equal(additions[0].weight.to, 0.5); assert.equal(additions[1].title.length, 240); assert.equal(additions[1].fixed, true);
});

test('consolidate CLI reads optional JSON files and rejects invalid JSON without writes', async t => {
  const f = await lab(t), team = projectTeam(f.repo, true), meeting = 'ledger-cli-r1';
  team.append({ type: 'meeting', meeting, status: 'confirmed' });
  const summaryFile = path.join(f.runtime, 'summary.md'), incidents = path.join(f.runtime, 'incidents.json'), findings = path.join(f.runtime, 'findings.json');
  await fs.writeFile(summaryFile, summary); await fs.writeFile(incidents, '[]'); await fs.writeFile(findings, '{bad json');
  const args = ['consolidate', '--cwd', f.repo, '--meeting', meeting, '--summary', summaryFile, '--incidents', incidents, '--findings', findings];
  const before = [await fs.readFile(team.journal, 'utf8'), await fs.readFile(team.memory, 'utf8')];
  let stdout = '';
  assert.equal(await run(args, { stdout: { write: value => { stdout += value; } } }), 1);
  assert.match(stdout, /--findings must contain valid JSON/);
  assert.deepEqual([await fs.readFile(team.journal, 'utf8'), await fs.readFile(team.memory, 'utf8')], before);
  await fs.writeFile(findings, '[]');
  assert.equal(await run(args, { stdout: { write() {} } }), 0);
  assert.equal(team.entries().at(-1).type, 'consolidate');
});

test('consolidating a fresh repository reports missing roundtable records rather than a missing repository', async t => {
  const f = await lab(t), summaryFile = path.join(f.runtime, 'summary.md');
  await fs.writeFile(summaryFile, summary);
  let stdout = '';
  assert.equal(await run(['consolidate', '--cwd', f.repo, '--meeting', 'unknown-r1', '--summary', summaryFile],
    { stdout: { write: value => { stdout += value; } }, launch: () => assert.fail('team command launched a worker') }), 1);
  assert.match(stdout, /No roundtable records for unknown-r1/); assert.doesNotMatch(stdout, /require a git repository/);
  assert.ok(projectTeam(f.repo));
});

test('review and investigation resumed from a consolidated round do not block the next roundtable', async t => {
  const f = await lab(t), team = projectTeam(f.repo, true);
  for (const role of ['审查', '调查']) {
    const meeting = role === '审查' ? 'review-r1' : 'investigate-r1', session = randomUUID(), id = randomUUID();
    team.append({ type: 'meeting', meeting, session, agent: 'codex', role, allow: [], status: 'confirmed' });
    await team.consolidate(meeting, summary);
    const resumed = { ...options(f.repo), role, allow: [], resume: session };
    const admission = await team.admit(resumed, id);
    assert.equal(admission.meeting, meeting);
    await team.finish(resumed, { ...admission, id, session, answer: '', header: '', reason: 'exit', kind: role === '审查' ? 'review' : 'investigate' });
    team.release(id);
    assert.equal(team.entries().at(-1).meeting, meeting, 'the end remains recorded with its originating round');
    const next = randomUUID();
    await team.admit(options(f.repo, ['--meeting', meeting + '-next', '--allow', 'src/a.js']), next);
    team.release(next);
  }
});

function load(file, replacements = {}, globals = {}) {
  const loaded = { exports: {} }, localRequire = createRequire(file);
  vm.runInNewContext(sync.readFileSync(file, 'utf8'), {
    module: loaded, exports: loaded.exports, require: name => Object.hasOwn(replacements, name) ? replacements[name] : localRequire(name),
    __dirname: path.dirname(file), __filename: file, process, Buffer, setTimeout, clearTimeout, setInterval, clearInterval, ...globals,
  }, { filename: file });
  return loaded.exports;
}

async function invoke(prepared, extra = {}) {
  let stdout = '';
  const code = await run(prepared.args, { env: prepared.env, stdout: { write: text => { stdout += text; } },
    resolveExecutable: (_, args) => ({ file: process.execPath, args: [worker, ...args] }), ...extra });
  return { code, stdout };
}

test('team options reject ambiguity and never leak helper flags into CLI argv', () => {
  const base = options(os.tmpdir(), ['--meeting', 'round.1-foo', '--allow', 'src/**']);
  assert.equal(base.meeting, 'round.1-foo');
  assert.ok(!commandOf(base).includes('--meeting'));
  for (const flags of [
    ['--meeting', '../bad', '--allow', 'src/**'], ['--meeting', 'x', '--read-only', '--allow', 'src/**'],
    ['--meeting', 'x'], ['--skip-meeting', 'reason'], ['--allow', 'src/**', '--skip-meeting', ' '],
    ['--meeting', 'x', '--allow', 'src/**', '--skip-meeting', 'reason'],
    ['--meeting', 'x', '--meeting', 'y', '--allow', 'src/**'], ['--fast'],
  ]) assert.throws(() => options(os.tmpdir(), flags));
  assert.throws(() => argumentsOf(['minutes', '--cwd', '.', '--meeting', 'x', '--out', 'm.md', '--language', 'fr']));
  assert.throws(() => argumentsOf(['consolidate', '--cwd', '.', '--meeting', 'x', '--summary', 's.md', '--out', 'm.md']));
});

test('understanding and confirmation parsing require complete blocks', () => {
  assert.equal(understandingOf(understanding).status, 'understood');
  assert.deepEqual(understandingOf(understanding).understanding, {
    goal: 'Coordinate safely', files: 'src/a.js', provides: 'team state', uses: 'minutesPage(minutes)', doneWhen: 'tests pass', questions: 'none',
  });
  for (const answer of ['', understanding.replace('- Uses: minutesPage(minutes)\n', ''), understanding.replace('- Uses: minutesPage(minutes)', '- Uses: '),
    understanding + '- Goal: duplicate\n', understanding + '\n## Another section\nNo.\n',
    understanding.replace('- Uses: minutesPage(minutes)', '- Uses:\n  \t'),
    understanding.replace('- Goal:', 'orphan before fields\n- Goal:')]) assert.equal(understandingOf(answer).status, 'incomplete');
  assert.equal(confirmationOf(confirmation).status, 'confirmed');
  for (const answer of ['', 'Status: confirmed', confirmation + '- still unresolved', '## Roundtable confirmation\nStatus: yes']) assert.equal(confirmationOf(answer).status, 'open');
  assert.deepEqual(confirmationOf('## Roundtable confirmation\nStatus: open\n- Answer my question.\n').confirmation.questions, ['Answer my question.']);
  assert.equal(understandingOf(understanding + '\n' + understanding.replace('Coordinate safely', 'Latest goal')).understanding.goal, 'Latest goal');
  assert.equal(understandingOf(understanding + '\n## Roundtable understanding\n- Goal: incomplete').status, 'incomplete');
  assert.equal(confirmationOf(confirmation + '\n## Roundtable confirmation\nStatus: open\n- Latest question.').status, 'open');
  assert.equal(confirmationOf('## Roundtable confirmation\nStatus: open\n- Old question.\n\n' + confirmation).status, 'confirmed');
});

test('understanding fields accept continuations and preserve them in the minutes', () => {
  const answer = understanding.replace('Goal: Coordinate safely', 'Goal: Coordinate safely\nand report findings')
    .replace('Files: src/a.js', 'Files: src/a.js\n  src/b.js')
    .replace('Uses: minutesPage(minutes)', 'Uses:\n  - first dependency\n  - second dependency')
    .replace('Questions and risks: none', 'Questions and risks: none\n- Other: follow-up');
  const parsed = understandingOf(answer.replace(/\n/g, '\r\n'));
  assert.equal(parsed.status, 'understood');
  assert.equal(parsed.understanding.goal, 'Coordinate safely\nand report findings');
  assert.equal(parsed.understanding.files, 'src/a.js\n  src/b.js');
  assert.equal(parsed.understanding.uses, '- first dependency\n  - second dependency');
  assert.equal(parsed.understanding.questions, 'none\n- Other: follow-up');
  const minutes = { meeting: 'r1', round: 1, generatedAt: 0, language: 'en', issues: [],
    rows: [{ who: 'Terra', title: 'Task', ...parsed.understanding, status: parsed.status }] };
  const md = minutesMarkdown(minutes), html = minutesPage(minutes);
  assert.match(md, /Coordinate safely<br>and report findings/);
  assert.match(md, /src\/a\.js<br>  src\/b\.js/);
  assert.match(html, /Coordinate safely\nand report findings/);
  assert.match(html, /src\/<wbr>a\.js<\/span><span class="file">src\/<wbr>b\.js/);
});

test('understanding rejects placeholder-only fields and trailing sections', () => {
  for (const line of understanding.split('\n').filter(line => line.startsWith('- '))) {
    const placeholder = line.slice(0, line.indexOf(':') + 1) + ' \u2026';
    assert.equal(understandingOf(understanding.replace(line, placeholder)).status, 'incomplete', line);
  }
  assert.equal(understandingOf(understanding.replace('Goal: Coordinate safely', 'Goal: \u2026\n  Further detail')).status, 'understood');
  for (const section of ['# End', '## Another section', '### Appendix', '#include']) {
    assert.equal(understandingOf(understanding + '\n' + section + '\nNo.').status, 'incomplete', section);
  }
  assert.equal(understandingOf(understanding + '\n  # indented continuation').status, 'understood');
});

test('worktrees share team state and outside git the helper behaves as before', async t => {
  const f = await lab(t), second = path.join(f.directory, 'second');
  git(f.repo, 'worktree', 'add', '--detach', second, 'HEAD');
  const team = projectTeam(f.repo, true), peer = projectTeam(second, true);
  assert.equal(team.directory, peer.directory);
  await fs.writeFile(team.memory, 'Shared decision.\n');
  assert.equal(await fs.readFile(peer.memory, 'utf8'), 'Shared decision.\n');
  assert.ok(team.directory.endsWith(path.join('.git', 'agentrix')));
  assert.equal(projectTeam(f.runtime, true), null);
  const plain = await start(f, { cwd: f.runtime, edits: [['a.js', 'outside git']] });
  const result = await output(plain), captured = await json(plain.capture);
  assert.equal(result.code, 0); assert.match(result.stdout, /scope unchecked/); assert.doesNotMatch(result.stdout, / · roundtable /);
  assert.equal(captured.brief, briefOf({ cwd: f.runtime, allow: ['src/a.js'] }, Buffer.from('Whole plan.\n')).toString());
  assert.doesNotMatch(captured.brief, /# Project memory|# Working now|# Roundtable before work/);
  assert.match(briefOf({ cwd: f.runtime, allow: [] }, Buffer.from('plain')).toString(), /## Skill proposals[\s\S]*plain$/);
});

test('overlap checks tracked and untracked files and identical future globs across worktrees', async t => {
  const f = await lab(t), second = path.join(f.directory, 'second');
  git(f.repo, 'worktree', 'add', '--detach', second, 'HEAD');
  const team = projectTeam(f.repo, true), peer = projectTeam(second, true), id = randomUUID();
  await team.admit(options(f.repo, ['--allow', 'src/a.*', '--skip-meeting', 'test']), id);
  await assert.rejects(peer.admit(options(second, ['--allow', 'src/*.js', '--skip-meeting', 'test']), randomUUID()), /Owner of A.*src\/a.js/);
  const separate = randomUUID();
  await peer.admit(options(second, ['--allow', 'src/b.js', '--skip-meeting', 'test']), separate);
  peer.release(separate); team.release(id);
  await fs.mkdir(path.join(second, 'notes'));
  await fs.writeFile(path.join(second, 'notes/new.md'), 'new');
  await team.admit(options(f.repo, ['--allow', 'notes/**', '--skip-meeting', 'test']), id);
  await assert.rejects(peer.admit(options(second, ['--allow', '**/*.md', '--skip-meeting', 'test']), randomUUID()), /notes\/new.md/);
  team.release(id);
  await team.admit(options(f.repo, ['--allow', 'future/**', '--skip-meeting', 'test']), id);
  await assert.rejects(peer.admit(options(second, ['--allow', 'future/**', '--skip-meeting', 'test']), randomUUID()), /future\/\*\*/);
  team.release(id);
});

test('simultaneous helpers serialize overlap admission and retain the helper pid', async t => {
  const f = await lab(t), team = projectTeam(f.repo, true);
  const runs = await Promise.all([start(f, { skip: 'concurrent test', release: true, title: 'First' }), start(f, { skip: 'concurrent test', release: true, title: 'Second' })]);
  await until(() => runs.some(item => /started /.test(item.stdout())) && runs.some(item => /failed to start /.test(item.stdout())));
  const active = runs.find(item => /\[dispatch\] started /.test(item.stdout())), rejected = runs.find(item => item !== active);
  assert.match((await output(rejected)).stdout, /Scope overlaps/);
  const entries = team.live();
  assert.equal(entries.length, 1); assert.equal(entries[0].pid, active.child.pid);
  assert.notEqual(entries[0].pid, (await json(active.capture)).pid, 'the board names the helper, not its worker');
  await active.release(); assert.equal((await output(active)).code, 0);
  assert.deepEqual(team.live(), []);
  assert.equal(exists(path.join(team.directory, 'lock')), false);
});

test('dead board entries and stale locks are removed while a live lock is respected', async t => {
  const f = await lab(t), team = projectTeam(f.repo, true);
  const dead = spawn(process.execPath, ['-e', ''], { windowsHide: true }); await once(dead, 'close');
  await fs.writeFile(path.join(team.board, 'dead.json'), JSON.stringify({ pid: dead.pid, allow: ['src/**'] }));
  const lock = path.join(team.directory, 'lock'); await fs.writeFile(lock, 'stale');
  await fs.utimes(lock, staleTime, staleTime);
  const id = randomUUID(); await team.admit(options(f.repo, ['--allow', 'src/a.js', '--skip-meeting', 'test']), id);
  assert.equal(exists(path.join(team.board, 'dead.json')), false); team.release(id);
  sync.writeFileSync(lock, 'held');
  let entered = false, observed;
  const checked = new Promise(resolve => { observed = resolve; }), stat = sync.statSync;
  const intercepted = t.mock.method(sync, 'statSync', function (file, ...args) {
    const result = stat.call(this, file, ...args);
    if (file === lock) observed();
    return result;
  });
  const pending = team.locked(() => { entered = true; });
  try {
    await Promise.race([checked, pending.then(() => { throw new Error('Lock was not respected'); })]);
    assert.equal(entered, false);
    sync.unlinkSync(lock); await pending; assert.equal(entered, true);
  } finally {
    intercepted.mock.restore();
    await fs.rm(lock, { force: true }); await pending.catch(() => {});
  }
});

test('execution requires a confirmed resumed session and the same scope set', async t => {
  const f = await lab(t), team = projectTeam(f.repo, true), session = randomUUID(), allow = ['src/a.js', 'src/b.js'];
  const absent = await start(f);
  const refused = await output(absent);
  assert.equal(refused.code, 1); assert.match(refused.stdout, /no meeting for the session.*--skip-meeting/); assert.equal(exists(absent.capture), false);
  await until(() => f.events.length >= 2);
  assert.deepEqual(f.events.slice(0, 2).map(event => [event.type, event.unconfirmed || event.reason]), [['dispatch-start', true], ['dispatch-end', 'unconfirmed']]);
  const answer = understanding.replace('Files: src/a.js', 'Files: src/a.js\n  src/b.js');
  const first = await start(f, { meeting: 'r1', session, allow, answer });
  assert.match((await output(first)).stdout, /roundtable r1 · understanding complete/);
  assert.equal(team.entries().at(-1).status, 'understood');
  assert.equal(team.entries().at(-1).understanding.files, 'src/a.js\n  src/b.js');
  const meetingEnd = team.entries().find(entry => entry.type === 'end' && entry.role === '圆桌');
  assert.equal(meetingEnd.kind, 'roundtable'); assert.equal(meetingEnd.reason, 'exit'); assert.equal(meetingEnd.model, 'gpt-6.1-sol');
  assert.match((await json(first.capture)).brief, /fields may continue on following lines/);
  const notConfirmed = await start(f, { resume: session, allow });
  assert.match((await output(notConfirmed)).stdout, /roundtable not confirmed/);
  const confirm = await start(f, { meeting: 'r1', resume: session, session, allow, answer: confirmation });
  assert.match((await output(confirm)).stdout, /roundtable r1 · confirmed/);
  const captured = await json(confirm.capture);
  assert.match(captured.brief, /# Roundtable before work[\s\S]*other workers[\s\S]*## Roundtable confirmation/);
  assert.deepEqual(captured.args.slice(0, 3), ['exec', 'resume', session]); assert.ok(!captured.args.includes('-s'));
  const differs = await start(f, { resume: session, allow: ['src/a.js'] });
  assert.match((await output(differs)).stdout, /scope differs from the one agreed/); assert.equal(exists(differs.capture), false);
  const build = await start(f, { resume: session, session, allow: ['src/b.js', 'src/a.js', 'src/a.js'], answer: 'Built.' });
  assert.equal((await output(build)).code, 0);
  assert.deepEqual(team.entries().at(-1).meeting, 'r1'); assert.equal(team.entries().at(-1).type, 'end');
  await until(() => f.events.some(event => event.role === '圆桌'));
  assert.deepEqual(team.live(), []);
});

test('skip reasons are printed and journaled while investigation and review bypass execution gates', async t => {
  const f = await lab(t), team = projectTeam(f.repo, true);
  const skipped = await start(f, { skip: 'isolated regression fixture' }), result = await output(skipped);
  assert.equal(result.code, 0); assert.match(result.stdout.split('\n')[0], /roundtable skipped: isolated regression fixture/);
  assert.equal(team.entries().find(entry => entry.type === 'skip').reason, 'isolated regression fixture');
  const id = randomUUID(); await team.admit(options(f.repo, ['--allow', 'src/**', '--skip-meeting', 'test']), id);
  for (const role of ['investigate', 'review']) {
    const read = await start(f, { role, answer: 'Read.' });
    assert.equal((await output(read)).code, 0);
    const meeting = await start(f, { role, meeting: role + '-meeting', allow: [], answer: understanding });
    assert.match((await output(meeting)).stdout, /understanding complete/);
  }
  const overlappingMeeting = await start(f, { meeting: 'exec-meeting' });
  assert.match((await output(overlappingMeeting)).stdout, /Scope overlaps/);
  team.release(id);
});

test('failed meetings are invalid even when the answer confirms', async t => {
  const f = await lab(t), team = projectTeam(f.repo, true), session = randomUUID();
  await output(await start(f, { meeting: 'r1', session }));
  await output(await start(f, { meeting: 'r1', session, resume: session, answer: confirmation, exitCode: 7 }));
  assert.equal(team.entries().at(-1).status, 'invalid');
  const refused = await start(f, { resume: session });
  assert.match((await output(refused)).stdout, /roundtable not confirmed/); assert.equal(exists(refused.capture), false);
  const retry = await start(f, { meeting: 'r1', session, resume: session, answer: '## Roundtable confirmation\nStatus: open\n- Clarify ownership.\n' });
  assert.match((await output(retry)).stdout, /roundtable r1 · open/);
  const invalid = await start(f, { meeting: 'r2', answer: understanding, exitCode: 2 });
  await output(invalid); assert.equal(team.entries().at(-1).status, 'invalid');
  const repeat = await start(f, { meeting: 'r2', session: invalid.session, resume: invalid.session });
  await output(repeat);
  assert.match((await json(repeat.capture)).brief, /ending with exactly this block[\s\S]*## Roundtable understanding/);
  assert.equal(team.entries().at(-1).status, 'understood');
});

test('meetings reject every working-tree change including agreed files', async t => {
  const f = await lab(t), team = projectTeam(f.repo, true);
  await fs.writeFile(path.join(f.repo, 'src/b.js'), 'already dirty\n');
  const clean = await start(f, { meeting: 'r1' });
  assert.match((await output(clean)).stdout, /scope ok/);
  const edit = await start(f, { meeting: 'r1', edits: [['src/a.js', 'changed agreed file'], ['new.txt', 'new file']] });
  const result = await output(edit);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /reason scope · OUT OF SCOPE: new.txt, src\/a.js/);
  assert.equal(team.entries().at(-1).status, 'invalid');
  const review = await start(f, { meeting: 'r1', role: 'review', allow: [], edits: [['src/b.js', 'changed during review meeting']] });
  assert.match((await output(review)).stdout, /reason scope · OUT OF SCOPE: src\/b.js/);
  assert.deepEqual(team.live(), []);
});

test('new meetings wait for consolidation and round numbers follow first appearance', async t => {
  const f = await lab(t), team = projectTeam(f.repo, true), session = randomUUID();
  await output(await start(f, { meeting: 'z-last-alphabetically', session }));
  await output(await start(f, { meeting: 'z-last-alphabetically', resume: session, session, answer: confirmation }));
  await output(await start(f, { resume: session, session, answer: 'Built.' }));
  const next = await start(f, { meeting: 'a-first-alphabetically' });
  assert.match((await output(next)).stdout, /z-last-alphabetically is not consolidated.*dispatch.cjs" consolidate.*--summary/);
  assert.ok((await output(next)).stdout.includes('node "' + helper + '" consolidate'));
  assert.equal(exists(next.capture), false);
  const existing = await start(f, { meeting: 'z-last-alphabetically' });
  assert.equal((await output(existing)).code, 0);
  const review = await start(f, { role: 'review', allow: [] });
  assert.equal((await output(review)).code, 0);
  await team.consolidate('z-last-alphabetically', summary);
  const allowed = await start(f, { meeting: 'a-first-alphabetically' });
  assert.equal((await output(allowed)).code, 0);
  assert.equal(team.minutes('z-last-alphabetically').round, 1); assert.equal(team.minutes('a-first-alphabetically').round, 2);
});

test('a meeting loses approval when its working tree can no longer be checked', async t => {
  const f = await lab(t), second = path.join(f.directory, 'second'), team = projectTeam(f.repo, true);
  git(f.repo, 'worktree', 'add', '--detach', second, 'HEAD');
  const meeting = await start(f, { cwd: second, meeting: 'r1', edits: [['.git', 'broken worktree reference\n']] });
  const result = await output(meeting);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /reason error.*understanding incomplete/);
  assert.equal(team.entries().at(-1).status, 'invalid'); assert.deepEqual(team.live(), []);
});

test('board entries leave on failed spawn and interruption', async t => {
  const f = await lab(t), team = projectTeam(f.repo, true);
  const failed = await start(f, { meeting: 'r1', missing: true });
  assert.match((await output(failed)).stdout, /failed to start .*ENOENT/);
  assert.deepEqual(team.live(), []); assert.equal(team.entries().at(-1).status, 'invalid');
  const active = await start(f, { meeting: 'r1', release: true });
  await until(() => /\[dispatch\] started /.test(active.stdout()));
  assert.equal(team.live().length, 1);
  active.child.send('SIGTERM');
  assert.match((await output(active)).stdout, /reason killed/);
  assert.deepEqual(team.live(), []); assert.equal(team.entries().at(-1).status, 'invalid');
});

test('briefs inject ledger first then recent memory live peers and bounded repository context', async t => {
  const f = await lab(t), team = projectTeam(f.repo, true), id = randomUUID();
  const ledger = path.join(f.runtime, 'ledger.md'); await fs.writeFile(ledger, 'The owner chose cents.\n');
  await fs.writeFile(team.memory, 'Old preface.\n## Round 1 · old\nobsolete\n## Round 2 · middle\nmiddle decision\n## Round 3 · new\nnew decision\n### Findings\nlatest finding\n');
  await team.admit(options(f.repo, ['--allow', 'src/b.js', '--skip-meeting', 'test']), id);
  for (let n = 0; n < 45; n++) await fs.writeFile(path.join(f.repo, `dirty-${String(n).padStart(2, '0')}.txt`), 'dirty');
  const text = briefOf({ cwd: f.repo, allow: ['src/a.js'], ledger }, Buffer.from('Actual task.'), team).toString();
  assert.ok(text.indexOf('# Shared context') < text.indexOf('# Project memory'));
  assert.ok(text.indexOf('# Project memory') < text.indexOf('# Working now'));
  assert.ok(text.indexOf('# Working now') < text.indexOf('# Repository'));
  assert.ok(text.indexOf('# Repository') < text.indexOf('# Files you may change'));
  assert.match(text, /middle decision[\s\S]*new decision[\s\S]*latest finding/); assert.doesNotMatch(text, /obsolete|Old preface/);
  assert.ok(text.includes(team.memory)); assert.match(text, /Owner of A \(codex gpt-6.1-sol, 执行\): src\/b.js/);
  assert.match(text, /… and 5 more/); assert.match(text, /[a-f0-9]+ base/);
  assert.match(text, /## Findings for the ledger/); assert.match(text, /# Task\n\nActual task\.$/);
  const noLedger = briefOf({ cwd: f.repo, allow: [] }, Buffer.from('Read.'), team).toString();
  assert.match(noLedger, /# Handing back/);
  team.release(id);
  const excerpt = memoryExcerpt('## Round 1\nold\n## Round 2\n' + '汉字'.repeat(15000) + '\n## Round 3\n最新 finding\n');
  assert.ok(Buffer.byteLength(excerpt) <= 24 * 1024); assert.ok(excerpt.startsWith('…\n')); assert.ok(excerpt.endsWith('最新 finding'));
  assert.ok(!excerpt.includes('\uFFFD'));
});

test('findings always reach memory and also reach an explicit ledger', async t => {
  const f = await lab(t), team = projectTeam(f.repo, true), answer = 'Done.\n\n## Findings for the ledger\n\n- Shares a decision.\n';
  const plain = await start(f, { skip: 'findings fixture', answer });
  await output(plain);
  assert.match(await fs.readFile(team.memory, 'utf8'), /Shares a decision/);
  const ledger = path.join(f.repo, 'ledger.md');
  await fs.writeFile(ledger, '# Ledger\n');
  await output(await start(f, { skip: 'ledger write-back fixture', answer: answer.replace('a decision', 'another decision'), ledger }));
  assert.match(await fs.readFile(ledger, 'utf8'), /Shares another decision/);
  assert.match(await fs.readFile(team.memory, 'utf8'), /Shares another decision/);
  // The public write-back function is the same one used under the team's journal lock.
  const { recordFindings } = require('../integration/dispatch.cjs');
  assert.equal(recordFindings({ memory: team.memory, ledger }, answer, 'Both destinations'), true);
  assert.match(await fs.readFile(ledger, 'utf8'), /Both destinations[\s\S]*Shares a decision/);
  assert.match(await fs.readFile(team.memory, 'utf8'), /Both destinations[\s\S]*Shares a decision/);
  const before = await fs.readFile(team.memory, 'utf8');
  recordFindings({ memory: team.memory, ledger: team.memory }, answer, 'Once only');
  assert.equal((await fs.readFile(team.memory, 'utf8')).slice(before.length).split('Once only').length, 2);
});

test('minutes write two escaped Markdown tables and the HTML companion without a worker', async t => {
  const f = await lab(t), team = projectTeam(f.repo, true), session = randomUUID();
  const entry = { type: 'meeting', meeting: 'r1', session, agent: 'codex', model: 'gpt-6.1-sol', role: '执行', title: 'Task | <script>unsafe</script>',
    allow: ['src/a.js'], ...understandingOf(understanding), status: 'understood' };
  team.append(entry); team.append({ ...entry, understanding: undefined, confirmation: { status: 'confirmed' }, title: 'Confirm minutes', status: 'confirmed' });
  team.append({ ...entry, session: randomUUID(), title: 'Failed task', status: 'invalid' });
  const issues = path.join(f.runtime, 'issues.json');
  await fs.writeFile(issues, JSON.stringify([{ issue: 'a | b', raisedBy: 'Sol', answer: '<b>literal</b>', result: 'resolved' }]));
  const out = path.join(f.runtime, 'minutes.md');
  let stdout = '';
  const code = await run(['minutes', '--cwd', f.repo, '--meeting', 'r1', '--out', out, '--issues', issues, '--language', 'en'],
    { stdout: { write: text => { stdout += text; } }, launch: () => assert.fail('minutes launched a worker') });
  assert.equal(code, 0, stdout);
  const md = await fs.readFile(out, 'utf8'), html = await fs.readFile(path.join(f.runtime, 'minutes.html'), 'utf8');
  assert.equal((md.match(/^\| (?:--- \| ?)+$/gm) || []).length, 2);
  assert.match(md, /\| Worker \| Task \|/); assert.match(md, /\*\*Task \\\| &lt;script&gt;unsafe&lt;\/script&gt;\*\*<br>Coordinate safely/);
  assert.doesNotMatch(md, /Confirm minutes|<script>/); assert.match(md, /Confirmed 1 of 2/); assert.match(md, /\| gpt-6\.1-sol · 执行 \|/); assert.match(md, /✖ Incomplete/);
  assert.match(html, /^<!doctype html>/i); assert.ok(html.includes('Coordinate safely')); assert.ok(!html.includes('<script>unsafe'));
  const data = team.minutes('r1');
  assert.equal(data.rows.length, 2); assert.equal(data.rows[0].title, entry.title); assert.equal(data.rows[0].status, 'confirmed');
  assert.equal(data.rows[1].status, 'invalid'); assert.equal(data.language, 'zh'); assert.equal(typeof data.generatedAt, 'number');
  assert.match(minutesMarkdown(data), /\| 子模型 \| 任务 \|/);
  assert.match(minutesMarkdown({ ...data, issues: [] }), /\| 分歧或疑问 \| 谁提出 \| 主模型的答复 \| 结果 \|/);
});

test('team subcommand errors are one line and never launch a worker', async t => {
  const f = await lab(t), team = projectTeam(f.repo, true);
  team.append({ type: 'meeting', meeting: 'r1', session: 's', agent: 'codex', model: 'm', title: 'T', allow: [], ...understandingOf(understanding) });
  const issues = path.join(f.runtime, 'bad-issues.json'); await fs.writeFile(issues, '{"not":"an array"}');
  for (const args of [
    ['minutes', '--cwd', f.repo, '--meeting', 'r1', '--out', path.join(f.runtime, 'm.md'), '--issues', issues],
    ['minutes', '--cwd', f.repo, '--meeting', 'missing', '--out', path.join(f.runtime, 'm.md')],
    ['minutes', '--cwd', f.repo, '--meeting', 'r1', '--out', path.join(f.runtime, 'm.md'), '--unknown', 'x'],
    ['minutes', '--cwd', f.runtime, '--meeting', 'r1', '--out', path.join(f.runtime, 'm.md')],
    ['consolidate', '--cwd', f.repo, '--meeting', 'r1', '--summary', 'missing.md'],
  ]) {
    let stdout = '';
    assert.equal(await run(args, { stdout: { write: text => { stdout += text; } }, launch: () => assert.fail('subcommand launched a worker') }), 1);
    assert.match(stdout, /^\[dispatch\] [^\r\n]+\n$/);
  }
});

test('consolidation validates headings before appending memory and journal', async t => {
  const f = await lab(t), team = projectTeam(f.repo, true);
  team.append({ type: 'meeting', meeting: 'r1', session: 's', agent: 'codex', model: 'm', title: 'T', allow: [], ...understandingOf(understanding) });
  const before = team.entries().length;
  for (const invalid of ['Done.', '### Results\nFine.', '### Architecture changes\nNone.']) {
    await assert.rejects(team.consolidate('r1', invalid), /Results.*Architecture changes/);
  }
  assert.equal(team.entries().length, before); assert.equal(await fs.readFile(team.memory, 'utf8'), '');
  const file = path.join(f.runtime, 'summary.md'); await fs.writeFile(file, summary);
  let stdout = '';
  assert.equal(await run(['consolidate', '--cwd', f.repo, '--meeting', 'r1', '--summary', file],
    { stdout: { write: text => { stdout += text; } }, launch: () => assert.fail('consolidate launched a worker') }), 0, stdout);
  assert.match(await fs.readFile(team.memory, 'utf8'), /## Round 1 · r1 · \d{4}-\d\d-\d\d \d\d:\d\d[\s\S]*### Results[\s\S]*### Architecture changes/);
  assert.equal(team.entries().at(-1).type, 'consolidate'); assert.equal(team.entries().at(-1).meeting, 'r1');
});

test('Claude meetings use plan then acceptEdits on the resumed build', async t => {
  const f = await lab(t), session = randomUUID();
  const first = await start(f, { agent: 'claude', meeting: 'r1', session });
  assert.equal((await output(first)).code, 0);
  assert.ok((await json(first.capture)).args.includes('plan'));
  const confirm = await start(f, { agent: 'claude', meeting: 'r1', session, resume: session, answer: confirmation });
  assert.match((await output(confirm)).stdout, / · confirmed/);
  const build = await start(f, { agent: 'claude', session, resume: session, answer: 'Built.' });
  assert.equal((await output(build)).code, 0);
  const args = (await json(build.capture)).args;
  assert.deepEqual(args.slice(0, 3), ['-p', '--resume', session]); assert.ok(args.includes('acceptEdits'));
});

test('meeting lifecycle keeps consolidated ids closed even after late ends', async t => {
  const f = await lab(t), team = projectTeam(f.repo, true), session = randomUUID();
  const entry = { type: 'meeting', meeting: 'r1', session, agent: 'codex', model: 'gpt-6.1-sol', role: '执行', title: 'Task A',
    allow: ['src/a.js'], ...understandingOf(understanding), status: 'confirmed' };
  team.append(entry);
  team.append({ ...entry, meeting: 'already-seen-r2', session: randomUUID(), status: 'understood' });
  team.append({ type: 'end', id: 'build', meeting: 'r1', session });
  const reused = await start(f, { meeting: 'already-seen-r2', allow: ['src/b.js'] });
  const refusal = await output(reused);
  assert.equal(refusal.code, 1); assert.equal(exists(reused.capture), false);
  assert.ok(refusal.stdout.includes('node "' + helper + '" consolidate'));
  const active = randomUUID();
  await team.admit(options(f.repo, ['--meeting', 'r1', '--allow', 'src/a.js']), active, helper);
  const before = await fs.readFile(team.memory, 'utf8'), count = team.entries().length;
  await assert.rejects(team.consolidate('r1', summary), /still has live workers/);
  assert.equal(await fs.readFile(team.memory, 'utf8'), before); assert.equal(team.entries().length, count);
  team.release(active); await team.consolidate('r1', summary);
  await assert.rejects(team.admit(options(f.repo, ['--meeting', 'r1', '--allow', 'src/a.js']), randomUUID(), helper), /closed.*new --meeting/);
  await assert.rejects(team.admit(options(f.repo, ['--resume', session, '--allow', 'src/a.js']), randomUUID(), helper), /closed.*--meeting <id>.*--resume.*--skip-meeting.*--help/);
  team.append({ type: 'end', id: 'late-build', meeting: 'r1', session });
  const next = randomUUID();
  await team.admit(options(f.repo, ['--meeting', 'already-seen-r2', '--allow', 'src/b.js']), next, helper);
  team.release(next);
});

test('roundtables outside git are refused before any worker launches', async t => {
  const f = await lab(t);
  const meeting = await start(f, { cwd: f.runtime, meeting: 'r1' }), result = await output(meeting);
  assert.equal(result.code, 1); assert.match(result.stdout, /roundtables need a git repository/);
  assert.equal(exists(meeting.capture), false); assert.equal(projectTeam(f.runtime), null);
});

test('admission brief snapshot and log-open signals prevent launch', async t => {
  const f = await lab(t), prepared = await start(f, { skip: 'signal regression' });
  await output(prepared);
  const team = projectTeam(f.repo), proto = Object.getPrototypeOf(team), admit = proto.admit;
  const read = sync.readFileSync, stream = sync.createWriteStream;
  const dirty = path.join(f.repo, 'src/a.js'); await fs.writeFile(dirty, 'dirty before snapshot\n');
  for (const phase of ['admission', 'brief', 'snapshot', 'log']) {
    let sent = false, calls = 0;
    const send = () => { if (!sent) { sent = true; process.emit(phase === 'brief' ? 'SIGINT' : 'SIGTERM'); } };
    let mocked;
    if (phase === 'admission') mocked = t.mock.method(proto, 'admit', async function (...args) { const value = await admit.apply(this, args); send(); return value; });
    else if (phase === 'log') mocked = t.mock.method(sync, 'createWriteStream', function (...args) { const value = stream.apply(this, args); queueMicrotask(send); return value; });
    else mocked = t.mock.method(sync, 'readFileSync', function (file, ...args) {
      const value = read.call(this, file, ...args);
      if (String(file) === (phase === 'brief' ? prepared.prompt : dirty)) send();
      return value;
    });
    try {
      const result = await invoke(prepared, { launch: () => { calls++; assert.fail('cancelled admission launched a worker'); } });
      assert.equal(sent, true, phase); assert.equal(calls, 0, phase); assert.equal(result.code, 1, phase);
      assert.match(result.stdout, /interrupted before launch/); assert.deepEqual(team.live(), []);
    } finally { mocked.mock.restore(); }
  }
});

test('a signal between the launch check and spawn stops the new worker', async t => {
  const f = await lab(t), prepared = await start(f, { skip: 'spawn signal regression' });
  await output(prepared);
  let pid;
  const result = await invoke(prepared, { launch: (file, args, config) => {
    process.emit('SIGTERM');
    const child = spawn(file, args, config); pid = child.pid; return child;
  } });
  assert.ok(pid); assert.match(result.stdout, /reason (?:killed|unconfirmed)/);
  assert.throws(() => process.kill(pid, 0));
  assert.deepEqual(projectTeam(f.repo).live(), []);
});

test('bookkeeping failures preserve worker results and never retry findings', async t => {
  const f = await lab(t), ledger = path.join(f.repo, 'ledger.md');
  await fs.writeFile(ledger, '# Ledger\n');
  const prepared = await start(f, { skip: 'bookkeeping regression', ledger, answer: 'Done.\n\n## Findings for the ledger\n\n- Once per result.\n' });
  await output(prepared);
  const team = projectTeam(f.repo), proto = Object.getPrototypeOf(team), append = proto.append, finish = proto.finish;
  await fs.writeFile(team.memory, ''); await fs.writeFile(ledger, '# Ledger\n');
  let calls = 0;
  const failure = t.mock.method(proto, 'append', function (entry) {
    if (entry.type === 'end') throw new Error('journal append failed');
    return append.call(this, entry);
  });
  const attempted = t.mock.method(proto, 'finish', function (...args) { calls++; return finish.apply(this, args); });
  try {
    const result = await invoke(prepared);
    assert.equal(result.code, 0); assert.match(result.stdout, /exit 0 reason exit.*WARNING: team bookkeeping failed: journal append failed/);
    assert.equal(calls, 1);
    for (const file of [team.memory, ledger]) assert.equal((await fs.readFile(file, 'utf8')).split('Once per result.').length, 2);
  } finally { attempted.mock.restore(); failure.mock.restore(); }
  const busy = t.mock.method(proto, 'finish', async () => { throw new Error('Team admission lock is busy'); });
  try {
    const result = await invoke(prepared);
    assert.equal(result.code, 0); assert.match(result.stdout, /exit 0 reason exit.*WARNING: team bookkeeping failed: Team admission lock is busy/);
    assert.deepEqual(team.live(), []);
  } finally { busy.mock.restore(); }
});

test('gate refusals explain starting a roundtable and expose occupying board records', async t => {
  const f = await lab(t), team = projectTeam(f.repo, true), id = randomUUID();
  await assert.rejects(team.admit(options(f.repo, ['--allow', 'src/a.js']), randomUUID(), helper),
    /--meeting <id> \(same --allow\).*--resume.*--skip-meeting <reason>.*--help/);
  await team.admit(options(f.repo, ['--allow', 'src/a.js', '--skip-meeting', 'ghost diagnostic']), id, helper);
  await assert.rejects(team.admit(options(f.repo, ['--allow', 'src/**', '--skip-meeting', 'test']), randomUUID(), helper), error => {
    assert.ok(error.message.includes('pid ' + process.pid)); assert.ok(error.message.includes(path.join(team.board, id + '.json')));
    return true;
  });
  team.release(id);
});

test('a fresh replacement lock survives stale-lock removal', async t => {
  const f = await lab(t), team = projectTeam(f.repo, true), file = path.join(team.directory, 'lock');
  await fs.writeFile(file, 'old'); await fs.utimes(file, staleTime, staleTime);
  const rename = sync.renameSync, stat = sync.statSync;
  let replaced = false, entered = false, observed;
  const checked = new Promise(resolve => { observed = resolve; });
  const intercepted = t.mock.method(sync, 'renameSync', function (from, to) {
    rename.call(this, from, to);
    if (from === file) { assert.ok(to.endsWith('.stale')); replaced = true; sync.writeFileSync(file, 'fresh holder'); }
  });
  const checkedLock = t.mock.method(sync, 'statSync', function (name, ...args) {
    const result = stat.call(this, name, ...args);
    if (name === file && replaced) observed();
    return result;
  });
  const pending = team.locked(() => { entered = true; });
  try {
    await Promise.race([checked, pending.then(() => { throw new Error('Replacement lock was not respected'); })]);
    assert.equal(replaced, true); assert.equal(entered, false); assert.equal(sync.readFileSync(file, 'utf8'), 'fresh holder');
    sync.unlinkSync(file); await pending;
    assert.equal(entered, true); assert.equal(exists(file), false);
  } finally {
    intercepted.mock.restore(); checkedLock.mock.restore();
    await fs.rm(file, { force: true }); await pending.catch(() => {});
  }
});

for (const operation of ['renameSync', 'unlinkSync']) {
  test(`stale-lock ${operation} retries only transient failures`, async t => {
    const f = await lab(t), original = projectTeam(f.repo, true), file = path.join(original.directory, 'lock');
    const applies = name => operation === 'renameSync' ? name === file : name.startsWith(file + '.') && name.endsWith('.stale');
    const real = sync[operation];
    let failures = ['EPERM', 'EBUSY'], attempts = 0;
    const injected = { ...sync, [operation](...args) {
      if (applies(args[0])) {
        attempts++;
        const code = failures.shift();
        if (code) throw Object.assign(new Error('Injected lock failure'), { code });
      }
      return real(...args);
    } };
    const team = load(path.resolve(__dirname, '../electron/features/team/team.cjs'), { 'node:fs': injected }).projectTeam(f.repo);
    await fs.writeFile(file, 'old'); await fs.utimes(file, staleTime, staleTime);
    let entered = false;
    await team.locked(() => { entered = true; });
    assert.equal(entered, true); assert.equal(attempts, 3);
    assert.equal(exists(file), false);
    assert.deepEqual((await fs.readdir(team.directory)).filter(name => name.endsWith('.stale')), []);

    await fs.writeFile(file, 'old'); await fs.utimes(file, staleTime, staleTime);
    failures = ['EACCES']; entered = false;
    await assert.rejects(team.locked(() => { entered = true; }), error => error.code === 'EACCES');
    assert.equal(entered, false);
  });

  test(`stale-lock ${operation} stops retrying at the admission deadline`, async t => {
    const f = await lab(t), original = projectTeam(f.repo, true), file = path.join(original.directory, 'lock');
    const applies = name => operation === 'renameSync' ? name === file : name.startsWith(file + '.') && name.endsWith('.stale');
    const real = sync[operation];
    let now = Date.now(), attempts = 0;
    const injected = { ...sync, [operation](...args) {
      if (applies(args[0])) { attempts++; throw Object.assign(new Error('Injected lock contention'), { code: 'EPERM' }); }
      return real(...args);
    } };
    const team = load(path.resolve(__dirname, '../electron/features/team/team.cjs'), {
      'node:fs': injected, 'node:timers/promises': { setTimeout: async () => { now += 15001; } },
    }, { Date: { now: () => now } }).projectTeam(f.repo);
    await fs.writeFile(file, 'old'); await fs.utimes(file, staleTime, staleTime);
    let entered = false;
    await assert.rejects(team.locked(() => { entered = true; }), /Team admission lock is busy/);
    assert.equal(entered, false); assert.equal(attempts, 1);
  });

  test(`a replacement lock survives transient stale-lock ${operation} failure`, async t => {
    const f = await lab(t), original = projectTeam(f.repo, true), file = path.join(original.directory, 'lock');
    const applies = name => operation === 'renameSync' ? name === file : name.startsWith(file + '.') && name.endsWith('.stale');
    const real = sync[operation];
    let replaced = false, entered = false, observed;
    const checked = new Promise(resolve => { observed = resolve; });
    const injected = { ...sync, [operation](...args) {
      if (!replaced && applies(args[0])) {
        if (operation === 'renameSync') sync.unlinkSync(file);
        sync.writeFileSync(file, 'fresh holder'); replaced = true;
        throw Object.assign(new Error('Injected lock contention'), { code: 'EBUSY' });
      }
      return real(...args);
    }, statSync(name, ...args) {
      const result = sync.statSync(name, ...args);
      if (name === file && replaced) observed();
      return result;
    } };
    const team = load(path.resolve(__dirname, '../electron/features/team/team.cjs'), { 'node:fs': injected }).projectTeam(f.repo);
    await fs.writeFile(file, 'old'); await fs.utimes(file, staleTime, staleTime);
    const pending = team.locked(() => { entered = true; });
    try {
      await Promise.race([checked, pending.then(() => { throw new Error('Replacement lock was not respected'); })]);
      assert.equal(entered, false); assert.equal(sync.readFileSync(file, 'utf8'), 'fresh holder');
      sync.unlinkSync(file); await pending;
      assert.equal(entered, true); assert.equal(exists(file), false);
    } finally {
      await fs.rm(file, { force: true }); await pending.catch(() => {});
    }
  });
}

test('scoped dispatch reuses repository listings and snapshot status outside the admission lock', async t => {
  const f = await lab(t), prepared = await start(f, { skip: 'git call budget' });
  await output(prepared);
  const boundaryFile = path.resolve(__dirname, '../electron/boundaries.cjs'), teamFile = path.resolve(__dirname, '../electron/features/team/team.cjs');
  const calls = [], childProcess = require('node:child_process'), directory = projectTeam(f.repo).directory;
  const children = { ...childProcess, execFileSync(file, args, config) {
    calls.push(args);
    assert.equal(exists(path.join(directory, 'lock')), false, 'Git runs outside the repository-wide lock');
    return childProcess.execFileSync(file, args, config);
  } };
  const boundaries = load(boundaryFile, { 'node:child_process': children });
  const teamModule = load(teamFile, { 'node:child_process': children, '../../boundaries.cjs': boundaries });
  const dispatched = load(helper, { [boundaryFile]: boundaries, [teamFile]: teamModule });
  assert.match(dispatched.briefOf({ cwd: f.repo, allow: [] }, Buffer.from('plain')).toString(), /## Skill proposals[\s\S]*plain$/);
  assert.equal(calls.length, 0, 'briefOf has no hidden team discovery');
  for (const withPeer of [false, true]) {
    const team = projectTeam(f.repo), peer = randomUUID();
    if (withPeer) await team.admit(options(f.repo, ['--allow', 'src/b.js', '--skip-meeting', 'peer']), peer, helper);
    calls.length = 0;
    let stdout = '';
    const code = await dispatched.run(prepared.args, { env: prepared.env, stdout: { write: value => { stdout += value; } },
      resolveExecutable: (_, args) => ({ file: process.execPath, args: [worker, ...args] }) });
    assert.equal(code, 0, stdout);
    assert.equal(calls.filter(args => args.includes('ls-files')).length, 1, 'one listing serves admission and boundaries');
    assert.equal(calls.filter(args => args.includes('status')).length, 2, 'only the before/after snapshots read status');
    if (withPeer) team.release(peer);
  }
});

test('confirmation questions reach both minutes formats with their language prefix', async t => {
  const f = await lab(t), team = projectTeam(f.repo, true);
  const entry = { type: 'meeting', meeting: 'r1', session: 'session', agent: 'codex', model: 'model', role: '执行', title: 'Task',
    ...understandingOf(understanding.replace('Questions and risks: none', 'Questions and risks: Original question.')) };
  team.append(entry);
  team.append({ ...entry, understanding: undefined, status: 'open', confirmation: { status: 'open', questions: ['New question <script>?', 'Another question.'] } });
  const { minutesPage, stamp, LABELS } = require('../electron/features/team/minutes-page.cjs');
  for (const [language, expected] of [['en', 'Open: '], ['zh', '未解决：']]) {
    const prefix = LABELS[language].openPrefix;
    assert.equal(prefix, expected, 'the page and Team share the unresolved-question prefix');
    const data = team.minutes('r1', [], language);
    assert.deepEqual(data.rows[0].open, ['New question <script>?', 'Another question.']);
    assert.equal(data.rows[0].questions, 'Original question.\n' + prefix + 'New question <script>?\n' + prefix + 'Another question.');
    const md = minutesMarkdown(data), html = minutesPage(data);
    assert.ok(md.includes(prefix + 'New question')); assert.ok(html.includes(prefix + 'New question'));
    assert.ok(!md.includes('<script>')); assert.ok(!html.includes('<script>'));
    assert.ok(md.includes(stamp(data.generatedAt)));
  }
  assert.throws(() => team.minutes('r1', [{ issue: 'missing other fields' }]), /Issues must be an array/);
  const unknown = minutesMarkdown({ ...team.minutes('r1'), language: 'constructor', rows: [{ title: ['none', 'line'], status: 'constructor' }], generatedAt: NaN });
  assert.match(unknown, /子模型/); assert.match(unknown, /none<br>line/); assert.doesNotMatch(unknown, /native code/);
});

test('finish returns status data and sessionless failures count as invalid workers', async t => {
  const f = await lab(t), team = projectTeam(f.repo, true), opts = options(f.repo, ['--meeting', 'r1', '--allow', 'src/a.js']);
  const result = await team.finish(opts, { id: randomUUID(), session: null, model: 'unreported', phase: 'understanding', reason: 'unconfirmed', answer: '', header: '' });
  assert.deepEqual(result, { status: 'invalid' });
  assert.equal(team.entries().at(-1).status, 'invalid');
  const data = team.minutes('r1');
  assert.equal(data.rows.length, 1); assert.equal(data.rows[0].status, 'invalid'); assert.equal(data.rows[0].title, opts.title);
  assert.match(minutesMarkdown(data), /已确认 0 \/ 1/);
  const { minutesPage } = require('../electron/features/team/minutes-page.cjs');
  assert.match(minutesPage({ ...data, language: 'en' }), /Confirmed 0 of 1/);
});

test('failed meetings are replaced by retries with the same title agent and scope set', async t => {
  const f = await lab(t), team = projectTeam(f.repo, true);
  const failed = { type: 'meeting', meeting: 'r1', title: 'Core task', agent: 'codex', model: 'unreported', role: '执行',
    session: null, status: 'invalid', allow: ['src/a.js', 'src/b.js'], understanding: {} };
  team.append(failed); team.append({ ...failed, id: 'another-failed-attempt' });
  let data = team.minutes('r1');
  assert.equal(data.rows.length, 1); assert.equal(data.rows[0].status, 'invalid');
  assert.match(minutesMarkdown(data), /已确认 0 \/ 1/);
  const retry = { ...failed, session: 'retry-session', model: 'gpt-6.1-sol', allow: ['src/b.js', 'src/a.js', 'src/b.js'], ...understandingOf(understanding) };
  team.append(retry);
  data = team.minutes('r1');
  assert.equal(data.rows.length, 1); assert.equal(data.rows[0].status, 'understood');
  assert.equal(data.rows[0].goal, 'Coordinate safely'); assert.equal(data.rows[0].who, 'gpt-6.1-sol · 执行');
  team.append({ ...retry, title: 'Confirm minutes', understanding: undefined, status: 'confirmed' });
  data = team.minutes('r1');
  assert.equal(data.rows.length, 1); assert.equal(data.rows[0].status, 'confirmed'); assert.equal(data.rows[0].title, 'Core task');
  assert.match(minutesMarkdown(data), /已确认 1 \/ 1/);
  team.append({ ...failed, title: 'UI task' });
  data = team.minutes('r1');
  assert.equal(data.rows.length, 2); assert.equal(data.rows[1].status, 'invalid');
  assert.match(minutesMarkdown(data), /已确认 1 \/ 2/);
  const { minutesPage } = require('../electron/features/team/minutes-page.cjs');
  assert.match(minutesPage({ ...data, language: 'en' }), /Confirmed 1 of 2/);
});

test('same-title failures survive retries by another agent or scope', async t => {
  const f = await lab(t), team = projectTeam(f.repo, true);
  const { minutesPage } = require('../electron/features/team/minutes-page.cjs');
  for (const [meeting, changes] of [['agent', { agent: 'claude' }], ['scope', { allow: ['src/b.js'] }], ['larger-scope', { allow: ['src/a.js', 'src/b.js'] }]]) {
    const failed = { type: 'meeting', meeting, title: 'Same task', agent: 'codex', model: 'unreported', role: '执行',
      allow: ['src/a.js'], session: null, status: 'invalid' };
    team.append(failed);
    team.append({ ...failed, ...changes, session: 'retry', model: 'worker', ...understandingOf(understanding), status: 'confirmed' });
    const data = team.minutes(meeting);
    assert.equal(data.rows.length, 2, meeting);
    assert.deepEqual(data.rows.map(row => row.status), ['invalid', 'confirmed'], meeting);
    assert.match(minutesMarkdown(data), /已确认 1 \/ 2/);
    assert.match(minutesPage({ ...data, language: 'en' }), /Confirmed 1 of 2/);
  }
});

test('minutes keep distinct sessions separate when titles agents and scopes match', async t => {
  const f = await lab(t), team = projectTeam(f.repo, true);
  const entry = { type: 'meeting', meeting: 'r1', title: 'Same task', agent: 'codex', role: '执行', allow: ['src/a.js'], ...understandingOf(understanding) };
  team.append({ ...entry, session: 'first', model: 'first worker' });
  team.append({ ...entry, session: 'second', model: 'second worker' });
  team.append({ ...entry, session: 'first', title: 'Confirm minutes', understanding: undefined, status: 'confirmed' });
  const data = team.minutes('r1');
  assert.equal(data.rows.length, 2);
  assert.deepEqual(data.rows.map(row => [row.title, row.who, row.status]), [
    ['Same task', 'first worker · 执行', 'confirmed'], ['Same task', 'second worker · 执行', 'understood'],
  ]);
  assert.match(minutesMarkdown(data), /已确认 1 \/ 2/);
});

test('minutes expose only the latest open confirmation questions and clear resolved ones', async t => {
  const f = await lab(t), team = projectTeam(f.repo, true);
  const entry = { type: 'meeting', meeting: 'r1', title: 'Task', agent: 'codex', session: 'session',
    ...understandingOf(understanding.replace('Questions and risks: none', 'Questions and risks: Open: original plan question.')) };
  team.append(entry);
  assert.deepEqual(team.minutes('r1').rows[0].open, []);
  const questions = ['Who owns this?\nAnd the follow-up?', 'Any risk?'];
  team.append({ ...entry, understanding: undefined, status: 'open', confirmation: { status: 'open', questions } });
  for (const [language, prefix] of [['en', 'Open: '], ['zh', '未解决：']]) {
    const row = team.minutes('r1', [], language).rows[0];
    assert.deepEqual(row.open, questions);
    assert.equal(row.questions, 'Open: original plan question.\n' + questions.map(question => prefix + question).join('\n'));
  }
  team.append({ ...entry, understanding: undefined, status: 'open', confirmation: { status: 'open', questions: ['Latest question.'] } });
  assert.deepEqual(team.minutes('r1').rows[0].open, ['Latest question.']);
  for (const status of ['confirmed', 'understood', 'incomplete', 'invalid', 'open']) {
    team.append({ ...entry, understanding: undefined, status, confirmation: status === 'open' ? undefined : { status: 'open', questions } });
    const row = team.minutes('r1').rows[0];
    assert.deepEqual(row.open, [], status);
    assert.equal(row.questions, 'Open: original plan question.', status);
  }
});

test('confirmation prefixes follow the shared page labels', async t => {
  const f = await lab(t), team = projectTeam(f.repo, true);
  team.append({ type: 'meeting', meeting: 'r1', title: 'Task', agent: 'codex', session: 'session', ...understandingOf(understanding) });
  team.append({ type: 'meeting', meeting: 'r1', title: 'Confirm', agent: 'codex', session: 'session', status: 'open', confirmation: { questions: ['Who owns this?'] } });
  const page = require('../electron/features/team/minutes-page.cjs');
  const shared = { ...page, LABELS: {
    zh: { ...page.LABELS.zh, openPrefix: '共享前缀：' },
    en: { ...page.LABELS.en, openPrefix: 'Shared prefix: ' },
  } };
  const reader = load(path.resolve(__dirname, '../electron/features/team/team.cjs'), { './minutes-page.cjs': shared }).projectTeam(f.repo);
  assert.equal(reader.minutes('r1', [], 'zh').rows[0].questions, '共享前缀：Who owns this?');
  assert.equal(reader.minutes('r1', [], 'en').rows[0].questions, 'Shared prefix: Who owns this?');
});
