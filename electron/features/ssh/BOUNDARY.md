# Boundary: SSH runtime

The SSH terminal's runtime helpers and host-local Claude account query bridge. Remote credentials stay on their own
host; only validated usage windows reach the activity pane.

## Owns
- `electron/features/ssh/**`

## Interface
- `createRemoteCodexProcess` (`electron/features/ssh/codex-process.cjs`) — a process-shaped byte stream over the project's own SSH channel; close never kills a local PID; `opened` settles once the host has looked Codex up and started it, and the runtime's handshake deadline starts after it
- `createSshRuntime` (`electron/features/ssh/runtime.cjs`) — prepares and removes the private Windows askpass helper
- `registerSshIpc` (`electron/features/ssh/ipc.cjs`) — registers SSH connection and authentication IPC with injected dependencies
- `watchRemoteClaudeAccount` (`electron/features/ssh/claude-account.cjs`) — an abortable account poller bound to the current SSH terminal; the file also exports remoteClaudeResult

## May import
- `electron/features/agents/claude-account-usage.cjs`

## Invariants
- SSH Codex starts and resumes through its remote app-server byte channel; local executables and account readers are never used — test: `tests/ssh-codex.test.cjs` › "SSH Codex starts, sends, resumes and reads accounts solely through its remote byte channel"
- Account replies contain only validated numeric windows and fixed status words; credentials, diagnostic strings and remote response bodies never reach the pane — the remote host owns its account — test: `tests/remote-claude-account.test.cjs` › "remote account boundary copies only validated numeric limits and fixed status words"
- A closed or replaced terminal cannot publish a late account result, and polling uses read-only requests with the existing rate limit — background account reads must not affect a different session — test: `tests/remote-claude-account.test.cjs` › "remote polling is read-only, rate limited, aborted on disposal and rejects late or rebound results"
- SSH questions retain the CLI's captured shape through UTF-8 packet boundaries — transport must not hide a live question or invent a form interaction — test: `tests/remote-ssh-cards.test.cjs` › "SSH carries Claude quota numbers and real-shaped question, Review, permission and waiting screens"
- SSH Codex starts on the host's login-shell PATH, as found by that shell, and a failed start names its exit and the host's last stderr lines — an npm Codex finds node on that PATH only, and the general failure sentence alone cannot be fixed — test: `tests/ssh-connection.test.cjs` › "Linux SSH Codex app-server initializes, starts a thread and answers a turn through the real worker on the login PATH; a failed start states its cause"

## Not ours
- Multiplexing, framing and request cancellation — electron/remote-connection.cjs
- Reading remote credentials and querying Anthropic — integration/remote-worker.py
- Parsing a screen and presenting its choice or waiting card — Activity pane parsers and Reading view
- Session lifecycle, completion and dashboard quota recording — electron/main.cjs
