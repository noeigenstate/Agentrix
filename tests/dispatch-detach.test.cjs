const { loadWithStubs } = require('./helpers/load-with-stubs.cjs');
const { dispatchEnvironment } = require('./fixtures/team-isolation.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { EventEmitter, once } = require('node:events');
const { spawn, execFileSync } = require('node:child_process');
const { argumentsOf, startDetached, waitDetached, run, renderDispatchLine } = require('../integration/dispatch.cjs');
const { started: startEvent, ended: endEvent, waiting: waitingEvent } = require('./helpers/dispatch-events.cjs');
const { DetachedRuns } = require('../integration/dispatch-outbox.cjs');
const { updateDispatchSeats, updateDispatchLaunchSeats } = require('../electron/features/terminal-events/bootstrap-file.cjs');

test('receipt rename retries sharing errors with bounded backoff while a reader holds the file', async t => {
  const base = receipts(t), id = randomUUID(), delays = [], failures = ['EPERM', 'EACCES', 'EBUSY'];
  base.create({ id, createdAt: Date.now() });
  const reader = await fs.promises.open(base.file(id), 'r');
  let attempts = 0;
  const store = new DetachedRuns(base.directory, {
    rename: async (from, to) => {
      assert.equal(JSON.parse(await reader.readFile('utf8') || '{}').id || id, id);
      if (attempts < failures.length) throw Object.assign(new Error('Synthetic reader sharing violation'), { code: failures[attempts++] });
      attempts++; await reader.close(); return fs.promises.rename(from, to);
    }, delay: async ms => { delays.push(ms); },
  });
  await store.update(id, { startedLine: 'started' });
  assert.equal(attempts, 4); assert.deepEqual(delays, [5, 10, 20]); assert.equal(store.read(id).startedLine, 'started');
});

test('receipt retries stop at their bound and a later update retains failed changes', async t => {
  const base = receipts(t), id = randomUUID(), delays = []; let blocked = true, attempts = 0;
  base.create({ id, createdAt: Date.now() });
  const store = new DetachedRuns(base.directory, { rename: async (from, to) => {
    attempts++; if (blocked) throw Object.assign(new Error('Synthetic locked receipt'), { code: 'EPERM' });
    return fs.promises.rename(from, to);
  }, delay: async ms => { delays.push(ms); } });
  await assert.rejects(store.update(id, { startedLine: 'started' }), { code: 'EPERM' });
  assert.equal(attempts, 8); assert.equal(delays.reduce((sum, ms) => sum + ms, 0), 635);
  blocked = false; await store.update(id, { endedLine: 'ended', settled: true });
  assert.equal(store.read(id).startedLine, 'started'); assert.equal(store.read(id).endedLine, 'ended');
});

test('receipt readers retain the last complete value across missing and partial replacements', t => {
  const store = receipts(t), id = randomUUID(); store.create({ id, createdAt: Date.now() });
  fs.writeFileSync(store.file(id), '{'); assert.equal(store.read(id).id, id);
  const fresh = new DetachedRuns(store.directory); assert.equal(fresh.read(id), undefined);
  fs.unlinkSync(store.file(id)); assert.equal(store.read(id).id, id); assert.equal(fresh.read(id), null);
});

test('wait reports an unknown id and still collects a known run, printing its start once across waits', async t => {
  const store = receipts(t), id = randomUUID(), unknown = randomUUID(); let text = '';
  store.create({ id, createdAt: Date.now(), settled: true, exitCode: 0, started: startEvent(id), ended: endEvent(id),
    startedLine: 'stale start', endedLine: 'stale end' });
  const output = { write: value => { text += value; } };
  assert.equal(await waitDetached({ ids: [unknown, id], timeout: 0 }, { store, stdout: output }), 1);
  assert.match(text, new RegExp(`unknown run ${unknown}`)); assert.match(text, new RegExp(`ended ${id}`));
  await waitDetached({ ids: [id], timeout: 0 }, { store: new DetachedRuns(store.directory), stdout: output });
  assert.equal(text.split(`[dispatch] started ${id}`).length, 2);
  assert.doesNotMatch(text, /stale/);
});

test('legacy receipt text remains opaque and cannot set the machine-readable outcome', async t => {
  const store = receipts(t), id = randomUUID(), events = [];
  const endedLine = `[dispatch] ended ${id} · exit 0 reason permission`;
  fs.writeFileSync(store.file(id), JSON.stringify({ id, settled: true, exitCode: 0, endedLine }));
  assert.equal(store.read(id).legacy, true);
  let text = '';
  assert.equal(await waitDetached({ ids: [id], timeout: 0 }, { store, onEvent: event => events.push(event), stdout: { write: value => { text += value; } } }), 0);
  assert.equal(text, endedLine + '\n');
  assert.deepEqual(events.map(event => [event.type, event.reason, event.result.source]), [['dispatch.ended', 'unknown', 'legacy']]);
  fs.writeFileSync(store.file(id), JSON.stringify({ id, format: 'agentrix.detached-run', version: 3, endedLine }));
  assert.throws(() => store.read(id), { code: 'wire.unsupported_version' });
});

test('wait for any returns on a missing receipt while ordinary wait keeps observing the other runs', async t => {
  const store = receipts(t), id = randomUUID(), unknown = randomUUID();
  store.create({ id, createdAt: Date.now() });
  for (const untilAny of [true, false]) {
    let text = '', observed = false;
    const status = await waitDetached({ ids: [unknown, id], timeout: 240 }, {
      store, untilAny, stdout: { write: value => { text += value; } },
      observe: async () => { observed = true; },
    });
    assert.equal(observed, !untilAny);
    assert.equal(status, untilAny ? 1 : 75);
    assert.ok(text.includes(`[dispatch] unknown run ${unknown}\n`));
    assert.ok(text.includes(`[dispatch] still running ${id} `));
  }
});

test('detached startup reports an owner wait while status can read it and claim the eventual start', async t => {
  const store = receipts(t), statuses = [];
  let id, text = '', status = '';
  const launch = (_file, args) => {
    id = path.basename(args.at(-1), '.json');
    const child = new EventEmitter();
    child.unref = () => {};
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  store.observe = async (check, timeout) => {
    assert.equal(timeout, 60_000);
    await store.update(id, { admitted: true, waiting: waitingEvent(id, 'waiting for the owner') });
    assert.equal(check(), undefined);
    assert.equal(await waitDetached({ ids: [id], timeout: 0 }, { store, stdout: { write: line => { status += line; } } }), 75);
    await store.update(id, { started: startEvent(id), waiting: null });
    assert.equal(store.claimStart(id), true);
    return check();
  };
  const code = await startDetached(['codex', '--detach', '--role', 'review', '--title', 'Synthetic wait', '--model', 'gpt-6.1-sol', '--effort', 'high',
    '--cwd', store.directory, '--brief', 'brief', '--out', 'out'], {
    store, env: {}, launch, stdout: { write: line => { text += line; } }, onTiming: info => statuses.push(info),
  });
  assert.equal(code, 0);
  assert.match(status, /still running.*waiting for the owner/);
  assert.match(text, /waiting for the owner\n\[dispatch\] started/);
  assert.equal(statuses[0].waiting.message, 'waiting for the owner');
  assert.equal(store.read(id).waiting, null);
});

test('detached launcher saves absolute cwd and notices a helper load failure immediately', async t => {
  const store = receipts(t); let saved, text = '';
  const result = await startDetached(['claude', '--detach', '--role', 'review', '--title', 'Synthetic crash', '--model', 'sonnet', '--effort', 'high', '--permission', 'plan', '--cwd', path.relative(process.cwd(), store.directory), '--brief', 'brief.md', '--out', 'answer.md'], {
    store, stdout: { write: value => { text += value; } }, launch: (_file, args, options) => {
      const id = path.basename(args.at(-1), '.json'), child = new EventEmitter(); saved = store.read(id);
      assert.equal(saved.argv[saved.argv.indexOf('--cwd') + 1], options.cwd); assert.ok(path.isAbsolute(options.cwd));
      child.unref = () => {}; queueMicrotask(() => { child.emit('spawn'); child.emit('exit', 1, null); }); return child;
    },
  });
  assert.equal(result, 1); assert.match(text, /failed to start/); assert.equal(store.read(saved.id).settled, true);
});

test('unadmitted helper timeout records settlement after observing its exit', async t => {
  const store = receipts(t); let id, killed = false;
  store.observe = async () => null;
  const code = await startDetached(['claude', '--detach', '--role', 'review', '--title', 'Synthetic timeout', '--model', 'sonnet', '--effort', 'high', '--permission', 'plan', '--cwd', store.directory, '--brief', 'brief', '--out', 'out'], {
    store, stdout: { write() {} }, launch: (_file, args) => {
      id = path.basename(args.at(-1), '.json');
      const child = new EventEmitter();
      child.unref = () => {};
      child.kill = () => { killed = true; queueMicrotask(() => child.emit('exit', 1, null)); };
      queueMicrotask(() => child.emit('spawn')); return child;
    },
  });
  assert.equal(code, 1); assert.equal(killed, true); assert.equal(store.read(id).settled, true);
});

test('a detached Codex helper keeps the seat it parsed if the bootstrap changes before the child starts', async t => {
  const store = receipts(t), bootstrap = path.join(store.directory, 'bootstrap.json');
  const first = { developer: { model: 'gpt-6.2-sol', effort: 'high', fast: true } };
  updateDispatchSeats(bootstrap, first);
  const argv = ['codex', '--detach', '--role', 'review', '--title', 'Fixture', '--seat', 'developer',
    '--cwd', store.directory, '--brief', 'brief.md', '--out', 'answer.md', '--model', 'gpt-6.1-sol', '--effort', 'medium'];
  let childOptions;
  const launchSnapshot = { developer: { model: 'gpt-6.1-sol', effort: 'medium', fast: false } };
  updateDispatchLaunchSeats(bootstrap, launchSnapshot);
  const launchEnv = { AGENTRIX_BOOTSTRAP: bootstrap };
  const code = await startDetached(argv, { store, env: launchEnv, stdout: { write() {} },
    launch: (_file, args, { env }) => {
      updateDispatchSeats(bootstrap, { developer: { model: 'gpt-6.2-astra', effort: 'xhigh', fast: false } });
      updateDispatchLaunchSeats(bootstrap, { developer: { model: 'gpt-6.2-astra', effort: 'xhigh', fast: false } });
      const { argv: saved } = store.read(path.basename(args.at(-1), '.json'));
      childOptions = argumentsOf(saved, env, JSON.parse(env.AGENTRIX_DISPATCH_PINNED_SEATS ?? 'null'));
      const child = new EventEmitter();
      child.unref = () => {};
      queueMicrotask(() => { child.emit('spawn'); child.emit('exit', 1, null); });
      return child;
    },
  });
  assert.equal(code, 1);
  assert.deepEqual([childOptions?.model, childOptions?.effort, childOptions?.fast], ['gpt-6.2-sol', 'high', true]);
});

test('wait rejects a reused PID whose socket identity differs from the run lease', async t => {
  const store = receipts(t), id = randomUUID(), filename = path.resolve(__dirname, '../integration/dispatch.cjs');
  const { Module, createRequire } = require('node:module'), realRequire = createRequire(filename), loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = module.paths;
  loaded.require = name => name === 'node:net' ? { createConnection: () => {
    const socket = new EventEmitter(); socket.setTimeout = () => {}; socket.destroy = () => {};
    queueMicrotask(() => socket.emit('data', Buffer.from(randomUUID()))); return socket;
  } } : realRequire(name);
  loaded._compile(fs.readFileSync(filename, 'utf8'), filename);
  store.create({ id, createdAt: Date.now(), helperPid: process.pid, lease: { port: 123, token: randomUUID() } });
  let text = '';
  assert.equal(await loaded.exports.waitDetached({ ids: [id], timeout: 0 }, { store, stdout: { write: value => { text += value; } } }), 0);
  assert.match(text, /helper exited without a final receipt/); assert.doesNotMatch(text, /still running/);
});

test('an uncertain identity probe cannot declare a live helper dead', async t => {
  const store = receipts(t), id = randomUUID(); store.create({ id, helperPid: 123, createdAt: Date.now() }); let text = '';
  assert.equal(await waitDetached({ ids: [id], timeout: 0 }, { store, alive: () => null, stdout: { write: value => { text += value; } } }), 75);
  assert.match(text, /still running/); assert.doesNotMatch(text, /helper exited/);
});

test('receipt pruning removes only old settled receipts and their launcher logs', t => {
  const store = receipts(t), old = randomUUID(), running = randomUUID(), now = Date.now();
  store.create({ id: old, createdAt: now - 8 * 86400000, settled: true });
  store.create({ id: running, createdAt: now - 8 * 86400000 });
  fs.writeFileSync(store.file(old) + '.log', 'old'); store.prune(now);
  assert.equal(fs.existsSync(store.file(old)), false); assert.equal(fs.existsSync(store.file(old) + '.log'), false);
  assert.equal(fs.existsSync(store.file(running)), true);
});

test('concurrent reader process cannot break four hundred receipt replacements', async t => {
  const store = receipts(t), id = randomUUID(); store.create({ id, createdAt: Date.now() });
  const code = `const fs=require('node:fs'); const file=process.argv[1];
    const watcher=fs.watch(require('node:path').dirname(file),()=>{fs.readFile(file,()=>{});});
    process.on('message',()=>{watcher.close();process.disconnect();});process.send('ready');`;
  const reader = spawn(process.execPath, ['-e', code, store.file(id)], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
  const closed = once(reader, 'close'); t.after(() => { if (reader.exitCode === null) reader.kill(); });
  await once(reader, 'message');
  try {
    for (let index = 0; index < 400; index++) await store.update(id, { index });
    assert.equal(store.read(id).index, 399);
  } finally { reader.send('stop'); await closed; }
});

test('receipt write failures cannot prevent the signed start and end events', async t => {
  const store = receipts(t), id = randomUUID(), filename = path.resolve(__dirname, '../integration/dispatch.cjs');
  const { Module, createRequire } = require('node:module'), { PassThrough } = require('node:stream');
  const realRequire = createRequire(filename), loaded = new Module(filename, module), events = [], attempts = [];
  loaded.filename = filename; loaded.paths = module.paths;
  const bootstrap = path.join(store.directory, 'bootstrap.json'), brief = path.join(store.directory, 'brief.md');
  fs.writeFileSync(brief, 'Synthetic receipt failure'); fs.writeFileSync(bootstrap, JSON.stringify({ pipeName: 'synthetic-pipe', projectId: 'synthetic', sessionKey: 'synthetic-key' }));
  loaded.require = name => {
    if (name.replaceAll('\\', '/').endsWith('/features/team/team.cjs')) return { ...realRequire(name), projectTeam: () => null };
    if (name.endsWith('dispatch-outbox.cjs')) return { ...realRequire(name), DetachedRuns: class extends DetachedRuns {
      update(runId, changes) {
        if (changes.startedLine || changes.endedLine) { attempts.push(changes); throw Object.assign(new Error('Synthetic locked receipt'), { code: 'EPERM' }); }
        return super.update(runId, changes);
      }
    } };
    if (name === 'node:net') return {
      createServer: () => { const server = new EventEmitter(); server.listen = (_port, _host, callback) => queueMicrotask(callback); server.address = () => ({ port: 123 }); server.close = callback => callback(); return server; },
      connect: () => { const socket = new EventEmitter(); socket.setTimeout = () => {}; socket.destroy = () => socket.emit('close');
        socket.end = (bytes, callback) => { events.push(JSON.parse(bytes)); callback(); socket.emit('close'); }; queueMicrotask(() => socket.emit('connect')); return socket; },
    };
    return realRequire(name);
  };
  loaded._compile(fs.readFileSync(filename, 'utf8'), filename);
  store.create({ id, source: 'dispatch', createdAt: Date.now(), argv: ['claude', '--role', 'review', '--title', 'Synthetic failure', '--model', 'sonnet', '--effort', 'high', '--permission', 'plan', '--cwd', store.directory, '--brief', brief, '--out', path.join(store.directory, 'answer.md')] });
  const code = await loaded.exports.runDetached(store.file(id), {
    env: { PATH: '', HOME: store.directory, USERPROFILE: store.directory, CODEX_HOME: path.join(store.directory, 'codex'), CLAUDE_CONFIG_DIR: path.join(store.directory, 'claude'), AGENTRIX_BOOTSTRAP: bootstrap },
    resolveExecutable: () => ({ file: 'synthetic-worker', args: [] }), launch: () => {
      const child = new EventEmitter(); child.pid = 123; child.exitCode = null; child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.stdin.once('finish', () => queueMicrotask(() => {
        child.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: id, model: 'claude-sonnet-5-5', effort: 'high', fast_mode: false }) + '\n');
        child.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', session_id: id, result: 'done' }) + '\n');
        child.stdout.end(); child.stderr.end(); child.exitCode = 0; child.emit('exit', 0); child.emit('close', 0, null);
      })); return child;
    },
  });
  assert.equal(code, 0); assert.equal(events.filter(event => event.type === 'dispatch-start').length, 1);
  assert.equal(events.filter(event => event.type === 'dispatch-end').length, 1); assert.equal(attempts.length, 2);
  const { settled, endedAt } = store.read(id);
  const { startedAt, confirmedAt } = attempts[0];
  assert.equal(settled, true);
  assert.ok(startedAt <= confirmedAt && confirmedAt <= endedAt && endedAt <= Date.now());
});

