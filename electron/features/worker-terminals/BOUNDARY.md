# Boundary: Worker terminals

Under a local terminal lead, a dispatched Claude worker runs as a hidden interactive `claude` in a PTY of its own, billed like the lead's terminal: main starts it, routes its hooks, reads its transcript into the dispatch stream, lets the owner answer its confirmations from the split, and kills it when the run ends.

## Owns
- `electron/features/worker-terminals/**`

## Interface
- `createWorkerTerminals` (`electron/features/worker-terminals/worker-terminals.cjs`) — `(deps) → { create, keyOf, hook, event, register, closeAll }`: `create(run, spec, stream)` is the runtime native-session/worker.cjs drives (`start`, `resume`, `send`, `close`) and publishes native-shaped events on its stream (`path.changed` selected `terminal-worker`, `turn.started` on UserPromptSubmit, compacted `transcript.record`, the final `item.upsert` agent-message, `turn.completed` and `session.state` idle on Stop); `keyOf`/`hook` sit in front of main's hook ingest and `event` in front of its event pipe; `register({ handle, listen })` serves `worker-terminal:attach`, `:keys`, `:resize` and `:detach` (the split's data arrives as `worker-terminal:data`); `closeAll` at quit
- `meterRecord` (`electron/features/worker-terminals/worker-terminals.cjs`) — what of a transcript record reaches the dispatch helper's meter

## May import
- `electron/shared/agentrix-shims.cjs` (withoutShims: the worker starts from the owner's environment)
- `electron/transcript-tail.cjs` (following the worker's transcript)
- `electron/claude-sessions.cjs` (findClaudeSession: the transcript found by session id under the worker's own Claude home)

## Invariants
- Only an authenticated `leadMode: 'terminal'` binding with `run.local` true gets a worker terminal; SSH projects and Codex or native leads keep their path. The worker's env is the parent terminal's own minus Agentrix credentials, the reading note, the shell integration's wiring and CLAUDE_CODE_ENTRYPOINT, with the user's own ZDOTDIR back; no client identity, API key or `-p` is added, its billing path is subscription, and its token totals and cost stay unknown in this wave — test: `tests/terminal-workers.test.cjs` › "billing follows the lead's mode and no client identity is set"
- A worker terminal is never a project terminal: it is not in `sessions` or the store, never restored, never counted in the all-complete check and never arms or rearms a completion notification; its hooks and command-hook events are taken before any project terminal's, by its own key — test: `tests/terminal-workers.test.cjs` › "a worker's hooks never reach a project terminal or its completion"
- Hooks add no model context: the worker's --settings are exactly terminalHooks(), there is no note file, and every hook is answered `{}` by the hook server — test: `tests/terminal-workers.test.cjs` › "a worker's hooks never reach a project terminal or its completion"
- The brief goes in as the initial prompt argument naming a brief file in the worker's private folder outside the repository (its only `--add-dir`); nothing is pasted. An owner intervention is written once, only while the CLI is idle, confirmed by UserPromptSubmit, never resent — test: `tests/terminal-workers.test.cjs` › "an intervention is written once when idle and never resent"
- `--out` is the final turn's last assistant text read from the transcript; the helper's meter gets only compacted records (`transcript.record`, no full text, bounded), each after the item that names its input channel, and never the renderer — test: `tests/terminal-workers.test.cjs` › "a terminal planner's worker shows its rate, waits for the owner and writes output on Stop"
- Only the owner answers the worker's confirmations: keys from its split reach that worker's PTY only while it awaits the owner (a permission or elicitation hook, or a start-up dialog drawn 15 s without a prompt), which stays until the next progress hook; nothing is answered automatically — test: `tests/terminal-workers.test.cjs` › "keys reach the worker only while it awaits the owner"
- The worker delegates only through the dispatcher: it runs at shim depth 1 with its run identity and a proof from the parent's session key, and its CLAUDE_ENV_FILE is its own private copy, never the parent's — test: `tests/terminal-workers.test.cjs` › "billing follows the lead's mode and no client identity is set"
- Stop, disconnect and quit kill the PTY tree and remove the private folder; the run then ends interrupted or failed — test: `tests/terminal-workers.test.cjs` › "keys reach the worker only while it awaits the owner"

## Not ours
- Choosing the worker's path and the SDK runtime — Native session router (worker.cjs) and claude-sdk
- The dispatch helper, its run binding and the billing it reports — Dispatch (integration/dispatch.cjs)
- A project terminal's hooks, state machine and completion — Terminal events
- The split that shows the worker's terminal — Sub-agent view (src/features/agents)
