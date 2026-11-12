// The app-server peer of scripts/native-question-smoke.mjs: once the trigger file exists it starts a turn and asks two questions, and it writes the
// owner's answer to the answered file. Both paths come from the environment; nothing else is read or written.
const fs = require('node:fs'), readline = require('node:readline');
if (process.argv.includes('--version')) { console.log(process.argv[2] === 'claude' ? '2.1.318 (Claude Code)' : 'codex-cli 0.166.0'); process.exit(0); }
const trigger = process.env.AGENTRIX_QUESTION_TRIGGER, answered = process.env.AGENTRIX_QUESTION_ANSWERED;
const SANDBOX_TYPES = { 'read-only': 'readOnly', 'workspace-write': 'workspaceWrite', 'danger-full-access': 'dangerFullAccess' };
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const threadId = 'fixture-thread', turnId = 'fixture-turn'; let asked = false;
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line); let result = {};
  if (!message.method && message.id === 'fixture-question') {
    fs.writeFileSync(answered, JSON.stringify(message.result));
    send({ method: 'serverRequest/resolved', params: { requestId: message.id, threadId } });
    send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } }); return;
  }
  if (!message.method) return;
  if (message.method === 'initialize') result = { userAgent: 'codex/0.166.0' };
  if (['thread/resume', 'turn/start', 'turn/steer', 'turn/interrupt'].includes(message.method) && !message.params?.threadId) return send({ id: message.id, error: { code: -32600, message: 'Invalid request: missing field `threadId`' } });
  // As Codex does, the sandbox and approvals asked for come back; with none asked, this stand-in's own configuration is workspace-write.
  if (['thread/start', 'thread/resume'].includes(message.method)) result = { thread: { id: threadId, turns: [] }, cwd: process.cwd(),
    sandbox: { type: SANDBOX_TYPES[message.params?.sandbox || 'workspace-write'] }, approvalPolicy: message.params?.approvalPolicy || 'on-request' };
  if (message.method === 'skills/list') result = { data: [] };
  if (message.method === 'thread/turns/list') result = { data: [] };
  if (message.id !== undefined) send({ id: message.id, result });
});
process.stdin.on('end', () => process.exit(0));
setInterval(() => {
  if (asked || !trigger || !fs.existsSync(trigger)) return; asked = true;
  send({ method: 'turn/started', params: { threadId, turn: { id: turnId, status: 'inProgress' } } });
  send({ id: 'fixture-question', method: 'item/tool/requestUserInput', params: { threadId, turnId, itemId: 'fixture-item', questions: [
    { id: 'q', header: 'Fixture', question: 'Choose one', options: [{ label: 'One', description: 'First' }, { label: 'Two', description: 'Second' }] },
    { id: 'q2', header: 'Details', question: 'Explain your choice', options: [] }
  ] } });
}, 50);
