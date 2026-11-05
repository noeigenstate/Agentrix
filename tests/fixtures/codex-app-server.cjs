const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
const mode = process.env.SYNTHETIC_CODEX_MODE || 'normal';
let threadId = 'synthetic-thread', turnId = 'turn-1', turns = 0, skillReads = 0;
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const notify = (method, params) => send({ method, params: { threadId, ...params } });
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line), params = request.params || {};
  if (process.env.SYNTHETIC_CODEX_LOG) fs.appendFileSync(process.env.SYNTHETIC_CODEX_LOG, JSON.stringify(request) + '\n');
  if (!request.method) return;
  if (['thread/resume', 'turn/start', 'turn/steer', 'turn/interrupt'].includes(request.method) && !params.threadId) {
    return send({ id: request.id, error: { code: mode === 'missing-steer' && request.method === 'turn/steer' ? -32601 : -32600,
      message: 'Invalid request: missing field `threadId`' } });
  }
  let result = {};
  if (request.method === 'initialize') result = { userAgent: mode === 'unknown-version' ? 'codex/9.99.0' : 'codex/0.166.0' };
  else if (request.method === 'thread/start' || request.method === 'thread/resume') {
    if (mode === 'empty-thread' && request.method === 'thread/resume') return send({ id: request.id,
      error: { code: -32600, message: 'no rollout found for thread id ' + params.threadId } });
    threadId = params.threadId || threadId;
    if (mode === 'resume-frame-limit') return send({ id: request.id, result: { thread: { id: threadId, turns: [] }, padding: 'x'.repeat(4 * 1024 * 1024) } });
    if (mode.startsWith('long-') && request.method === 'thread/resume' && params.excludeTurns !== true) return send({ id: request.id, result: { thread: { id: threadId, turns: [] }, padding: 'x'.repeat(4 * 1024 * 1024) } });
    let sandbox = params.sandbox || 'workspace-write';
    if (mode === 'sandbox-persist') {
      sandbox = params.sandbox || (fs.existsSync(process.env.SYNTHETIC_POLICY_FILE) ? JSON.parse(fs.readFileSync(process.env.SYNTHETIC_POLICY_FILE)).sandbox : 'read-only');
      fs.writeFileSync(process.env.SYNTHETIC_POLICY_FILE, JSON.stringify({ sandbox }));
    }
    result = { thread: { id: threadId, turns: [] }, cwd: params.cwd, model: params.model, serviceTier: params.serviceTier,
      reasoningEffort: params.config?.model_reasoning_effort, approvalPolicy: params.approvalPolicy || 'on-request', sandbox: { type: sandbox === 'read-only' ? 'readOnly' : 'workspaceWrite' } };
  } else if (request.method === 'turn/start') {
    if (mode === 'skill-catalog') notify('skills/changed', {});
    if (mode === 'sandbox-persist' && JSON.parse(fs.readFileSync(process.env.SYNTHETIC_POLICY_FILE)).sandbox === 'workspace-write') fs.writeFileSync(path.join(process.cwd(), 'synthetic-write-proof.txt'), 'workspace-write');
    turnId = 'turn-' + ++turns;
    result = { turn: { id: turnId, status: 'inProgress', items: [] } };
    send({ id: request.id, result });
    notify('turn/started', result);
    notify('item/agentMessage/delta', { turnId, itemId: 'message-' + turns, delta: 'partial 汉字' });
    if (mode === 'approval') send({ id: 91, method: 'item/commandExecution/requestApproval', params: { threadId, turnId, itemId: 'command', approvalId: 'a', command: 'echo example' } });
    if (mode === 'unread-worker' && params.input?.some(item => item.text?.includes('业主插话'))) setTimeout(() => {
      notify('item/completed', { turnId, item: { type: 'userMessage', id: 'resumed-input', clientId: params.clientUserMessageId, content: params.input } });
      notify('item/completed', { turnId, item: { type: 'agentMessage', id: 'resumed-answer', text: 'Correction handled', phase: 'final_answer' } });
      notify('turn/completed', { turn: { id: turnId, status: 'completed' } });
    }, 20);
    if (!['hold', 'approval', 'worker', 'unread-worker'].includes(mode)) setTimeout(() => {
      if (mode === 'structured') notify('thread/tokenUsage/updated', { tokenUsage: { total: { inputTokens: 10, cachedInputTokens: 2, cacheWriteInputTokens: 0, outputTokens: 3, reasoningOutputTokens: 1, totalTokens: 13 },
        last: { inputTokens: 10, cachedInputTokens: 2, cacheWriteInputTokens: 0, outputTokens: 3, reasoningOutputTokens: 1, totalTokens: 13 }, modelContextWindow: 456789 } });
      notify('item/completed', { turnId, item: { type: 'agentMessage', id: 'message-' + turns, text: 'final answer', phase: 'final_answer' } });
      notify('turn/completed', { turn: { id: turnId, status: mode === 'spend-limit' ? 'failed' : 'completed', durationMs: mode === 'structured' ? 123 : null,
        ...(mode === 'spend-limit' ? { error: { codexErrorInfo: 'usageLimitExceeded', message: 'Never expose this raw provider error' } } : {}) } });
    }, 60);
    return;
  } else if (request.method === 'turn/steer') {
    if (mode === 'disconnect') return process.exit(1);
    if (mode === 'race') return send({ id: request.id, error: { code: -32602, message: 'Turn ended' } });
    if (params.expectedTurnId !== turnId) return send({ id: request.id, error: { code: -32602, message: 'Turn ended' } });
    result = { turnId };
    if (mode === 'unread-worker') setTimeout(() => {
      notify('item/completed', { turnId, item: { type: 'agentMessage', id: 'old-answer', text: 'Old answer', phase: 'final_answer' } });
      notify('turn/completed', { turn: { id: turnId, status: 'completed' } });
    }, 20);
    if (mode === 'worker') setTimeout(() => {
      notify('item/completed', { turnId, item: { type: 'userMessage', id: 'steered-input', clientId: params.clientUserMessageId, content: params.input } });
      notify('item/completed', { turnId, item: { type: 'agentMessage', id: 'message-1', text: params.input[0].text, phase: 'final_answer' } });
      notify('turn/completed', { turn: { id: turnId, status: 'completed' } });
    }, 20);
  } else if (request.method === 'turn/interrupt') {
    notify('turn/completed', { turn: { id: turnId, status: 'interrupted' } });
  } else if (request.method === 'skills/list' && mode === 'missing-skills') return send({ id: request.id, error: { code: -32601, message: 'Unsupported method' } });
  else if (request.method === 'skills/list') result = { data: [{ cwd: process.cwd(), skills: mode === 'skill-catalog' ? [
    { name: ++skillReads === 1 ? 'offline' : 'replacement', description: 'Offline skill', enabled: true, path: process.env.SYNTHETIC_SKILL_PATH },
    { name: 'disabled', enabled: false, path: process.env.SYNTHETIC_SKILL_PATH },
  ] : [] }] };
  else if (request.method === 'account/rateLimits/read') result = { rateLimits: { limitId: 'codex', primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 100 } }, rateLimitResetCredits: { availableCount: 2 }, ordinaryUsageAllowed: true };
  else if (request.method === 'thread/read') result = { thread: { id: threadId, status: { type: 'idle' }, turns: [{ id: turnId, status: 'completed', items: [] }] } };
  else if (request.method === 'thread/turns/list') {
    if (mode.startsWith('long-')) {
      const total = mode === 'long-many' ? 1200 : mode === 'long-large' ? 60 : mode === 'long-mixed' ? 600 : 2, offset = Number(params.cursor || 0);
      const count = Math.min(params.limit, total - offset);
      result = { data: Array.from({ length: count }, (_, i) => ({ id: 'history-' + (total - offset - i), status: 'completed',
        items: params.itemsView === 'notLoaded' ? [] : [{ id: 'item-' + (total - offset - i), type: 'agentMessage',
          text: (['long-huge', 'long-mixed'].includes(mode) && offset + i === 0 ? 'x'.repeat(17 * 1024 * 1024) : mode === 'long-large' ? '汉'.repeat(200000) : 'small') + '-END' }] })),
        nextCursor: offset + count < total ? String(offset + count) : null, backwardsCursor: null };
    } else result = { data: [{ id: mode === 'race' ? turnId : 'history', status: 'completed', items: [] }], nextCursor: 'next-page', backwardsCursor: null };
  }
  else if (request.method === 'account/usage/read') result = { tokenUsage: { totalTokens: 50 } };
  if (request.id !== undefined) send({ id: request.id, result });
});
