# Boundary: Activity view

Shows the expanded project's usage and quota in the Activity pane. The routing dialog supplies the routing section and host.

## Owns
- `src/features/agents/ActivityPane.tsx`
- `src/features/agents/ApiUsage.tsx`
- `src/features/agents/Metric.tsx`
- `src/features/agents/ResetQuota.tsx`
- `src/features/agents/ResetCountdown.tsx`
- `src/features/agents/reset-count.ts`

## Interface
- `ActivityPane` (`src/features/agents/ActivityPane.tsx`) — usage and routing for ProjectPanel's terminal and project. Re-exports `SeatsHost` for App.
- `exactCount` (`src/features/agents/Metric.tsx`) — formats exact counts for the activity view and the Agent tab.

## May import

- `electron/features/cli-adapters/*.mjs`
- `src/features/agents/RoutingKeyCard.tsx`
- `src/features/agents/SeatsHost.tsx`
- `src/features/home/send-to-agent.ts`
- `src/features/native-session/native-billing-link.ts`
- `src/features/native-session/native-bridge.ts`
- `src/features/native-session/native-store.ts`
- `src/features/native-session/native-words.ts`
- `src/features/terminal/terminal-screen.ts`
- `src/shared/**`

## Invariants
- The only CLI action is `/usage` after a cancellable ten-second countdown — test: `tests/boundary-activity-pane.test.cjs` › "the pane never acts on its own"
- The API usage card only reads usage — test: `tests/boundary-activity-pane.test.cjs` › "the API usage card only reads the main process"
- Claude Code's own input hints and placeholders count as empty input, with or without its queue row on screen — test: `tests/cli-panel.test.cjs` › "Claude fallback recognizes only complete input placeholders, independently of queue controls"
- A quota update refreshes only that project's card — test: `tests/native-session-ui.test.cjs` › "a quota change reported for one project makes only that project’s usage card read again"
- Unknown reset counts stay unknown — test: `tests/reset-count.test.cjs` › "unknown is never zero"
- The pane fits without scrolling — test: `scripts/completion-smoke.mjs` › "the live pane and the full 340px fixture fit without scrolling or overlap"

## Not ours
- Reading agent records and account data — Activity pane.
- Showing the lead model and its prompts — Agent tab.
- Handling routing edits and showing accepted seat settings — Model-routing dialog.
- Deciding when to show the pane or expand the project — Workspace.
