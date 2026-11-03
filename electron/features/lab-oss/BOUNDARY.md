# Boundary: Lab oss source

The Virtual Lab's oss task source: curated SWE-bench Verified Python tasks from small repositories, cloned at a pinned commit and graded natively with pytest. It meets the source contract (`electron/features/lab/sources/contract.cjs`) and reaches the machine only through the tools and session in its context.

## Owns
- `electron/features/lab-oss/**`

## Interface
- `createOssSource` (`electron/features/lab-oss/index.cjs`) — the oss provider the lab engine runs as one lane of an experiment

## May import
- `electron/i18n.cjs`
- `electron/features/lab/sources/contract.cjs`
- `src/shared/lab-types.ts`

## Invariants
- The provider meets the source contract: describe never throws, ids match TASK_ID, sampling is deterministic, a forged id is rejected, and no task, description or workspace carries an answer or a fixture secret — every source must be safe to run and show through one engine and one page — test: `tests/lab-oss.test.cjs` › "the oss provider meets the source contract"
- The shipped manifest holds twelve pinned tasks as metadata only (no problem statement, no patch); describe and sample never touch the network, and the engine's second `canonical` after `fetch` is what fills in the problem statement — a cold cache can be sampled offline and nothing from the dataset ships in the app — test: `tests/lab-oss.test.cjs` › "the shipped manifest contains twelve pinned Python tasks, metadata only, with attribution"; test: `tests/lab-oss.test.cjs` › "describe and sample are manifest-only even with broken machine tools"; test: `tests/lab-oss.test.cjs` › "fetch verifies data and Git identity; the second canonical hydrates only the problem statement"
- A task is resolved (score 1, otherwise 0) only when every pinned fail-to-pass and pass-to-pass case is reported passing, with hidden tests and pytest configuration restored first; missing, duplicate, renamed, skipped, errored or malformed evidence is never a pass — the lab must not invent success — test: `tests/lab-oss.test.cjs` › "grade restores hidden tests and reports resolved only when both groups pass"; test: `tests/lab-oss.test.cjs` › "missing, duplicate, renamed, skipped, malformed and errored evidence is never a pass"
- Downloads are checked against the manifest's SHA-256 and Git identity before use, and a changed row or grading patch is fatal; dependencies are installed only in the preparation call that asks for the network, once per dependency hash at a time, from checksum-verified wheels cached by Python runtime and platform — a tampered dataset or package never reaches a model — test: `tests/lab-oss.test.cjs` › "a corrupt download never publishes a row or reaches Git"; test: `tests/lab-oss.test.cjs` › "a changed private row or grading patch is fatal to the guard"; test: `tests/lab-oss.test.cjs` › "concurrent preparations serialize installation for the same dependency hash"; test: `tests/lab-oss.test.cjs` › "wheel checksum corruption is refused before another installation"

## Not ours
- Lanes, budgets, references, the sandboxed session and the tools behind ctx — Lab engine (`electron/features/lab`)
- The contract between the page and the main process — `src/shared/lab-types.ts` (changed only through the lead)
- The aa source — Lab aa source (`electron/features/lab-aa`)
