# Boundary: Terminal events

How a terminal's CLI reports to main: the Claude Code hook events and transcript, and the Codex and Claude turn snapshots, turned into the terminal's CLI state, lights and completion alert; and the bootstrap file a terminal's hooks and the dispatch helper read to reach main.

## Owns
- `electron/features/terminal-events/**`

## Interface
- `createClaudeActivity` (`electron/features/terminal-events/claude-activity.cjs`) — followClaude, followClaudeSession, publishCliState, applyActivity and claudeActivity over the app shell's deps, read on every call; main hands it every agent-activity event and every turn snapshot
- `writeBootstrap` (`electron/features/terminal-events/bootstrap-file.cjs`) — the one writer of a terminal's or native session's bootstrap file (session key, event pipe, control channel, and a terminal's hook paths), readable only by its owner

## May import

## Invariants
- CLI state is published synchronously from the hook that reports it, and a Stop never waits on the transcript reader — the waiting light and the round end must not lag behind the CLI — test: `tests/main-cli-state.test.cjs` › "host CLI transitions broadcast synchronously and Stop does not await a stalled transcript reader"
- An old session, an old event time, a duplicate event or another tool's progress never clears newer attention — a stale hook must not hide a question the CLI is asking — test: `tests/main-cli-state.test.cjs` › "old session, old event time, duplicate events and another tool cannot clear newer attention"
- Progress, a repeated Stop and a local command never rearm completion — AGENTS.md: completion notifications are never rearmed by idle or background callbacks — test: `tests/main-cli-state.test.cjs` › "local command completion clears attention, while progress and repeated Stop never rearm completion"
- main.cjs defines none of this module's functions and writes no bootstrap file itself; it only wires the module — main regrowing the carved region would bring back the bottleneck every round edits — test: `tests/main-carve-out.test.cjs` › "main.cjs only wires the terminal activity, bootstrap, switch host, host inputs and dispatch intake modules"

## Not ours
- Spawning the PTY, the session records and restore plans — main.cjs (app shell)
- Round completion, prompt queues and the completion notification — Completion
- Reading the transcript records into the conversation, actions and usage — Activity pane and the readers main passes in
- The event pipe server and the hooks' own scripts — electron/events.cjs and integration/
