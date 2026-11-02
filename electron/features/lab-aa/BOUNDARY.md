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

## Not ours
- Lanes, budgets, references, the sandboxed session and the tools behind ctx — Lab engine (`electron/features/lab`)
- The contract between the page and the main process — `src/shared/lab-types.ts` (changed only through the lead)
- The oss source — Lab oss source (`electron/features/lab-oss`)