function receipts(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-detach-receipts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return new DetachedRuns(root);
}

test('standalone Linux receipts use separate uid roots while Windows keeps its per-user temp root', t => {
  const store = receipts(t), filename = path.resolve(__dirname, '../integration/dispatch.cjs');
  const temporary = fs.realpathSync(store.directory);
  const legacy = path.join(temporary, 'agentrix-dispatch'); fs.mkdirSync(legacy);
  function locate(platform, uid) {
    const processView = Object.create(process);
    Object.defineProperty(processView, 'platform', { value: platform });
    processView.getuid = () => uid;
    const { detachedRuns } = loadWithStubs(filename, (name, realRequire) => {
      if (name === 'node:process') return processView;
      if (name === 'node:os') return { ...realRequire(name), tmpdir: () => store.directory };
      if (name === 'node:fs') return { ...fs, lstatSync: (...args) => {
        if (platform === 'linux') assert.notEqual(args[0], legacy, 'Linux must never inspect the other owner\'s shared root');
        const stat = fs.lstatSync(...args);
        return stat && { ...stat, uid, mode: 0o40700, isDirectory: () => stat.isDirectory(), isSymbolicLink: () => stat.isSymbolicLink() };
      } };
      if (name.replaceAll('\\', '/').endsWith('/features/team/team.cjs')) return { ...realRequire(name), projectTeam: () => null };
      return realRequire(name);
    });
    return detachedRuns(store.directory, true).directory;
  }
  const first = locate('linux', 1001), second = locate('linux', 1002);
  assert.ok(first.startsWith(path.join(temporary, 'agentrix-dispatch-1001') + path.sep));
  assert.ok(second.startsWith(path.join(temporary, 'agentrix-dispatch-1002') + path.sep));
  assert.notEqual(first, second);
  fs.rmdirSync(legacy);
  // Windows's temp root is already per-user; its legacy receipt path remains stable.
  assert.ok(locate('win32', 1001).startsWith(legacy + path.sep));
});

