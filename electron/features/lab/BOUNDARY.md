# Boundary: Lab engine

Runs Virtual Lab experiments on macOS and Windows: takes tasks from its sources (the project's own past changes, and the oss and aa providers behind `sources/contract.cjs`), runs each source as one lane
and each approach in its own sandboxed workspace through the dispatch helper, grades it by the source's own tests and, when the provider asks, a blind review, and owns the lab window, its IPC and dedicated preload. Unknown measurements stay null.

## Owns
- `electron/features/lab/**`

## Interface
- `createLab` (`electron/features/lab/index.cjs`) — injected main-process composition: the lab window, its IPC and the experiment engine; open, sync and dispose
- `assertProvider` (`electron/features/lab/sources/contract.cjs`) — the task-source contract providers meet: its typedefs, LAB_SOURCES, LAB_ARMS, TASK_ID and taskKey

## May import
- `electron/i18n.cjs`
- `electron/shared/ipc.cjs`
- `electron/features/dashboard/cost.cjs`
- `electron/features/dashboard/records-routing.cjs`
- `electron/features/dashboard/prices.json`
- `electron/features/lab-oss/index.cjs`
- `electron/features/lab-aa/index.cjs`
- `src/shared/lab-types.ts`

## Invariants
- Lab IPC requires the exact main frame and page, and only the main window may open the lab — other pages cannot start or read experiments — test: `tests/lab-engine-window.test.cjs` › "lab IPC requires the exact main frame and page and only the main window may open it"
- The lab preload exposes exactly LabBridge — the page gets no other main-process power — test: `tests/lab-engine-window.test.cjs` › "lab preload exposes exactly LabBridge and removes event listeners without exposing IPC events"
- Runs never change the project's own working tree or its team journal — an experiment must not touch the owner's work — test: `tests/lab-engine.test.cjs` › "history samples only source changes with executable Node tests and profiles modules without exposing a diff"; test: `tests/lab-engine-sources.test.cjs` › "the history provider conforms and restores its real Node tests over an isolated Git snapshot"
- Main rebuilds every selected task, rejects unsupported or duplicate sources, forged ids and more than 600 runs, and fetches then rebuilds tasks and validates every source's references before any model starts — the page cannot point a run at arbitrary code or files — test: `tests/lab-engine-sources.test.cjs` › "all source references finish before models start and lanes overlap with stable per-lane order"; test: `tests/lab-engine-sources.test.cjs` › "throwing describe becomes unavailable and forged ids, duplicate sources and over 600 runs are rejected"
- Each source owns its grader and score: a task passes only when all its tests pass in a strict majority of repeats, a test that cannot run is an error, never a pass, and scores of different sources are never merged — the lab must not invent success — test: `tests/lab-engine.test.cjs` › "pass rule needs all hidden tests in a strict majority and never counts a tie or zero tests"; test: `tests/lab-engine.test.cjs` › "grading treats failed assertions as failed tests and unavailable or incomplete tests as errors"
- Source budget slices sum to the experiment budget and never rebalance; insufficient funds stop that lane before its next run without rejecting the start, and unknown real cost stays null while the estimate is reserved — spending is bounded and never made up — test: `tests/lab-engine-sources.test.cjs` › "budget slices follow source estimates, sum to the budget and never rebalance"; test: `tests/lab-engine-sources.test.cjs` › "an insufficient single-source budget persists a stopped experiment without rejecting start"
- Model code runs only inside a sandbox session that is offline unless a preparation call asks for the network; on Windows each admission rechecks the real host permissions, a refused or failed preparation starts no worker, and the one elevated step is a fixed operation with no task argument — a run cannot reach the network or protected files by accident — test: `tests/lab-session.test.cjs` › "execute defaults to offline for every call and never retains a preparation allowance"; test: `tests/lab-sandbox-win32.test.cjs` › "prepared hosts are verified on every admission without requesting elevation"; test: `tests/lab-sandbox-win32.test.cjs` › "UAC refusal and unsuccessful preparation fail closed without repeated prompts"
- Container commands reach a task's container only through the run's broker (one capability per run, bounded in size, time and concurrency, cancelled when the run closes), models never get Docker access, and every container of a run is removed after grading, stop or interruption — a model cannot touch another container or leave one behind — test: `tests/lab-session.test.cjs` › "a broker capability belongs to one run and is rejected by another run"; test: `tests/lab-engine-sources.test.cjs` › "Docker uses pinned images without mounts, bounds exec, preserves task exits and removes only owned containers"; test: `tests/lab-engine-sources.test.cjs` › "startup reaps a persisted run container before returning experiments without needing a live session"
- An AA key is stored encrypted, travels only in the AA request header and never enters an experiment or returned data; downloads are hash-checked and size-bounded and every redirect is restricted — a secret or an unpinned file never reaches a run — test: `tests/lab-engine-sources.test.cjs` › "AA keys use encrypted storage, never enter experiments, clear correctly and fail closed without encryption"; test: `tests/lab-engine-sources.test.cjs` › "downloads verify hashes atomically, restrict every redirect and enforce size limits"
- Stop and timeouts end every descendant worker (on Windows the whole Job) before the run's workspace is removed; a broker that ignores cancellation blocks the cleanup instead of allowing it — no worker keeps running or writing after a stop — test: `tests/lab-engine.test.cjs` › "the guardian closes its process group and detached descendants when the app IPC disconnects"; test: `tests/lab-sandbox-win32.test.cjs` › "Windows Job Objects reap detached descendants whose environment markers were erased"; test: `tests/lab-session.test.cjs` › "a handler that refuses cancellation cannot cause live workspace cleanup"
- Experiments still running at startup are marked stopped, and store ids cannot leave userData — a crash cannot resume spending or escape the data folder — test: `tests/lab-engine.test.cjs` › "persisted running experiments are stopped on reload and store ids cannot escape userData"

## Not ours
- The lab page and the Windows/Linux menu entry — Lab window page (`src/features/lab`)
- The contract between page and engine — `src/shared/lab-types.ts` (changed only through the lead)
- Starting, authenticating and reporting workers — Dispatch (`integration/dispatch.cjs`)
- Run records, public prices and cost estimates — Dashboard records (`electron/features/dashboard`)
- The oss and aa task sources — Lab oss source (`electron/features/lab-oss`), Lab aa source (`electron/features/lab-aa`)
