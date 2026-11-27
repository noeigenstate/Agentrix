# Boundary: Antigravity ACP runtime

Runs local Antigravity owner and role sessions through ACP, the Agent Client Protocol, and publishes Agentrix session events.

## Owns
- `electron/features/agy-acp/**`

## Interface
- `createAgyRuntime` (`electron/features/agy-acp/index.cjs`) — creates owner and role sessions, lists project history, reads the model catalog, and accepts an injected CLI launcher and process tree stop.
- `readActualModel` (`electron/features/agy-acp/index.cjs`) — reads the last model recorded for an ACP session in its profile.
- `createInstall` (`electron/features/agy-acp/adapter.cjs`) — detects the executable and its version.
- `native` (`electron/features/agy-acp/adapter.cjs`) — loads the runtime factory on demand.
- `nativePolicy` (`electron/features/agy-acp/adapter.cjs`) — declares the transport, session identity and startup messages.
- `modelProbe` (`electron/features/agy-acp/adapter.cjs`) — reads selectable models and thinking levels through the host's catalog refresh.
- `readAgyAccount` (`electron/features/agy-acp/usage.cjs`) — runs the CLI's structured `/usage` command and sanitizes the quota windows.
- `agyAccountLimits` (`electron/features/agy-acp/usage.cjs`) — converts the reading to the existing usage payload.

## May import
- `electron/shared/stdio-rpc.cjs`
- `electron/shared/native-events.cjs`
- `electron/shared/agentrix-shims.cjs` (skip Agentrix's own launchers when resolving the installed executable)
- `electron/features/cli-adapters/workers.cjs`
- `electron/features/cli-adapters/registry.mjs` (install version floor and model IDs)
- `electron/features/cli-adapters/capabilities.mjs` (shared version comparison)
- `electron/features/codex-app-server/index.cjs`
- `electron/command-phrase.cjs`
- `electron/session-files.cjs` (shared path identity for filtering history)

## Invariants
- Startup and live routing select the model before its thinking level and keep provider approval mode at default. A running turn finishes before the new lead settings apply, and the next queued turn waits for the change — test: `tests/agy-acp-runtime.test.cjs` › "starts and resumes with isolated ACP configuration"; test: `tests/agy-owner.test.cjs` › "agy applies the changed lead model and effort before a queued turn starts"
- Tool approval uses structured inputs and preserves the request ID. On interruption every outstanding approval receives a cancelled outcome while the peer is connected, so the peer can end the turn — test: `tests/agy-acp-runtime.test.cjs` › "answers exact string IDs using structured tool intents"; test: `tests/agy-acp-runtime.test.cjs` › "interrupts a waiting turn and sends the next prompt on the same session"
- A lost process leaves a written turn unknown and clears pending requests — a replacement process cannot execute the same input twice — test: `tests/agy-acp-runtime.test.cjs` › "process exit leaves sent input unknown and rejects unsent queued input"
- Selectable models come from a prompt-free ACP probe that filters orchestration modes. Existing saved choices stay usable. Actual model evidence comes from the session transcript — test: `tests/agy-acp-runtime.test.cjs` › "probes model choices without a prompt and verifies models from transcripts"; test: `tests/agy-owner.test.cjs` › "an existing agy lead choice remains effective without appearing in the model dropdown"
- The local broker and the carried SSH helper both apply role scope. SSH uses Agentrix's private remote profile — test: `tests/agy-role-real-cli.test.cjs` › "real agy role uses the dispatch broker and enforces its file scope"; test: `tests/ssh-agy-role.test.cjs` › "the carried SSH helper runs agy without a broker and enforces role scope in a private profile"
- Owner history is filtered by working directory on every page. Replay uses `session/load`, emits replay items and does not repeat the persisted system prompt — test: `tests/agy-owner.test.cjs` › "agy owner history filters every page by cwd and replays messages without starting a turn"
- Owner approvals use the configured full or ask behavior and interruption expires outstanding approval tickets — test: `tests/agy-owner.test.cjs` › "agy full answers automatically and ask waits for the owner through allow, deny and interrupt"
- Account reads accept only zero-turn `/usage` replies and retain numeric windows under safe group names — test: `tests/agy-usage.test.cjs` › "agy reads its own four quota windows without emitting account data"

## Not ours
- Role dispatch and access policy — native-session and cli-adapters.
- Sender checks and persisted model choices — native session host.
