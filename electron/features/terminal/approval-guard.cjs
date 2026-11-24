// These are Agentrix observation epochs, NOT native CLI approval request IDs. Any raw output (including an
// identical repaint), ordinary input or observed lifecycle change invalidates a captured approval action.
class ApprovalGuard {
  constructor(sessionId) { this.sessionId = sessionId; this.revision = 0; this.contexts = new Map(); }
  invalidate() { this.revision++; this.owner = null; }
  context(source, value) {
    const next = JSON.stringify(value);
    if (this.contexts.get(source) === next) return;
    this.contexts.set(source, next); this.invalidate();
  }
  stamp() { return { sessionId: this.sessionId, revision: this.revision }; }
  matches(stamp) {
    return !!stamp && stamp.sessionId === this.sessionId && Number.isSafeInteger(stamp.revision) && stamp.revision === this.revision;
  }
  send(stamp, key, actionId, write) {
    if (!this.matches(stamp)) throw new Error('审批操作已失效，未发送本次按键。请重新查看请求，或切换到终端处理。');
    if (typeof actionId !== 'string' || !/^[\w-]{1,100}$/.test(actionId) || this.owner && this.owner !== actionId) throw new Error('另一项审批操作已开始，请重新查看请求，或切换到终端处理。');
    this.owner = actionId;
    // Navigation leaves the ticket alive only until the CLI emits anything. Consume a final key before the
    // synchronous PTY write, so even two IPC calls with the same stamp cannot submit twice.
    if (key === '\r' || key === '\x1b') this.invalidate();
    write(key);
  }
}

// Recheck the live session binding at snapshot/IPC boundaries too. Lifecycle callbacks above the transport
// still need context() calls to retain intermediate A/B/A changes that a final value comparison would miss.
function approvalStamp(session) {
  session.approval.context('binding', [session.sessionId, session.agent, session.cliActive, session.status,
    session.rootThreadId, session.reportedThreadId, session.claudeSessionId, session.claudePromptEventId,
    session.activitySince, session.activityInputAt]);
  return session.approval.stamp();
}
module.exports = { ApprovalGuard, approvalStamp };
