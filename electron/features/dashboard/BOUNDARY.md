# Boundary: Dashboard

Keeps private evaluation records and owns the dashboard window, which answers one question: how reliably each model's dispatched tasks come back tested.
A task is one dispatched role run. Its outcome is unfinished when it did not end cleanly, and otherwise follows the checks the role reported through
finish_role (`checks` on the run record, counts by result): failed when one failed, passed when one passed, untested otherwise and on records from
before checks were kept. The pass rate is passed over all tasks; fewer than five tasks is a small sample, marked and ranked last.
Quota and model names use the registered provider and model IDs, including prefixes that preserve distinct providers for models with the same name.
Weights the owner adopted on earlier dashboards stay in their decision files and still reach model routing through `routingNote`; nothing records new ones.

## Owns
- `electron/features/dashboard/**` — bounded records, the reliability summary, the adopted-weight reader, prices, window, IPC and dedicated preload

## Interface
- `DashboardRecords` (`electron/features/dashboard/records.cjs`) — asynchronous append and bounded read(kind, { since }); run, grade and quota hooks, subscribe(listener), busy and one capped waitForQuit()
- `quotaScope` (`electron/features/dashboard/records.cjs`) — anonymized account-series key for a provider, project location and CLI home
- `TASK_KINDS` (`electron/features/dashboard/records-routing.cjs`) — historical task categories, with `DISPATCH_TASK_KINDS` for new launches
- `taskKind` (`electron/features/dashboard/records-routing.cjs`) — task kind from an explicit category or role default, including historical calls
- `routingVerdict` (`electron/features/dashboard/records-routing.cjs`) — the shared declared-versus-reported routing decision
- `estimateCost` (`electron/features/dashboard/cost.cjs`) — pure public-price equivalent with standard and Fast rows, used by the Virtual Lab
- `models` (`electron/features/dashboard/prices.json`) — the public per-model price table, read by the Virtual Lab
- `summarize` (`electron/features/dashboard/summary.cjs`) — pure DashboardSummary from bounded run records, projects, query and time: per-model outcomes, the trend and model × kind cells
- `routingNote` (`electron/features/dashboard/decisions.cjs`) — synchronous English paragraph listing the model and task-kind weights adopted on earlier dashboards
- `createDashboard` (`electron/features/dashboard/index.cjs`) — injected main-process composition; open, summary, sync and dispose

## May import
- `electron/i18n.cjs`
- `electron/shared/ipc.cjs`
- `electron/features/cli-adapters/registry.cjs` (session identity and quota scope)
- `electron/features/cli-adapters/registry.mjs` (registered model IDs and prefixes)

## Invariants
- App records contain only the declared metadata fields, with the owner's sent-back note as the local text field and a role's checks as counts by result — conversations, credentials and scope filenames do not belong in evaluation data — test: `tests/dashboard-records.test.cjs` › "run and grade hooks retain only local evaluation metadata"; test: `tests/dashboard-records.test.cjs` › "a role’s reported checks reach its run record by result; malformed counts are refused and older records read as untested"
- Recording failures never reject and quit drains at most once within two seconds — evaluation cannot block the owner's work or exit — test: `tests/dashboard-records.test.cjs` › "quit drains once within the cap even with a stalled write and a late append"
- Quota series isolate providers, hosts and CLI homes and persist trailing changes — account series cannot mix or expose their locations — test: `tests/dashboard-records.test.cjs` › "quota series isolate providers, SSH hosts and CLI homes without recording their names"
- A pass needs a check that ran and passed; untested and unfinished tasks count against the pass rate, and a small sample never ranks above a model with enough tasks — the dashboard must not invent reliability — test: `tests/dashboard-summary.test.cjs` › "a small sample is marked and ranked after every model with enough tasks, even at 100%"
- Dashboard IPC requires its own main-frame and open requires the main window; its dedicated sandboxed preload has only DashboardBridge — other pages cannot read evaluation data or control the window — test: `tests/dashboard-window.test.cjs` › "open accepts only the main main-frame and every other dashboard IPC accepts only the dashboard main-frame"
- While open, the dashboard reads again at least once a minute and run record changes coalesce for one second; closing or disposing cancels every timer — the owner's numbers must stay current without a click — test: `tests/dashboard-live.test.cjs` › "an open dashboard refreshes on each minute, advances its range, and stops on close or dispose"

## Not ours
- Authenticating worker events and extracting usage — Dispatch
- Keeping dispatch start metadata and rejecting duplicate ends — Activity pane
- Accepting and sending back deliveries in the interface — Home
- Dashboard renderer and the menu entry in `src/features/titlebar/AppMenu.tsx` — Dashboard page
