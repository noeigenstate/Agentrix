# Boundary: Standard I/O RPC

Carries newline-delimited JSON-RPC over a child process or equivalent byte streams.

## Owns
- `electron/shared/stdio-rpc.cjs`
- `electron/shared/native-events.cjs`

## Interface
- `createRpc` (`electron/shared/stdio-rpc.cjs`) — connects stdin, stdout and process events. Set jsonrpc to true to tag outgoing frames with version 2.0.
- `MAX_FRAME` (`electron/shared/stdio-rpc.cjs`) — the 64 MiB frame limit.
- `createEventStream` (`electron/shared/native-events.cjs`) — publishes and snapshots events using the caller's explicit provider and transport.

## May import
- `electron/oversized-record.cjs` (bounded frame reader)

## Invariants
- Replies preserve the peer's string ID — the peer must be able to match its reply — test: `tests/stdio-rpc.test.cjs` › "JSON-RPC 2.0 tags each write and preserves the peer request ID in answers"
- Exiting rejects every pending request and reports whether it was written — delivery may be uncertain after a write — test: `tests/stdio-rpc.test.cjs` › "process exit rejects written and queued requests with their delivery status"

## Not ours
- RPC methods, error classification and process launch or shutdown — caller.
