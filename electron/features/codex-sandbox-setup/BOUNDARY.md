# Boundary: Codex sandbox setup

Offers one-time elevated sandbox setup for the app's local Codex installation on Windows.

## Owns
- `electron/features/codex-sandbox-setup/**`

## Interface
- `createSandboxSetup` (`electron/features/codex-sandbox-setup/index.cjs`) — creates an asynchronous startup offer over main's executable locator, window state, translation and dialog.

## May import
- `electron/features/codex-app-server/index.cjs`
- `electron/features/codex-app-server/sandbox-refresh.cjs`

## Invariants
- No Codex or failed readiness check displays nothing. Only a local Windows Codex reporting notConfigured or updateRequired can prompt. A user decision applies to this app run — test: `tests/codex-sandbox-setup.test.cjs` › "only a known unready Windows installation can prompt"; test: `tests/codex-sandbox-setup.test.cjs` › "Later defers the offer until another app run"
- A successful setup requires the user's acceptance and a fresh ready response. Only then does the offer run its fixed offline sandbox command and show indeterminate progress while it waits for a fresh successful read-ACL completion. The wait ends within 15 minutes, and closing the app-server leaves an ongoing ACL worker alone. Readiness and refresh create no thread and submit no model input — test: `tests/codex-sandbox-setup.test.cjs` › "the fixed refresh command creates no model turn and progress needs the ACL completion"
- Only Codex's setup command runs under elevation, with the initiating identity, a local absolute home and a five-minute CLI tree deadline. Agentrix writes no Codex configuration — test: `tests/codex-sandbox-setup.test.cjs` › "setup encodes its arguments and bounds the elevated CLI tree"

## Not ours
- Deciding when the main window shows or locating Codex — main and Codex runtime
- Per-role sandbox admission and SSH sessions — Codex app-server runtime
