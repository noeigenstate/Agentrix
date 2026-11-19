# Boundary: Agent sidebar

Composes the Agent tab from the selected terminal's Orchestrator and the project-wide worker and background lists.

## Owns
- `src/features/agents/AgentSidebar.tsx`

## Interface
- `AgentSidebar` (`src/features/agents/AgentSidebar.tsx`) — gives App the rendered Agent tab and its worker and background counts to pass to the files module.

## May import
- `src/features/agents/AgentCalls.tsx`
- `src/features/agents/MainModel.tsx`
- `src/features/agents/subagent-splits.ts`
- `src/features/terminal/active-terminal.ts`
- `src/features/terminal/terminal-visibility.ts`
- `src/shared/types.ts`

## Invariants
- The Orchestrator follows terminal selection and the called models span all project terminals — test: `tests/activity-route.test.cjs` › "the Agent tab leads with the selected terminal’s Orchestrator above calls from every terminal"
- App supplies the rendered node and counts to the files module. Switching to Agent clears file-tree focus and pauses hidden tree loads — test: `tests/boundary-activity-pane.test.cjs` › "the files module imports nothing from the agents module: the Agent tab gets its list as a node and a count from the app"

## Not ours
- Rendering the lead model and prompts — Agent tab.
- Opening and rendering worker splits — Activity pane and Sub-agent view.
