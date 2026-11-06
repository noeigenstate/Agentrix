require('./fixtures/team-isolation.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { run, argumentsOf } = require('../integration/dispatch.cjs');
const { projectTeam } = require('../electron/features/team/team.cjs');
const { RunInbox } = require('../electron/features/team/inbox.cjs');
const { createInterventions } = require('../electron/features/agents/interventions.cjs');
const { createEventServer } = require('../electron/events.cjs');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const end = Date.now() + 15000;
  while (!predicate()) { if (Date.now() > end) throw new Error('Timed out waiting for synthetic intervention worker'); await pause(20); }
}

const fakeWorker = `
const fs = require('node:fs'), path = require('node:path'), {spawn} = require('node:child_process');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  const fixture = JSON.parse(fs.readFileSync(process.env.OWNER_FIXTURE, 'utf8'));
  let brief = '', turnRequest, threadRequest;
  const rpc = message => process.stdout.write(JSON.stringify(message) + '\\n');
  if (fixture.agent === 'codex') {
    brief = await new Promise(resolve => require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      const request=JSON.parse(line), p=request.params||{};
      if (request.id === undefined) return;
      if (['thread/resume','turn/start','turn/steer','turn/interrupt'].includes(request.method) && !p.threadId) return rpc({id:request.id,error:{code:-32600,message:'Invalid request: missing field \`threadId\`'}});
      fs.appendFileSync(path.join(fixture.root, 'rpc-methods'), request.method + '\\n');
      if (request.method === 'turn/start') {turnRequest=request; resolve(p.input.map(x=>x.text||'').join('\\n'));return;}
      if (request.method === 'turn/steer') return rpc({id:request.id,error:{code:-32602,message:'Turn ended'}});
      if (request.method === 'turn/interrupt') rpc({method:'turn/completed',params:{threadId:fixture.session,turn:{id:'fixture-turn',status:'interrupted'}}});
      let result={};
      if(request.method==='initialize')result={userAgent:'codex/0.166.0'};
      if(['thread/start','thread/resume'].includes(request.method)){threadRequest=request;result={thread:{id:fixture.badSession&&fs.existsSync(path.join(fixture.root,'count'))?fixture.otherSession:p.threadId||fixture.session,turns:[]},cwd:process.cwd(),sandbox:{type:p.sandbox==='read-only'?'readOnly':'workspaceWrite'}};}
      rpc({id:request.id,result});
    }));
  } else for await (const chunk of process.stdin) brief += chunk;
  const countFile = path.join(fixture.root, 'count');
  const round = (fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8')) : 0) + 1;
  fs.writeFileSync(countFile, String(round));
  fs.appendFileSync(path.join(fixture.root, 'captures'), JSON.stringify({ round, args: process.argv.slice(2), brief, pid: process.pid, threadRequest }) + '\\n');
  const id = round > 1 && fixture.badSession ? fixture.otherSession : fixture.session;
  if (fixture.agent === 'codex') {
    const directory = path.join(process.env.CODEX_HOME, 'sessions/2026/01/01'); fs.mkdirSync(directory, {recursive:true});
    const records = structuredClone(fixture.rollout);
    for (const record of records) {
      if (record.type === 'session_meta') record.payload.id = id;
      if (record.timestamp) record.timestamp = new Date(Date.parse(record.timestamp) + (round - 1) * 60000).toISOString();
      const payload = record.payload || {};
      if (payload.item?.completed_at_ms) payload.item.completed_at_ms += (round - 1) * 60000;
      for (const usage of [payload.info?.total_token_usage, payload.thread_token_usage]) if (usage) usage.output_tokens += (round - 1) * 150;
    }
    fs.appendFileSync(path.join(directory, 'rollout-fixture-' + id + '.jsonl'), records.filter(record => round === 1 || record.type !== 'session_meta').map(record => JSON.stringify(record) + '\\n').join(''));
    rpc({id:turnRequest.id,result:{turn:{id:'fixture-turn',status:'inProgress'}}});
    rpc({method:'turn/started',params:{threadId:id,turn:{id:'fixture-turn'}}});
  } else process.stdout.write(JSON.stringify({type:'system',subtype:'init',session_id:id,model:'claude-sonnet-5-5',effort:'high',fast_mode:false}) + '\\n');
  const claudeResult = () => process.stdout.write(JSON.stringify({type:'result',subtype:'success',session_id:id,result:'done '+round,usage:{input_tokens:5,cache_creation_input_tokens:2,cache_read_input_tokens:3,output_tokens:10},...(fixture.untimedRound === round ? {} : {duration_api_ms:1000}),total_cost_usd:0.01}) + '\\n');
  if (fixture.agent === 'claude' && fixture.untimedRound === round) claudeResult();
  if (round === 1 && fixture.descendant) {
    const descendant = spawn(process.execPath, ['-e', "const fs=require('node:fs');process.on('SIGTERM',()=>{});setInterval(()=>fs.writeFileSync(process.argv[1],String(Date.now())),30)", path.join(fixture.root,'heartbeat')], {stdio:'ignore',windowsHide:true});
    fs.writeFileSync(path.join(fixture.root,'descendant'), String(descendant.pid));
  }
  for (const end = Date.now() + 15000; !fs.existsSync(path.join(fixture.root, 'release-' + round)) && Date.now() < end;) await pause(20);
  if (round === 1 && fixture.outsideScope) fs.writeFileSync('outside.txt', 'Synthetic unauthorized change');
  if (fixture.agent === 'claude') { if (fixture.untimedRound !== round) claudeResult(); }
  else {
    rpc({method:'item/completed',params:{threadId:id,turnId:'fixture-turn',item:{id:'input',type:'userMessage',clientId:turnRequest.params.clientUserMessageId,content:turnRequest.params.input}}});
    rpc({method:'item/completed',params:{threadId:id,turnId:'fixture-turn',item:{id:'answer',type:'agentMessage',text:'done '+round,phase:'final_answer'}}});
    fs.writeFileSync(path.join(fixture.root, 'completed-' + round), 'done ' + round);
    rpc({method:'turn/completed',params:{threadId:id,turn:{id:'fixture-turn',status:'completed'}}});
  }
})().catch(error => {process.stderr.write(String(error));process.exitCode=1;});
`;

