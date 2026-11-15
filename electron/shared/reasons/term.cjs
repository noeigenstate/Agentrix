// Reason codes of the terminal event pipeline (C-1). A code maps to the parameter names and stage values it may carry;
// its words live in src/shared/reason-words/term.ts. The terminal-events rounds extend this table, nobody else.
module.exports = {
  codes: {
    waiting_permission: {},
    waiting_question: {},
    menu_open: {},
    queued_behind_turn: {},
    turn_running: {},
    cli_not_ready: {},
    input_has_draft: {},
    receipt_missing: {},
    hooks_silent: {},
    hooks_down: {},
    // variable: HTTPS_PROXY or HTTP_PROXY (the hook client ignores ALL_PROXY); source: where it was set, environment,
    // user, project, local or managed (Claude Code's settings files), or terminal (the wrapper's live check).
    hooks_command_proxy: { params: ['variable', 'source'] },
    hooks_command_ssh: {},
    transcript_behind: {},
    interrupted: {},
  },
};
