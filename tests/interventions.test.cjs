const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { projectTeam } = require('../electron/features/team/team.cjs');
const { RunInbox, MAX_INBOX } = require('../electron/features/team/inbox.cjs');
const { createInterventions } = require('../electron/features/agents/interventions.cjs');

function plannerRelay() {
  const sent = [], context = { Date, setTimeout, clearTimeout,
    sessions: new Map([['terminal', { sessionId: 'planner', codexActive: true, agent: 'codex' }]]),
    window: { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (channel, data) => sent.push({ channel, data }) } },
  };
  const main = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  vm.runInNewContext(main.slice(main.indexOf('const relays = new Map();'), main.indexOf('const interventions = createInterventions('))
    + '\nthis.sendParentPrompt = sendParentPrompt; this.relayResult = relayResult; this.relays = relays;', context);
  return { context, sent };
}

async function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentrix-interventions-')));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore', windowsHide: true });
  const team = projectTeam(repo, true), id = randomUUID();
  await team.admit({ title: 'Synthetic worker', role: '审查', agent: 'codex', model: 'test', cwd: repo, allow: [] }, id);
  const inbox = new RunInbox(team, id); await inbox.open();
  const target = { terminalId: 'terminal', callId: `dispatch:${id}`, parentSessionId: 'planner', confirmed: true, done: false,
    route: 'dispatch', runId: id, title: 'Synthetic worker', cwd: repo, projectPath: repo, local: true };
  const notifications = [];
  const api = createInterventions({ resolve: () => target, sendParentPrompt: (terminal, text) => { notifications.push({ terminal, text }); }, now: () => 1000 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, repo, team, id, inbox, target, notifications, api };
}

test('send queues exact text, journals and notifies its planner; stop is a separate control', async t => {
  const f = await fixture(t), text = '保留草稿\nUse the smaller change.';
  const receipt = await f.api.interveneAgent('terminal', f.target.callId, text);
  assert.deepEqual(receipt, { id: receipt.id, callId: f.target.callId, text, at: 1000, route: 'dispatch', status: 'queued' });
  assert.deepEqual(await f.inbox.take(), [{ id: receipt.id, text, at: 1000 }]);
  assert.deepEqual(await f.inbox.take(), []);
  assert.match(f.notifications[0].text, /已排队，工作者本次运行结束后接着处理/);
  assert.ok(f.notifications[0].text.includes(`dispatch.cjs stop ${f.id}`));
  assert.equal(f.team.entries().filter(entry => entry.type === 'intervention').length, 1);
  assert.ok(fs.readFileSync(f.team.memory, 'utf8').includes('保留草稿\\nUse the smaller change.'));
  const stopped = await f.api.stopAgent('terminal', f.target.callId);
  assert.deepEqual(await f.inbox.take(), [{ id: stopped.id, type: 'stop', at: 1000 }]);
  assert.equal(stopped.text, '停下'); assert.match(f.notifications[1].text, /业主要求停下/);
  assert.equal(f.team.entries().filter(entry => entry.type === 'stop').length, 1);
});

test('Task calls relay through the original parent and record the owner message without writing an inbox', async t => {
  const f = await fixture(t);
  Object.assign(f.target, { route: 'parent', callId: 'agent:tool-use-1' });
  const receipt = await f.api.interveneAgent('terminal', f.target.callId, 'Use the existing parser.');
  assert.equal(receipt.route, 'parent');
  assert.equal(f.notifications[0].text, '请转告子代理「Synthetic worker」：Use the existing parser.');
  await f.api.stopAgent('terminal', f.target.callId);
  assert.equal(f.notifications[1].text, '业主要求停下工作者「Synthetic worker」。');
  assert.equal(fs.statSync(f.inbox.file).size, 0);
  assert.deepEqual(f.team.entries().map(entry => entry.type), ['intervention', 'stop']);
});

