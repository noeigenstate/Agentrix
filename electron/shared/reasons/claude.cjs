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
    // The route decision (R2).
    billing_mismatch: {},
    invalid_key: {},
    route_config: {},
    native_cli_unverified: {},
    // Limits the provider reports; Agentrix sets none of its own.
    credits_exhausted: {},
    rate_limited: {},
    account_limit: {},
  },
};
