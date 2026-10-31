# Boundary: SSH runtime

The SSH terminal's runtime helpers and host-local Claude account query bridge. Remote credentials stay on their own
host; only validated usage windows reach the activity pane.

## Owns
- `electron/features/ssh/**`

## Interface
- `createSshRuntime` (`electron/features/ssh/runtime.cjs`) — prepares and removes the private Windows askpass helper
- `registerSshIpc` (`electron/features/ssh/ipc.cjs`) — registers SSH connection and authentication IPC with injected dependencies
- `watchRemoteClaudeAccount` (`electron/features/ssh/claude-account.cjs`) — an abortable account poller bound to the current SSH terminal; the file also exports remoteClaudeResult

## May import
- `electron/features/agents/claude-account-usage.cjs`

## Invariants
- Account replies contain only validated numeric windows and fixed status words; credentials, diagnostic strings and remote response bodies never reach the pane — the remote host owns its account — test: `tests/remote-claude-account.test.cjs` › "remote account boundary copies only validated numeric limits and fixed status words"
- A closed or replaced terminal cannot publish a late account result, and polling uses read-only requests with the existing rate limit — background account reads must not affect a different session — test: `tests/remote-claude-account.test.cjs` › "remote polling is read-only, rate limited, aborted on disposal and rejects late or rebound results"
- SSH questions retain the CLI's captured shape through UTF-8 packet boundaries — transport must not hide a live question or invent a form interaction — test: `tests/remote-ssh-cards.test.cjs` › "SSH carries Claude quota numbers and real-shaped question, Review, permission and waiting screens"

## Not ours
- Multiplexing, framing and request cancellation — electron/remote-connection.cjs
- Reading remote credentials and querying Anthropic — integration/remote-worker.py
- Parsing a screen and presenting its choice or waiting card — Activity pane parsers and Reading view
- Session lifecycle, completion and dashboard quota recording — electron/main.cjs
