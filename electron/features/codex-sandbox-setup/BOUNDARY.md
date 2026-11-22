# Boundary: Codex sandbox setup

Offers one-time elevated sandbox setup for the app's local Codex installation on Windows.

## Owns
- `electron/features/codex-sandbox-setup/**`

## Interface
- `createSandboxSetup` (`electron/features/codex-sandbox-setup/index.cjs`) — creates an asynchronous startup offer over main's executable locator, window state, translation and dialog.

## May import
- `electron/features/codex-app-server/index.cjs`

## Invariants
- No Codex or failed readiness check displays nothing. Only a local Windows Codex reporting notConfigured or updateRequired can prompt. A user decision applies to this app run — test: `tests/codex-sandbox-setup.test.cjs` › "only a known unready Windows installation can prompt"; test: `tests/codex-sandbox-setup.test.cjs` › "Later defers the offer until another app run"
- A successful setup requires the user's acceptance and a fresh ready response. Readiness never starts a thread or submits model input and always closes its app-server — test: `tests/codex-sandbox-setup.test.cjs` › "acceptance runs setup and reports the fresh readiness result"; test: `tests/codex-sandbox-setup.test.cjs` › "the readiness probe initializes and closes its own app-server"
- Only Codex's setup command runs under elevation, with the initiating identity, a local absolute home and a five-minute CLI tree deadline. Agentrix writes no Codex configuration — test: `tests/codex-sandbox-setup.test.cjs` › "setup encodes its arguments and bounds the elevated CLI tree"

## Not ours
- Deciding when the main window shows or locating Codex — main and Codex runtime
- Per-role sandbox admission and SSH sessions — Codex app-server runtime