test('prune removes old orphaned receipt temp files and preserves recent replacements', t => {
  const store = receipts(t), now = Date.now(), old = store.file(randomUUID()) + '.123.tmp', recent = store.file(randomUUID()) + '.456.tmp';
  fs.writeFileSync(old, 'orphan'); fs.writeFileSync(recent, 'active');
  const past = new Date(now - 8 * 86400000); fs.utimesSync(old, past, past);
  store.prune(now);
  assert.equal(fs.existsSync(old), false); assert.equal(fs.existsSync(recent), true);
});

test('a fast helper exit cannot overwrite a finished receipt through the parent stale cache', async t => {
  const store = receipts(t), disk = new DetachedRuns(store.directory), read = store.read.bind(store); let id, initial;
  store.observe = () => new Promise(() => {});
  store.read = (runId, options) => options?.fresh ? read(runId, options) : initial || read(runId);
  const code = await startDetached(['claude', '--detach', '--role', 'review', '--title', 'Synthetic fast exit', '--model', 'sonnet', '--effort', 'high', '--permission', 'plan', '--cwd', store.directory, '--brief', 'brief', '--out', 'out'], {
    store, stdout: { write() {} }, launch: (_file, args) => {
      id = path.basename(args.at(-1), '.json'); initial = read(id);
      const child = new EventEmitter(); child.unref = () => {};
      queueMicrotask(() => {
        child.emit('spawn');
        const ended = endEvent(id);
        void disk.update(id, { started: startEvent(id), ended, endedLine: renderDispatchLine(ended), settled: true, exitCode: 0 }).then(() => child.emit('exit', 0, null));
      }); return child;
    },
  });
  assert.equal(code, 0); assert.equal(disk.read(id).exitCode, 0); assert.match(disk.read(id).endedLine, /exit 0/);
});

