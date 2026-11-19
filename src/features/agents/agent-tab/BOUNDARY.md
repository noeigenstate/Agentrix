# Boundary: Agent tab

Shows the selected terminal's Orchestrator, current step and prompt history in the Agent tab.

## Owns
- `src/features/agents/MainModel.tsx`

## Interface
- `MainModelGroup` (`src/features/agents/MainModel.tsx`) — mounts the selected terminal's screen subscription and lead model in the Agent panel.
- `MainModel` (`src/features/agents/MainModel.tsx`) — renders the selected terminal's model and prompts.
- `useMainTurn` (`src/features/agents/MainModel.tsx`) — observes the selected terminal's CLI state and derives the displayed turn.

## May import
- `src/features/agents/AgentCalls.tsx`
- `src/features/agents/Metric.tsx`
- `src/features/agents/action-text.ts`
- `src/features/native-session/native-store.ts`
- `src/features/terminal/terminal-screen.ts`
- `src/shared/elapsed-clock.ts`
- `src/shared/i18n.ts`
- `src/shared/model-name.ts`
- `src/shared/routing-command.ts`
- `src/shared/types.ts`
- `src/shared/useNow.ts`

## Invariants
- Screen frames update only the mounted Orchestrator group. Closing the Agent panel releases its subscription.
  Test: `tests/activity-route.test.cjs` › "a terminal screen frame updates the mounted Orchestrator without rendering a sidebar sibling"
- The main model, rate and current step come from the selected terminal's own records, with the configured model used until the first reply — test: `tests/activity-route.test.cjs` › "the main model section: the model its latest reply records"
- The working prompt and three most recent queued prompts are visible before opening the fold — test: `tests/activity-route.test.cjs` › "activity shows the working prompt and three most recent queued prompts, with an accessible fold"

## Not ours
- Choosing the terminal and composing the sidebar — Agent sidebar.
- Project-wide worker and background rows — Activity pane.
