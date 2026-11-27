# Boundary: Model routing backend

Defines model seats, roles and project routing files. Tracks available models, probes provider catalogs and
validates and renders the shipped guide in `resources/routing/model-routing.md`. Stores project trust, freezes launch choices and prepares mode and seat notices.

## Owns
- `electron/features/routing/**`

## Interface
- `RoutingStore` (`electron/features/routing/store.cjs`) — reads and saves seats, seeds and confirms project routing, captures launches and prepares notices. Also exports remoteGuide and the provider probes.
- `registerRoutingIpc` (`electron/features/routing/ipc.cjs`) — routing reads, refreshes, saves and reviews.
- `launchNote` (`electron/features/routing/mode-notes.cjs`) — startup mode and guide reference. Also exports modeNote, routingChangeNote and plain.
- `seatHookOutput` (`electron/features/routing/agent-seat.cjs`) — prepares the Claude Agent or Task input and provisional report. `observedAgentSeat` reports the final input.
- `probeCodex` (`electron/features/routing/model-probe.cjs`) — bounded model catalog reads through injected provider APIs. Also exports `probeClaude`.
- `resolveSeat` (`electron/features/routing/model-seats.cjs`) — model defaults, validation and effective seat choices.
- `readRouting` (`electron/features/routing/project-routing.cjs`) — reads and validates project routing files. The module also writes files and builds review and watch state.
- `resolveTeam` (`electron/features/routing/team-roles.cjs`) — validates, normalizes and resolves roles and their seats.
- `agentOfModel` (`electron/features/routing/seat-rules.mjs`) — shared model ownership, seat validation, model rank and Ultracode eligibility.
- `checkTeamRules` (`electron/features/routing/role-rules.mjs`) — validates the lead, role limits, name uniqueness and custom roles.
- `renderRoutingGuide` (`electron/features/routing/guide-render.cjs`) — renders accepted roles and model settings into the guide.
- `guideMetadata` (`electron/features/routing/guide-format.cjs`) — validates shipped guide metadata and reads guide sections outside code fences.

## May import
- `electron/features/agents/call-seat.cjs` (the Agent tab's seat description and live seat map)
- `electron/features/cli-adapters/registry.mjs` and `electron/features/cli-adapters/capabilities.mjs` (model ownership and lead eligibility)
- `electron/atomic-write.cjs` (model catalog persistence)
- `electron/shared/front-matter.cjs` (guide metadata)
- `electron/codex-activity.cjs` (project routing file monitoring)
- `src/shared/agent-events.ts` (provider type in the seat declarations)

## Invariants
- Accepted seat changes reach running hooks, with launch settings as fallback — test: `tests/seat-auto.test.cjs` › "a running terminal and SDK query read new seats and fall back on malformed or missing data"
- Project routing digests cover ignored content and treat key order and line endings as equivalent — test: `tests/project-routing.test.cjs` › "canonical digests include ignored content and ignore LF, CRLF, and key order"
- Model probes read the catalog without starting a turn and clean up on failure or deadline — test: `tests/model-catalog.test.cjs` › "one-shot Codex probe pages without creating a thread and closes its injected process"
- Guide rendering preserves the expected model table for template, project and SSH delivery — test: `tests/routing-guide.test.cjs` › "routing renderer retains the pinned HEAD cells for template, project and SSH"

- Confirmed settings reach running sessions while their launch copies stay available — test: `tests/routing-store.test.cjs` › "worker and lead seats go live in the running conversation"
- New projects trust their seed on first scan and a deleted trusted file is never recreated — test: `tests/routing-store.test.cjs` › "a project without a routing file gets the template on first scan, trusted at once"; test: `tests/routing-store.test.cjs` › "a deleted routing file is not seeded again"
- Existing trust survives upgrade and external changes await the owner's decision — test: `tests/routing-store.test.cjs` › "an unchanged beta routing file keeps its trust across migration and restart"
- Only conductor launches carry a guide. SSH carries a single rendered file with no local paths — test: `tests/routing-launch.test.cjs` › "native launch has only its mode sentence and a conductor reads one rendered guide with its adopted weights"

## Not ours
- Startup note assembly and length — handoff.
- Preload methods and shared types — shared contract.
- Presenting and saving drafts from the routing dialog — Model-routing dialog