test('admission timeout waits for helper exit, keeps a concurrently finished receipt and reports the configured deadline', async t => {
  const store = receipts(t), disk = new DetachedRuns(store.directory);
  const args = ['claude', '--detach', '--role', 'review', '--title', 'Fixture', '--model', 'sonnet', '--effort', 'high',
    '--permission', 'plan', '--cwd', store.directory, '--brief', 'brief', '--out', 'out'];
  store.observe = async () => null;
  for (const completed of [true, false]) {
    const events = [];
    let id;
    const code = await startDetached(args, {
      store, timeout: 2500, onEvent: event => events.push(event), launch: (_file, words) => {
        id = path.basename(words.at(-1), '.json');
        const child = new EventEmitter();
        child.unref = () => {};
        child.kill = () => {
          queueMicrotask(async () => {
            if (completed) await disk.update(id, { started: startEvent(id), ended: endEvent(id), settled: true, exitCode: 0 });
            child.emit('exit', completed ? 0 : 1, null);
          });
        };
        queueMicrotask(() => child.emit('spawn'));
        return child;
      },
    });
    assert.equal(code, completed ? 0 : 1);
    assert.equal(disk.read(id).exitCode, code);
    if (completed) assert.equal(events[0].type, 'dispatch.started');
    else {
      assert.equal(events[0].type, 'dispatch.start-failed');
      assert.match(renderDispatchLine(events[0]), /within 2\.5 s/);
    }
  }
});

