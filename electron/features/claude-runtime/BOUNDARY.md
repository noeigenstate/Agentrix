# Boundary: Claude runtime

Where Claude Code is on this machine, for the terminal and the native path alike: one search order, one cache, and the
Windows PATH merge it searches. Main keeps one locator; the native path runs its `native` file (through
`claude-sdk/executable.cjs`), a local terminal is told its `terminal` file in `AGENTRIX_CLAUDE_EXECUTABLE`, and the
agents' state reads its last result.

Which program a terminal's `claude` runs, highest first: an alias for claude in the user's start-up files (bash, zsh),
then `AGENTRIX_CLAUDE_EXECUTABLE` while that file exists, then the wrapper's own PATH search. An SSH project's terminal
is never told one. The wrappers' own search is deliberately left narrower than the locator's this round (bootstrap.ps1:
the first claude on PATH, a shim mapped to its npm package's bin/claude.exe; bash and zsh: the first on PATH); it runs
only when no file was chosen. An alias that makes the terminal run another program than the native path is not seen by
the locator, an accepted gap.

The PATH merge has two implementations with one meaning: `integration/refresh-path.ps1` in a terminal's PowerShell and
`mergePath` here. Both keep the inherited PATH first and append every entry of the stored machine then user PATH,
each expanded against the environment (%NAME% of a defined variable, anything else as written), that is not already
there; an entry is kept as written (trimmed), and two entries are the same folder when they match without quotes, with
/ as \ and without trailing \ (a drive root keeps its own), letter case ignored; a scope that cannot be read adds nothing.

## Owns
- `electron/features/claude-runtime/**`

## Interface
- `createLocator` (`electron/features/claude-runtime/locator.cjs`) — `{ locate, refresh, peek }` over injected `probe`, `files`, `storedPath` and `now`. `locate({ env, platform, arch, home })` and `refresh(…)` give `{ terminal, native, reason, pathHash, effectivePath }`, where `terminal` (the first Claude Code found that printed a version) and `native` (the first that meets `REQUIRED`) are `{ file, fileShown, version, via, fingerprint: { file, size, mtimeMs, pathHash } }` or null, and are the same object when they are the same file; `fileShown` writes home as `~`. `reason` is null, `cli_split_versions` (two different files), `too_old` (with `version`), the failed check's `timeout`, `failed` or `unreadable` (with `failure: { reason, found, error?, elapsedMs? }`), or `not_found` (with `pathFolders`, `searched` and `incomplete` for an npm package without its native program). Search order: the effective PATH (inherited, then the stored Windows PATH merged by `mergePath`), each folder as the wrapper takes it (Windows: claude.ps1, claude + each PATHEXT, bare claude; a shim that comes before claude.exe puts its npm package first; npm's placeholder bin/claude.exe gives way to the platform package's copy; a cli.js package reads as too old by its package.json and is not run), then ~/.local/bin, ~/.claude/local, WinGet's links (Windows) or the system folders (elsewhere); paths follow `platform`'s rules on any host. `refresh` reads the stored Windows PATH again, at most once a minute while no `native` was found; `locate` stats only what the last search chose and searches again when a file or the PATH changed; under the same PATH nothing found stays the answer until the next refresh. `--version` runs once per file, size and mtime (a check that printed no version is tried again by the next search); overlapping calls share one search, and a refresh asked during a locate follows it. `peek()` is the last result, null before the first search
- `VIAS` (`electron/features/claude-runtime/locator.cjs`) — every `via`: `path` (an inherited PATH folder), `npm` (an npm package's bin/claude.exe, found by a folder's shims or its node_modules), `platform-package` (the platform package's copy behind npm's placeholder), `local-bin` (~/.local/bin, the native installer), `claude-local` (~/.claude/local, the legacy local install), `winget` (WinGet's links), `registry-path` (a folder only the stored Windows PATH has), `system` (/opt/homebrew/bin, /usr/local/bin, /usr/bin)
- `REQUIRED` (`electron/features/claude-runtime/locator.cjs`) — the oldest Claude Code the native path runs
- `mergePath` (`electron/features/claude-runtime/path-env.cjs`) — the PATH merge above: `mergePath(inherited, [machine, user], env)`
- `readStoredPath` (`electron/features/claude-runtime/path-env.cjs`) — the stored machine and user PATH as `[machine, user]`, read (never written) by the PowerShell under the environment's SystemRoot within five seconds; null when it cannot be read or the environment has no SystemRoot

## May import

## Invariants
- The terminal and the native path run one Claude Code from one search: the native path the first that meets the minimum version, the terminal the first found, and two different ones are `cli_split_versions` with both described — test: `tests/claude-runtime-locator-core.test.cjs` › "the terminal runs the first Claude Code found and the native path the first that meets 2.1.317: two different ones are cli_split_versions"
- Every install way is found in the wrapper's order, a placeholder or an old JavaScript package is never run, and none found says where it looked with home as ~ — test: `tests/claude-runtime-locator-core.test.cjs` › "Windows: Claude Code is found where npm, the stored PATH, the legacy local install and WinGet put it, and none found says where it looked"; test: `tests/claude-runtime-locator-core.test.cjs` › "Windows: within a folder a shim that PowerShell would take first puts its npm package before claude.exe, and a broken or unreadable candidate never hides the next"; test: `tests/claude-runtime-locator-core.test.cjs` › "POSIX: npm, its placeholder, the native installer and the system folders, in the platform path rules on any host"
- One fingerprint runs `--version` once and a locate is a stat of what was chosen; a changed file or PATH searches again — test: `tests/claude-runtime-locator-core.test.cjs` › "one fingerprint runs --version once: a locate only stats what the last search chose, and a changed file or PATH searches again"
- A CLI installed while Agentrix runs is found by the next refresh without a restart, the stored PATH is read no more than once a minute while nothing is found, and nothing found stays the answer until a refresh — test: `tests/claude-runtime-locator-core.test.cjs` › "a refresh reads the stored Windows PATH; while nothing is found at most once a minute, and nothing found stays the answer until the next refresh"
- The Node merge and refresh-path.ps1 give the same PATH for the same stored values, and the stored PATH is only read — test: `tests/claude-runtime-path-env.test.cjs` › "Windows: refresh-path.ps1 and the Node merge give the same PATH for the same stored values"; test: `tests/claude-runtime-path-env.test.cjs` › "the stored PATH is read with the PowerShell of the environment SystemRoot, machine then user, and a read that fails gives null"
- A terminal's claude is the user's alias, then the chosen file while it exists, then the wrapper's own search — test: `tests/claude-runtime-wrappers.test.cjs` › "wrapper runs the user's alias first, then the Claude Code Agentrix chose while it exists, then the first on PATH"; test: `tests/claude-runtime-wrappers.test.cjs` › "PowerShell wrapper runs the Claude Code Agentrix chose while it exists, and otherwise maps the first claude on PATH to its npm package"

## Not ours
- Running the CLI, its version requirement's wording and the connection test — Claude SDK runtime (`electron/features/claude-sdk/**`)
- The terminal wrappers that read the choice — `integration/bootstrap.ps1`, `integration/bash-integration.bash`, `integration/zsh-integration.zsh`, `integration/refresh-path.ps1`
- Telling a terminal its choice, refreshing on start-up and window focus — `electron/main.cjs`
