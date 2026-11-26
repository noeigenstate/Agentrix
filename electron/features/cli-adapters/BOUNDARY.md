# Boundary: CLI adapters

Owns the CLI registry and capability manifests shared by main and the renderer.
Generic modules get CLI differences through the registry and `support()`.
Regenerate the Node 20.3 worker manifest projection with `node tests/cli-adapters.test.cjs --write-worker-manifests` when its source fields change.
The first matching model rule wins and the final rule matches every model.
Installer version floors describe the native runtime. Each capability's `via` describes its primary path. Claude's live controls describe the terminal path.
After the migration, adding a CLI requires only its manifest, adapter and screen files, with the entries wired into their registries.
Keep CLI names out of generic control flow, including regex tests, string tricks and lookup tables that evade the branch guard.
Regenerate branch count reductions with `node tests/cli-branch-guard.test.cjs --write` and review the affected module JSON in the same change.
The S2 worker facet will expose `resultServer({ command, args, env })` for the role's own stdio result server.
The facet translates its descriptor into provider launch options or the native runtime's server spec.
The terminal migration uses the shared launch field names and supplies separate delivery note components.
Git approval checks recognize explicit subcommands. The final snapshot can detect ref changes made by a script or alias.

## Owns
- `electron/features/cli-adapters/**`

## Interface
- `adapters` (`electron/features/cli-adapters/registry.cjs`) - main registry for install and runtime facets. `settingsInstall` binds locator snapshots and refreshes.
- `terminalAdapters` (`electron/features/cli-adapters/terminal.cjs`) — launch argv, resume lines, note delivery and role server config. Also exports `claudeWire` for the SSH worker's Python 3.6 path.
- `adapters` (`electron/features/cli-adapters/registry.mjs`) — the shared declarations for both processes. `agentOfModel(model)` uses the first matching manifest in either entry point.
- `support` (`electron/features/cli-adapters/capabilities.mjs`) — reports `via` or a reason key with optional parameters. A detected version older than the capability's verified range is refused; a newer one is tried and flagged `unverified`.
- `events` (`electron/features/cli-adapters/registry.cjs`) - optional settings builder and hook signal decoder.
- `transcript` (`electron/features/cli-adapters/registry.cjs`) - resolves, validates and interprets local session records.
- `usage` (`electron/features/cli-adapters/usage.cjs`) — reads account limits, selects usage record handling and supplies dashboard identity and quota scope.
- `bindNativeAdapters` (`electron/features/cli-adapters/registry.cjs`) — binds each host's runtime as `native.create(spec, emit)`. The registered facet loads the factory with `native.load()`.

- `workerOf` (`electron/features/cli-adapters/workers.cjs`) — the CJS worker registry for dispatch, including CLI argv, normalized output, permission and standing rules.
- `workerRefusal` (`electron/features/cli-adapters/workers.cjs`) — shared command and file scope decisions for worker approvals. The Claude worker policy also exposes it with the role's access level bound.
- `worker-manifests` (`electron/features/cli-adapters/manifests/worker.cjs`) — the carried install floors and ordered model matches projected from the shared manifests.

## May import
- `electron/boundaries.cjs` (allowed file glob matching)
- `electron/features/agents/dispatch-events.cjs` (structured launch field table)
- `electron/features/claude-runtime/adapter.cjs` (Claude Code install, hooks and transcript)
- `electron/features/codex-runtime/adapter.cjs` (Codex install and transcript)
- `electron/features/claude-sdk/adapter.cjs` (Claude native runtime and policy)
- `electron/features/codex-app-server/adapter.cjs` (Codex native runtime and policy)
- `electron/features/agents/call-seat.cjs` (Claude lead seat fallback from the bootstrap sidecar)
- `electron/features/agents/claude-account-usage.cjs` (read-only account reader)
- `electron/features/agents/codex-account-usage.cjs` (read-only account reader)
- `electron/oversized-record.cjs` (worker stream image metadata)
- `electron/features/dashboard/records-routing.cjs` (shared routing verdict)
- `src/shared/agent-events.ts` (the provider ID type for the renderer declaration)

## Invariants
- The CLI adapter text readers stay within their module baseline — test: `tests/self-format-guard.test.cjs` › "product and test text readers match the per-module self-format baseline"
- Both entry points share the manifests. Each capability names its channel or an unsupported reason — test: `tests/cli-adapters.test.cjs` › "expose complete capability manifests"
- Screen verification uses inclusive numeric bounds per capability — test: `tests/cli-adapters.test.cjs` › "support refuses versions older than the verified range and flags newer ones"
- A CLI without a dedicated install facet uses its manifest for PATH detection and version checks — test: `tests/cli-adapters.test.cjs` › "a manifest supplies a PATH install facet when there is no dedicated locator"
- The carried CJS manifests use the shared install floors and model order — test: `tests/cli-adapters.test.cjs` › "carried workers use the shared manifest projection"
- Each generic file matches its branch count during migration — test: `tests/cli-branch-guard.test.cjs` › "generic code matches its per-file CLI branch baseline"

## Not ours
- Running CLI processes, protocol implementations and parsers — the runtime and screen modules
- Control visibility, disabled state and reason rendering — the caller's view