test('an unreadable receipt stays running while other selected receipts settle', async t => {
  const store = receipts(t), damaged = randomUUID(), healthy = randomUUID();
  for (const id of [damaged, healthy]) store.create({ id, createdAt: Date.now() });
  const initial = store.read(damaged);
  fs.writeFileSync(store.file(damaged), JSON.stringify({ ...initial, version: 27 }));
  await store.update(healthy, { settled: true, ended: endEvent(healthy), exitCode: 0 });
  const events = [];
  assert.equal(await waitDetached({ ids: [damaged, healthy], timeout: 0 }, { store, onEvent: event => events.push(event) }), 75);
  assert.deepEqual(events.filter(event => event.type !== 'dispatch.notice').map(event => [event.type, event.id]), [
    ['dispatch.ended', healthy], ['dispatch.running', damaged],
  ]);
  fs.writeFileSync(store.file(damaged), JSON.stringify(initial));
  await store.update(damaged, { settled: true, ended: endEvent(damaged), exitCode: 0 });
  assert.equal(await waitDetached({ ids: [damaged], timeout: 0 }, { store, onEvent: event => events.push(event) }), 0);
  assert.equal(events.at(-1).id, damaged);
  assert.equal(events.at(-1).type, 'dispatch.ended');
});

test('conditional parent settlement refuses a transient fresh read and preserves an ended receipt', async t => {
  const store = receipts(t), id = randomUUID(); store.create({ id, settled: true, exitCode: 0, endedLine: 'ended' });
  const disk = new DetachedRuns(store.directory), read = store.read.bind(store);
  store.read = (runId, options) => options?.fresh ? undefined : read(runId);
  assert.equal(await store.update(id, { settled: true, exitCode: 1 }, { unlessEnded: true }), undefined);
  assert.equal(disk.read(id).exitCode, 0);
});

