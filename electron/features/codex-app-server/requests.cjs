const { randomUUID } = require('node:crypto');
const METHODS = {
  'item/commandExecution/requestApproval': 'command', 'item/fileChange/requestApproval': 'file-change',
  'item/permissions/requestApproval': 'permissions', 'item/tool/requestUserInput': 'question', 'mcpServer/elicitation/request': 'elicitation',
};

function createRequests(rpc, events, state) {
  const pending = new Map();
  function resolve(requestId, result, resolution) {
    const task = pending.get(requestId);
    if (!task) throw new Error('request_expired');
    pending.delete(requestId);
    rpc.respond(task.id, result);
    events.publish('request.resolved', { requestId, resolution, reason: null });
    if (!pending.size) state('running');
  }
  function cancel(requestId) {
    const task = pending.get(requestId);
    if (!task) return;
    if (task.kind === 'command' || task.kind === 'file-change') resolve(requestId, { decision: 'cancel' }, 'cancelled');
    else if (task.kind === 'permissions') resolve(requestId, { permissions: {}, scope: 'turn' }, 'cancelled');
    else if (task.kind === 'elicitation') resolve(requestId, { action: 'cancel', content: null, _meta: null }, 'cancelled');
    else { pending.delete(requestId); rpc.reject(task.id, -32000); events.publish('request.resolved', { requestId, resolution: 'cancelled', reason: null }); }
  }
  return {
    open(message) {
      const kind = METHODS[message.method], params = message.params || {};
      if (pending.size >= 100) return rpc.reject(message.id, -32000);
      if (!kind || params.threadId && params.threadId !== events.binding.providerSessionId || params.turnId && params.turnId !== events.binding.turnId) return rpc.reject(message.id);
      const requestId = randomUUID();
      const questions = kind === 'question' ? (params.questions || []).map(x => ({ id: x.id, header: x.header, question: x.question,
        isSecret: !!x.isSecret, allowFreeText: !!x.isOther, ...(x.options ? { options: x.options } : {}) })) : undefined;
      const payload = { requestId, kind, blocking: params.isBlocking !== false,
        title: kind === 'command' ? '命令审批' : kind === 'question' ? '问题' : '权限请求',
        preview: String(params.command || params.reason || params.message || '').slice(0, 8000), actions: ['allow', 'deny'],
        ...(questions ? { questions } : {}), providerData: { approvalId: params.approvalId ?? null, itemId: params.itemId ?? null,
          ...(kind === 'elicitation' ? { mode: params.mode, requestedSchema: params.requestedSchema ?? null, url: params.url ?? null } : {}) } };
      pending.set(requestId, { id: message.id, kind, params, payload });
      events.publish('request.opened', payload, { itemId: params.itemId ?? null });
      if (payload.blocking) state('waiting');
    },
    answer(requestId, answer) {
      const task = pending.get(requestId);
      if (!task) throw new Error('request_expired');
      if (answer?.decision === 'deny' && task.kind === 'elicitation') return cancel(requestId);
      if (task.kind === 'question' || task.kind === 'elicitation' && task.params.mode !== 'url') {
        const supplied = answer?.answers;
        if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) throw new Error('invalid_answer');
        const expected = task.kind === 'question' ? task.params.questions || [] : Object.keys(task.params.requestedSchema?.properties || {}).map(id => ({ id }));
        const answers = {};
        if (Object.keys(supplied).some(id => !expected.some(q => q.id === id))) throw new Error('invalid_answer');
        for (const question of expected) {
          const value = supplied[question.id], values = typeof value === 'string' ? [value] : value;
          if (!Array.isArray(values) || !values.length || values.some(x => typeof x !== 'string' || !x.trim() || x.length > 16000)) throw new Error('invalid_answer');
          answers[question.id] = { answers: values };
        }
        if (task.kind === 'question') return resolve(requestId, { answers }, 'answered');
        const schema = task.params.requestedSchema;
        if (schema?.type !== 'object' || !expected.length) throw new Error('unsupported_answer');
        const content = {};
        for (const { id } of expected) {
          const value = answers[id].answers;
          const property = schema.properties[id];
          if (property.type !== 'string' || value.length !== 1 || property.enum && !property.enum.includes(value[0])) throw new Error('invalid_answer');
          content[id] = value[0];
        }
        return resolve(requestId, { action: 'accept', content, _meta: null }, 'answered');
      }
      if (!['allow', 'deny'].includes(answer?.decision)) throw new Error('invalid_answer');
      if (task.kind === 'command' || task.kind === 'file-change') return resolve(requestId, { decision: answer.decision === 'allow' ? 'accept' : 'decline' }, answer.decision === 'allow' ? 'allowed' : 'denied');
      if (answer.decision === 'deny') return cancel(requestId);
      if (task.kind === 'permissions') {
        const requested = task.params.permissions;
        if (!requested || typeof requested !== 'object') throw new Error('invalid_permissions');
        return resolve(requestId, { permissions: Object.fromEntries(['network', 'fileSystem'].filter(key => requested[key] != null).map(key => [key, requested[key]])), scope: 'turn' }, 'allowed');
      }
      if (task.kind === 'elicitation' && task.params.mode === 'url') return resolve(requestId, { action: 'accept', content: null, _meta: null }, 'answered');
      throw new Error('unsupported_answer');
    },
    resolved(id) {
      for (const [requestId, task] of pending) if (task.id === id) {
        pending.delete(requestId); events.publish('request.resolved', { requestId, resolution: 'expired', reason: null });
      }
      if (!pending.size) state('running');
    },
    cancelAll() { for (const id of [...pending.keys()]) { try { cancel(id); } catch { pending.delete(id); } } },
    snapshot: () => [...pending.values()].map(x => x.payload),
  };
}

module.exports = { createRequests };
