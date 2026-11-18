require('./fixtures/team-isolation.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { EventEmitter, once } = require('node:events');
const { spawn, execFileSync } = require('node:child_process');
const { argumentsOf, startDetached, waitDetached, run } = require('../integration/dispatch.cjs');
const { DetachedRuns } = require('../integration/dispatch-outbox.cjs');

function receipts(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-detach-receipts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return new DetachedRuns(root);
}

test('detach is opt-in and wait has a bounded timeout and strict run ids', () => {
  const id = randomUUID();
  assert.equal(argumentsOf(['wait', id]).timeout, 540);
  assert.equal(argumentsOf(['wait', id, '--timeout', '570']).timeout, 570);
  for (const args of [[id, '--timeout', '571'], [id, '--timeout', '-1'], [id, '--timeout', 'NaN'], [id, id], ['../run'], []]) {
    assert.throws(() => argumentsOf(['wait', ...args]));
  }
  const args = ['claude', '--role', 'review', '--title', 'Synthetic', '--model', 'sonnet', '--effort', 'high', '--permission', 'plan', '--cwd', '.', '--brief', 'brief', '--out', 'out'];
  assert.equal(argumentsOf(args).detach, undefined);
  assert.equal(argumentsOf([...args, '--detach']).detach, true);
  assert.throws(() => argumentsOf([...args, '--detach', '--detach']));
});

test('wait prints both normal end receipts, including nonzero worker exit codes, and exits zero', async t => {
  const store = receipts(t), ids = [randomUUID(), randomUUID()];
  let text = '';
  for (const [index, id] of ids.entries()) store.create({ id, createdAt: Date.now(), settled: true, exitCode: index,
    endedLine: `[dispatch] ended ${id} claude model synthetic · exit ${index} reason exit` });
  assert.equal(await waitDetached({ ids, timeout: 0 }, { store, stdout: { write: value => { text += value; } } }), 0);
  for (const id of ids) assert.equal(text.split(`[dispatch] ended ${id}`).length, 2);
  assert.match(text, /exit 1 reason exit/);
});

test('wait timeout returns 75 and reports elapsed time and last activity for each unfinished run', async t => {
  const store = receipts(t), ids = [randomUUID(), randomUUID()];
  let text = '';
  for (const id of ids) store.create({ id, createdAt: Date.now(), admitted: true });
  assert.equal(await waitDetached({ ids, timeout: 0 }, { store, stdout: { write: value => { text += value; } } }), 75);
  for (const id of ids) assert.match(text, new RegExp(`still running ${id} .*last activity `));
});

test('wait reports a helper crash as an error instead of claiming it is still running', async t => {
  const store = receipts(t), id = randomUUID(); let text = '';
  store.create({ id, createdAt: Date.now(), helperPid: 123 });
  assert.equal(await waitDetached({ ids: [id], timeout: 0 }, { store, alive: () => false, stdout: { write: value => { text += value; } } }), 0);
  assert.match(text, /exit 1 reason error.*without a final receipt/);
  assert.doesNotMatch(text, /still running/);
});

test('receipt replacement wakes wait and each ended line is printed only once', async t => {
  const store = receipts(t), ids = [randomUUID(), randomUUID()];
  for (const id of ids) store.create({ id, createdAt: Date.now() });
  let inspect, text = '', registered;
  const ready = new Promise(resolve => { registered = resolve; });
  const waiting = waitDetached({ ids, timeout: 10 }, { store, stdout: { write: value => { text += value; } },
    observe: check => new Promise(resolve => { inspect = () => { if (check()) resolve(true); }; registered(); inspect(); }) });
  await ready;
  store.update(ids[1], { settled: true, endedLine: `[dispatch] ended ${ids[1]} · exit 0 reason exit` }); inspect(); inspect();
  store.update(ids[0], { settled: true, endedLine: `[dispatch] ended ${ids[0]} · exit 0 reason exit` }); inspect();
  assert.equal(await waiting, 0);
  assert.equal(text.split('[dispatch] ended ').length, 3);
  assert.ok(text.indexOf(ids[1]) < text.indexOf(ids[0]));
});

test('detached helper uses an independent process group, file stdio and the original start receipt', async t => {
  const store = receipts(t), brief = path.join(store.directory, 'brief.md');
  fs.writeFileSync(brief, 'Synthetic brief');
  let text = '', launched;
  const args = ['claude', '--detach', '--role', 'review', '--title', 'Synthetic', '--model', 'sonnet', '--effort', 'high', '--permission', 'plan', '--cwd', store.directory, '--brief', brief, '--out', path.join(store.directory, 'answer.md')];
  const result = await startDetached(args, { store, stdout: { write: value => { text += value; } }, launch: (file, argv, options) => {
    assert.equal(file, process.execPath); assert.equal(options.detached, true); assert.equal(options.windowsHide, true);
    assert.equal(options.stdio[0], 'ignore'); assert.equal(typeof options.stdio[1], 'number');
    assert.equal(options.stdio[1], options.stdio[2]);
    const id = path.basename(argv.at(-1), '.json'), child = new EventEmitter();
    launched = store.read(id); assert.ok(!launched.argv.includes('--detach'));
    child.unref = () => {}; child.kill = () => assert.fail('A confirmed detached helper must survive');
    queueMicrotask(() => { store.update(id, { admitted: true, startedLine: `[dispatch] started ${id} claude model synthetic · pid 123 session synthetic` }); child.emit('spawn'); });
    return child;
  } });
  assert.equal(result, 0); assert.match(text, new RegExp(`started ${launched.id} .*session synthetic`));
  assert.equal(store.read(launched.id).settled, undefined);
});

test('without detach the helper waits for the worker and preserves its exit code', async t => {
  const store = receipts(t), filename = path.resolve(__dirname, '../integration/dispatch.cjs');
  const { Module, createRequire } = require('node:module'), { PassThrough } = require('node:stream');
  const realRequire = createRequire(filename), loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = module.paths;
  loaded.require = name => name.replaceAll('\\', '/').endsWith('/features/team/team.cjs')
    ? { ...realRequire(name), projectTeam: () => null } : realRequire(name);
  loaded._compile(fs.readFileSync(filename, 'utf8'), filename);
  const brief = path.join(store.directory, 'brief.md'), out = path.join(store.directory, 'answer.md'), session = randomUUID();
  fs.writeFileSync(brief, 'Synthetic foreground task');
  let worker, release, launched, text = '', finished = false;
  const ready = new Promise(resolve => { launched = resolve; });
  const completed = loaded.exports.run(['claude', '--role', 'review', '--title', 'Synthetic foreground', '--model', 'sonnet', '--effort', 'high', '--permission', 'plan', '--cwd', store.directory, '--brief', brief, '--out', out], {
    env: { PATH: '', HOME: store.directory, USERPROFILE: store.directory, CODEX_HOME: path.join(store.directory, 'codex'), CLAUDE_CONFIG_DIR: path.join(store.directory, 'claude') },
    stdout: { write: value => { text += value; } }, resolveExecutable: () => ({ file: 'synthetic-worker', args: [] }),
    launch: () => {
      worker = new EventEmitter(); worker.pid = 123; worker.exitCode = null;
      worker.stdin = new PassThrough(); worker.stdout = new PassThrough(); worker.stderr = new PassThrough();
      release = () => {
        worker.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: session, model: 'claude-sonnet-5-5', effort: 'high', fast_mode: false }) + '\n');
        worker.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', session_id: session, result: 'done' }) + '\n');
        worker.stdout.end(); worker.stderr.end(); worker.exitCode = 7; worker.emit('exit', 7); worker.emit('close', 7, null);
      };
      launched(); return worker;
    },
  }).then(code => { finished = true; return code; });
  await ready;
  assert.equal(finished, false);
  release(); assert.equal(await completed, 7);
  assert.match(text, /\[dispatch\] started /); assert.match(text, /exit 7 reason error/);
});