test('parent settlement rechecks completion after a sharing-error backoff', async t => {
  const disk = receipts(t), id = randomUUID(); disk.create({ id, createdAt: Date.now() }); let attempts = 0;
  const store = new DetachedRuns(disk.directory, {
    rename: async () => { attempts++; throw Object.assign(new Error('Synthetic sharing violation'), { code: 'EPERM' }); },
    delay: async () => {
      // Simulate the other process's distinct temporary file without sharing this process's PID suffix.
      const temporary = disk.file(id) + '.helper.tmp';
      fs.writeFileSync(temporary, JSON.stringify({ ...disk.read(id), endedLine: 'ended successfully', settled: true, exitCode: 0 }));
      fs.renameSync(temporary, disk.file(id));
    },
  });
  const final = await store.update(id, { settled: true, exitCode: 1 }, { unlessEnded: true });
  assert.equal(attempts, 1); assert.equal(final.exitCode, 0); assert.equal(disk.read(id).exitCode, 0);
});

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
    ended: endEvent(id, 'exit', { agent: 'claude', exitCode: index }) });
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
    observe: check => new Promise(resolve => { inspect = async () => { if (await check()) resolve(true); }; registered(); void inspect(); }) });
  await ready;
  await store.update(ids[1], { settled: true, ended: endEvent(ids[1]) }); await inspect(); await inspect();
  await store.update(ids[0], { settled: true, ended: endEvent(ids[0]) }); await inspect();
  assert.equal(await waiting, 0);
  assert.equal(text.split('[dispatch] ended ').length, 3);
  assert.ok(text.indexOf(ids[1]) < text.indexOf(ids[0]));
});

