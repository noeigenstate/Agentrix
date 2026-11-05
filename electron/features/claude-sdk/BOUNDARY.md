# Boundary: Claude SDK runtime

Owns the host's Claude Agent SDK sessions, protected credentials, worker tool decisions and local API accounting.

Owner and worker entrypoints remain the CLI default. Ownership is host-observed session identity, persisted locally for owners and read from the team journal for workers; the old agentrix-sdk transcript marker remains readable, while unclassified old sdk-ts prompts stay excluded.

Owner sessions currently keep tool and hook environment inheritance; dispatch workers enable the CLI's subprocess scrub. A2 is awaiting the owner's answer; the existing behavior is retained in the meantime, not an isolation guarantee. API routing is pinned in a private session settings file from host and user sources; repository env and helper settings cannot choose the destination. Routing secrets never enter argv. The saved key remains in the child environment, never the settings file or argv; project/local env overrides found at launch are refused. This does not attest effective key bytes against later config changes or active hooks. Project hooks still inherit it under the retained A2 behavior.

## Owns
- `electron/features/claude-sdk/**`

## Interface
- `createClaudeRuntime` (`electron/features/claude-sdk/index.cjs`) — injected SDK session factory, credentials, usage and availability
- `createSdkLoader` (`electron/features/claude-sdk/runtime.cjs`) — deferred ESM loading from development or unpacked production paths
- `inspectClaudeExecutable` (`electron/features/claude-sdk/executable.cjs`) — whether the installed native Claude Code exists and meets the minimum version; main reads it to say what a new session takes
- `commands` (`electron/features/claude-sdk/session.cjs`) — a native-safe command catalog from the live SDK, its replacement pushes or the shared file catalog before a query exists; listing never starts a query

## May import
- `electron/command-phrase.cjs`
- `electron/conversation-record.cjs`
- `electron/prompt-queue.cjs`
- `electron/features/native-session/storage.cjs`
- `electron/features/native-session/events.cjs`
- `electron/boundaries.cjs`
- `electron/agent-actions.cjs` (the one rule for naming a command: running tests, checking types)

## Invariants
- Owner queries stay open at idle; explicit sends renew spent caps at safe message boundaries. Listing commands never starts a query; live command feedback is visible while historical machine records stay filtered, and reset aliases or host-overridden model settings are not advertised — test: `tests/claude-sdk-budget.test.cjs` › "M1 each explicit idle turn renews its five-dollar cap without charging resumed history"; test: `tests/native-commands.test.cjs` › "local slash output renders once as assistant text without becoming an owner prompt or leaking wrappers"; test: `tests/claude-sdk-real-cli.test.cjs` › "native slash /compact has real CLI feedback and a lazy command list"
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
