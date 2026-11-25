# Boundary: Codex sandbox setup

Offers elevated sandbox setup for the app's local Codex installation on Windows until Codex is ready or the owner dismisses future offers.
A failed executable lookup allows another offer during the same app run.

## Owns
- `electron/features/codex-sandbox-setup/**`

## Interface
- `createSandboxSetup` (`electron/features/codex-sandbox-setup/index.cjs`) — creates an asynchronous startup offer over main's executable locator, window state, translation and dialog.

## May import
- `electron/features/codex-app-server/index.cjs`
- `electron/features/codex-app-server/sandbox-refresh.cjs`

## Invariants
- Only a local Windows Codex reporting notConfigured or updateRequired can prompt. Later defers the offer for this run. Don't ask again saves the owner's choice in application settings — test: `tests/codex-sandbox-setup.test.cjs` › "Later defers the offer until another app run"
- A parseable setup marker delays the startup probe by 30 seconds. Only the app-server's readiness reply determines whether to offer setup — test: `tests/codex-sandbox-setup.test.cjs` › "a parseable setup marker defers the lookup and still asks Codex before showing the dialog"
- A successful setup requires the user's acceptance and a fresh ready response. Only then does the offer run its fixed offline sandbox command and show indeterminate progress while it waits for a fresh successful read-ACL completion. The wait ends within 15 minutes, and closing the app-server leaves an ongoing ACL worker alone. Readiness and refresh create no thread and submit no model input — test: `tests/codex-sandbox-setup.test.cjs` › "the fixed refresh command creates no model turn and progress needs the ACL completion"
- Elevated setup runs verified private copies under a five-minute limit — test: `tests/codex-sandbox-setup.test.cjs` › "the setup work verifies and launches the same private copy or refuses it"

## Not ours
- Deciding when the main window shows or locating Codex — main and Codex runtime
- Per-role sandbox admission and SSH sessions — Codex app-server runtime