test('invalid text, ownership, unconfirmed or finished targets and unavailable dispatch transports never send', async t => {
  const f = await fixture(t);
  for (const text of ['', '  ', 'x'.repeat(4001), null, '\x1b[2J']) await assert.rejects(f.api.interveneAgent('terminal', f.target.callId, text));
  await assert.rejects(f.api.interveneAgent('other-terminal', f.target.callId, 'hello'));
  await assert.rejects(f.api.interveneAgent('terminal', 'dispatch:../../other', 'hello'));
  const original = { ...f.target };
  for (const patch of [{ done: true }, { confirmed: false }, { parentSessionId: null }, { local: false }, { runId: randomUUID() }, { cwd: f.root }]) {
    Object.assign(f.target, original, patch);
    await assert.rejects(f.api.interveneAgent('terminal', f.target.callId, 'hello'));
  }
  assert.deepEqual(f.notifications, []); assert.equal(fs.statSync(f.inbox.file).size, 0);
  assert.deepEqual(f.team.entries(), []);
  Object.assign(f.target, original);
  await f.api.interveneAgent('terminal', f.target.callId, 'x'.repeat(4000));
});

test('parent rejection or rebinding withdraws its audit without publishing to the inbox or poisoning the next send', async t => {
  const f = await fixture(t); let reject = true, reads = 0;
  const api = createInterventions({ resolve: () => ({ ...f.target, parentSessionId: ++reads === 2 ? 'replacement' : 'planner' }),
    sendParentPrompt: () => assert.fail('rebound parent was sent a prompt') });
  await assert.rejects(api.interveneAgent('terminal', f.target.callId, 'hello'), /会话已变化/);
  const queue = createInterventions({ resolve: () => f.target, sendParentPrompt: () => { if (reject) throw new Error('queue unavailable'); } });
  await assert.rejects(queue.interveneAgent('terminal', f.target.callId, 'hello'), /queue unavailable/);
  assert.equal(fs.statSync(f.inbox.file).size, 0);
  const audit = f.team.entries();
  assert.deepEqual(audit.map(entry => entry.type), ['intervention', 'withdrawn', 'intervention', 'withdrawn']);
  assert.equal(audit[0].messageId, audit[1].messageId); assert.equal(audit[2].messageId, audit[3].messageId);
  assert.match(fs.readFileSync(f.team.memory, 'utf8'), /owner intervention withdrawn/);
  reject = false;
  await queue.interveneAgent('terminal', f.target.callId, 'next');
  assert.equal((await f.inbox.take()).length, 1);
});

test('queued owner sends preserve submission order even while the first planner notification is pending', async t => {
  const f = await fixture(t); let release;
  const waiting = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const api = createInterventions({ resolve: () => f.target, sendParentPrompt: () => ++calls === 1 ? waiting : undefined });
  const first = api.interveneAgent('terminal', f.target.callId, 'first');
  const second = api.interveneAgent('terminal', f.target.callId, 'second');
  release(); await Promise.all([first, second]);
  assert.deepEqual((await f.inbox.take()).map(entry => entry.text), ['first', 'second']);
});

test('the final empty check rejects late sends, and partial or duplicate records never replay', async t => {
  const f = await fixture(t), record = { id: randomUUID(), text: 'partial 汉字', at: 1000 }, bytes = Buffer.from(JSON.stringify(record) + '\n');
  fs.appendFileSync(f.inbox.file, bytes.subarray(0, bytes.length - 3));
  assert.deepEqual(await f.inbox.take(), []);
  fs.appendFileSync(f.inbox.file, bytes.subarray(bytes.length - 3));
  assert.deepEqual(await f.inbox.take(), [record]);
  fs.appendFileSync(f.inbox.file, JSON.stringify(record) + '\nmalformed\n');
  assert.deepEqual(await f.inbox.take(), []);
  assert.deepEqual(await f.inbox.take(true), []);
  await assert.rejects(f.api.interveneAgent('terminal', f.target.callId, 'too late'), /已结束/);
  assert.deepEqual(f.notifications, []);
});