test('wait for any detached run returns when the first settles and reports the others as running', { timeout: 5000 }, async t => {
  const store = receipts(t), ids = [randomUUID(), randomUUID()];
  for (const id of ids) store.create({ id, createdAt: Date.now() });
  const watching = Promise.withResolvers(), controller = new AbortController();
  t.after(() => controller.abort());
  let text = '';
  const waiting = waitDetached({ ids, timeout: 240 }, { store, untilAny: true, signal: controller.signal, stdout: { write: value => { text += value; } },
    observe: (check, timeout, options) => {
      const observed = store.observe(check, timeout, options);
      watching.resolve();
      return observed;
    } });
  await watching.promise;
  await store.update(ids[1], { settled: true, ended: endEvent(ids[1]) });
  assert.equal(await waiting, 0);
  assert.ok(text.includes(`[dispatch] ended ${ids[1]} `));
  assert.ok(text.includes(`[dispatch] still running ${ids[0]} `));
});

test('wait for any ignores a cleared owner prompt and wakes on the next active prompt', async t => {
  const store = receipts(t), id = randomUUID();
  store.create({ id, createdAt: Date.now(), ownerWait: null, ownerWaitSequence: 1 });
  const updates = [];
  const ownerWait = 'waiting for the owner: answer a Claude Code question';
  const result = await waitDetached({ ids: [id], timeout: 240 }, {
    store, untilAny: true, stdout: { write() {} },
    onTiming: status => updates.push(status),
    async observe(check) {
      assert.equal(await check(), undefined);
      await store.update(id, { ownerWait, ownerWaitSequence: 2 });
      assert.equal(await check(), true);
    },
  });
  assert.equal(result, 75);
  assert.deepEqual(updates.map(status => [status.ownerWait, status.ownerWaitSequence]), [[ownerWait, 2]]);
});

