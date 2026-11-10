// A real child process standing in for either CLI. All input/output stays in the test's temporary directory.
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

async function main() {
  const fixture = JSON.parse(fs.readFileSync(process.env.DISPATCH_FIXTURE, 'utf8'));
  if (process.argv[2] === 'app-server') return appServer(fixture);
  let brief = '';
  for await (const chunk of process.stdin) brief += chunk;
  fs.writeFileSync(process.env.DISPATCH_CAPTURE, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), brief, pid: process.pid }));
  for (const entry of fixture.lines || []) {
    if (entry.delay) await delay(entry.delay);
    // When a record was written, for tests that time how soon the helper reads it.
    if (entry.mark) { fs.writeFileSync(entry.mark, String(Date.now())); continue; }
    // A worker editing its project: the scope check compares these with --allow.
    if (entry.write) { fs.mkdirSync(path.dirname(path.resolve(entry.write)), { recursive: true }); fs.writeFileSync(path.resolve(entry.write), entry.text || ''); continue; }
    if (entry.rollout || entry.rolloutRaw) {
      const folder = path.join(process.env.CODEX_HOME, 'sessions/2026/01/01');
      fs.mkdirSync(folder, { recursive: true });
      fs.appendFileSync(path.join(folder, `rollout-fixture-${entry.rolloutSession || fixture.sessionId}.jsonl`),
        entry.rolloutRaw || JSON.stringify(entry.rollout) + '\n');
      continue;
    }
    const stream = entry.stderr ? process.stderr : process.stdout;
    stream.write(typeof entry.raw === 'string' ? entry.raw : JSON.stringify(entry.record) + '\n');
  }
  // Stays until the test has seen the helper's start line (bounded, so a broken helper cannot hang the test run).
  for (const end = Date.now() + 60000; fixture.release && !fs.existsSync(fixture.release) && Date.now() < end;) await delay(10);
  if (fixture.hold) await delay(fixture.hold);
  process.exitCode = fixture.exitCode || 0;
}
function appServer(fixture) {
  const send = message => process.stdout.write(JSON.stringify(message) + '\n');
  const requests = [], replies = new Map(), threadId = fixture.sessionId, turnId = 'fixture-turn';
  const notify = (method, params) => send({ method, params: { threadId, ...params } });
  require('node:readline').createInterface({ input: process.stdin }).on('line', async line => {
    const request = JSON.parse(line), params = request.params || {};
    requests.push(request);
    if (!request.method) replies.get(request.id)?.();
    if (!request.method || request.id === undefined) return;
    if (['thread/resume', 'turn/start', 'turn/steer', 'turn/interrupt'].includes(request.method) && !params.threadId)
      return send({ id: request.id, error: { code: -32600, message: 'Invalid request: missing field `threadId`' } });
    let result = {};
    if (request.method === 'initialize') result = { userAgent: 'codex/0.166.0' };
    if (['thread/start', 'thread/resume'].includes(request.method)) result = { thread: { id: threadId, turns: [] }, cwd: process.cwd(),
      sandbox: { type: params.sandbox === 'read-only' ? 'readOnly' : 'workspaceWrite' } };
    if (request.method === 'turn/start') {
      const brief = params.input.filter(item => item.type === 'text').map(item => item.text).join('\n');
      const capture = () => fs.writeFileSync(process.env.DISPATCH_CAPTURE, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), brief, pid: process.pid, requests }));
      capture();
      let replied = false, failed = null;
      for (const entry of fixture.lines || []) {
        if (entry.delay) await delay(entry.delay);
        if (entry.mark) { fs.writeFileSync(entry.mark, String(Date.now())); continue; }
        if (entry.write) { fs.mkdirSync(path.dirname(path.resolve(entry.write)), { recursive: true }); fs.writeFileSync(path.resolve(entry.write), entry.text || ''); continue; }
        // The worker's own request (a question, a form, an approval): it waits for the reply, which joins the captured requests.
        if (entry.request) {
          const id = `request-${replies.size}`, answered = new Promise(resolve => replies.set(id, resolve));
          send({ id, method: entry.request.method, params: { threadId, turnId, ...entry.request.params } });
          await answered; capture();
          continue;
        }
        if (entry.rollout || entry.rolloutRaw) {
          const folder = path.join(process.env.CODEX_HOME, 'sessions/2026/01/01'); fs.mkdirSync(folder, { recursive: true });
          fs.appendFileSync(path.join(folder, `rollout-fixture-${entry.rolloutSession || threadId}.jsonl`), entry.rolloutRaw || JSON.stringify(entry.rollout) + '\n');
          if (entry.rollout?.type === 'turn_context' && !replied) {
            replied = true; send({ id: request.id, result: { turn: { id: turnId, status: 'inProgress' } } });
            notify('turn/started', { turn: { id: turnId } });
          }
          continue;
        }
        if (entry.stderr) process.stderr.write(entry.raw || JSON.stringify(entry.record) + '\n');
        if (entry.record?.type === 'turn.failed') failed = entry.record.error;
      }
      for (const end = Date.now() + 60000; fixture.release && !fs.existsSync(fixture.release) && Date.now() < end;) await delay(10);
      if (fixture.hold) await delay(fixture.hold);
      if (!replied) return process.exit(fixture.exitCode || 0);
      const out = fixture.lines.findLast(entry => entry.write && entry.write.endsWith('.md'));
      if (out) notify('item/completed', { turnId, item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: out.text } });
      notify('turn/completed', { turn: { id: turnId, status: failed || fixture.exitCode ? 'failed' : 'completed',
        ...(failed || fixture.exitCode ? { error: { codexErrorInfo: failed?.message.includes('capacity') ? 'serverOverloaded' : 'internalServerError' } } : {}) } });
      return;
    }
    if (request.method === 'thread/turns/list') result = { data: [], nextCursor: null };
    if (request.method === 'skills/list') result = { data: [] };
    send({ id: request.id, result });
  });
}
main().catch(error => { process.stderr.write(String(error)); process.exitCode = 1; });
