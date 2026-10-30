# Boundary: Dashboard records

Keeps local, versioned model-evaluation records and exposes the pure cost estimate. Round incidents and review findings belong to the repository's Team journal.

## Owns
- `electron/features/dashboard/**` — records*.cjs, cost.cjs and prices.json

## Interface
- `DashboardRecords` (`electron/features/dashboard/records.cjs`) — asynchronous append and bounded read(kind, { since }); run, grade and quota hooks, busy and one capped waitForQuit()
- `quotaScope` (`electron/features/dashboard/records.cjs`) — anonymized account-series key for a provider, project location and CLI home
- `TASK_KINDS` (`electron/features/dashboard/records-routing.cjs`) — the shared task categories, carried with the dispatch runtime
- `taskKind` (`electron/features/dashboard/records-routing.cjs`) — task kind from an explicit category, roundtable or role default
- `routingVerdict` (`electron/features/dashboard/records-routing.cjs`) — the shared declared-versus-reported routing decision

## May import

## Invariants
- App records contain only the declared metadata fields, with the owner's sent-back note as the local text field — conversations, credentials and scope filenames do not belong in evaluation data — test: `tests/dashboard-records.test.cjs` › "run and grade hooks retain only local evaluation metadata"
- Stores serialize writes, reject oversized lines and rotate to one previous generation — records stay valid and disk use stays bounded — test: `tests/dashboard-records.test.cjs` › "append queues valid lines and rotates one generation"
- Disk failures never reject recording calls and are logged once — recording cannot block the owner's work — test: `tests/dashboard-records.test.cjs` › "unwritable stores never reject and log once"
- Reads include at most two bounded file tails and return at most 10000 versioned records since the requested time — long-term evaluation cannot require an unbounded read — test: `tests/dashboard-records.test.cjs` › "reads bound history and skip malformed oversized and torn records"
- Quota snapshots use a short digest per provider and account scope, record the first reading and the trailing change within each ten-minute window — hosts and CLI homes must neither mix nor leak into evaluation records — test: `tests/dashboard-records.test.cjs` › "quota series isolate providers, SSH hosts and CLI homes without recording their names"; test: `tests/dashboard-records.test.cjs` › "quota bursts persist the trailing value when the ten-minute window ends"
- Quit waits at most once for pending writes, capped at two seconds, and flushes trailing quota changes — late appends and stalled disks cannot prevent quitting — test: `tests/dashboard-records.test.cjs` › "quit drains once within the cap even with a stalled write and a late append"
- outputTokens and activeMs describe the same timed replies; totalOutputTokens holds this invocation's cost count — incomplete timing must not inflate a displayed rate — test: `tests/dispatch.test.cjs` › "an untimed Codex reply changes cost totals without changing the pane or helper rate"

## Not ours
- Authenticating worker events and extracting usage — Dispatch
- Keeping dispatch start metadata and rejecting duplicate ends — Activity pane
- Accepting and sending back deliveries in the interface — Home
- Repository incident and review-finding records — Team
- Dashboard windows and routing suggestions — the next dashboard round
