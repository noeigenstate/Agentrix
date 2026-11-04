# Boundary: Claude SDK runtime

Owns the host's Claude Agent SDK sessions, protected credentials, worker tool decisions and local API accounting.

## Owns
- `electron/features/claude-sdk/**`

## Interface
- `createClaudeRuntime` (`electron/features/claude-sdk/index.cjs`) — injected SDK session factory, credentials, usage and availability
- `createSdkLoader` (`electron/features/claude-sdk/runtime.cjs`) — deferred ESM loading from development or unpacked production paths
- `inspectClaudeExecutable` (`electron/features/claude-sdk/executable.cjs`) — whether the installed native Claude Code exists and meets the minimum version; main reads it to say what a new session takes

## May import
- `electron/features/native-session/storage.cjs`
- `electron/features/native-session/events.cjs`
- `electron/boundaries.cjs`

## Invariants
- Owner queries stay open at idle; explicit sends renew spent caps at safe message boundaries — test: `tests/claude-sdk-budget.test.cjs` › "M1 each explicit idle turn renews its five-dollar cap without charging resumed history"
- Workers explicitly isolate disk settings and failed policy hooks block execution — test: `tests/claude-sdk-runtime.test.cjs` › "a worker explicitly disables disk setting sources and blocks failed hooks"
- API identity is verified before accepting usage — test: `tests/claude-sdk-runtime.test.cjs` › "billing identity mismatch fails without trusting a subscription init"
- Stopping cancels pending approvals and preserves uncertain delivery — test: `tests/claude-sdk-runtime.test.cjs` › "stop rejects queued input and stale permission answers"
- Credential status contains only a saved flag — test: `tests/claude-sdk-runtime.test.cjs` › "credential status returns only saved and ciphertext never contains the test key"
- Cumulative usage is differenced and deduplicated across resume — test: `tests/claude-sdk-runtime.test.cjs` › "usage deltas persist across resume, deduplicate, and ignore zeroed failures"
- Reservations survive a crash and cannot be spent twice — test: `tests/claude-sdk-runtime.test.cjs` › "concurrent reservations and crash leftovers cannot spend the budget twice"
- Worker policy audits decisions while final scope checks remain the execution guarantee — test: `tests/claude-sdk-runtime.test.cjs` › "worker policy permits general commands, rejects explicit Git and scoped path escapes"

## Not ours
- Provider-neutral routing, IPC and settings
- Helper admission, scope verification and durable control delivery
- Native view components and account billing statements
