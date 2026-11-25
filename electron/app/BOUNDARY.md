# Boundary: Terminal lifecycle host

Assembles, starts, restores and disposes terminal sessions with dependencies supplied by the application shell.

## Owns
- `electron/app/terminal-lifecycle.cjs`

## Interface
- `createTerminalLifecycle` (`electron/app/terminal-lifecycle.cjs`) — shell selection, PTY startup, session input and output, restore, and disposal
- `createCloseGuards` (`electron/app/terminal-lifecycle.cjs`) — terminal close and application quit confirmation
- `restoreTerminals` (`electron/app/terminal-lifecycle.cjs`) — stagger startup restores after the CLI discovery wait

## May import

## Invariants
- Terminal exit removes abandoned runtime files for its own session — test: `tests/main-terminal-cleanup.test.cjs` › "normal terminal exit also removes abandoned settings"
- Startup restore waits for both CLI discovery attempts within its existing bound — test: `tests/main-startup-first-looks.test.cjs` › "a restored terminal waits for the Codex first look"

## Not ours
- Shell event admission and CLI state updates — Terminal events
- Native provider composition and runtime routing — Native session router
