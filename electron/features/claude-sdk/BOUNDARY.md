# Boundary: Claude SDK runtime

Owns the host's Claude Agent SDK sessions, protected credentials, worker tool decisions and local API accounting.

Owner sessions intentionally keep tool and hook environment inheritance; dispatch workers enable the CLI's subprocess scrub. This is the owner's current decision (A2), not an isolation guarantee. API routing is pinned in flag settings from host and user sources; repository env and helper settings cannot choose the destination. The saved key remains in the child environment, never flag settings or argv. Known gap: project settings can replace that key while reporting the same source; the SDK cannot prove its effective bytes.

## Owns
- `electron/features/claude-sdk/**`

## Interface
- `createClaudeRuntime` (`electron/features/claude-sdk/index.cjs`) — injected SDK session factory, credentials, usage and availability
- `createSdkLoader` (`electron/features/claude-sdk/runtime.cjs`) — deferred ESM loading from development or unpacked production paths
- `inspectClaudeExecutable` (`electron/features/claude-sdk/executable.cjs`) — whether the installed native Claude Code exists and meets the minimum version; main reads it to say what a new session takes

## May import
- `electron/command-phrase.cjs`
- `electron/conversation-record.cjs`
- `electron/features/native-session/storage.cjs`
- `electron/features/native-session/events.cjs`
- `electron/boundaries.cjs`
- `electron/agent-actions.cjs` (the one rule for naming a command: running tests, checking types)

## Invariants
- Owner queries stay open at idle; explicit sends renew spent caps at safe message boundaries — test: `tests/claude-sdk-budget.test.cjs` › "M1 each explicit idle turn renews its five-dollar cap without charging resumed history"
- Workers isolate disk settings and rely on blocking PreToolUse policy under bypassPermissions; owner questions still reach canUseTool — test: `tests/claude-sdk-real-cli.test.cjs` › "A7 product worker policy remains active on resume and a throwing hook blocks"; test: `tests/claude-sdk-real-cli.test.cjs` › "under bypass a question still reaches the owner through canUseTool"
- API identity requires the env API source; routing overrides project transport and helper settings without disabling owner project settings — test: `tests/claude-sdk-runtime.test.cjs` › "billing identity mismatch fails without trusting a subscription init"; test: `tests/claude-sdk-real-cli.test.cjs` › "A1 project settings cannot send the saved key to a trap endpoint"
- Stopping cancels pending approvals and preserves uncertain delivery — test: `tests/claude-sdk-runtime.test.cjs` › "stop rejects queued input and stale permission answers"
- Credential status contains only a saved flag — test: `tests/claude-sdk-runtime.test.cjs` › "credential status returns only saved and ciphertext never contains the test key"
- Cumulative usage is differenced and deduplicated across resume — test: `tests/claude-sdk-runtime.test.cjs` › "usage deltas persist across resume, deduplicate, and ignore zeroed failures"
- Reservations survive a crash and cannot be spent twice — test: `tests/claude-sdk-runtime.test.cjs` › "concurrent reservations and crash leftovers cannot spend the budget twice"
- Worker policy audits decisions while final scope checks remain the execution guarantee — test: `tests/claude-sdk-runtime.test.cjs` › "worker policy permits general commands, rejects explicit Git and scoped path escapes"

## Not ours
- Provider-neutral routing, IPC and settings
- Helper admission, scope verification and durable control delivery
- Native view components and account billing statements