test('inbox bounds, foreign repositories and a redirected inbox directory are rejected', async t => {
  const f = await fixture(t);
  fs.truncateSync(f.inbox.file, MAX_INBOX);
  await assert.rejects(f.api.interveneAgent('terminal', f.target.callId, 'too much'), /已满/);
  fs.truncateSync(f.inbox.file, 0);
  const foreign = path.join(f.root, 'foreign'); fs.mkdirSync(foreign);
  execFileSync('git', ['init', '-q'], { cwd: foreign, stdio: 'ignore', windowsHide: true });
  projectTeam(foreign, true); f.target.projectPath = foreign;
  await assert.rejects(f.api.interveneAgent('terminal', f.target.callId, 'wrong repo'), /不可用/);
  f.target.projectPath = f.repo;
  const original = path.dirname(f.inbox.file), outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
  fs.renameSync(original, original + '-original');
  fs.symlinkSync(outside, original, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.api.interveneAgent('terminal', f.target.callId, 'redirected'), /不可用/);
  assert.deepEqual(fs.readdirSync(outside), []); assert.deepEqual(f.notifications, []);
});

test('failed audit writes and rejected no-resume notifications leave no accepted control behind', async t => {
  const f = await fixture(t), append = fs.appendFileSync;
  const failure = t.mock.method(fs, 'appendFileSync', (file, ...args) => {
    if (file === f.team.journal) throw new Error('synthetic disk full');
    return append(file, ...args);
  });
  try { await assert.rejects(f.api.interveneAgent('terminal', f.target.callId, 'not accepted'), /disk full/); }
  finally { failure.mock.restore(); }
  assert.equal(fs.statSync(f.inbox.file).size, 0); assert.match(fs.readFileSync(f.team.memory, 'utf8'), /owner intervention withdrawn/);
  assert.deepEqual(f.notifications, []);
  await assert.rejects(f.team.queueControl(f.id, { id: randomUUID(), type: 'stop', at: 1000, noResume: true }, () => { throw new Error('planner gone'); }), /planner gone/);
  assert.deepEqual(await f.inbox.take(), []);
  await f.api.interveneAgent('terminal', f.target.callId, 'accepted after recovery');
  assert.equal((await f.inbox.take())[0].text, 'accepted after recovery');
});

test('a missing or destroyed main window rejects the planner relay immediately without sending or starting a timeout', async t => {
  for (const window of [null, { isDestroyed: () => true }, { isDestroyed: () => false, webContents: { isDestroyed: () => true } }]) {
    const { context, sent } = plannerRelay(); context.window = window;
    context.setTimeout = () => assert.fail('unavailable window started a relay timeout');
    await assert.rejects(context.sendParentPrompt('terminal', 'synthetic notice'), /无法把插话转给规划员/);
    assert.equal(context.relays.size, 0); assert.deepEqual(sent, []);
  }
  const f = await fixture(t), { context } = plannerRelay(); context.window = null;
  const api = createInterventions({ resolve: () => f.target, sendParentPrompt: context.sendParentPrompt });
  await assert.rejects(api.interveneAgent('terminal', f.target.callId, 'window gone'), /无法把插话转给规划员/);
  assert.deepEqual(await f.inbox.take(), []);
});

test('planner acknowledgments and renderer send errors settle the relay and remove its timeout', async () => {
  const { context, sent } = plannerRelay();
  const prompt = context.sendParentPrompt('terminal', 'synthetic notice');
  assert.equal(sent[0].channel, 'agents:relay'); assert.equal(sent[0].data.text, 'synthetic notice');
  context.relayResult(sent[0].data.id); await prompt;
  assert.equal(context.relays.size, 0);
  context.window.webContents.send = () => { throw new Error('renderer destroyed during send'); };
  await assert.rejects(context.sendParentPrompt('terminal', 'notice'), /renderer destroyed during send/);
  assert.equal(context.relays.size, 0);
});

