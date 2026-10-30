# Boundary: Dashboard records

Keeps local, versioned model-evaluation records and exposes the pure cost estimate. Round incidents and review findings belong to the repository's Team journal.

## Owns
- `electron/features/dashboard/**` — records*.cjs, cost.cjs and prices.json

## Interface
- `DashboardRecords` (`electron/features/dashboard/records.cjs`) — asynchronous append and bounded read(kind, { since }); run, grade and quota recording hooks

## May import

## Invariants
- App records contain only the declared metadata fields, with the owner's sent-back note as the local text field — conversations, credentials and scope filenames do not belong in evaluation data — test: `tests/dashboard-records.test.cjs` › "run and grade hooks retain only local evaluation metadata"
- Stores serialize writes, reject oversized lines and rotate to one previous generation — records stay valid and disk use stays bounded — test: `tests/dashboard-records.test.cjs` › "append queues valid lines and rotates one generation"
- Disk failures never reject recording calls and are logged once — recording cannot block the owner's work — test: `tests/dashboard-records.test.cjs` › "unwritable stores never reject and log once"
- Reads include at most two bounded file tails and return at most 10000 versioned records since the requested time — long-term evaluation cannot require an unbounded read — test: `tests/dashboard-records.test.cjs` › "reads bound history and skip malformed oversized and torn records"
- Quota snapshots contain no account identity and write changed readings at most once per provider per ten minutes, beginning with the first reading — repeated terminal publication must not multiply account history — test: `tests/dashboard-records.test.cjs` › "quota snapshots throttle each provider and preserve zero"

## Not ours
- Authenticating worker events and extracting usage — Dispatch
- Keeping dispatch start metadata and rejecting duplicate ends — Activity pane
- Accepting and sending back deliveries in the interface — Home
- Repository incident and review-finding records — Team
- Dashboard windows and routing suggestions — the next dashboard round
