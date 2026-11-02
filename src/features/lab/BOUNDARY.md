# Boundary: Lab window page

The page of the Virtual Lab window (`lab.html`, loaded by `electron/features/lab` as `agentrix://app/lab.html`): the experiment list, the four-step new-experiment
wizard, the live board and the results charts. It talks only to `window.agentrixLab`, whose shapes are the contract in `src/shared/lab-types.ts`; every
unknown number shows as a dash, never as 0.

One named exception to "the interface uses only theme tokens": the four approach colours (`--lab-arm-*` in `lab.css`, Okabe-Ito, a set for dark and light).
They are content, not interface; each approach also keeps one shape everywhere, so colour is never the only cue.

## Owns
- `src/features/lab/**`

## Interface
- `Lab` (`src/features/lab/Lab.tsx`) — the page for a bridge; the file also exports LabView, the same page from a state
- `createLabStore` (`src/features/lab/lab-store.ts`) — the experiments, projects and appearance the page holds, newest answer first
- `conclude` (`src/features/lab/results-math.ts`) — the pass rule as shown, per-approach totals, kind scores, the matrix and the conclusion
- `shapePath` (`src/features/lab/chart-math.ts`) — chart scales, error bars and the shape of each approach

## May import
- `src/shared/**`

## Invariants
- The page reads only the lab bridge and imports only `src/shared` — the lab window has no main preload — test: `tests/lab-ui.test.cjs` › "the page reads only the lab bridge and imports only src/shared"
- An unknown number reads as a dash and an unpriced run is said to be unpriced, never free — a made-up zero would pass for a measured one — test: `tests/lab-ui.test.cjs` › "results never show 0 for what is unknown"
- A task passes for an approach when its source's own metric passes in most of its repeats, and scores of different sources are never added or averaged: the combined view counts sources led and sums cost and time only — a summed score would mean nothing — test: `tests/lab-ui.test.cjs` › "a task passes for an approach when all its hidden tests pass in most of its repeats"; test: `tests/lab-ui.test.cjs` › "combine counts the sources each approach leads and sums cost and time over every run; no field adds or averages a score across sources"
- The newest answer wins: a slow list never replaces a later push — the screen matches the latest state — test: `tests/lab-ui.test.cjs` › "the newest answer wins"
- Sources are chosen from what the bridge reports: an unavailable one is disabled with its reason and never ticked, and the form names the source that lacks a scope or a task — the page never offers what the engine cannot run — test: `tests/lab-ui.test.cjs` › "the source step offers every source the bridge reports to be chosen together; a source that cannot run is disabled with its reason and never ticked"
- Every scrolling region is labelled and focusable and is drawn through one component — long results stay reachable without a pointer — test: `tests/lab-ui.test.cjs` › "every scrolling region is labelled and focusable"
- The stylesheet keeps the product scale and takes every colour from the theme tokens apart from the four approach colours — the lab reads as one product with the app — test: `tests/lab-ui.test.cjs` › "the lab stylesheet keeps the product scale"
- `lab.html` permits only its own assets and the development socket, and the build lists three pages — the lab has no external image or embedded-page access — test: `tests/lab-ui.test.cjs` › "the lab CSP allows its own assets and dev socket without external images or embedded pages"

## Not ours
- The window, its IPC and the experiment engine — Lab engine (`electron/features/lab`)
- The contract between the page and the main process — `src/shared/lab-types.ts` (changed only through the lead)
- The theme tokens, the shared buttons and icons — `src/shared`
- The main window's app menu entry — Dashboard window page (`src/features/titlebar/AppMenu.tsx`)
