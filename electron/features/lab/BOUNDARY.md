# Boundary: Lab engine

Runs Virtual Lab experiments: samples a project's past changes that came with tests, runs each approach in its own worktree through the dispatch helper,
grades it with the change's hidden tests and a blind review, and owns the lab window, its IPC and dedicated preload. Unknown measurements stay null.

## Owns
- `electron/features/lab/**`

## Interface
- `createLab` (`electron/features/lab/index.cjs`) — injected main-process composition: the lab window, its IPC and the experiment engine; open, sync and dispose

## May import
- `electron/i18n.cjs`
- `electron/shared/ipc.cjs`
- `electron/features/dashboard/cost.cjs`
- `electron/features/dashboard/records-routing.cjs`
- `electron/features/dashboard/prices.json`

## Invariants
- Lab IPC requires the exact main frame and page, and only the main window may open the lab — other pages cannot start or read experiments — test: `tests/lab-engine-window.test.cjs` › "lab IPC requires the exact main frame and page and only the main window may open it"
- The lab preload exposes exactly LabBridge — the page gets no other main-process power — test: `tests/lab-engine-window.test.cjs` › "lab preload exposes exactly LabBridge"
- Runs never change the project's own working tree or its team journal — an experiment must not touch the owner's work — test: `tests/lab-engine.test.cjs` › "a fake helper runs, grades and saves both arms without changing the original tree or team journal"
- Tasks are rebuilt and validated in the main process: unsupported sources, duplicate arms, forged commits and path-like ids are rejected — the page cannot point a run at arbitrary code or files — test: `tests/lab-engine.test.cjs` › "validation rejects unsupported sources, duplicate arms, forged commits, bounds and path-like ids"
- A task passes only when all its hidden tests pass in a strict majority of repeats; a test that cannot run is an error, never a pass — the lab must not invent success — test: `tests/lab-engine.test.cjs` › "pass rule needs all hidden tests in a strict majority and never counts a tie or zero tests"
- Unknown cost stays null while the budget reserves the estimate, and no run starts once the reservation would exceed the budget — spending is bounded and never made up — test: `tests/lab-engine.test.cjs` › "unknown real cost remains null while budget accounting reserves the estimate"
- Stop and timeouts end every descendant worker before the run's worktree is removed — no worker keeps running or writing after a stop — test: `tests/lab-engine.test.cjs` › "stop kills detached descendants before worktree cleanup and marks the remaining runs stopped"
- Experiments still running at startup are marked stopped, and store ids cannot leave userData — a crash cannot resume spending or escape the data folder — test: `tests/lab-engine.test.cjs` › "persisted running experiments are stopped on reload and store ids cannot escape userData"

## Not ours
- The lab page and the Windows/Linux menu entry — Lab window page (`src/features/lab`)
- The contract between page and engine — `src/shared/lab-types.ts` (changed only through the lead)
- Starting, authenticating and reporting workers — Dispatch (`integration/dispatch.cjs`)
- Run records, public prices and cost estimates — Dashboard records (`electron/features/dashboard`)