// Real subprocess acceptance uses Node stand-ins only. The helper/worker inherit isolated provider homes;
// resolveExecutable bypasses every installed CLI search. No provider API or owner profile is used.
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-detach-worker-')), repo = path.join(root, 'repo');
  fs.mkdirSync(repo); fs.writeFileSync(path.join(repo, 'a.txt'), 'base');
  const git = args => execFileSync('git', args, { cwd: repo, stdio: 'ignore', windowsHide: true });
  git(['init', '-q']); git(['add', '.']); git(['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '-qm', 'base']);
  const helper = path.resolve(__dirname, '../integration/dispatch.cjs'), worker = path.join(root, 'worker.cjs'), brief = path.join(root, 'brief.md');
  fs.writeFileSync(brief, 'Synthetic task');
  fs.writeFileSync(worker, `const fs=require('node:fs'); const release=process.env.SYNTHETIC_RELEASE;
    (async()=>{for await(const chunk of process.stdin){};
    const watcher=fs.watch(require('node:path').dirname(release),()=>{if(fs.existsSync(release)){watcher.close();process.stdout.write(JSON.stringify({type:'result',subtype:'success',session_id:process.env.SYNTHETIC_SESSION,result:'done'})+'\\n');}});
    process.stdout.write(JSON.stringify({type:'system',subtype:'init',session_id:process.env.SYNTHETIC_SESSION,model:'claude-sonnet-5-5',effort:'high',fast_mode:false})+'\\n');})();`);
  const env = { ...process.env, HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex') };
  for (const key of Object.keys(env)) if (/^AGENTRIX_|^CLAUDECODE$|^ANTHROPIC_/.test(key)) delete env[key];
  const store = new DetachedRuns(path.join(repo, '.git/agentrix/detached')), ids = [], releases = new Map();
  t.after(async () => {
    for (const id of ids) if (!store.read(id).settled) {
      await run(['stop', id, '--no-resume', '--cwd', repo], { env, launch: () => assert.fail('stop launches no CLI') });
      await waitDetached({ ids: [id], timeout: 5 }, { store, stdout: { write() {} } });
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  async function start(scope, skip = true) {
    const out = path.join(root, randomUUID() + '.md'), release = out + '.release';
    const args = ['claude', '--detach', '--role', 'exec', '--title', 'Synthetic detached', '--model', 'sonnet', '--effort', 'high', '--permission', 'acceptEdits', '--cwd', repo, '--brief', brief, '--out', out, '--allow', scope,
      ...(skip ? ['--skip-meeting', 'Synthetic detach acceptance'] : [])];
    // The foreground launcher exits; its detached Node helper and stand-in must remain alive.
    const script = `const h=require(${JSON.stringify(helper)}),cp=require('node:child_process');h.startDetached(JSON.parse(process.argv[1]),{launch:(file,args,options)=>cp.spawn(file,['-e',${JSON.stringify(`require(${JSON.stringify(helper)}).runDetached(process.argv[1], {resolveExecutable:()=>({file:process.execPath,args:[${JSON.stringify(worker)}]}),locate:()=>null,locateClaude:()=>null}).then(code=>{process.exitCode=code;});`)},args.at(-1)],options)}).then(code=>{process.exitCode=code;});`;
    const child = spawn(process.execPath, ['-e', script, JSON.stringify(args)], { env: { ...env, SYNTHETIC_RELEASE: release, SYNTHETIC_SESSION: randomUUID() }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let text = '', errors = ''; child.stdout.on('data', bytes => { text += bytes; }); child.stderr.on('data', bytes => { errors += bytes; });
    const [code] = await once(child, 'close');
    const id = text.match(/\[dispatch\] started ([a-f\d-]{36})/)?.[1];
    if (id) { ids.push(id); releases.set(id, release); }
    return { code, id, text, errors };
  }
  return { repo, store, start, release: id => fs.writeFileSync(releases.get(id), 'done'), env };
}

test('detached stand-ins survive launcher exit; wait handles timeout, parallel completion and stop', async t => {
  const f = await fixture(t), first = await f.start('a.txt'), second = await f.start('b.txt');
  assert.equal(first.code, 0, first.text + first.errors); assert.equal(second.code, 0, second.text + second.errors);
  assert.equal(f.store.read(first.id).settled, undefined);
  assert.equal(await waitDetached({ ids: [first.id, second.id], timeout: 0 }, { store: f.store, stdout: { write() {} } }), 75);
  let text = '';
  const waiting = waitDetached({ ids: [first.id, second.id], timeout: 15 }, { store: f.store, stdout: { write: value => { text += value; } } });
  f.release(second.id); f.release(first.id);
  assert.equal(await waiting, 0); assert.match(text, /exit 0 reason exit/);
  const third = await f.start('a.txt'); assert.equal(third.code, 0, third.text + third.errors);
  assert.equal(await run(['stop', third.id, '--no-resume', '--cwd', f.repo], { env: f.env, launch: () => assert.fail('stop launches no CLI') }), 0);
  assert.equal(await waitDetached({ ids: [third.id], timeout: 15 }, { store: f.store, stdout: { write: value => { text += value; } } }), 0);
  assert.match(text, /reason killed/);
});

test('detach still refuses overlapping scope and an execution without confirmed minutes', async t => {
  const f = await fixture(t), first = await f.start('a.txt');
  assert.equal(first.code, 0, first.text + first.errors);
  const overlap = await f.start('a.txt'); assert.equal(overlap.code, 1); assert.match(overlap.text, /overlap/i);
  const unconfirmed = await f.start('b.txt', false); assert.equal(unconfirmed.code, 1); assert.match(unconfirmed.text, /roundtable|confirm/i);
});
