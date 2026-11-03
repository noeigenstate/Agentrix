const readline = require('node:readline');
const mode = process.env.SYNTHETIC_CODEX_MODE || 'normal';
let threadId = 'synthetic-thread', turnId = 'turn-1', turns = 0;
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const notify = (method, params) => send({ method, params: { threadId, ...params } });
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line), params = request.params || {};
  if (!request.method) return;
  if (['thread/resume', 'turn/start', 'turn/steer', 'turn/interrupt'].includes(request.method) && !params.threadId) {
    return send({ id: request.id, error: { code: mode === 'missing-steer' && request.method === 'turn/steer' ? -32601 : -32602, message: 'Synthetic capability probe' } });
  }
  let result = {};
  if (request.method === 'initialize') result = { userAgent: mode === 'unknown-version' ? 'codex/9.99.0' : 'codex/0.166.0' };
  else if (request.method === 'thread/start' || request.method === 'thread/resume') {
    threadId = params.threadId || threadId;
    result = { thread: { id: threadId, turns: [] }, cwd: params.cwd, model: params.model, serviceTier: params.serviceTier,
      reasoningEffort: params.config?.model_reasoning_effort, approvalPolicy: params.approvalPolicy || 'on-request', sandbox: { type: params.sandbox === 'read-only' ? 'readOnly' : 'workspaceWrite' } };
  } else if (request.method === 'turn/start') {
    turnId = 'turn-' + ++turns;
    result = { turn: { id: turnId, status: 'inProgress', items: [] } };
    send({ id: request.id, result });
    notify('turn/started', result);
    notify('item/agentMessage/delta', { turnId, itemId: 'message-' + turns, delta: 'partial 汉字' });
    if (mode === 'approval') send({ id: 91, method: 'item/commandExecution/requestApproval', params: { threadId, turnId, itemId: 'command', approvalId: 'a', command: 'echo example' } });
    if (!['hold', 'approval', 'worker'].includes(mode)) setTimeout(() => {
      notify('item/completed', { turnId, item: { type: 'agentMessage', id: 'message-' + turns, text: 'final answer', phase: 'final_answer' } });
      notify('turn/completed', { turn: { id: turnId, status: 'completed' } });
    }, 60);
    return;
  } else if (request.method === 'turn/steer') {
    if (mode === 'disconnect') return process.exit(1);
    if (mode === 'race') return send({ id: request.id, error: { code: -32602, message: 'Turn ended' } });
    if (params.expectedTurnId !== turnId) return send({ id: request.id, error: { code: -32602, message: 'Turn ended' } });
    result = { turnId };
    if (mode === 'worker') setTimeout(() => {
      notify('item/completed', { turnId, item: { type: 'agentMessage', id: 'message-1', text: params.input[0].text, phase: 'final_answer' } });
      notify('turn/completed', { turn: { id: turnId, status: 'completed' } });
    }, 20);
  } else if (request.method === 'turn/interrupt') {
    notify('turn/completed', { turn: { id: turnId, status: 'interrupted' } });
  } else if (request.method === 'account/rateLimits/read') result = { rateLimits: { limitId: 'codex', primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 100 } }, rateLimitResetCredits: { availableCount: 2 }, ordinaryUsageAllowed: true };
  else if (request.method === 'thread/read') result = { thread: { id: threadId, status: { type: 'idle' }, turns: [{ id: turnId, status: 'completed', items: [] }] } };
  else if (request.method === 'thread/turns/list') result = { data: [{ id: 'history', status: 'completed', items: [] }], nextCursor: 'next-page', backwardsCursor: null };
  else if (request.method === 'account/usage/read') result = { tokenUsage: { totalTokens: 50 } };
  if (request.id !== undefined) send({ id: request.id, result });
});
