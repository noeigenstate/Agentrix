# Boundary: Model-routing dialog

Shows the selected project's accepted team settings and its running Orchestrator. Saves edits to the selected scope.
The dialog uses `src/features/agents/seats-dialog.css` for its layout and controls.

## Owns
- `src/features/agents/SeatsDialog.tsx`
- `src/features/agents/routing-seats.ts`
- `src/features/agents/SeatsHost.tsx`
- `src/features/agents/RoutingKeyCard.tsx`
- `src/features/agents/RoleEditor.tsx`
- `src/features/agents/RoutingReview.tsx`
- `src/features/agents/role-rules.d.ts`
- `src/shared/routing-role-icons.ts` (each role's mark, also drawn on the Agent tab's role groups)

## Interface
- `SeatsHost` (`src/features/agents/SeatsHost.tsx`) — handles scoped routing requests and opens the dialog. App mounts it through ActivityPane's re-export.
- `RoutingKeyCard` (`src/features/agents/RoutingKeyCard.tsx`) — shows the current routing summary and opens the scoped dialog from ActivityPane.
- `roleGroups` (`src/features/agents/routing-seats.ts`) — `callSeatRole`, `modelRow`, `roleGroups`, `routeVerdict` and `shortLabel` support the Agent tab's role groups and labels.
- `roleIconOf` (`src/shared/routing-role-icons.ts`) — a role's mark by its id, the person for a custom role; the Agent tab draws it before each role group's name.

## May import

- `electron/features/cli-adapters/registry.mjs` and `electron/features/cli-adapters/capabilities.mjs` (registered providers, model ownership and capabilities)
- `src/shared/agent-events.ts` (provider ID type)
- `src/shared/agent-label.ts` (provider short names)
- `src/features/cli-screens/index.ts` and `src/features/terminal/terminal-screen.ts` (the running CLI's screen)
- `src/features/native-session/native-bridge.ts` (remote model catalog)
- `electron/features/routing/seat-rules.mjs` (shared seat validation and model rules)
- `electron/features/routing/role-rules.mjs` (shared role validation, locks and ID generation)
- `src/features/agents/AgentBrandIcon.ts` (provider marks) and `src/features/agents/subagent-splits.ts` (the `CallRow` type)
- `src/shared/i18n.ts`
- `src/shared/*routing*.ts` (routing commands and automatic lead-switch notices)
- `src/shared/types.ts`
- `src/features/workspace/useProjectReorder.ts` (the shared drag-to-reorder hook)

## Invariants
- The chart uses the team order and exposes every seat's controls — test: `tests/seats-ui.test.cjs` › "org chart uses fixture order and gives each seat its own model, effort and fast controls"
- The edit menu uses the model's own effort levels and fast availability — test: `tests/seats-ui.test.cjs` › "the 更换 menu lists the row’s own efforts, switches fast only where the row has it"
- A project save uses the digest at the start of its draft — test: `tests/seats-ui.test.cjs` › "a file-watch refresh does not replace a draft’s compare-and-swap digest"
- The read-only box follows accepted roles and the running lead — test: `tests/seats-ui.test.cjs` › "the conversation box uses accepted settings across drafts"
- Confirmation shows full project text and main’s allowed actions — test: `tests/routing-review-ui.test.cjs` › "routing review shows every change, flag and custom text as plain text"
- Cards after the lead reorder by drag and by the role menu; the order is saved — test: `tests/seats-ui.test.cjs` › "team cards reorder by drag and by the role menu, and the order is saved"
- The key follows accepted roles and shows the lead the conversation runs now — test: `tests/seats-ui.test.cjs` › "the routing key refreshes accepted roles and shows the lead the conversation runs now"

## Not ours
- Validating seat choices and role rules — Model routing backend.
- Saving seat choices and applying them at launch — Model routing backend and the launch runtimes.
- Rendering the Agent tab and tracking its calls — Activity pane.
