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
const { createRequire } = require('node:module');
const vm = require('node:vm');
const { projectTeam, memoryExcerpt } = require('../electron/features/team/team.cjs');
const { createEventServer } = require('../electron/events.cjs');

const helper = path.resolve(__dirname, '../integration/dispatch.cjs');
const worker = path.resolve(__dirname, 'fixtures/dispatch-worker.cjs');
const scale = Math.max(1, Number(process.env.AGENTRIX_TEST_TIMEOUT_SCALE) || 1);
const staleTime = new Date('2000-01-01T00:00:00Z');
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
  assert.ok(team.directory.endsWith(path.join('.git', 'agentrix')));
  assert.equal(projectTeam(f.runtime, true), null);
  const plain = await start(f, { cwd: f.runtime, edits: [['a.js', 'outside git']] });
  const result = await output(plain), captured = await json(plain.capture);
  assert.equal(result.code, 0); assert.match(result.stdout, /scope unchecked/); assert.doesNotMatch(result.stdout, / · roundtable /);
  assert.equal(captured.brief, briefOf({ cwd: f.runtime, allow: ['src/a.js'] }, Buffer.from('Whole plan.\n')).toString());
  assert.doesNotMatch(captured.brief, /# Project memory|# Working now|# Roundtable before work/);
  assert.match(briefOf({ cwd: f.runtime, allow: [] }, Buffer.from('plain')).toString(), /## Skill proposals[\s\S]*plain$/);
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
  await fs.writeFile(team.memory, 'Old preface.\n## Round 1 · old\nobsolete\n## Round 2 · Storage\n- Update src/a.js.\n'
    + '### 2026-01-01 12:00 · Dispatch timing · worker\n- Latest finding.\n');
  team.register(options(f.repo, ['--allow', 'src/b.js']), id);
  for (let n = 0; n < 45; n++) await fs.writeFile(path.join(f.repo, `dirty-${String(n).padStart(2, '0')}.txt`), 'dirty');
  const text = briefOf({ cwd: f.repo, allow: ['src/a.js'], ledger }, Buffer.from('Actual dispatch task.'), team).toString();
  assert.ok(text.indexOf('# Shared context') < text.indexOf('# Project memory'));
  assert.ok(text.indexOf('# Project memory') < text.indexOf('# Working now'));
  assert.ok(text.indexOf('# Working now') < text.indexOf('# Repository'));
  assert.ok(text.indexOf('# Repository') < text.indexOf('# Files you may change'));
  assert.match(text, /Dispatch timing[\s\S]*Latest finding\.[\s\S]*## Round 2 · Storage[\s\S]*src\/a\.js/);
  assert.doesNotMatch(text, /Old preface|Round 1|obsolete/);
  assert.ok(text.includes(team.memory)); assert.match(text, /Owner of A \(codex gpt-6.1-sol, 执行\): src\/b.js/);
  assert.match(text, /… and 5 more/); assert.match(text, /[a-f0-9]+ base/);
  assert.match(text, /## Findings for the ledger/); assert.match(text, /# Task\n\nActual dispatch task\.$/);
  const noLedger = briefOf({ cwd: f.repo, allow: [] }, Buffer.from('Read.'), team).toString();
  assert.match(noLedger, /# Handing back/);
  team.release(id);
});

test('memory picks task paths and title words newest first and skips entries that cannot fit whole', () => {
  const entry = (day, title, body) => `### 2026-01-${day} 12:00 · ${title} · worker\n\n${body}\n`;
  const older = entry('01', 'Storage', 'src/a.js and the complete old finding.');
  const middle = entry('02', 'Routing', '汉字'.repeat(400) + ' End of middle.');
  const latest = entry('03', 'Routing', '汉字'.repeat(1000) + ' End of latest.');
  const irrelevant = entry('04', 'Quota review', 'other/a.js');
  const ownerEvent = '### 2026-01-03T13:00:00Z · Owner stop · Quota\n\nStopped another role.\n';
  const excerpt = memoryExcerpt(older + middle + latest + ownerEvent + irrelevant, { brief: 'Review routing in src/a.js' });
  assert.equal(excerpt, [latest.trimEnd(), older.trimEnd()].join('\n\n'));
  assert.ok(Buffer.byteLength(excerpt) <= 6 * 1024);
  assert.equal(memoryExcerpt(older + irrelevant, { allow: ['src/**'], brief: 'Review.' }), older.trimEnd());
  assert.equal(memoryExcerpt(older + irrelevant, { brief: 'Inspect billing.' }), '');
  const sdk = entry('05', 'SDK 权限', 'Denied tool.');
  assert.equal(memoryExcerpt(sdk, { brief: 'Inspect the SDK.' }), sdk.trimEnd());
  assert.equal(memoryExcerpt(sdk, { brief: '检查权限设置。' }), sdk.trimEnd());
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

  test(`stale-lock ${operation} stops retrying at the lock deadline`, async t => {
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
    await assert.rejects(team.locked(() => { entered = true; }), /Team lock is busy/);
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
  assert.match(dispatched.briefOf({ cwd: f.repo, allow: [] }, Buffer.from('plain')).toString(), /## Skill proposals[\s\S]*plain$/);
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
