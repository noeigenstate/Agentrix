# Boundary: Dashboard window page

The page of the model dashboard window (`dashboard.html`, loaded by `electron/features/dashboard` as `agentrix://app/dashboard.html`): the model evaluation
and collaboration report pages, their tables and charts, and the suggestion buttons. It talks only to `window.agentrixDashboard`, whose shapes are the
contract in `src/shared/dashboard-types.ts`; every number there may be null and the page shows that as a dash, never as 0.

Model cells are native buttons. They open one filtered task list beneath the comparison table; closing the list returns
focus to its model button. Task titles and project names wrap, while the labelled scroll region keeps the title and
outcome columns in view.

One named exception to "the interface uses only theme tokens": the three chart series colours (`--chart-1..3` in `dashboard.css`, a pair of sets for dark and
light). They are content, not interface; a model is also told apart by its shape, line style and bar texture, so colour is never the only cue.

## Owns
- `src/features/dashboard/**`
- `src/features/titlebar/AppMenu.tsx`

## Interface
- `Dashboard` (`src/features/dashboard/Dashboard.tsx`) — the page for a bridge; the file also exports DashboardView, the same page from a summary
- `createDashboardStore` (`src/features/dashboard/dashboard-store.ts`) — the query, summary and appearance the page holds, read through a bridge
- `modelLabel` (`src/features/dashboard/format.ts`) — how numbers, models, task kinds and weights are written; the file also exports percent and duration
- `chartSeries` (`src/features/dashboard/chart-math.ts`) — which models a chart draws and the arithmetic of its plot
- `AppMenu` (`src/features/titlebar/AppMenu.tsx`) — the main window's app menu, including the entry that calls openDashboard

## May import
- `src/shared/**`
- `src/features/shortcuts/shortcuts.ts`

## Invariants
- A number the records do not support reads as a dash, never as 0, and an unpriced run is counted as unpriced rather than free — a made-up zero would pass for a measured one — test: `tests/dashboard-ui.test.cjs` › "numbers the records do not support read as a dash, never as 0"
- The newest answer wins: a slow answer to an earlier query never replaces a later one — the numbers on screen must match the filters shown — test: `tests/dashboard-ui.test.cjs` › "a slow answer to an earlier query never replaces the answer to a later one"
- Adopting, dismissing or reopening a suggestion goes through decide with its id, the state and the current query, and the page shows the summary returned — nothing changes on the page before the main process has recorded it — test: `tests/dashboard-ui.test.cjs` › "采纳 / 不采纳 / 撤销 call decide with the suggestion id and the state they mean, and the status line answers"
- The page reads only the dashboard bridge and imports only `src/shared` — the dashboard window has no main preload and the page must not depend on it — test: `tests/dashboard-ui.test.cjs` › "the page reads only the dashboard bridge and never the main window’s"
- A chart draws at most three models; the others stay in its data table and the legend says so, and a model keeps one shape everywhere — a crowded plot cannot be read — test: `tests/dashboard-ui.test.cjs` › "series: the first three models with data are drawn, the rest only in the table; a model keeps its shape"
- Every scrolling table sits in a labelled region the keyboard can focus — a wide table must stay reachable without a pointer — test: `tests/dashboard-ui.test.cjs` › "every scrolling table sits in a labelled, keyboard-focusable region"
- The stylesheet keeps the product scale (spacing 2/4/8/12/16/24/32, sizes 48/16/14/13/12, weights 400/600, three radii) and takes every colour from the theme tokens apart from the chart series — the page must read as one product with the app — test: `tests/dashboard-ui.test.cjs` › "the dashboard stylesheet keeps the product scale: spacing, type, radii, controls, and tokens for every colour but the chart series"
- `dashboard.html` permits only its own scripts, styles, images and fonts, inline styles and the development socket; media and embedded pages are blocked and the build lists both pages — the dashboard has no external image or preview access — test: `tests/dashboard-ui.test.cjs` › "the dashboard CSP allows its own assets and dev socket without external images or embedded pages"

## Not ours
- The window, its IPC, the summary, suggestions and decisions — Dashboard records (`electron/features/dashboard`)
- The contract between the page and the main process — `src/shared/dashboard-types.ts` (changed only through the lead)
- The theme tokens, the shared buttons, title bar and Select — `src/shared`
