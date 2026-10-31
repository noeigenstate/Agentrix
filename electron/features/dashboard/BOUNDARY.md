# Boundary: Dashboard

Keeps private evaluation records, summarizes local model and collaboration evidence, and owns the dashboard window and owner-adopted routing weights. Incidents, findings and roundtable issues originate in Team journals.

## Owns
- `electron/features/dashboard/**` — bounded records and decisions, cost and summary functions, journal readers, suggestions, window, IPC and dedicated preload

## Interface
- `DashboardRecords` (`electron/features/dashboard/records.cjs`) — asynchronous append and bounded read(kind, { since }); run, grade and quota hooks, subscribe(listener), busy and one capped waitForQuit()
- `quotaScope` (`electron/features/dashboard/records.cjs`) — anonymized account-series key for a provider, project location and CLI home
- `TASK_KINDS` (`electron/features/dashboard/records-routing.cjs`) — the shared task categories, carried with the dispatch runtime
- `taskKind` (`electron/features/dashboard/records-routing.cjs`) — task kind from an explicit category, roundtable or role default
- `routingVerdict` (`electron/features/dashboard/records-routing.cjs`) — the shared declared-versus-reported routing decision
- `estimateCost` (`electron/features/dashboard/cost.cjs`) — pure public-price equivalent with standard and Fast rows
- `summarize` (`electron/features/dashboard/summary.cjs`) — pure DashboardSummary from bounded records, project journals, decisions, query and time
- `DashboardDecisions` (`electron/features/dashboard/decisions.cjs`) — serialized bounded append-only decisions with live-state checkpoints at rotation
- `routingNote` (`electron/features/dashboard/decisions.cjs`) — synchronous English paragraph listing currently adopted model and task-kind weights
- `createDashboard` (`electron/features/dashboard/index.cjs`) — injected main-process composition; open, summary, decide, sync, routingNote and dispose

## May import
- `electron/i18n.cjs`

## Invariants
- App records contain only the declared metadata fields, with the owner's sent-back note as the local text field — conversations, credentials and scope filenames do not belong in evaluation data — test: `tests/dashboard-records.test.cjs` › "run and grade hooks retain only local evaluation metadata"
- Stores serialize bounded writes and preserve live decision states through rotation — disk use stays bounded without silently withdrawing adopted weights — test: `tests/dashboard-decisions.test.cjs` › "rotation checkpoints old live decisions rather than losing their adopted routing weights"
- Recording failures never reject and quit drains at most once within two seconds — evaluation cannot block the owner's work or exit — test: `tests/dashboard-records.test.cjs` › "quit drains once within the cap even with a stalled write and a late append"
- Quota series isolate providers, hosts and CLI homes and persist trailing changes — account series cannot mix or expose their locations — test: `tests/dashboard-records.test.cjs` › "quota series isolate providers, SSH hosts and CLI homes without recording their names"
- First pass, rework and phases use the same evidence; unknown metrics stay null and speed uses matched timed replies — the dashboard must not invent performance — test: `tests/dashboard-summary.test.cjs` › "rework follows review completion and explicit review follow-ups, with author and kind isolation"
- Only an explicit decision applies a server-generated suggestion and withdrawal restores the previous live adoption — recommendations cannot silently alter routing — test: `tests/dashboard-window.test.cjs` › "decide resolves server-generated evidence, persists adoption and returns the same query with current weights"
- Dashboard IPC requires its own main-frame and open requires the main window; its dedicated sandboxed preload has only DashboardBridge — other pages cannot read evaluation data or control the window — test: `tests/dashboard-window.test.cjs` › "open accepts only the main main-frame and every other dashboard IPC accepts only the dashboard main-frame"
- Journal reads are bounded and watchers use native real paths shared across worktrees — large history and Windows short paths cannot break the app — test: `tests/dashboard-journals.test.cjs` › "journal reads are bounded and watchers always use native real paths, including shared worktree journals"

## Not ours
- Authenticating worker events and extracting usage — Dispatch
- Keeping dispatch start metadata and rejecting duplicate ends — Activity pane
- Accepting and sending back deliveries in the interface — Home
- Repository incident and review-finding records — Team
- Dashboard renderer and menu entry — Dashboard page
