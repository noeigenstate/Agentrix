// Reason codes of the dispatcher (C-1): the helper, the outbox and inbox, the control channel, interception and
// delegation. A code maps to the parameter names and stage values it may carry; its words live in
// src/shared/reason-words/dispatch.ts.
module.exports = {
  codes: {
    // Printed by the helper; main never receives these.
    bootstrap_missing: {},
    bootstrap_invalid: {},
    pipe_unreachable: {},
    pipe_timeout: {},
    // Main's gate.
    session_mismatch: {},
    project_mismatch: {},
    invalid_event: {},
    oversize_event: {},
    unknown_run: {},
    late_after_end: {},
    // The inbox.
    gap_recovered: {},
    outbox_unreadable: {},
    // The control channel and the liveness check.
    control_timeout: {},
    control_unbound: {},
    duplicate_run: {},
    control_disconnected: {},
    helper_gone: {},
    // Interception (C-8): option is the refused option, equivalent the dispatcher command that runs the same call.
    intercept_unsupported: { params: ['option', 'equivalent'] },
    intercept_nested: {},
    // Delegation (C-13): rule is depth, concurrency, count, scope, model, timeout or no_dispatcher.
    delegation_refused: { params: ['rule'] },
    delegation_waiting_lead: {},
    parent_ended: {},
  },
};
