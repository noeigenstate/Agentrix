# Boundary: Team

Shares project memory, a live worker board and an end journal under Git's common directory.
The structured migration uses `memory.jsonl` as the source for rendered `memory.md`. The journal retains a v0 reader for historical rows.
Inbox records add v1 in 1.6.4. The intervention type starts in 1.6.5 to keep old inbox readers working.

## Owns
- `electron/features/team/team.cjs`
- `electron/features/team/inbox.cjs`
- `electron/features/team/team-locate.cjs`

## Interface
- `projectTeam` (`electron/features/team/team.cjs`) — opens repository coordination state. `register` publishes a live entry, `context` builds the brief prefix, and `finish` appends findings and worker end metadata.
- `RunInbox` (`electron/features/team/inbox.cjs`) — a dispatched run's bounded owner inbox: incremental reads, atomic final closure; `queueControl` and `recordControl` serialize owner controls, their audit record and the planner's notification, rolling back when the planner's admission fails
- `readRows` (`electron/features/team/inbox.cjs`) — returns supported memory or journal entries and a count of skipped rows
- `locateTeam` (`electron/features/team/team-locate.cjs`) — main's team lookup for a working directory without blocking: Git runs off the event loop, Git's common directory is remembered 30 s by the directory's real path and a failed lookup or a Git that takes over 10 s (null) is never kept, and whether the team folder exists is checked on every lookup; `createTeamLocator({ execFile, now })` lets a test delay or fail Git — covered by `tests/team-locate.test.cjs`; the helper keeps the synchronous `projectTeam`

## May import

- `electron/boundaries.cjs` (the allowed-path glob matcher)
- `electron/features/agents/dispatch-events.cjs` (ledger, board, journal and inbox formats)

## Invariants
- Historical envelope reads and the 1.6.4 inbox shape are pinned — test: `tests/wire-format.test.cjs` › "wire fixtures preserve fields and reject unsupported versions with their channel"
- Team text readers stay within the module baseline — test: `tests/self-format-guard.test.cjs` › "product and test text readers match the per-module self-format baseline"
- All worktrees share Git's common-directory state. Outside Git, workers start without repository context — test: `tests/dispatch-team.test.cjs` › "worktrees share team state and outside git the helper behaves as before"; main and its consumers ask `locateTeam` without blocking the control channel — test: `tests/boundary-dispatch.test.cjs` › "main, the control channel and the sub-agent view ask the team without a synchronous Git call"
- Each run registers its helper PID with an atomic rename, releases the entry on exit, and board reads remove dead helpers — test: `tests/dispatch-team.test.cjs` › "a scoped build starts while a worker with overlapping scope is still running"; test: `tests/dispatch-team.test.cjs` › "board entries leave on failed spawn and interruption"
- Inbox updates and worker end writes retain the exclusive lock with its 15 s deadline and stale-lock recovery — test: `tests/dispatch-team.test.cjs` › "dead board entries and stale locks are removed while a live lock is respected"
- Normal briefs carry the newest two entries and relevant older entries within 6 KiB, truncating at paragraph boundaries. Read-only roles whose memory file is outside their folder get a notice to request entries from the lead. Small briefs skip memory. Findings reach memory and any explicit ledger — test: `tests/dispatch-team.test.cjs` › "memory includes the newest two entries and matches older bodies within its byte budget"; test: `tests/dispatch-team.test.cjs` › "findings always reach memory and also reach an explicit ledger"

## Not ours
- Launching workers, checking their working-tree changes and authenticating their events — Dispatch
- Planning tasks and reviewing the completed work — the lead
- Displaying dispatched workers inside the app — Activity pane
