# Boundary: CLI adapters

Owns the CLI registry and capability manifests shared by main and the renderer.
Generic modules get CLI differences through the registry and `support()`.
The first matching model rule wins and the final rule matches every model.
Installer version floors describe the native runtime. Each capability's `via` describes its primary path. Claude's live controls describe the terminal path.
After the migration, adding a CLI requires only its manifest, adapter and screen files, with the entries wired into their registries.
Keep CLI names out of generic control flow, including regex tests, string tricks and lookup tables that evade the branch guard.
Regenerate branch count reductions with `node tests/cli-branch-guard.test.cjs --write` and review the JSON diff in the same change.

## Owns
- `electron/features/cli-adapters/**`

## Interface
- `adapters` (`electron/features/cli-adapters/registry.cjs`) - main registry for install and runtime facets. `settingsInstall` binds locator snapshots and refreshes.
- `adapters` (`electron/features/cli-adapters/registry.mjs`) — the shared declarations for both processes. `agentOfModel(model)` uses the first matching manifest in either entry point.
- `support` (`electron/features/cli-adapters/capabilities.mjs`) — reports `via` or a reason key with optional parameters. A detected version older than the capability's verified range is refused; a newer one is tried and flagged `unverified`.
- `events` (`electron/features/cli-adapters/registry.cjs`) - optional settings builder and hook signal decoder.
- `transcript` (`electron/features/cli-adapters/registry.cjs`) - resolves, validates and interprets local session records.

## May import
- `electron/features/claude-runtime/adapter.cjs` (Claude Code install, hooks and transcript)
- `electron/features/codex-runtime/adapter.cjs` (Codex install and transcript)
- `src/shared/agent-events.ts` (the provider ID type for the renderer declaration)

## Invariants
- Both entry points share the manifests. Each capability names its channel or an unsupported reason — test: `tests/cli-adapters.test.cjs` › "expose complete capability manifests"
- Screen verification uses inclusive numeric bounds per capability — test: `tests/cli-adapters.test.cjs` › "support honors inclusive numeric verification bounds"
- A CLI without a dedicated install facet uses its manifest for PATH detection and version checks — test: `tests/cli-adapters.test.cjs` › "a manifest supplies a PATH install facet when there is no dedicated locator"
- Each generic file matches its branch count during migration — test: `tests/cli-branch-guard.test.cjs` › "generic code matches its per-file CLI branch baseline"

## Not ours
- CLI launch, protocol implementations and parsers — the runtime and screen modules
- Control visibility, disabled state and reason rendering — the caller's view
