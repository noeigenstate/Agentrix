# Boundary: Dispatch

The dispatch helper that every command-line Codex or Claude worker is started through — it builds the real command, confirms the worker started, and reports its routing, rate and end — and the main-process gate that accepts its events for the activity pane.

## Owns
- `integration/dispatch.cjs`
- `electron/features/agents/dispatch-events.cjs`

## Interface
- `USAGE` (`integration/dispatch.cjs`) — the helper's command line (`node dispatch.cjs <codex|claude> …`); sessions learn its path from the startup note (skills/agent-dispatch)
- `[dispatch]` (`integration/dispatch.cjs`) — the started / failed to start / ended lines the lead reads on the helper's stdout
- `runtimeFiles` (`integration/dispatch.cjs`) — the electron modules the helper carries; copied by scripts/after-pack.cjs and electron/remote-connection.cjs
- `acceptDispatch` (`electron/features/agents/dispatch-events.cjs`) — main.cjs hands it every dispatch-* event from a session's event pipe

## May import
- `electron/features/agents/token-rate.cjs`
- `electron/features/agents/agent-settings.cjs`
- `electron/session-files.cjs`
- `electron/transcript-tail.cjs`
- `electron/boundaries.cjs`
- `electron/features/team/team.cjs`
- `electron/features/team/minutes-page.cjs`

## Invariants
- A worker is known only from the helper's declarations, never shell commands, prompt filenames or stdout; events require the session's own key and project, well-formed fields and at most 16 KB — guessed routing is misleading and any local process can reach the pipe — test: `tests/dispatch-events.test.cjs` › "Bash commands, prompt filenames and helper stdout text never create or update a call"; test: `tests/dispatch-events.test.cjs` › "bad keys, projects, unknown ids, malformed fields and oversized payloads are rejected"
- What is declared is what runs: the helper builds the CLI's argv itself from its options and rejects unknown, repeated, missing or conflicting ones — a loose option lets a worker run other settings than reported — test: `tests/dispatch.test.cjs` › "helper constructs exact Codex/Claude argv and rejects incomplete or ambiguous options"
- "started" is printed and sent only from the worker's own records (its session, and Codex's turn context) within 30 s — while it runs, or from everything it left once it exits — never from its exit alone; otherwise exactly one failed-start line and an unconfirmed start/end pair — the start line is the lead's proof the task ran, and a fast worker did run — test: `tests/dispatch.test.cjs` › "a worker that exits right after its records is confirmed from them; without them it still failed to start"
- Reported routing is what the worker's own records say; a reported mismatch names the declaration and a missing value stays unreported and is marked unverified, and an unreported model gives an unverified verdict, never borrowed from the declaration or config — routing mistakes must be visible — test: `tests/dispatch.test.cjs` › "reported mismatches and missing settings never borrow the declaration"
- The helper never waits for Agentrix: with no bootstrap or a stalled pipe the worker still runs and finishes promptly — the helper also runs outside Agentrix — test: `tests/dispatch.test.cjs` › "without bootstrap or with a stalled pipe the worker still runs and finishes promptly"
- Everything the helper loads from electron/ is carried in runtimeFiles and requires only Node built-ins and other carried files — plain Node cannot read app.asar and an SSH host has only the copies — test: `tests/boundary-dispatch.test.cjs` › "the helper's runtime modules require only Node built-ins and each other"
- Tests start workers only through an injected fake CLI (launch, resolveExecutable or a fake-only PATH), never the CLI installed on the machine — results must not depend on the machine — test: `tests/boundary-dispatch.test.cjs` › "dispatch tests start workers only through an injected fake CLI"
- A roundtable changes no working-tree file beyond the helper's output, log, ledger and memory files; any change is out of scope and invalidates the meeting — a writable resumable sandbox must not permit work before agreement — test: `tests/dispatch-team.test.cjs` › "meetings reject every working-tree change including agreed files"

## Not ours
- Showing dispatched rows, their grouping, wording and how long they stay — Activity pane (agent-calls.cjs, ActivityPane.tsx)
- The rate calculation and reading settings from records — Activity pane (token-rate.cjs, agent-settings.cjs)
- The event pipe server and its bootstrap file — electron/events.cjs and main.cjs
- Telling a session where the helper is — the startup note (electron/features/agents/handoff.cjs)
- Copying the runtime into packaged builds and onto SSH hosts — scripts/after-pack.cjs, electron/remote-connection.cjs, integration/remote-worker.py
- Which model takes a task and what its brief says — the lead (skills/model-routing)
- The BOUNDARY.md format and its checker — scripts/module-boundaries.cjs
