# Boundary: Team

Coordinates dispatched workers through shared project memory, roundtable records and a live scope board in Git's common directory, and produces the owner's roundtable minutes.

## Owns
- `electron/features/team/team.cjs`
- `electron/features/team/minutes-page.cjs`

## Interface
- `projectTeam` (`electron/features/team/team.cjs`) — repository state, worker admission, context, meeting records, every-role end metadata, minutes with bounded latest issues snapshots and consolidation with validated incidents and findings
- `minutesMarkdown` (`electron/features/team/team.cjs`) — two Markdown tables from the minutes-page data contract
- `minutesPage` (`electron/features/team/minutes-page.cjs`) — a self-contained HTML document from the same minutes data

## May import
- `electron/boundaries.cjs`
- `electron/features/dashboard/records-routing.cjs`

## Invariants
- All worktrees share Git's common-directory state; roundtables require Git and other runs keep their outside-Git behavior — repository context must not cross repositories — test: `tests/dispatch-team.test.cjs` › "worktrees share team state and outside git the helper behaves as before"; test: `tests/dispatch-team.test.cjs` › "roundtables outside git are refused before any worker launches"
- Scope admission checks and board registration hold one exclusive lock, and dead helpers are removed — simultaneous launches must not acquire overlapping files — test: `tests/dispatch-team.test.cjs` › "simultaneous helpers serialize overlap admission and retain the helper pid"
- Execution requires its resumed session's latest clean confirmation and the agreed scope set, or a recorded skip reason — a worker must understand its task before work — test: `tests/dispatch-team.test.cjs` › "execution requires a confirmed resumed session and the same scope set"
- A different meeting waits for pending rounds; consolidated ids stay closed even after late ends and live workers prevent consolidation — resuming an old review must not block a new round — test: `tests/dispatch-team.test.cjs` › "meeting lifecycle keeps consolidated ids closed even after late ends"; test: `tests/dispatch-team.test.cjs` › "review and investigation resumed from a consolidated round do not block the next roundtable"
- Only complete understanding and exact confirmation blocks advance a clean meeting; other ends are invalid — failed work cannot approve the next run — test: `tests/dispatch-team.test.cjs` › "failed meetings are invalid even when the answer confirms"
- Briefs carry bounded recent memory, live peers and repository context; findings reach memory and any explicit ledger — workers need shared decisions and each other's findings — test: `tests/dispatch-team.test.cjs` › "briefs inject ledger first then recent memory live peers and bounded repository context"
- Minutes retain each session's latest understanding, status and questions, and explicitly supplied issues append a bounded latest snapshot — the owner sees agreements and the dashboard distinguishes historical absence from zero issues — test: `tests/team-issues.test.cjs` › "minutes persist bounded latest issues snapshots and distinguish explicit zero from no snapshot"
- Consolidation requires results and architecture headings and appends both memory and the journal — a prose-free completion cannot unlock the next round — test: `tests/dispatch-team.test.cjs` › "consolidation validates headings before appending memory and journal"

## Not ours
- Launching workers, checking their working-tree changes and authenticating their events — Dispatch
- Planning tasks, answering roundtable questions and reviewing the completed work — the lead
- Displaying dispatched workers inside the app — Activity pane
