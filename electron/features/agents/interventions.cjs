const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { projectTeam } = require('../team/team.cjs');
const { validText, runId } = require('../team/inbox.cjs');

function createInterventions({ resolve, pushControl, sendDirect, now = Date.now }) {
  const pending = new Map();
  function submit(terminalId, callId, text, stopping) {
    if (typeof terminalId !== 'string' || !terminalId || typeof callId !== 'string' || !/^(?:dispatch:|agent:)[\w-]{1,160}$/.test(callId)) return Promise.reject(new Error('无效的子代理。'));
    if (!stopping && !validText(text)) return Promise.reject(new Error('插话须为 1 至 4000 个字符。'));
    const previous = pending.get(terminalId) || Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      // The resolver owns provenance and the original planner binding; never accept routing or filesystem paths
      // from the renderer. Repeat that check while admitting the durable inbox record.
      const target = await resolve(terminalId, callId);
      if (!target || target.terminalId !== terminalId || target.callId !== callId || !target.parentSessionId || !target.confirmed || target.done) throw new Error('子代理已结束或尚未就绪。');
      if (!['dispatch', 'parent'].includes(target.route) || !validText(target.title)) throw new Error('无效的子代理。');
      const control = { id: randomUUID(), at: now(), ...(stopping ? { type: 'stop' } : { text }) };
      const receipt = { id: control.id, callId, text: stopping ? '停下' : text, at: control.at, route: target.route, status: 'queued' };
      const notify = async () => {
        const current = await resolve(terminalId, callId);
        if (!current || current.parentSessionId !== target.parentSessionId || current.terminalId !== terminalId || current.callId !== callId || current.done || !current.confirmed) throw new Error('规划员会话已变化，消息未发送。');
      };
      if (target.route === 'parent') {
        if (!sendDirect) throw new Error('此工作者的插话通道不可用。');
        const team = typeof target.projectPath === 'string' && projectTeam(target.projectPath);
        const deliver = async () => { await notify(); await sendDirect(target, control); };
        if (team) await team.recordControl(callId, target.title, control, deliver); else await deliver();
        return receipt;
      }
      if (target.local !== true || !runId(target.runId) || callId !== `dispatch:${target.runId}` || typeof target.cwd !== 'string' || typeof target.projectPath !== 'string') throw new Error('此工作者的插话通道不可用。');
      const team = projectTeam(target.cwd), parent = projectTeam(target.projectPath);
      if (!team || !parent || fs.realpathSync.native(team.directory) !== fs.realpathSync.native(parent.directory)) throw new Error('此工作者的插话通道不可用。');
      await team.queueControl(target.runId, control, notify);
      if (pushControl) {
        try {
          const result = await pushControl(target.runId, { messageId: control.id, type: stopping ? 'stop' : 'intervene', ...(!stopping ? { text } : {}) });
          if (['queued', 'delivered', 'rejected', 'unknown'].includes(result?.status)) receipt.status = result.status;
        } catch { receipt.status = 'unknown'; }
      }
      return receipt;
    });
    pending.set(terminalId, task);
    void task.finally(() => { if (pending.get(terminalId) === task) pending.delete(terminalId); }).catch(() => {});
    return task;
  }
  return {
    interveneAgent: (terminalId, callId, text) => submit(terminalId, callId, text, false),
    stopAgent: (terminalId, callId) => submit(terminalId, callId, '', true),
  };
}

module.exports = { createInterventions };