async function fixture(t, { agent = 'codex', descendant = false, badSession = false, outsideScope = false, readOnly = false, untimedRound = null, closeWithSignal = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentrix-owner-dispatch-'))), repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true }); fs.writeFileSync(path.join(repo, '.gitignore'), '.dispatch/\n'); fs.writeFileSync(path.join(repo, 'src/a.js'), 'base');
  const git = args => execFileSync('git', args, { cwd: repo, stdio: 'ignore', windowsHide: true });
  git(['init', '-q']); git(['add', '-A']); git(['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '-qm', 'base']);
  const team = projectTeam(repo, true), events = [], server = await createEventServer(event => events.push(event));
  const worker = path.join(root, 'worker.cjs'), brief = path.join(root, 'brief.md'), out = path.join(repo, '.dispatch/answer.md');
  fs.mkdirSync(path.dirname(out)); fs.writeFileSync(worker, fakeWorker); fs.writeFileSync(brief, 'Original synthetic scope.');
  const session = randomUUID(), config = path.join(root, 'fixture.json'), bootstrap = path.join(root, 'bootstrap.json');
  fs.writeFileSync(config, JSON.stringify({ root, agent, session, otherSession: randomUUID(), descendant, badSession, outsideScope, untimedRound,
    rollout: fs.readFileSync(path.join(__dirname, 'fixtures/codex-dispatch-rollout.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) }));
  fs.writeFileSync(bootstrap, JSON.stringify({pipeName:server.address,projectId:'synthetic-terminal',sessionKey:'synthetic-owner-fixture'}));
  const home = path.join(root, 'home'); fs.mkdirSync(home);
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: home, CODEX_HOME: path.join(home, 'codex'), CLAUDE_CONFIG_DIR: path.join(home, 'claude'), AGENTRIX_BOOTSTRAP: bootstrap, OWNER_FIXTURE: config };
  delete env.AGENTRIX_READING_NOTE; delete env.AGENTRIX_READING_NOTE_FILE;
  const args = [agent, '--role', 'exec', '--title', 'Synthetic worker', '--model', agent === 'codex' ? 'gpt-6.1-sol' : 'claude-sonnet-5-5',
    '--effort', agent === 'codex' ? 'max' : 'high', '--cwd', repo, '--brief', brief, '--out', out, '--allow', 'src/**', '--skip-meeting', 'Synthetic intervention fixture',
    ...(agent === 'codex' ? ['--fast', ...(readOnly ? ['--read-only'] : [])] : ['--permission', 'plan'])];
  let stdout = '', finished = false;
  const children = [];
  const completedAtExit = [];
  const result = run(args, { env, rateInterval: 30, stdout: { write: text => { stdout += text; } },
    resolveExecutable: (_, argv) => ({ file: process.execPath, args: [worker, ...argv] }),
    launch: (file, argv, options) => {
      const child = spawn(file, argv, options); children.push(child);
      child.once('exit', () => completedAtExit.push(fs.existsSync(path.join(root, 'completed-1'))));
      if (closeWithSignal) {
        // Reproduce POSIX app-server shutdown on Windows too: it is a persistent
        // server, so closing the transport need not give process exit code zero.
        const end = child.stdin.end.bind(child.stdin);
        child.stdin.end = (...args) => { child.kill('SIGKILL'); return end(...args); };
      }
      return child;
    },
  }).finally(() => { finished = true; });
  const release = round => fs.writeFileSync(path.join(root, 'release-' + round), '');
  t.after(async () => {
    if (!finished) {
      for (const entry of team.live()) if (entry.controls && !entry.closing) {
        await team.queueControl(entry.id, { id: randomUUID(), type: 'stop', at: Date.now(), noResume: true }).catch(() => {});
      }
      for (let round = 1; round <= 10; round++) release(round);
    }
    await result; server.close(); fs.rmSync(root, { recursive: true, force: true });
  });
  await until(() => stdout.includes('[dispatch] started '));
  const id = /\[dispatch\] started ([\w-]+)/.exec(stdout)[1], notifications = [];
  const target = { terminalId:'terminal',callId:'dispatch:'+id,route:'dispatch',runId:id,cwd:repo,projectPath:repo,title:'Synthetic worker',parentSessionId:'planner',confirmed:true,done:false,local:true };
  const api = createInterventions({resolve:()=>target,sendParentPrompt:(_,text)=>{notifications.push(text);}});
  const captures = () => fs.existsSync(path.join(root, 'captures')) ? fs.readFileSync(path.join(root, 'captures'), 'utf8').trim().split('\n').map(JSON.parse) : [];
  return { root, repo, team, id, api, target, notifications, result, events, children, completedAtExit, release, captures, stdout: () => stdout, out, session };
}

test('default send leaves the child running and joins ordered messages in same-session resumes', async t => {
  for (const agent of ['codex', 'claude']) {
    const f = await fixture(t, { agent, readOnly: agent === 'codex' });
    const firstPid = f.captures()[0].pid;
    await f.api.interveneAgent('terminal', f.target.callId, 'First change.');
    await f.api.interveneAgent('terminal', f.target.callId, '第二条\nKeep the scope.');
    await until(() => f.stdout().includes('Keep the scope.'));
    assert.equal(f.children[0].exitCode, null); assert.equal(f.captures().length, 1);
    assert.equal(f.captures()[0].pid, firstPid);
    f.release(1); await until(() => f.captures().length === 2);
    const resumed = f.captures()[1];
    assert.match(resumed.brief, /业主插话：First change\.[\s\S]*业主插话：第二条\nKeep the scope\.[\s\S]*继续执行当前任务。/);
    assert.match(resumed.brief, /src\/\*\*/);
    assert.deepEqual(resumed.args.slice(0, 3), agent === 'codex' ? ['app-server', '--listen', 'stdio://'] : ['-p', '--resume', f.session]);
    if (agent === 'claude') assert.ok(resumed.args.includes('plan'));
    if (agent === 'codex') { assert.equal(resumed.threadRequest.params.threadId, f.session); assert.equal(resumed.threadRequest.params.serviceTier, 'fast'); assert.equal(resumed.threadRequest.params.config.model_reasoning_effort, 'max'); }
    await f.api.interveneAgent('terminal', f.target.callId, 'During the resumed run.');
    assert.equal(f.children[1].exitCode, null);
    f.release(2); await until(() => f.captures().length === 3); f.release(3);
    assert.equal(await f.result, 0);
    await until(() => f.events.some(event => event.type === 'dispatch-end'));
    assert.equal(f.events.filter(event => event.type === 'dispatch-start').length, 1);
    assert.equal(f.events.filter(event => event.type === 'dispatch-end').length, 1);
    const end = f.events.at(-1);
    assert.equal(end.outputTokens, agent === 'codex' ? 450 : 30); assert.equal(end.activeMs, agent === 'codex' ? 12000 : 3000);
    const rates = f.events.filter(event => event.type === 'dispatch-rate');
    if (agent === 'codex') {
      assert.ok(rates.length >= 2);
      for (let index = 1; index < rates.length; index++) {
        assert.ok(rates[index].outputTokens >= rates[index - 1].outputTokens);
        assert.ok(rates[index].activeMs >= rates[index - 1].activeMs);
      }
    }
    assert.equal(f.team.entries().filter(entry => entry.type === 'end').length, 1);
    assert.equal(f.team.entries().filter(entry => entry.type === 'intervention').length, 3);
    const receipts = await f.api.receipts('terminal', f.target.callId);
    assert.equal(receipts.length, 3);
    assert.ok(receipts.every(value => value.status === 'consumed'), 'only a successful confirmed reply consumes the queued stdin brief');
    assert.match(f.stdout(), /owner intervened 3/); assert.equal(f.team.live().length, 0);
    assert.equal(fs.readFileSync(f.out, 'utf8'), 'done 3');
  }
});

test('transient inbox polling errors leave the child running and retry the intervention without poisoning its result', async t => {
  const f = await fixture(t), take = RunInbox.prototype.take;
  let failures = 2;
  t.mock.method(RunInbox.prototype, 'take', function (finish) {
    if (this.id === f.id && failures) { failures--; throw Object.assign(new Error('synthetic transient inbox read'), { code: 'EIO' }); }
    return take.call(this, finish);
  });
  await f.api.interveneAgent('terminal', f.target.callId, 'Deliver after the transient read.');
  await until(() => failures === 0);
  assert.equal(f.children[0].exitCode, null); assert.equal(f.children[0].signalCode, null);
  assert.equal(f.captures().length, 1);
  await until(() => f.stdout().includes('Deliver after the transient read.'));
  f.release(1); await until(() => f.captures().length === 2);
  assert.match(f.captures()[1].brief, /Deliver after the transient read\./);
  f.release(2); assert.equal(await f.result, 0);
  assert.match(f.stdout(), /reason exit/); assert.match(f.stdout(), /owner intervened 1/);
  assert.doesNotMatch(f.stdout(), /stop requested|reason error|owner stopped/);
});

test('a failed final empty check reports an error after completion and server shutdown without interruption or resume', async t => {
  for (const closeWithSignal of [false, true]) await t.test(closeWithSignal ? 'signal shutdown' : 'platform shutdown', async t => {
    const f = await fixture(t, { closeWithSignal }), take = RunInbox.prototype.take;
    let finalChecks = 0;
    t.mock.method(RunInbox.prototype, 'take', function (finish) {
      if (this.id === f.id && finish) {
        finalChecks++;
        assert.deepEqual(f.completedAtExit, [true], 'the completed turn must precede server exit and the final inbox check');
        throw new Error('synthetic final empty-check failure');
      }
      return take.call(this, finish);
    });
    assert.equal(f.children[0].exitCode, null); assert.equal(finalChecks, 0);
    assert.equal(fs.existsSync(path.join(f.root, 'completed-1')), false); f.release(1);
    assert.equal(await f.result, 1); assert.equal(finalChecks, 1);
    assert.notEqual(f.children[0].exitCode ?? f.children[0].signalCode, null, 'the persistent server must be reaped after its completed turn');
    if (closeWithSignal) assert.equal(f.children[0].signalCode, 'SIGKILL');
    assert.deepEqual(f.completedAtExit, [true]);
    assert.equal(fs.readFileSync(path.join(f.root, 'rpc-methods'), 'utf8').split('\n').includes('turn/interrupt'), false);
    assert.equal(f.captures().length, 1); assert.match(f.stdout(), /reason error/);
    assert.equal(fs.readFileSync(path.join(f.root, 'completed-1'), 'utf8'), 'done 1');
    assert.doesNotMatch(f.stdout(), /stop requested|owner stopped/);
  });
});

test('explicit stop terminates the old process tree before resuming queued work', async t => {
  const f = await fixture(t, { descendant: true });
  await until(() => fs.existsSync(path.join(f.root, 'heartbeat')));
  await f.api.interveneAgent('terminal', f.target.callId, 'Change the conflicting approach.');
  await f.api.stopAgent('terminal', f.target.callId);
  await until(() => f.captures().length === 2);
  // A signal-terminated POSIX child has signalCode set and exitCode null.
  assert.notEqual(f.children[0].exitCode ?? f.children[0].signalCode, null, 'old worker must exit before resume');
  const beat = fs.readFileSync(path.join(f.root, 'heartbeat'), 'utf8'); await pause(150);
  assert.equal(fs.readFileSync(path.join(f.root, 'heartbeat'), 'utf8'), beat, 'old descendant cannot keep working after resume');
  f.release(2); assert.equal(await f.result, 0);
  assert.match(f.stdout(), /owner intervened 1 · owner stopped 1/);
  assert.equal(f.team.entries().filter(entry => entry.type === 'stop').length, 1);
});

test('an untimed resumed reply never borrows the preceding segment duration for a live rate', async t => {
  const f = await fixture(t, { agent: 'claude', untimedRound: 2 });
  await f.api.interveneAgent('terminal', f.target.callId, 'Continue without timing evidence.');
  f.release(1); await until(() => f.captures().length === 2); await pause(200);
  assert.ok(f.events.filter(event => event.type === 'dispatch-rate').every(event => event.outputTokens === 10 && event.activeMs === 1000));
  f.release(2); assert.equal(await f.result, 0);
  await until(() => f.events.some(event => event.type === 'dispatch-end'));
  const end = f.events.at(-1); assert.equal(end.outputTokens, 20); assert.equal(end.totalOutputTokens, 20); assert.equal(end.activeMs, null);
  assert.match(f.stdout(), /token\/s unreported/);
});

test('stop CLI accepts reason and no-resume, never launches a worker itself, and refuses ended runs', async t => {
  const f = await fixture(t);
  await f.api.interveneAgent('terminal', f.target.callId, 'This stays pending after no-resume.');
  let stdout = '';
  const code = await run(['stop', f.id, '--cwd', f.repo, '--reason', 'Explicit owner cancellation', '--no-resume'],
    { stdout: {write:text=>{stdout+=text;}}, launch: () => assert.fail('stop launched a worker') });
  assert.equal(code, 0); assert.match(stdout, /stop queued/);
  assert.notEqual(await f.result, 0); assert.equal(f.captures().length, 1);
  assert.match(f.stdout(), /no resume/); assert.match(f.stdout(), /reason killed/);
  const stop = f.team.entries().find(entry => entry.type === 'stop'); assert.equal(stop.noResume, true); assert.equal(stop.reason, 'Explicit owner cancellation');
  assert.equal(await run(['stop', f.id, '--cwd', f.repo], {stdout:{write(){}},launch:()=>assert.fail('ended stop launched')}), 1);
  for (const suffix of [['--unknown'], ['--reason'], ['--reason',' '], ['--no-resume','--no-resume']]) assert.throws(() => argumentsOf(['stop', f.id, ...suffix]));
  assert.throws(() => argumentsOf(['stop', '../outside']));
});

test('scope violations stop queued continuation and a resumed session mismatch fails visibly', async t => {
  const scoped = await fixture(t, { outsideScope: true });
  await scoped.api.interveneAgent('terminal', scoped.target.callId, 'Continue only within scope.');
  scoped.release(1); await scoped.result;
  assert.equal(scoped.captures().length, 1); assert.match(scoped.stdout(), /OUT OF SCOPE: outside.txt/);
  const mismatch = await fixture(t, { badSession: true });
  await mismatch.api.interveneAgent('terminal', mismatch.target.callId, 'Continue the same session.');
  mismatch.release(1);
  assert.notEqual(await mismatch.result, 0); assert.match(mismatch.stdout(), /reason error/);
  assert.match(mismatch.stdout(), /thread_resume/); assert.equal(mismatch.captures().length, 1, 'a mismatched resume fails before input');
  assert.equal(mismatch.team.entries().filter(entry => entry.type === 'end').length, 1);
  assert.equal(mismatch.team.entries().find(entry => entry.type === 'end').session, mismatch.session);
});