test('a planner relay carries its exact three-second deadline and a late acknowledgment cannot revive it', async t => {
  const now = Date.UTC(2026, 10, 2);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now });
  const { context, sent } = plannerRelay();
  const prompt = context.sendParentPrompt('terminal', 'synthetic notice');
  const failed = assert.rejects(prompt, /无法把插话转给规划员/);
  assert.equal(sent[0].data.deadline, now + 3000);
  t.mock.timers.tick(2999); assert.equal(context.relays.size, 1);
  t.mock.timers.tick(1); await failed;
  assert.equal(context.relays.size, 0);
  context.relayResult(sent[0].data.id);
  assert.equal(context.relays.size, 0);
});

test('a stalled planner releases admission before the stale-lock threshold and the helper never sees its uncommitted control', { timeout: 25000 }, async t => {
  const f = await fixture(t), { context } = plannerRelay(), append = fs.appendFileSync;
  const api = createInterventions({ resolve: () => f.target, sendParentPrompt: context.sendParentPrompt });
  let observed = false, pending;
  const stat = fs.statSync;
  t.mock.method(fs, 'statSync', (file, ...args) => {
    const value = stat(file, ...args);
    if (file === path.join(f.team.directory, 'lock') && Date.now() - value.mtimeMs > 10000) observed = true;
    return value;
  });
  context.window.webContents.send = () => {
    // A different writer may append memory without taking the team lock while the renderer is stalled.
    append(f.team.memory, '\nConcurrent planner finding.\n');
    pending = f.inbox.take();
  };
  await assert.rejects(api.interveneAgent('terminal', f.target.callId, 'stalled notification'), /无法把插话转给规划员/);
  assert.deepEqual(await pending, []); assert.equal(observed, false, 'the helper never breaks a stale notification lock');
  assert.equal(context.relays.size, 0);
  assert.match(fs.readFileSync(f.team.memory, 'utf8'), /Concurrent planner finding\./);
  const offset = f.inbox.offset;
  await f.api.interveneAgent('terminal', f.target.callId, 'accepted after timeout');
  assert.equal((await f.inbox.take())[0].text, 'accepted after timeout'); assert.ok(f.inbox.offset > offset);
});

test('partial audit failures append withdrawals and preserve concurrent memory and journal appends', async t => {
  const f = await fixture(t), append = fs.appendFileSync;
  let failed = false;
  const failure = t.mock.method(fs, 'appendFileSync', (file, text, ...args) => {
    if (file === f.team.journal && !failed) {
      failed = true;
      append(file, String(text).slice(0, 12));
      append(f.team.memory, '\nConcurrent memory finding.\n');
      append(file, '\n' + JSON.stringify({ type: 'finding', title: 'Concurrent journal finding.' }) + '\n');
      throw new Error('partial audit write');
    }
    return append(file, text, ...args);
  });
  await assert.rejects(f.api.interveneAgent('terminal', f.target.callId, 'rejected partial write'), /partial audit write/);
  failure.mock.restore();
  assert.match(fs.readFileSync(f.team.memory, 'utf8'), /Concurrent memory finding\./);
  assert.match(fs.readFileSync(f.team.memory, 'utf8'), /owner intervention withdrawn/);
  assert.deepEqual(f.team.entries().map(entry => entry.type), ['finding', 'withdrawn']);
  assert.equal(f.team.entries()[0].title, 'Concurrent journal finding.');
  assert.deepEqual(await f.inbox.take(), []); assert.deepEqual(f.notifications, []);
});

