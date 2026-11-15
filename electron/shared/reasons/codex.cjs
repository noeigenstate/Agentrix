// Reason codes of the Codex runtime (C-1): the locator, the executable check and the account read. A code maps to the
// parameter names and stage values it may carry; its words live in src/shared/reason-words/codex.ts.
module.exports = {
  codes: {
    // Params are flat, so both lists are strings: the folders and places searched, joined by "; ".
    not_found: { params: ['pathFolders', 'searched'] },
    incomplete: {},
    timeout: {},
    failed: {},
    unreadable: {},
    account_read_failed: { stages: ['spawn', 'timeout', 'config', 'rpc'] },
  },
};
