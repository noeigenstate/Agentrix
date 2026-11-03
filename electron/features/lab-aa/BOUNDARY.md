# Boundary: Lab aa source

The Virtual Lab's aa task source ("AA 同款"): Terminal-Bench 4.0 tasks run in Docker and graded by each task's own tests, with AA's published scores shown for reference. It meets the source contract (`electron/features/lab/sources/contract.cjs`) and reaches the machine only through the tools and session in its context.

## Owns
- `electron/features/lab-aa/**`

## Interface
- `createAaSource` (`electron/features/lab-aa/index.cjs`) — the aa provider the lab engine runs as one lane of an experiment

## May import
- `electron/i18n.cjs`
- `electron/features/lab/sources/contract.cjs`
- `src/shared/lab-types.ts`

## Invariants
- The provider meets the source contract: describe never throws, ids match TASK_ID, sampling is deterministic, a forged id is rejected, and no task, description or workspace carries an answer or a fixture secret — every source must be safe to run and show through one engine and one page — test: `tests/lab-aa.test.cjs` › "the aa provider meets the source contract"
- Only the pinned single-container, non-GPU subset runs (52 of the 66 Terminal-Bench 4.0 tasks); every excluded task is recorded with its reason (multi-service or GPU) and its task data is checked against per-file SHA-256 pins — the lab never claims to run a task it cannot run faithfully — test: `tests/lab-aa.test.cjs` › "the pinned CPU catalog accounts for all 66 tasks and excludes all 11 multi-service and 3 GPU tasks"; test: `tests/lab-aa.test.cjs` › "fetch hydrates canonical text, validates pins, and reuses verified cache entries"
- The agent runs commands through the per-run broker clients only; grading copies the declared output into a separate verifier container with no host mounts, and a run is graded by the task's own reward evidence: missing or malformed evidence is an error, unknown test counts stay null, and a verifier exit of 1 with reward 0 is a finished failure — a model cannot reach the verifier and nothing is passed by default — test: `tests/lab-aa.test.cjs` › "prepare exposes only broker clients; grading transfers output into a separate verifier with no host mounts"; test: `tests/lab-aa.test.cjs` › "reward parsing never treats absent, partial, boolean or nonfinite evidence as a pass"; test: `tests/lab-aa.test.cjs` › "an upstream verifier that exits 1 with reward 0 reports a completed task failure"
- Reference and verifier containers are removed on success, failure and cancellation; the agent container returned by `prepare` is the runner's to remove — no container outlives its run — test: `tests/lab-aa.test.cjs` › "reference proves the oracle with the real verifier path and always removes its containers"; test: `tests/lab-aa.test.cjs` › "cancellation removes the private verifier and prevents a pass"
- Published AA scores are refreshed only during `fetch`, keep only `{ asOf, values }` mapped by exact model identity, are always `comparable: false` (a different harness and a subset), are absent (`published: null`) without a key, and an API failure never blocks local tasks; no score is invented for the orchestrated approach — a reference score is shown as a reference, never as a result — test: `tests/lab-aa.test.cjs` › "AA references refresh only in fetch, map exact identities, never compare the subset or expose a key"; test: `tests/lab-aa.test.cjs` › "AA API failure never blocks local tasks or leaks error text"

## Not ours
- Lanes, budgets, references, the sandboxed session and the tools behind ctx — Lab engine (`electron/features/lab`)
- The contract between the page and the main process — `src/shared/lab-types.ts` (changed only through the lead)
- The oss source — Lab oss source (`electron/features/lab-oss`)
