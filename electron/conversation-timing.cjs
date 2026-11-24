// User-only batches should acknowledge a send quickly; streaming updates stay batched.
function conversationBatchDelay(changes) {
  return changes.length && changes.every(change => !change.reset && change.entry?.role === 'user') ? 30 : 50;
}

// The same monitor follows both Codex rollouts and Claude transcripts. Resolve it at poll
// time because Claude may attach its follower only after the submission hook arrives.
function pollAfterSubmission(session, isCurrent) {
  session.submissionPolls ||= new Set();
  for (const delay of [150, 400, 900]) {
    const timer = setTimeout(() => {
      session.submissionPolls.delete(timer);
      if (isCurrent() && session.cliActive) void session.activityMonitor?.poll();
    }, delay);
    timer.unref?.(); session.submissionPolls.add(timer);
  }
}

module.exports = { conversationBatchDelay, pollAfterSubmission };
