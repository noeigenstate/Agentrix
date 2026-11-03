const { randomUUID } = require('node:crypto');
function createRequests({ publish, state }) {
  const pending = new Map();
  function finish(id, resolution, answer) {
    const item = pending.get(id); if (!item) return false;
    pending.delete(id); item.cleanup();
    publish('request.resolved', { requestId: id, resolution, reason: null });
    state(pending.size ? 'waiting' : 'running'); item.resolve(answer); return true;
  }
  return {
    open(name, input, { signal, toolUseID } = {}) {
      if (pending.size >= 256) return Promise.resolve({ behavior: 'deny', message: '待确认请求过多。' });
      const questions = name === 'AskUserQuestion' ? input.questions : null;
      if (questions && (!Array.isArray(questions) || !questions.length || questions.length > 10 || questions.some(q => typeof q.question !== 'string' || q.question.length > 4000 || !Array.isArray(q.options) || q.options.length > 20 ||
        q.options.some(option => typeof option.label !== 'string' || option.label.length > 256 || option.description && (typeof option.description !== 'string' || option.description.length > 2000))))) return Promise.resolve({ behavior: 'deny', message: '不支持的问题格式。' });
      const requestId = randomUUID();
      return new Promise(resolve => {
        const abort = () => finish(requestId, 'cancelled', { behavior: 'deny', message: '请求已取消。' });
        pending.set(requestId, { input, resolve, questions, cleanup: () => signal?.removeEventListener('abort', abort) });
        signal?.addEventListener('abort', abort, { once: true });
        publish('request.opened', { requestId, kind: questions ? 'question' : name === 'Bash' ? 'command' : /Edit|Write/.test(name) ? 'file-change' : 'tool', blocking: true,
          title: name, preview: JSON.stringify(input).slice(0, 4000), actions: questions ? ['answer', 'deny'] : ['allow', 'deny'],
          ...(questions ? { questions: questions.map((q, i) => ({ id: String(i), question: q.question, header: q.header, options: q.options, multiSelect: !!q.multiSelect, allowFreeText: true })) } : {}), providerData: { toolUseID: toolUseID || null } });
        state('waiting'); if (signal?.aborted) abort();
      });
    },
    answer(id, answer) {
      const item = pending.get(id); if (!item) throw new Error('请求已失效。');
      if (answer?.decision === 'deny') return finish(id, 'denied', { behavior: 'deny', message: '用户拒绝了此操作。' });
      if (item.questions) {
        const answers = answer?.answers;
        if (!answers || Object.keys(answers).length !== item.questions.length || item.questions.some((q, i) => {
          const value = answers[String(i)]; return typeof value !== 'string' && !(q.multiSelect && Array.isArray(value) && value.every(v => typeof v === 'string'));
        })) throw new Error('请完整回答所有问题。');
        const mapped = Object.fromEntries(item.questions.map((q, i) => [q.question, Array.isArray(answers[i]) ? answers[i].join(', ') : answers[i]]));
        return finish(id, 'answered', { behavior: 'allow', updatedInput: { ...item.input, answers: mapped } });
      }
      if (answer?.decision !== 'allow') throw new Error('无效的请求回答。');
      return finish(id, 'allowed', { behavior: 'allow', updatedInput: item.input });
    },
    cancel() { for (const id of [...pending.keys()]) finish(id, 'cancelled', { behavior: 'deny', message: '会话已停止。' }); },
  };
}
module.exports = { createRequests };
