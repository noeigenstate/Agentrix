# Boundary: Terminal

The main-process side of a project terminal: its IPC (start, attach, write, paste, resize, close), the input
classification that tells a typed prompt from keys and protocol replies, the shell environment and start-up files, link
resolution and title tracking. Agentrix starts Codex only through app-server; terminal-protocol probes live under scripts and are not product launch paths.

## Owns
- `electron/features/terminal/**`
- `electron/terminal-*.cjs`
- `electron/zsh-terminal.cjs`

## Interface
- `registerTerminalIpc` (`electron/features/terminal/ipc.cjs`) — the terminal:* IPC handlers main.cjs registers, with every session dependency injected; returns the same tracked write path for main's admitted quota fallback (never clears an existing input)
- `registerNativeIpc` (`electron/features/terminal/native-ipc.cjs`) — the native approval, question-answer and managed-prompt IPC handlers
- `ApprovalGuard` (`electron/features/terminal/approval-guard.cjs`) — a session's observation epochs; the file also exports approvalStamp
- `createTerminalEnvironment` (`electron/terminal-env.cjs`) — the environment a PTY starts with
- `SubmissionTracker` (`electron/terminal-input.cjs`) — which writes submit a prompt; the file also exports isTerminalResponse, isLocalCommand and acceptShellEvent
- `InputGate` (`electron/terminal-input.cjs`) — holds keys while PowerShell asks for the cursor; the file also exports PromptMarkers
- `TerminalTitleTracker` (`electron/terminal-title.cjs`) — the Codex session ids a terminal's OSC title reports; the file also exports wholeThread
- `sameThread` (`electron/terminal-title.cjs`) — whether a session id is the one a title reported, whole or cut short
- `resolveTerminalLink` (`electron/terminal-links.cjs`) — what a clicked terminal link opens; the file also exports resolveRevealPath
- `shellEnvironment` (`electron/zsh-terminal.cjs`) — the zsh and Bash environment, arguments, locale and shell choice of a local terminal
- `prepareZshStartup` (`electron/zsh-terminal.cjs`) — the ZDOTDIR stubs and login-shell PATH used at app start-up

## May import
- `electron/project-files.cjs`

## Invariants
- Only a submitted line arms completion; typing, an empty Enter and xterm's protocol replies never do — AGENTS.md: completion is never rearmed by idle or background input — test: `tests/terminal-input.test.cjs` › "completion is rearmed by submitted input, not typing, empty Enter or terminal reports"
- Keys that answer a CLI signing in reach it as typed but never become a prompt, a queued message or a round — sign-in codes and API keys must not appear anywhere — test: `tests/terminal-input.test.cjs` › "answers to a CLI signing in reach it as typed but are never a prompt"
- The legacy terminal:approval endpoint answers terminal-only and writes nothing, and an approval stamp works once and only for the current observation epoch — no screen observation can target a native TUI request, and a held card must never answer a newer, identical-looking request — test: `tests/approval-aba.test.cjs` › "backend independently returns terminal-only for every key, identity, gate and session state"; test: `tests/approval-aba.test.cjs` › "observation guard still rejects stale epochs, competing transactions and consumed final stamps"
- Agentrix never starts a Codex TUI, including manually typed commands in its injected PowerShell, cmd, Bash, zsh and SSH shells; their authenticated codex-started event requests the native start path, with unsupported argv refused in Chinese. Subscription login remains valid on app-server. Product process and terminal write callsites are explicitly admitted, while terminal-protocol probes live under scripts — test: `tests/codex-app-server-only.test.cjs` › "product Codex command builders cannot restore exec or terminal input"; "Agentrix injected shells never start a Codex TUI, including manually typed commands"; test: `tests/codex-shell-native.test.cjs` › "authenticated manual Codex events leave before any terminal agent tracking"
- Retired host answer channels refuse every payload without reading sessions or writing keys, and managed Claude cannot start. Attaching a raw terminal view to a structured native host returns an empty PTY snapshot without invoking PTY methods or minting a PTY capability, and a native host takes no shell report: across a run-mode switch it keeps the key of the terminal it stages or replaces, whose last exit and prompt reports can arrive after the host is back — a stale renderer must not reach a CLI, and a failed switch to the terminal must not leave the kept API session shown as a shell — test: `tests/native-approvals.test.cjs` › "all retired host channels refuse every payload without reading sessions or writing keys"; "native provider binding refuses managed Claude before starting any process"; test: `tests/ipc-features.test.cjs` › "terminal attach returns an empty PTY snapshot for native hosts without invoking PTY methods"; test: `tests/terminal-input.test.cjs` › "a native host takes no shell report, whatever its sequence"; test: `tests/native-switch-main.test.cjs` › "after a failed switch the late exit and prompt reports of the staged terminal leave the restored native host as it was"
- A PTY never inherits AGENTRIX_DATA_DIR, AGENTRIX_DEV_URL, ELECTRON_RUN_AS_NODE or a colour-disabling variable, in any letter case — a shell started from a test profile must not write to that profile, and agents must keep their colours — test: `tests/terminal-env.test.cjs` › "Windows environment casing cannot leave duplicate color-disabling variables"
- Standalone terminal-protocol tests inject a fake `cli` and never use the one installed on the machine — results must not depend on the developer's installed agents or accounts — test: `tests/boundary-terminal.test.cjs` › "native session tests inject a fake CLI and never start the one installed on the machine"
- A terminal link opens only HTTP(S) addresses and files inside the project; executable protocols and paths that escape the project are refused — agent output is untrusted text — test: `tests/terminal-links.test.cjs` › "link resolution opens HTTP URLs and project files while rejecting executable protocols and escapes"

## Not ours
- Spawning the PTY, the session records and restore plans — main.cjs (app shell)
- Round completion, prompt queues and the completion notification — Completion
- Window zoom and its keyboard handling — app window (electron/app/window-zoom.cjs)
- Reading an agent's transcripts and activity — Activity pane
- Delivering a dispatched task into a terminal — Dispatch
- The terminal's rendering, keys and clipboard in the window — Terminal view (src/features/terminal)
