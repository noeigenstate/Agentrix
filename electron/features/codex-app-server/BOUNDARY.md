# Boundary: Codex app-server runtime

Owns an independent stdio app-server for a native Codex session; normalizes its events and keeps request tickets and input receipts within that session.

## Owns
- `electron/features/codex-app-server/**`

## Interface
- `createCodexRuntime` (`electron/features/codex-app-server/index.cjs`) — injected process launcher, executable resolver and clock; provides create(spec, emit) and limits(scope); a runtime provides start, resume, send, interrupt, answer, snapshot, close and read-only account reads.
- `commands` (`electron/features/codex-app-server/index.cjs`) — cached enabled skills from `skills/list` for its own cwd; selected slash skills become structured skill input using the host-held path, never a renderer-supplied path
- `createRpc` (`electron/features/codex-app-server/rpc.cjs`) — bounded stdio transport, also used by the separately admitted owner reset-credit client

## May import
- `electron/command-phrase.cjs`
- `electron/generated-image-path.cjs`
- `src/shared/agent-events.ts`
- `electron/features/agents/codex-account-usage.cjs`

## Invariants
- An optional missing skills RPC leaves the session usable and lists no terminal commands; skill changes invalidate the bounded catalog — test: `tests/native-commands-codex.test.cjs` › "an unavailable optional skills RPC returns no terminal commands and leaves the connection usable".
- Input written before a disconnect receives unknown and is never automatically submitted again — duplicate execution changes the workspace twice — test: `tests/codex-app-server-runtime.test.cjs` › "steer written before process loss becomes unknown, and duplicates never restart it".
- Busy messages steer the active turn with an expected turn identity; a message ID cannot name different input. After a confirmed owner reset, only an explicitly empty failed usage-limit turn with no execution or consumption evidence can retry its original input, once; partial, consumed and unknown turns never replay — test: `tests/codex-app-server-runtime.test.cjs` › "busy input steers the same turn, duplicate IDs are idempotent and conflicts fail"; test: `tests/codex-auto-reset-runtime.test.cjs` › "reset-unread: confirmed reset replays only a proved empty unconsumed turn, at most once".
- Request tickets wait for an explicit answer, are consumed once and expire with the session — closing or stale UI never approves a command — test: `tests/codex-app-server-runtime.test.cjs` › "request tickets wait, are consumed once, and closing cancels them without auto allow".
- Usage and limits are snapshots; absent values remain null and sparse updates retain prior fields — token activity and a reset date cannot prove remaining subscription allowance — test: `tests/codex-app-server-runtime.test.cjs` › "sparse limits retain missing fields, never infer recovery, and reject unsafe integers".
- Completed items replace their deltas; raw reasoning is never displayed — reconstruction must not duplicate the response or disclose internal reasoning — test: `tests/codex-app-server-runtime.test.cjs` › "final items replace deltas, duplicate finals and raw reasoning are ignored".
- A resumed thread is exclusively occupied until close inside the host — two runtimes must not write the same thread — test: `tests/codex-app-server-runtime.test.cjs` › "resumed threads have exclusive occupancy and release on close".
- Resume requests exclude full history; optional history frames are bounded to 16 MiB and an oversized bound history response is drained without disconnecting the live session — long history must not force a transport fallback — test: `tests/codex-app-server-long-thread.test.cjs` › "oversized history is drained without disconnect, replay or losing another response".

## Not ours
- Renderer IPC, project identity and runtime selection — native-session router.
- Helper admission, scope checks and owner controls — Dispatch and Team.
- Account scope verification, shared refresh throttle and legacy readers — Activity pane.
