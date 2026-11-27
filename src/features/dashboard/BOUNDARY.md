# Boundary: Dashboard window page

The page of the model dashboard window (`dashboard.html`, loaded by `electron/features/dashboard` as `agentrix://app/dashboard.html`): one page, no tabs,
with the reliability overview, the reliability trend and the model × task kind table, filtered by project and time range. It talks only to
`window.agentrixDashboard`, whose shapes are the contract in `src/shared/dashboard-types.ts`.

Outcomes take the semantic tokens only (passed `--success`, failed `--danger`, untested and unfinished neutral grey), and each also has its own
swatch shape and its words. A pass is the role's own check, and the page says so under the overview.

One named exception to "the interface uses only theme tokens": the six model colours (`--m-0..5` in `dashboard.css`, a pair of sets for dark and light). They are
content, not interface; a model is also told apart by its shape and its name, so colour is never the only cue.

## Owns
- `src/features/dashboard/**`
- `src/features/titlebar/AppMenu.tsx`

## Interface
- `Dashboard` (`src/features/dashboard/Dashboard.tsx`) — the page for a bridge; the file also exports DashboardView, the same page from a summary
- `createDashboardStore` (`src/features/dashboard/dashboard-store.ts`) — the query, summary and appearance the page holds, read through a bridge
- `modelTitle` (`src/features/dashboard/format.ts`) — how models, task kinds, ranges and rates are written; models through the shared naming
- `modelLooks` (`src/features/dashboard/chart-math.ts`) — the one colour and shape each model has on the whole page, and the arithmetic of the bars, trend and kind rows
- `AppMenu` (`src/features/titlebar/AppMenu.tsx`) — the main window's app menu, including the entries that call openDashboard and openLab

## May import
- `src/shared/**`
- `src/features/shortcuts/shortcuts.ts`

## Invariants
- The page is one page of three charts with only the project and time-range filters — the dashboard answers one question — test: `tests/dashboard-ui.test.cjs` › "one page with three charts top to bottom and only the project and time-range filters"
- A small sample sits last under its caption and reads weaker — two tasks at 100% must not read as the most reliable model — test: `tests/dashboard-ui.test.cjs` › "a small sample comes last under a caption, reads weaker and is never ranked above enough tasks"
- Without tasks every chart says so in one sentence and draws no axes or tables — test: `tests/dashboard-ui.test.cjs` › "without tasks every chart says so in one sentence and draws no axes or tables"
- The newest answer wins: a slow answer to an earlier query never replaces a later one — the numbers on screen must match the filters shown — test: `tests/dashboard-ui.test.cjs` › "a slow answer to an earlier query never replaces the answer to a later one"
- The page reads only the dashboard bridge and imports only `src/shared` — the dashboard window has no main preload and the page must not depend on it — test: `tests/dashboard-ui.test.cjs` › "the page reads only the dashboard bridge and never the main window’s"
- Every model keeps one colour and one shape across the whole page, whichever models a filter leaves, and no two models share both — test: `tests/dashboard-ui.test.cjs` › "every model keeps one colour and one shape for the whole page, whichever models are shown"
- The stylesheet keeps the product scale and takes every colour from the theme tokens apart from the model series — the page must read as one product with the app — test: `tests/dashboard-ui.test.cjs` › "the dashboard stylesheet keeps the product scale and takes every colour from the theme tokens but the model series"
- `dashboard.html` permits only its own scripts, styles, images and fonts, inline styles and the development socket — test: `tests/dashboard-ui.test.cjs` › "the dashboard CSP allows its own assets and dev socket without external images or embedded pages"

## Not ours
- The window, its IPC and the summary — Dashboard records (`electron/features/dashboard`)
- The contract between the page and the main process — `src/shared/dashboard-types.ts` (changed only through the lead)
- The theme tokens, the shared buttons, title bar and Select — `src/shared`
