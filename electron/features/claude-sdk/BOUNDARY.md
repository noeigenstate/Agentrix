# Boundary: Claude SDK runtime

Owns the host's Claude Agent SDK sessions, protected credentials, worker tool decisions and local API accounting.

Owner and worker entrypoints remain the CLI default. Ownership is host-observed session identity, persisted locally for owners and read from the team journal for workers; the old agentrix-sdk transcript marker remains readable, while unclassified old sdk-ts prompts stay excluded.

Owner sessions currently keep tool and hook environment inheritance; dispatch workers enable the CLI's subprocess scrub. A2 is awaiting the owner's answer; the existing behavior is retained in the meantime, not an isolation guarantee. API routing is pinned in a private session settings file from host and user sources; repository env and helper settings cannot choose the destination. Routing secrets never enter argv. The saved key remains in the child environment, never the settings file or argv; project/local env overrides found at launch are refused. This does not attest effective key bytes against later config changes or active hooks. Project hooks still inherit it under the retained A2 behavior.

Project hooks remain enabled for workers, matching the trusted project's CLI behavior. Worker scope policy constrains the model's requested inputs; it does not sandbox project hooks, which can execute commands and rewrite an allowed input to a path outside the worker scope. This is an explicit owner decision, not an isolation guarantee.

## Owns
- `electron/features/claude-sdk/**`

## Interface
- `createClaudeRuntime` (`electron/features/claude-sdk/index.cjs`) — injected SDK session factory, credentials, usage and availability
- `createSdkLoader` (`electron/features/claude-sdk/runtime.cjs`) — deferred ESM loading from development or unpacked production paths
- `inspectClaudeExecutable` (`electron/features/claude-sdk/executable.cjs`) — whether the installed native Claude Code exists and meets the minimum version; main reads it to say what a new session takes
- `commands` (`electron/features/claude-sdk/session.cjs`) — a native-safe command catalog from the live SDK, its replacement pushes or the shared file catalog before a query exists; listing never starts a query

## May import
- `electron/claude-sessions.cjs` (verified local project identity for aliased transcript history)
- `electron/session-files.cjs` (contained-file and open-handle identity checks for that read)
- `electron/command-phrase.cjs`
- `electron/conversation-record.cjs`
- `electron/prompt-queue.cjs`
- `electron/features/native-session/storage.cjs`
- `electron/features/native-session/events.cjs`
- `electron/boundaries.cjs`
- `electron/agent-actions.cjs` (the one rule for naming a command: running tests, checking types)

## Invariants
- Owner queries stay open at idle; a configured cap and reservation use the remaining monthly budget, without a fixed per-turn limit; no monthly budget means no cap. Explicit sends renew changed allowances at safe message boundaries, preserving live background work. Listing commands never starts a query; live command feedback is visible while historical machine records stay filtered, and the six native controls are advertised. Returned shell background jobs survive later interrupts and foreground deadlines; close still reaps them. Rejected model delivery retains shell output and names that it was not sent, including accepted shell inputs whose real CLI result fails without a parent model reply. The notice precedes completion and fallback; shell commands are never replayed as fallback prompts. A read of runOptions is lazy; acknowledged model, effort and fast choices survive renewal. New conversations migrate the binding before retiring the previous provider. Owner credit/spend refusals remain scoped until a successful probe, explicit invalidation or successful use; one new session per ten minutes may try again. Only a synthetic zero-usage final with delivery evidence and no execution offers a replayable fallback input — test: `tests/shell-delivery.test.cjs` › "shell delivery none distinguishes parent reply from CLI errors"; test: `tests/claude-sdk-budget.test.cjs` › "M1 a query uses the remaining monthly budget across idle turns without charging resumed history"; test: `tests/native-commands.test.cjs` › "local slash output renders once as assistant text without becoming an owner prompt or leaking wrappers"; test: `tests/claude-sdk-real-cli.test.cjs` › "native slash /compact has real CLI feedback and a lazy command list"; test: `tests/native-api-quota.test.cjs` › "quota availability remains scoped and sticky; only one new session can claim a ten-minute trial"
- Workers load normal user/project/local settings and rely on blocking PreToolUse policy under bypassPermissions; owner questions still reach canUseTool. GUI queries additionally define the read-only `agentrix-lookup` Haiku agent through SDK options, without writing user agent files; its plan permission mode limits Bash to read-only inspection — test: `tests/claude-sdk-haiku-real-cli.test.cjs` › "real SDK agents option selects Haiku and confines lookup Bash to read-only inspection"; test: `tests/claude-sdk-real-cli.test.cjs` › "A7 product worker policy remains active on resume and a throwing hook blocks"; test: `tests/claude-sdk-real-cli.test.cjs` › "under bypass a question still reaches the owner through canUseTool"
- API identity requires the env API source; routing overrides project transport and helper settings without disabling owner project settings — test: `tests/claude-sdk-runtime.test.cjs` › "billing identity mismatch fails without trusting a subscription init"; test: `tests/claude-sdk-real-cli.test.cjs` › "A1 project settings cannot send the saved key to a trap endpoint"
- Stopping cancels pending approvals and preserves uncertain delivery — test: `tests/claude-sdk-runtime.test.cjs` › "stop rejects queued input and stale permission answers"; Local command results complete only with CLI-provided `local_command`, `subtype:success` and `is_error:false` when no overriding terminal reason or interrupt exists. Unclassified ends stay unknown without an error or completion notification. Compaction succeeds only after a live context.compacted event in that turn; failed compact feedback stays visible even when the CLI result says success. Labelled model-setting/compaction feedback and replayed user stdout are omitted; read-only local command replies remain visible — test: `tests/native-ui-backend-real.test.cjs` › "D3 D5 real CLI local command results and identities drive completion and visible output"; test: `tests/backend-activity.test.cjs` › "D1 D3 D5 real CLI shell then compact completes and notifies once through the product main process".
- Credential status contains only a saved flag — test: `tests/claude-sdk-runtime.test.cjs` › "credential status returns only saved and ciphertext never contains the test key"
- Cumulative usage is differenced and deduplicated across resume — test: `tests/claude-sdk-runtime.test.cjs` › "usage deltas persist across resume, deduplicate, and ignore zeroed failures"
- Reservations survive a crash and cannot be spent twice — test: `tests/claude-sdk-runtime.test.cjs` › "concurrent reservations and crash leftovers cannot spend the budget twice"
- Worker policy audits decisions while final scope checks remain the execution guarantee — test: `tests/claude-sdk-runtime.test.cjs` › "worker policy permits general commands, rejects explicit Git and scoped path escapes"

## Not ours
- Provider-neutral routing, IPC and settings
- Helper admission, scope verification and durable control delivery
- Native view components and account billing statements
