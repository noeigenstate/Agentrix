const { dispatchEnvironment } = require('./fixtures/team-isolation.cjs');
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
const { loadWithStubs } = require('./helpers/load-with-stubs.cjs');
const { projectTeam, memoryExcerpt } = require('../electron/features/team/team.cjs');
const { createEventServer } = require('../electron/events.cjs');

const helper = path.resolve(__dirname, '../integration/dispatch.cjs');
const worker = path.resolve(__dirname, 'fixtures/dispatch-worker.cjs');
const scale = Math.max(1, Number(process.env.AGENTRIX_TEST_TIMEOUT_SCALE) || 1);
const staleTime = new Date('2000-01-01T00:00:00Z');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const memoryRows = async team => (await fs.readFile(team.memoryJsonl, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
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

async function start(f, { cwd = f.repo, role = 'exec', resume, allow = ['src/a.js'], extra = [], answer = 'Done.',
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
    ...(agent === 'codex' ? ['--fast'] : ['--permission', 'acceptEdits']),
    ...allow.flatMap(glob => ['--allow', glob]), ...(resume ? ['--resume', resume] : []),
    ...(ledger ? ['--ledger', ledger] : []), ...extra];
  const env = { ...dispatchEnvironment(), CODEX_HOME: home, AGENTRIX_BOOTSTRAP: f.bootstrap, DISPATCH_FIXTURE: fixture, DISPATCH_CAPTURE: capture };
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

test('team journals end metadata for every worker role', async t => {
  const f = await lab(t), team = projectTeam(f.repo, true);
  for (const role of ['执行', '审查', '调查']) {
    await team.finish({ role, title: 't'.repeat(400), allow: [], agent: 'codex' }, { id: randomUUID(), session: randomUUID(),
      model: 'gpt-6.1-sol', kind: role === '审查' ? 'review' : 'core', reason: 'exit', outputTokens: 25, totalOutputTokens: 40, activeMs: 2000, answer: '', header: '' });
  }
  const ends = team.entries().filter(entry => entry.type === 'end');
  assert.deepEqual(ends.map(entry => entry.role), ['执行', '审查', '调查']);
  assert.ok(ends.every(entry => entry.title.length === 240 && entry.model === 'gpt-6.1-sol' && entry.reason === 'exit' && entry.outputTokens === 25 && entry.totalOutputTokens === 40 && entry.activeMs === 2000));
  assert.ok(ends.every(entry => !Object.hasOwn(entry, 'meeting')));
});

function load(file, replacements) {
  return loadWithStubs(file, (name, localRequire) => replacements[name] ?? localRequire(name));
}

async function invoke(prepared, extra = {}) {
  let stdout = '';
  const code = await run(prepared.args, { env: prepared.env, stdout: { write: text => { stdout += text; } },
    resolveExecutable: (_, args) => ({ file: process.execPath, args: [worker, ...args] }), ...extra });
  return { code, stdout };
}

test('removed roundtable options fail once before dispatch or detach', async () => {
  for (const args of [['codex', '--meeting'], ['codex', '--detach', '--meeting', 'r1'], ['claude', '--meeting=r1'], ['minutes', '--help'], ['consolidate']]) {
    let stdout = '';
    const code = await run(args, { stdout: { write: text => { stdout += text; } }, launch: () => assert.fail('removed command launched') });
    assert.equal(code, 1);
    assert.deepEqual(stdout.trimEnd().split('\n'), ['[dispatch] Roundtables were removed. Run without --meeting, minutes or consolidate.']);
  }
});

test('legacy skip-meeting is ignored and other flags remain validated', async t => {
  const args = ['--allow', 'src/**'];
  const base = options(os.tmpdir(), args);
  assert.deepEqual(options(os.tmpdir(), [...args, '--skip-meeting', 'legacy build']), base);
  assert.ok(!commandOf(base).includes('--skip-meeting'));
  assert.throws(() => options(os.tmpdir(), ['--fast']), /Repeated option/);
  const f = await lab(t), worker = await start(f, { role: 'review', allow: [], extra: ['--skip-meeting', 'legacy review'] });
  const result = await output(worker);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /legacy review|roundtable/);
  assert.deepEqual(projectTeam(f.repo).entries().map(entry => entry.type), ['end']);
});

test('worktrees share team state and outside git the helper behaves as before', async t => {
  const f = await lab(t), second = path.join(f.directory, 'second');
  git(f.repo, 'worktree', 'add', '--detach', second, 'HEAD');
  const team = projectTeam(f.repo, true), peer = projectTeam(second, true);
  assert.equal(team.directory, peer.directory);
  await fs.writeFile(team.memory, 'Shared decision.\n');
  assert.equal(await fs.readFile(peer.memory, 'utf8'), 'Shared decision.\n');
  const [restrictedMemory] = peer.context(null, null, { readOnly: true });
  assert.match(restrictedMemory, /cannot be read from this role.*lead can supply an entry/);
  assert.ok(!restrictedMemory.includes(peer.memory));
  assert.ok(team.context(null, null, { readOnly: true })[0].includes(team.memory));
  assert.ok(team.directory.endsWith(path.join('.git', 'agentrix')));
  assert.equal(projectTeam(f.runtime, true), null);
  const plain = await start(f, { cwd: f.runtime, edits: [['a.js', 'outside git']] });
  const result = await output(plain), captured = await json(plain.capture);
  assert.equal(result.code, 0); assert.match(result.stdout, /scope unchecked/); assert.doesNotMatch(result.stdout, / · roundtable /);
  assert.equal(captured.brief, briefOf({ cwd: f.runtime, allow: ['src/a.js'] }, Buffer.from('Whole plan.\n')).toString());
  assert.doesNotMatch(captured.brief, /# Project memory|# Working now|# Roundtable before work/);
  assert.match(briefOf({ cwd: f.runtime, allow: [] }, Buffer.from('plain')).toString(), /finish_role\.skillProposals[\s\S]*plain$/);
});

test('a scoped build starts while a worker with overlapping scope is still running', async t => {
  const f = await lab(t), team = projectTeam(f.repo, true);
  const first = await start(f, { release: true, title: 'First' });
  await until(() => /\[dispatch\] started /.test(first.stdout()));
  const second = await start(f, { release: true, title: 'Second' });
  await until(() => /\[dispatch\] started /.test(second.stdout()));
  const entries = team.live();
  assert.deepEqual(entries.map(entry => entry.pid).sort(), [first.child.pid, second.child.pid].sort());
  assert.ok(entries.every(entry => entry.allow[0] === 'src/a.js'));
  assert.notEqual(entries.find(entry => entry.title === 'First').pid, (await json(first.capture)).pid);
  assert.match((await json(second.capture)).brief, /# Working now[\s\S]*First.*src\/a\.js/);
  for (const worker of [first, second]) await worker.release();
  for (const worker of [first, second]) assert.equal((await output(worker)).code, 0);
  assert.deepEqual(team.live(), []);
  assert.deepEqual(team.entries().map(entry => entry.type), ['end', 'end']);
});

test('dead board entries and stale locks are removed while a live lock is respected', async t => {
  const f = await lab(t), team = projectTeam(f.repo, true);
  const dead = spawn(process.execPath, ['-e', ''], { windowsHide: true }); await once(dead, 'close');
  await fs.writeFile(path.join(team.board, 'dead.json'), JSON.stringify({ pid: dead.pid, allow: ['src/**'] }));
  const lock = path.join(team.directory, 'lock'); await fs.writeFile(lock, 'stale');
  await fs.utimes(lock, staleTime, staleTime);
  const id = randomUUID(); team.register(options(f.repo, ['--allow', 'src/a.js']), id);
  await team.locked(() => {
    assert.deepEqual(team.live().map(entry => entry.id), [id]);
    assert.equal(exists(path.join(team.board, 'dead.json')), false);
  });
  team.release(id);
  const held = Promise.withResolvers(), release = Promise.withResolvers();
  const holder = team.locked(() => { held.resolve(); return release.promise; });
  await held.promise;
  await fs.utimes(lock, staleTime, staleTime);
  let entered = false, observed;
  const checked = new Promise(resolve => { observed = resolve; }), stat = sync.lstatSync;
  const intercepted = t.mock.method(sync, 'lstatSync', function (file, ...args) {
    const result = stat.call(this, file, ...args);
    if (file === lock) observed();
    return result;
  });
  const pending = team.locked(() => { entered = true; });
  try {
    await Promise.race([checked, pending.then(() => { throw new Error('Lock was not respected'); })]);
    assert.equal(entered, false);
    release.resolve(); await holder; await pending; assert.equal(entered, true);
  } finally {
    intercepted.mock.restore();
    release.resolve(); await holder; await pending.catch(() => {});
  }
});

test('a dead lock owner is reclaimed and a queued inbox write keeps finalization out until admission finishes', async t => {
  const f = await lab(t), team = projectTeam(f.repo, true), lock = path.join(team.directory, 'lock');
  const dead = spawn(process.execPath, ['-e', ''], { windowsHide: true }); await once(dead, 'close');
  await fs.mkdir(lock);
  await fs.writeFile(path.join(lock, `${dead.pid}-${randomUUID()}`), '');
  const id = randomUUID();
  team.register(options(f.repo, ['--allow', 'src/a.js']), id);
  const inbox = new (require('../electron/features/team/inbox.cjs').RunInbox)(team, id);
  await inbox.open();
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const message = { id: randomUUID(), at: Date.now(), text: 'still pending' };
  const queued = team.queueControl(id, message, () => { entered.resolve(); return release.promise; });
  await entered.promise;
  await fs.utimes(lock, staleTime, staleTime);
  let finalized = false;
  const taking = inbox.take(true).then(value => { finalized = true; return value; });
  assert.equal(finalized, false);
  release.resolve();
  await queued;
  assert.deepEqual(await taking, [message]);
});

test('memory keeps readable rows, counts corruption, and appends after a torn final row', async t => {
  const f = await lab(t), team = projectTeam(f.repo, true);
  const before = { v: 1, type: 'memory.entry', at: 1, title: 'Previously', text: 'Readable finding' };
  const future = { ...before, v: 9, title: 'Future format' };
  await fs.writeFile(team.memoryJsonl, JSON.stringify(before) + '\n' + JSON.stringify(future) + '\n{"v":1,"text":"torn');
  assert.match(team.context('current', null)[0], /Skipped 2 unreadable memory rows/);
  await team.finish({ title: 'A run', agent: 'claude' }, { id: 'run', findings: ['New finding'], header: 'Today' });
  const [first, second, torn, appended] = (await fs.readFile(team.memoryJsonl, 'utf8')).split('\n');
  assert.deepEqual(JSON.parse(first), before);
  assert.deepEqual(JSON.parse(second), future);
  assert.equal(torn, '{"v":1,"text":"torn');
  assert.equal(JSON.parse(appended).text, '- New finding');
  assert.match(await fs.readFile(team.memory, 'utf8'), /Generated project memory[\s\S]*Readable finding[\s\S]*New finding/);
  await fs.appendFile(team.journal, '{"v":9,"time":100}\n');
  assert.equal(team.journalHistory().skipped, 1);
  assert.deepEqual(team.entries().map(entry => entry.id), ['run']);
});

test('large team logs retain complete archived rows and bounded active files', async t => {
  const f = await lab(t), team = projectTeam(f.repo, true);
  const memory = { v: 1, type: 'memory.entry', at: 1, title: 'Archive', text: 'm'.repeat(256 * 1024) };
  const journal = { v: 1, type: 'incident', time: 1, text: 'j'.repeat(256 * 1024) };
  await fs.writeFile(team.memoryJsonl, (JSON.stringify(memory) + '\n').repeat(17));
  await fs.writeFile(team.journal, (JSON.stringify(journal) + '\n').repeat(65));
  await team.locked(() => {
    team.appendMemory({ title: 'New memory', text: 'new' });
    team.append({ type: 'end', id: 'latest' });
  });
  for (const [file, record, bound] of [[team.memoryJsonl, memory, 4], [team.journal, journal, 16]]) {
    const name = path.basename(file);
    const archive = (await fs.readdir(team.directory)).find(entry => entry.startsWith(name + '.') && entry.endsWith('.archive'));
    assert.ok(archive);
    assert.deepEqual(JSON.parse((await fs.readFile(path.join(team.directory, archive), 'utf8')).split('\n')[0]), record);
    assert.ok((await fs.stat(file)).size < bound * 1024 * 1024);
  }
  assert.equal(team.entries().at(-1).id, 'latest');
});

test('board entries leave on failed spawn and interruption', async t => {
  const f = await lab(t), team = projectTeam(f.repo, true);
  const failed = await start(f, { missing: true });
  assert.match((await output(failed)).stdout, /failed to start .*ENOENT/);
  assert.deepEqual(team.live(), []); assert.equal(team.entries().at(-1).type, 'end');
  const active = await start(f, { release: true });
  await until(() => /\[dispatch\] started /.test(active.stdout()));
  assert.equal(team.live().length, 1);
  active.child.send('SIGTERM');
  assert.match((await output(active)).stdout, /reason killed/);
  assert.deepEqual(team.live(), []); assert.equal(team.entries().at(-1).type, 'end');
});

test('briefs inject the ledger first, then selected memory, live peers and bounded repository context', async t => {
  const f = await lab(t), team = projectTeam(f.repo, true), id = randomUUID();
  const ledger = path.join(f.runtime, 'ledger.md'); await fs.writeFile(ledger, 'The owner chose cents.\n');
  team.appendMemory({ title: 'Round 1 · old', text: 'obsolete' });
  team.appendMemory({ title: 'Round 2 · Storage', text: '- Update src/a.js.' });
  team.appendMemory({ title: '2026-01-01 12:00 · Dispatch timing · worker', text: '- Latest finding.' });
  team.register(options(f.repo, ['--allow', 'src/b.js']), id);
  for (let n = 0; n < 45; n++) await fs.writeFile(path.join(f.repo, `dirty-${String(n).padStart(2, '0')}.txt`), 'dirty');
  const text = briefOf({ cwd: f.repo, allow: ['src/a.js'], ledger }, Buffer.from('Actual dispatch task.'), team).toString();
  assert.ok(text.indexOf('# Shared context') < text.indexOf('# Project memory'));
  assert.ok(text.indexOf('# Project memory') < text.indexOf('# Working now'));
  assert.ok(text.indexOf('# Working now') < text.indexOf('# Repository'));
  assert.ok(text.indexOf('# Repository') < text.indexOf('# Files you may change'));
  assert.match(text, /Dispatch timing[\s\S]*Latest finding\.[\s\S]*### Round 2 · Storage[\s\S]*src\/a\.js/);
  assert.doesNotMatch(text, /Old preface|Round 1|obsolete/);
  assert.ok(text.includes(team.memory)); assert.match(text, /Owner of A \(codex gpt-6.1-sol, 执行\): src\/b.js/);
  assert.match(text, /… and 5 more/); assert.match(text, /[a-f0-9]+ base/);
  assert.match(text, /finish_role\.findings/); assert.match(text, /# Task\n\nActual dispatch task\.$/);
  const noLedger = briefOf({ cwd: f.repo, allow: [] }, Buffer.from('Read.'), team).toString();
  assert.match(noLedger, /# Handing back/);
  team.release(id);
});

test('memory includes the newest two entries and matches older bodies within its byte budget', () => {
  const entry = (day, title, body) => ({ title: `2026-01-${day} 12:00 · ${title} · worker`, text: body });
  const older = entry('01', 'Storage', 'src/a.js and the complete old finding.');
  const cjk = entry('02', 'Routing', '审核读取权限。');
  const body = entry('03', 'Transport', 'Uses sharedBinder. Blue packets.\n\n' + '汉字'.repeat(1200));
  const unrelated = entry('04', 'Database', 'Other notes.');
  const first = entry('05', 'Quota', 'Other findings.');
  const second = entry('06', 'Progress', 'Other facts.');
  const all = [older, cjk, body, unrelated, first, second];
  const excerpt = memoryExcerpt(all, { brief: 'Review sharedBinder and src/a.js for 权限规则' });
  assert.ok(excerpt.startsWith([second, first].map(row => `### ${row.title}\n\n${row.text}`).join('\n\n')));
  assert.match(excerpt, /Blue packets\.\n\n\[Entry truncated\]/);
  assert.match(excerpt, /审核读取权限/);
  assert.match(excerpt, /complete old finding/);
  assert.doesNotMatch(excerpt, /Database|汉字/);
  assert.ok(Buffer.byteLength(excerpt) <= 6 * 1024);
  const largeFirst = entry('07', 'Very recent', 'a'.repeat(9000));
  const largeSecond = entry('08', 'Latest', 'b'.repeat(9000));
  const large = memoryExcerpt([...all, largeFirst, largeSecond]);
  assert.match(large, /Latest[\s\S]*Entry truncated[\s\S]*Very recent[\s\S]*Entry truncated/);
});

test('findings always reach memory and also reach an explicit ledger', async t => {
  const f = await lab(t), team = projectTeam(f.repo, true), answer = 'Done.\n\n## Findings for the ledger\n\n- Shares a decision.\n';
  const plain = await start(f, { answer });
  await output(plain);
  assert.match(await fs.readFile(team.memory, 'utf8'), /Shares a decision/);
  const ledger = path.join(f.repo, 'ledger.md');
  await fs.writeFile(ledger, '# Ledger\n');
  await output(await start(f, { answer: answer.replace('a decision', 'another decision'), ledger }));
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

test('signals during board registration, brief, snapshot and log-open prevent launch', async t => {
  const f = await lab(t), prepared = await start(f);
  await output(prepared);
  const team = projectTeam(f.repo), proto = Object.getPrototypeOf(team), register = proto.register;
  const read = sync.readFileSync, stream = sync.createWriteStream;
  const dirty = path.join(f.repo, 'src/a.js'); await fs.writeFile(dirty, 'dirty before snapshot\n');
  for (const phase of ['register', 'brief', 'snapshot', 'log']) {
    let sent = false, calls = 0;
    const send = () => { if (!sent) { sent = true; process.emit(phase === 'brief' ? 'SIGINT' : 'SIGTERM'); } };
    let mocked;
    if (phase === 'register') mocked = t.mock.method(proto, 'register', function (...args) { register.apply(this, args); send(); });
    else if (phase === 'log') mocked = t.mock.method(sync, 'createWriteStream', function (...args) { const value = stream.apply(this, args); queueMicrotask(send); return value; });
    else mocked = t.mock.method(sync, 'readFileSync', function (file, ...args) {
      const value = read.call(this, file, ...args);
      if (String(file) === (phase === 'brief' ? prepared.prompt : dirty)) send();
      return value;
    });
    try {
      const result = await invoke(prepared, { launch: () => { calls++; assert.fail('cancelled startup launched a worker'); } });
      assert.equal(sent, true, phase); assert.equal(calls, 0, phase); assert.equal(result.code, 1, phase);
      assert.match(result.stdout, /interrupted before launch/); assert.deepEqual(team.live(), []);
    } finally { mocked.mock.restore(); }
  }
});

test('a signal between the launch check and spawn stops the new worker', async t => {
  const f = await lab(t), prepared = await start(f);
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
  const prepared = await start(f, { ledger, answer: 'Done.\n\n## Findings for the ledger\n\n- Once per result.\n' });
  await output(prepared);
  const team = projectTeam(f.repo), proto = Object.getPrototypeOf(team), append = proto.append, finish = proto.finish;
  await fs.writeFile(ledger, '# Ledger\n');
  const before = await memoryRows(team);
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
    const added = (await memoryRows(team)).slice(before.length);
    assert.deepEqual(added.map(row => row.text), ['- Once per result.']);
    assert.equal((await fs.readFile(ledger, 'utf8')).split('Once per result.').length, 2);
  } finally { attempted.mock.restore(); failure.mock.restore(); }
  const busy = t.mock.method(proto, 'finish', async () => { throw new Error('Team lock is busy'); });
  try {
    const result = await invoke(prepared);
    assert.equal(result.code, 0); assert.match(result.stdout, /exit 0 reason exit.*WARNING: team bookkeeping failed: Team lock is busy/);
    assert.deepEqual(team.live(), []);
  } finally { busy.mock.restore(); }
});

test('a fresh replacement lock survives stale-lock removal', async t => {
  const f = await lab(t), team = projectTeam(f.repo, true), file = path.join(team.directory, 'lock');
  await fs.writeFile(file, 'old'); await fs.utimes(file, staleTime, staleTime);
  const unlink = sync.unlinkSync, stat = sync.lstatSync;
  let replaced = false, entered = false, observed;
  const checked = new Promise(resolve => { observed = resolve; });
  const intercepted = t.mock.method(sync, 'unlinkSync', function (name) {
    unlink.call(this, name);
    if (name === file) { replaced = true; sync.writeFileSync(file, 'fresh holder'); }
  });
  const checkedLock = t.mock.method(sync, 'lstatSync', function (name, ...args) {
    const result = stat.call(this, name, ...args);
    if (name === file && replaced) observed();
    return result;
  });
  const pending = team.locked(() => { entered = true; });
  try {
    await Promise.race([checked, pending.then(() => { throw new Error('Replacement lock was not respected'); })]);
    assert.equal(replaced, true); assert.equal(entered, false); assert.equal(sync.readFileSync(file, 'utf8'), 'fresh holder');
    unlink(file); await pending;
    assert.equal(entered, true); assert.equal(exists(file), false);
  } finally {
    intercepted.mock.restore(); checkedLock.mock.restore();
    await fs.rm(file, { force: true }); await pending.catch(() => {});
  }
});

const preventReplacingEmptyLock = (operation, file) => (from, to) => {
  if (operation === 'rmdirSync' && to === file && exists(file)) throw Object.assign(new Error('Lock exists'), { code: 'EEXIST' });
  sync.renameSync(from, to);
};

for (const operation of ['unlinkSync', 'rmdirSync']) {
  test(`stale-lock ${operation} retries only transient failures`, async t => {
    const f = await lab(t), original = projectTeam(f.repo, true), file = path.join(original.directory, 'lock');
    const applies = name => name === file;
    const real = sync[operation];
    let failures = ['EPERM', 'EBUSY'], attempts = 0;
    const injected = { ...sync, renameSync: preventReplacingEmptyLock(operation, file), [operation](...args) {
      if (applies(args[0])) {
        attempts++;
        const code = failures.shift();
        if (code) throw Object.assign(new Error('Injected lock failure'), { code });
      }
      return real(...args);
    } };
    const team = load(path.resolve(__dirname, '../electron/features/team/team.cjs'), { 'node:fs': injected }).projectTeam(f.repo);
    const makeOld = async () => {
      if (operation === 'rmdirSync') await fs.mkdir(file);
      else { await fs.writeFile(file, 'old'); await fs.utimes(file, staleTime, staleTime); }
    };
    await makeOld();
    let entered = false;
    await team.locked(() => { entered = true; });
    assert.equal(entered, true); assert.equal(attempts, operation === 'rmdirSync' ? 4 : 3);
    assert.equal(exists(file), false);
    assert.deepEqual((await fs.readdir(team.directory)).filter(name => name.endsWith('.stale')), []);

    await makeOld();
    failures = ['EACCES']; entered = false;
    await assert.rejects(team.locked(() => { entered = true; }), error => error.code === 'EACCES');
    assert.equal(entered, false);
  });

  test(`stale-lock ${operation} stops retrying at the lock deadline`, async t => {
    const f = await lab(t), original = projectTeam(f.repo, true), file = path.join(original.directory, 'lock');
    const applies = name => name === file;
    const real = sync[operation];
    let attempts = 0;
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const injected = { ...sync, renameSync: preventReplacingEmptyLock(operation, file), [operation](...args) {
      if (applies(args[0])) { attempts++; throw Object.assign(new Error('Injected lock contention'), { code: 'EPERM' }); }
      return real(...args);
    } };
    const team = load(path.resolve(__dirname, '../electron/features/team/team.cjs'), {
      'node:fs': injected, 'node:timers/promises': { setTimeout: async () => { t.mock.timers.tick(15001); } },
    }).projectTeam(f.repo);
    if (operation === 'rmdirSync') await fs.mkdir(file);
    else { await fs.writeFile(file, 'old'); await fs.utimes(file, staleTime, staleTime); }
    let entered = false;
    await assert.rejects(team.locked(() => { entered = true; }), /Team lock is busy/);
    assert.equal(entered, false); assert.equal(attempts, 1);
  });

  test(`a replacement lock survives transient stale-lock ${operation} failure`, async t => {
    const f = await lab(t), original = projectTeam(f.repo, true), file = path.join(original.directory, 'lock');
    const applies = name => name === file;
    const real = sync[operation];
    let replaced = false, entered = false, observed;
    const checked = new Promise(resolve => { observed = resolve; });
    const injected = { ...sync, renameSync: preventReplacingEmptyLock(operation, file), [operation](...args) {
      if (!replaced && applies(args[0])) {
        real(file);
        sync.writeFileSync(file, 'fresh holder'); replaced = true;
        throw Object.assign(new Error('Injected lock contention'), { code: 'EBUSY' });
      }
      return real(...args);
    }, lstatSync(name, ...args) {
      const result = sync.lstatSync(name, ...args);
      if (name === file && replaced) observed();
      return result;
    } };
    const team = load(path.resolve(__dirname, '../electron/features/team/team.cjs'), { 'node:fs': injected }).projectTeam(f.repo);
    if (operation === 'rmdirSync') await fs.mkdir(file);
    else { await fs.writeFile(file, 'old'); await fs.utimes(file, staleTime, staleTime); }
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

test('scoped dispatch lists repository files once and snapshots status before and after the run', async t => {
  const f = await lab(t), prepared = await start(f);
  await output(prepared);
  const boundaryFile = path.resolve(__dirname, '../electron/boundaries.cjs'), teamFile = path.resolve(__dirname, '../electron/features/team/team.cjs');
  const calls = [], childProcess = require('node:child_process'), directory = projectTeam(f.repo).directory;
  const children = { ...childProcess, execFileSync(file, args, config) {
    calls.push(args);
    assert.equal(exists(path.join(directory, 'lock')), false, 'Git runs outside the repository-wide lock');
    return childProcess.execFileSync(file, args, config);
  } };
  const boundaries = load(boundaryFile, { 'node:child_process': children });
  const teamModule = load(teamFile, { 'node:child_process': children });
  const dispatched = load(helper, { [boundaryFile]: boundaries, [teamFile]: teamModule });
  const rendered = dispatched.briefOf({ cwd: f.repo, allow: [] }, Buffer.from('plain')).toString();
  assert.ok(rendered.includes('finish_role.skillProposals'));
  assert.ok(rendered.endsWith('plain'));
  assert.equal(calls.length, 0, 'briefOf has no hidden team discovery');
  for (const withPeer of [false, true]) {
    const team = projectTeam(f.repo), peer = randomUUID();
    if (withPeer) team.register(options(f.repo, ['--allow', 'src/b.js']), peer);
    calls.length = 0;
    let stdout = '';
    const code = await dispatched.run(prepared.args, { env: prepared.env, stdout: { write: value => { stdout += value; } },
      resolveExecutable: (_, args) => ({ file: process.execPath, args: [worker, ...args] }) });
    assert.equal(code, 0, stdout);
    assert.equal(calls.filter(args => args.includes('ls-files')).length, 1, 'one listing serves scope checks and boundaries');
    assert.equal(calls.filter(args => args.includes('status')).length, 2, 'only the before/after snapshots read status');
    if (withPeer) team.release(peer);
  }
});
