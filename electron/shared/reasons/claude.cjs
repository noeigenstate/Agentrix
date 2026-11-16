// Reason codes of the Claude runtime (C-1): the locator, the route and billing decision, and the limits the provider
// reports. A code maps to the parameter names and stage values it may carry; its words live in
// src/shared/reason-words/claude.ts. The locator, R2 and B1 rounds extend this table, nobody else.
module.exports = {
  codes: {
    // The locator.
    not_found: {},
    too_old: {},
    cli_split_versions: {},
    timeout: {},
    failed: {},
    unreadable: {},
    // The route decision (R2): each fact decide() reads, and the settings' own choice. The names are the ones the windows
    // already receive as a path's reason.
    no_key: {},
    invalid_key: {},
    key_forbidden: {},
    api_unreachable: {},
    key_check_failed: {},
    native_cli_required: {},
    native_cli_unverified: {},
    cli_too_old: {},
    billing_identity_mismatch: {},
    billing_unconfirmed: {},
    route_config: {},
    api_unavailable: {},
    terminal_selected: {},
    set_terminal: {},
    set_api: {},
    // Limits the provider reports; Agentrix sets none of its own.
    credits_exhausted: {},
    rate_limited: {},
    account_limit: {},
  },
};
