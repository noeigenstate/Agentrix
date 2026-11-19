# Boundary: Model-routing dialog

Shows team seats, operation models and the frozen conversation choices. Saves the owner's edits to the selected scope for the next session.
The dialog uses `src/features/agents/seats-dialog.css` for its layout and controls.

## Owns
- `src/features/agents/SeatsDialog.tsx`
- `src/features/agents/skill-seats.ts`
- `src/features/agents/SeatsHost.tsx`
- `src/features/agents/RoutingKeyCard.tsx`
- `src/features/agents/OperationRows.tsx`
- `src/features/agents/RoleEditor.tsx`
- `src/features/agents/RoutingReview.tsx`
- `src/features/agents/role-rules.d.ts`

## Interface
- `SeatsHost` (`src/features/agents/SeatsHost.tsx`) — handles scoped routing requests and opens the dialog. App mounts it through ActivityPane's re-export.
- `RoutingKeyCard` (`src/features/agents/RoutingKeyCard.tsx`) — shows the current routing summary and opens the scoped dialog from ActivityPane.
- `roleGroups` (`src/features/agents/skill-seats.ts`) — `callSeatRole`, `modelRow`, `roleGroups`, `routeVerdict` and `shortLabel` support the Agent tab's role groups and labels.

## May import
- `electron/features/skills/seat-rules.mjs` (shared seat validation and model rules)
- `electron/features/skills/role-rules.mjs` (shared role validation, locks, ID generation and reviewer checks)
- `src/features/agents/subagent-splits.ts` (the `CallRow` type)
- `src/shared/i18n.ts`
- `src/shared/routing-command.ts`
- `src/shared/types.ts`

## Invariants
- The chart uses the team order and exposes every seat's controls — test: `tests/seats-ui.test.cjs` › "org chart uses fixture order and gives each seat its own model, effort and fast controls"
- The edit menu uses the model's own effort levels and fast availability — test: `tests/seats-ui.test.cjs` › "the 更换 menu lists the row’s own efforts, switches fast only where the row has it"
- A project save uses the digest at the start of its draft — test: `tests/seats-ui.test.cjs` › "a file-watch refresh does not replace a draft’s compare-and-swap digest"
- Unavailable models stay disabled and the current conversation is read-only — test: `tests/seats-ui.test.cjs` › "unavailable models are greyed with their reason"
- A blocked reviewer prevents saving and offers a one-click fix — test: `tests/seats-ui.test.cjs` › "a blocked reviewer is framed, named 已阻止, explained with a one-click fix and cannot be saved"
- An alias and its resolved ID count as one model for reviewer independence — test: `tests/seats-ui.test.cjs` › "an alias and the id it resolves to are one model for the reviewer rule"
- Confirmation shows full project text and main’s allowed actions — test: `tests/routing-review-ui.test.cjs` › "routing review shows every change, flag and custom text as plain text"
- The routing card opens the dialog for the selected terminal — test: `tests/seats-ui.test.cjs` › "the activity key is one button with a row for each role and opens the scoped dialog"

## Not ours
- Persisting and validating seat choices or applying them at launch — Skills and the launch runtimes.
- Rendering the Agent tab and tracking its calls — Activity pane.
