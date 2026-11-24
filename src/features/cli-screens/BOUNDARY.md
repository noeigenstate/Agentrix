# Boundary: CLI screens

Reads CLI terminal rows, including input, activity, dialogs and routing picker receipts.
Wire new facets into the screen registry. A minimal facet supplies input, working and atPrompt.
Keep provider-name branches, including regex workarounds for the branch guard, in the provider facets.

## Owns

- `src/features/cli-screens/**`

## Interface

- `screenOf` (`src/features/cli-screens/index.ts`) — selects a registered screen facet and exports screen types, parser entry points and the version gate for screen switching

## May import

- `electron/features/cli-adapters/**`
- `src/features/agents/agent-question.ts`
- `src/shared/**`

## Invariants

- Normalization preserves aligned options and the caller's rows — test: `tests/agent-screen.test.cjs` › "padding and trailing carriage returns preserve every fixture without mutating input"
- The current PTY's welcome version takes precedence over the installed version and survives redraws — test: `tests/terminal-screen-state.test.cjs` › "the CLI welcome version takes precedence over installation and stays with its PTY as the welcome scrolls out"
- Unverified screen switching sends no routing commands — test: `tests/lead-sync.test.cjs` › "an unverified live version reports why and sends no routing keys until a verified version is observed"

## Not ours

- Reading xterm buffers, maintaining PTY identity or sending terminal keys ? Terminal view
- Persisting the seat configuration and applying native routing ? Skills and the native runtimes
