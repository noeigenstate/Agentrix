# Boundary: Team

Shares project memory, a live worker board and an end journal under Git's common directory.

## Owns
- `electron/features/team/team.cjs`
- `electron/features/team/inbox.cjs`
- `electron/features/team/team-locate.cjs`

## Interface
- `projectTeam` (`electron/features/team/team.cjs`) — opens repository coordination state. `register` publishes a live entry, `context` builds the brief prefix, and `finish` appends findings and worker end metadata.
- `RunInbox` (`electron/features/team/inbox.cjs`) — a dispatched run's bounded owner inbox: incremental reads, atomic final closure; `queueControl` and `recordControl` serialize owner controls, their audit record and the planner's notification, rolling back when the planner's admission fails
- `locateTeam` (`electron/features/team/team-locate.cjs`) — main's team lookup for a working directory without blocking: Git runs off the event loop, Git's common directory is remembered 30 s by the directory's real path and a failed lookup or a Git that takes over 10 s (null) is never kept, and whether the team folder exists is checked on every lookup; `createTeamLocator({ execFile, now })` lets a test delay or fail Git — covered by `tests/team-locate.test.cjs`; the helper keeps the synchronous `projectTeam`

## May import

## Invariants
- All worktrees share Git's common-directory state. Outside Git, workers start without repository context — test: `tests/dispatch-team.test.cjs` › "worktrees share team state and outside git the helper behaves as before"; main and its consumers ask `locateTeam` without blocking the control channel — test: `tests/boundary-dispatch.test.cjs` › "main, the control channel and the sub-agent view ask the team without a synchronous Git call"
- Each run registers its helper PID with an atomic rename, releases the entry on exit, and board reads remove dead helpers — test: `tests/dispatch-team.test.cjs` › "a scoped build starts while a worker with overlapping scope is still running"; test: `tests/dispatch-team.test.cjs` › "board entries leave on failed spawn and interruption"
- Inbox updates and worker end writes retain the exclusive lock with its 15 s deadline and stale-lock recovery — test: `tests/dispatch-team.test.cjs` › "dead board entries and stale locks are removed while a live lock is respected"
- Briefs carry a bounded UTF-8 memory excerpt, live peers and repository context. Legacy round headings are read as ordinary text. Findings reach memory and any explicit ledger — test: `tests/dispatch-team.test.cjs` › "briefs inject ledger first then recent memory live peers and bounded repository context"; test: `tests/dispatch-team.test.cjs` › "findings always reach memory and also reach an explicit ledger"

## Not ours
- Launching workers, checking their working-tree changes and authenticating their events — Dispatch
- Planning tasks and reviewing the completed work — the lead
- Displaying dispatched workers inside the app — Activity pane
