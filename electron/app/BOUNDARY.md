# Boundary: Application host

Assembles terminal sessions, IPC, window state and presentation from application shell dependencies.

## Owns
- `electron/app/terminal-lifecycle.cjs`
- `electron/app/process-lifecycle.cjs`
- `electron/app/application-ipc.cjs`
- `electron/app/public-state.cjs`
- `electron/app/session-presentation.cjs`
- `electron/app/project-previews.cjs`
- `electron/app/window-host.cjs`
- `electron/app/window-startup.cjs`
- `electron/features/agents/usage-host.cjs`

## Interface
- `createTerminalLifecycle` (`electron/app/terminal-lifecycle.cjs`) — shell selection, PTY startup, session input and output, restore, and disposal
- `createCloseGuards` (`electron/app/terminal-lifecycle.cjs`) — terminal close and application quit confirmation
- `restoreTerminals` (`electron/app/terminal-lifecycle.cjs`) — stagger startup restores after the CLI discovery wait

- `registerQuit` (`electron/app/process-lifecycle.cjs`) — drain workers and release application resources before quit
- `startEventServer` (`electron/app/process-lifecycle.cjs`) — route worker ingress first along with `startHookServer`, and resolve the current lead with `workerParent`

- `registerApplicationIpc` (`electron/app/application-ipc.cjs`) — application IPC registration and renderer sender checks
- `createPublicState` (`electron/app/public-state.cjs`) — project and terminal lookups, ordering and the public workspace snapshot
- `createSessionPresentation` (`electron/app/session-presentation.cjs`) — reading history, conversation batches and routing launch notes
- `createProjectPreviews` (`electron/app/project-previews.cjs`) — generated image and themed project previews
- `createWindowHost` (`electron/app/window-host.cjs`) — theme, menus, indicators and completion notifications
- `openMainWindow` (`electron/app/window-startup.cjs`) — primary and secondary window setup with deferred Lab loading

- `createUsageHost` (`electron/features/agents/usage-host.cjs`) — usage meters, account watchers, CLI checks and model probes

## May import
- `electron/features/routing/store.cjs` (remote guide payload)
- `electron/features/cli-adapters/capabilities.mjs` (owner session eligibility)
- `electron/features/cli-adapters/registry.mjs` (provider of a selected quota model)
- `electron/project-svg.cjs` (project image theming)
- `electron/conversation-timing.cjs` (publication delay)
- `electron/app/mac-menu.cjs` (native menu template)
- `electron/i18n.cjs` (main-process translation)

## Invariants
- Terminal exit removes abandoned runtime files for its own session — test: `tests/main-terminal-cleanup.test.cjs` › "normal terminal exit also removes abandoned settings"
- Startup restore waits for both CLI discovery attempts within its existing bound — test: `tests/main-startup-first-looks.test.cjs` › "a restored terminal waits for the Codex first look"

## Not ours
- Shell event admission and CLI state updates — Terminal events
- Native provider composition and runtime routing — Native session router