test('a withdrawal after a partial journal append starts on its own line', async t => {
  const f = await fixture(t), append = fs.appendFileSync;
  let failed = false;
  const failure = t.mock.method(fs, 'appendFileSync', (file, text, ...args) => {
    if (file === f.team.journal && !failed) {
      failed = true; append(file, String(text).slice(0, 12)); throw new Error('partial journal');
    }
    return append(file, text, ...args);
  });
  await assert.rejects(f.api.interveneAgent('terminal', f.target.callId, 'not accepted'), /partial journal/);
  failure.mock.restore();
  assert.deepEqual(f.team.entries().map(entry => entry.type), ['withdrawn']);
  assert.deepEqual(await f.inbox.take(), []);
});

test('a failed inbox append is withdrawn without moving a reader offset backwards or replaying the rejected message', async t => {
  const f = await fixture(t), append = fs.appendFileSync;
  await f.api.interveneAgent('terminal', f.target.callId, 'first accepted message'); await f.inbox.take();
  const offset = f.inbox.offset;
  const failure = t.mock.method(fs, 'appendFileSync', (file, text, ...args) => {
    const result = append(file, text, ...args);
    if (file === f.inbox.file && JSON.parse(String(text)).text === 'rejected append') throw new Error('inbox write failed after append');
    return result;
  });
  await assert.rejects(f.api.interveneAgent('terminal', f.target.callId, 'rejected append'), /inbox write failed/);
  failure.mock.restore();
  assert.ok(fs.statSync(f.inbox.file).size > offset); assert.deepEqual(await f.inbox.take(), []);
  await f.api.interveneAgent('terminal', f.target.callId, 'next accepted message');
  assert.deepEqual((await f.inbox.take()).map(control => control.text), ['next accepted message']);
});

test('a failed partial inbox append retains room for withdrawal and leaves the final empty check usable', async t => {
  const f = await fixture(t), append = fs.appendFileSync;
  const control = { id: randomUUID(), text: 'synthetic failed partial write', at: 1000 };
  const record = JSON.stringify(control) + '\n', withdrawn = '\n' + JSON.stringify({ id: control.id, type: 'withdrawn', at: control.at }) + '\n';
  fs.writeFileSync(f.inbox.file, '\n'.repeat(MAX_INBOX - Buffer.byteLength(record + withdrawn)));
  let failed = false;
  const failure = t.mock.method(fs, 'appendFileSync', (file, text, ...args) => {
    if (file === f.inbox.file && !failed) {
      failed = true; append(file, String(text).slice(0, 20)); throw new Error('partial inbox');
    }
    return append(file, text, ...args);
  });
  await assert.rejects(f.team.queueControl(f.id, control), /partial inbox/);
  failure.mock.restore();
  assert.ok(fs.statSync(f.inbox.file).size <= MAX_INBOX);
  assert.deepEqual(await f.inbox.take(true), []);
});

test('worktrees share the inbox and accepting a send cannot race past the helper closing it', async t => {
  const f = await fixture(t);
  execFileSync('git', ['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '--allow-empty', '-qm', 'base'], {cwd:f.repo,stdio:'ignore',windowsHide:true});
  const peer = path.join(f.root, 'peer');
  execFileSync('git', ['worktree', 'add', '--detach', peer, 'HEAD'], {cwd:f.repo,stdio:'ignore',windowsHide:true});
  assert.equal(projectTeam(peer).directory, f.team.directory);
  f.target.projectPath = peer;
  const sending = f.api.interveneAgent('terminal', f.target.callId, 'racing finalization');
  const finishing = f.inbox.take(true);
  const [sent, final] = await Promise.allSettled([sending, finishing]);
  assert.equal(final.status, 'fulfilled');
  if (sent.status === 'fulfilled') {
    const controls = [...final.value, ...await f.inbox.take()];
    assert.equal(controls.filter(control => control.id === sent.value.id).length, 1);
  } else {
    assert.match(sent.reason.message, /已结束/);
    assert.deepEqual(final.value, []); assert.deepEqual(f.notifications, []);
  }
});