test('detached helper uses an independent process group, file stdio and the original start receipt', async t => {
  const store = receipts(t), brief = path.join(store.directory, 'brief.md');
  fs.writeFileSync(brief, 'Synthetic brief');
  let text = '', launched, timing;
  const args = ['claude', '--detach', '--role', 'review', '--title', 'Synthetic', '--model', 'sonnet', '--effort', 'high', '--permission', 'plan', '--cwd', store.directory, '--brief', brief, '--out', path.join(store.directory, 'answer.md')];
  const result = await startDetached(args, { store, stdout: { write: value => { text += value; } }, onTiming: status => { timing = status; }, launch: (file, argv, options) => {
    assert.equal(file, process.execPath); assert.equal(options.detached, true); assert.equal(options.windowsHide, true);
    assert.equal(options.stdio[0], 'ignore'); assert.equal(typeof options.stdio[1], 'number');
    assert.equal(options.stdio[1], options.stdio[2]);
    const id = path.basename(argv.at(-1), '.json'), child = new EventEmitter();
    launched = store.read(id); assert.ok(!launched.argv.includes('--detach'));
    child.unref = () => {}; child.kill = () => assert.fail('A confirmed detached helper must survive');
    queueMicrotask(() => {
      child.emit('spawn');
      void store.update(id, { admitted: true, startedAt: 1000, confirmedAt: 2000, started: startEvent(id, 'claude', { model: 'synthetic', pid: 123 }) });
    });
    return child;
  } });
  assert.equal(result, 0); assert.match(text, new RegExp(`started ${launched.id} .*session synthetic`));
  assert.equal(store.read(launched.id).settled, undefined);
  assert.deepEqual(timing, { id: launched.id, startedAt: 1000, confirmedAt: 2000, endedAt: undefined });
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
  const env = { ...dispatchEnvironment(), HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex') };
  for (const key of Object.keys(env)) if (/^CLAUDECODE$|^ANTHROPIC_/.test(key)) delete env[key];
  const store = new DetachedRuns(path.join(repo, '.git/agentrix/detached')), ids = [], releases = new Map();
  t.after(async () => {
    for (const id of ids) {
      if (!store.read(id).settled) {
        await run(['stop', id, '--no-resume', '--cwd', repo], { env, launch: () => assert.fail('stop launches no CLI') });
        await waitDetached({ ids: [id], timeout: 5 }, { store, stdout: { write() {} } });
      }
      assert.equal(store.read(id).settled, true, `detached run ${id} did not settle during cleanup`);
    }
    // A settled receipt precedes helper exit. On Windows its repo cwd can still block removal.
    if (process.platform === 'win32') {
      const live = new Map();
      for (const id of ids) {
        const { helperPid, started } = store.read(id);
        const workerPid = started?.pid;
        if (helperPid) live.set(helperPid, 'helper');
        if (workerPid) live.set(workerPid, 'worker');
      }
      if (live.size) await store.observe(() => {
        for (const pid of live.keys()) {
          try { process.kill(pid, 0); } catch (error) {
            if (error.code !== 'ESRCH') throw error;
            live.delete(pid);
          }
        }
        return live.size ? undefined : true;
      }, 5000);
      assert.equal(live.size, 0, `detached processes still alive: ${[...live].map(([pid, kind]) => `${kind} ${pid}`).join(', ')}`);
    }
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  async function start(scope) {
    const out = path.join(root, randomUUID() + '.md'), release = out + '.release';
    const args = ['claude', '--detach', '--role', 'exec', '--title', 'Synthetic detached', '--model', 'sonnet', '--effort', 'high',
      '--permission', 'acceptEdits', '--cwd', repo, '--brief', brief, '--out', out, '--allow', scope];
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
  assert.match(text.split('\n').find(line => line.startsWith(`[dispatch] ended ${third.id} `)) || '', /reason killed/, text);
});

test('detached workers with overlapping scopes both start and settle', async t => {
  const f = await fixture(t), first = await f.start('a.txt'), second = await f.start('a.txt');
  assert.equal(first.code, 0, first.text + first.errors);
  assert.equal(second.code, 0, second.text + second.errors);
  assert.equal(f.store.read(first.id).settled, undefined);
  assert.equal(f.store.read(second.id).settled, undefined);
  f.release(first.id); f.release(second.id);
  let text = '';
  assert.equal(await waitDetached({ ids: [first.id, second.id], timeout: 15 }, { store: f.store, stdout: { write: value => { text += value; } } }), 0);
  assert.match(text, new RegExp(first.id + '.*exit 0 reason exit'));
  assert.match(text, new RegExp(second.id + '.*exit 0 reason exit'));
});
