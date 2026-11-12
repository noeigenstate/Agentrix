// Desktop protocol peer. Only fixture-owned files under the injected CODEX_HOME/cwd are read.
const fs = require('node:fs'), path = require('node:path'), readline = require('node:readline'), { randomUUID } = require('node:crypto');
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const cwd = process.cwd(), folder = path.join(process.env.CODEX_HOME, 'sessions');
fs.mkdirSync(folder, { recursive: true });
let threadId, input = null, config = {}, status = 'completed', turnId = 'restore-turn';
function rows(id) {
  const file = fs.readdirSync(folder).find(name => name.endsWith('.jsonl') && name.includes(id));
  if (!file) return [];
  return fs.readFileSync(path.join(folder, file), 'utf8').split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
}
function metadata(id) { return rows(id).find(row => row.type === 'session_meta')?.payload; }
function receipt() {
  const value = JSON.stringify({ cwd, args: process.argv.slice(2), threadId, input, continued: input === '继续', developerInstructions: config.developer_instructions || '', protocol: 'app-server' });
  fs.writeFileSync(path.join(cwd, 'resume-receipt.json'), value);
  fs.writeFileSync(path.join(folder, threadId + '-receipt.json'), value);
}
function thread(id) { return { id, cwd: metadata(id)?.cwd || cwd, status: { type: 'idle' }, turns: [] }; }
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line), p = request.params || {}; let result = {};
  if (request.method === 'initialize') result = { userAgent: 'codex-cli/0.166.0', capabilities: {} };
  else if (['thread/resume', 'turn/start', 'turn/steer', 'turn/interrupt'].includes(request.method) && !p.threadId) return send({ id: request.id, error: { code: -32600, message: 'Invalid request: missing field `threadId`' } });
  else if (['thread/start', 'thread/resume'].includes(request.method)) {
    threadId = p.threadId || randomUUID(); config = p.config || {};
    const records = rows(threadId), last = records.filter(row => row.type === 'event_msg').at(-1)?.payload?.type;
    status = ['task_started', 'turn_started'].includes(last) ? 'inProgress' : 'completed';
    if (!records.length) fs.writeFileSync(path.join(folder, 'rollout-' + threadId + '.jsonl'), JSON.stringify({ type: 'session_meta', payload: { id: threadId, cwd, source: 'cli' } }) + '\n');
    result = { thread: thread(threadId), cwd, model: 'fixture-model', sandbox: { type: { 'read-only': 'readOnly', 'danger-full-access': 'dangerFullAccess' }[p.sandbox] || 'workspaceWrite' }, approvalPolicy: p.approvalPolicy || 'never' };
    receipt();
  } else if (request.method === 'thread/turns/list') result = { data: [{ id: turnId, status, items: [] }], nextCursor: null, backwardsCursor: null };
  else if (request.method === 'thread/list') result = { data: fs.readdirSync(folder).filter(file => file.startsWith('rollout-') && file.endsWith('.jsonl')).map(file => thread(file.slice(8, -6))).filter(item => item.cwd === p.cwd), nextCursor: null };
  else if (request.method === 'thread/read') result = { thread: thread(p.threadId) };
  else if (request.method === 'turn/start') {
    input = (p.input || []).filter(item => item.type === 'text').map(item => item.text).join('\n'); status = input === '继续' ? 'inProgress' : 'completed'; receipt();
    turnId = randomUUID(); result = { turn: { id: turnId, status: 'inProgress', items: [] } };
    send({ id: request.id, result });
    send({ method: 'turn/started', params: { threadId, turn: result.turn } });
    send({ method: 'item/completed', params: { threadId, turnId, item: { id: randomUUID(), type: 'userMessage', clientId: p.clientUserMessageId, content: [{ type: 'text', text: input }] } } });
    if (status === 'inProgress') return;
    send({ method: 'item/completed', params: { threadId, turnId, item: { id: randomUUID(), type: 'agentMessage', text: 'RESTORE_FIXTURE_REPLY', status: 'completed' } } });
    send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed', items: [] } } }); return;
  } else if (request.method === 'turn/interrupt') {
    status = 'interrupted'; send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status, items: [] } } });
  } else if (request.method === 'skills/list') result = { data: [{ cwd, skills: [] }] };
  else if (request.method === 'account/read') result = { account: null };
  else if (request.method === 'account/rateLimits/read') result = { rateLimits: null };
  if (request.id !== undefined) send({ id: request.id, result });
});

process.stdin.on('end', () => process.exit(0));
