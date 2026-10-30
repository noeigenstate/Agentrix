# Boundary: Team

Coordinates dispatched workers through shared project memory, roundtable records and a live scope board in Git's common directory, and produces the owner's roundtable minutes.

## Owns
- `electron/features/team/team.cjs`
- `electron/features/team/minutes-page.cjs`

## Interface
- `projectTeam` (`electron/features/team/team.cjs`) — repository state, worker admission, context, meeting records, minutes data and consolidation
- `minutesMarkdown` (`electron/features/team/team.cjs`) — two Markdown tables from the minutes-page data contract
- `minutesPage` (`electron/features/team/minutes-page.cjs`) — a self-contained HTML document from the same minutes data

## May import
- `electron/boundaries.cjs`

## Invariants
- All worktrees share Git's common-directory state; roundtables require Git and other runs keep their outside-Git behavior — repository context must not cross repositories — test: `tests/dispatch-team.test.cjs` › "worktrees share team state and outside git the helper behaves as before"; test: `tests/dispatch-team.test.cjs` › "roundtables outside git are refused before any worker launches"
- Scope admission checks and board registration hold one exclusive lock, and dead helpers are removed — simultaneous launches must not acquire overlapping files — test: `tests/dispatch-team.test.cjs` › "simultaneous helpers serialize overlap admission and retain the helper pid"
- Execution requires its resumed session's latest clean confirmation and the agreed scope set, or a recorded skip reason — a worker must understand its task before work — test: `tests/dispatch-team.test.cjs` › "execution requires a confirmed resumed session and the same scope set"
- A different meeting waits for pending rounds; consolidated ids stay closed, live workers prevent consolidation, and late ends make a round pending again — reusing ids must not bypass consolidation — test: `tests/dispatch-team.test.cjs` › "meeting lifecycle closes consolidated ids blocks reused ids and tracks late ends"
- Only complete understanding and exact confirmation blocks advance a clean meeting; other ends are invalid — failed work cannot approve the next run — test: `tests/dispatch-team.test.cjs` › "failed meetings are invalid even when the answer confirms"
- Briefs carry bounded recent memory, live peers and repository context; findings reach memory and any explicit ledger — workers need shared decisions and each other's findings — test: `tests/dispatch-team.test.cjs` › "briefs inject ledger first then recent memory live peers and bounded repository context"
- Minutes retain each session's latest understanding, status and new confirmation questions with the agreed page shape — the owner sees the interfaces and unresolved questions — test: `tests/dispatch-team.test.cjs` › "minutes write two escaped Markdown tables and the HTML companion without a worker"; test: `tests/dispatch-team.test.cjs` › "confirmation questions reach both minutes formats with their language prefix"
- Consolidation requires results and architecture headings and appends both memory and the journal — a prose-free completion cannot unlock the next round — test: `tests/dispatch-team.test.cjs` › "consolidation validates headings before appending memory and journal"

## Not ours
- Launching workers, checking their working-tree changes and authenticating their events — Dispatch
- Planning tasks, answering roundtable questions and reviewing the completed work — the lead
- Displaying dispatched workers inside the app — Activity pane
