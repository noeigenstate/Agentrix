# Boundary: Terminal view

The renderer side of a project terminal: the xterm pane (keys, clipboard, links, fitting, renderer, theme), the splits
of a project card with the agent launcher, the screen registry other views read the agent's screen from, and which
split is in use.

## Owns
- `src/features/terminal/**`

## Interface
- `ProjectTerminals` (`src/features/terminal/ProjectTerminals.tsx`) — the terminal splits of one project card, each with its pane, reading view or launcher
- `useActiveTerminal` (`src/features/terminal/active-terminal.ts`) — the split a project's reader last picked, and `setActiveTerminal` to pick one
- `visibleTerminals` (`src/features/terminal/terminal-visibility.ts`) — the splits a small card or an expanded project shows, and `terminalInUse` (the picked split, else the first)
- `readScreen` (`src/features/terminal/terminal-screen.ts`) — a terminal's live screen rows and approval stamp, `subscribeScreen` and `useScreen` for updates; the file also exports the Screen type
- `findPathCandidates` (`src/features/terminal/terminal-links.ts`) — the paths and links in a line of text, shared with the reading view
- `terminalFontFamily` (`src/features/terminal/terminal-font.ts`) — the CSS font list for the chosen terminal fonts
- `setTerminalRenderer` (`src/features/terminal/terminal-renderer.ts`) — switches every terminal between the GPU and DOM renderers
- `terminalTheme` (`src/features/terminal/terminal-theme.ts`) — the xterm colours of the current theme
- `mountReadingTerminal` (`src/features/terminal/terminal-popup.ts`) — shows a split's live xterm inside the reading view's terminal popup; `pruneReadingCli` drops closed ones

## May import
- `src/shared/**`
- `src/features/agents/agent-screen*.ts`
- `src/features/agents/AgentBrandIcon.ts`
- `src/features/reading/ReadingView.tsx`
- `src/features/reading/reading-mode.ts`
- `src/features/workspace/useProjectReorder.ts`

## Invariants
- Typing, selecting and copying inside a small card's terminal only select its split and never expand the project — AGENTS.md: expansion belongs to the project header, the waiting-status action and explicit expand buttons — test: `tests/boundary-terminal.test.cjs` › "typing, selecting or copying in a small card's terminal never expands the project"
- The pane takes only copy (with a selection), paste and select-all; Ctrl+= / Ctrl+- / Ctrl+0 and Ctrl+C without a selection reach the program — a zoom change once swallowed the keys the terminal must receive — test: `tests/boundary-terminal.test.cjs` › "the terminal key handler passes zoom keys and Ctrl+C without a selection to the program"
- No window-level handler takes the zoom keys from the terminals — the same keys, guarded where the window handles zoom — test: `tests/window-zoom.test.cjs` › "wheel and pinch zoom are reset to the effective setting, and zoom keys still reach the terminals"
- Output is subscribed before the attach snapshot and applied in sequence order, for the pane's own session only — a remount during a stream must neither lose nor repeat output — test: `tests/boundary-terminal.test.cjs` › "terminal output applies in sequence order: the attach snapshot, then newer packets of the same session only"
- Programs may write the clipboard through OSC 52, but a clipboard read request is ignored — nothing on the user's clipboard may reach a program unasked — test: `tests/boundary-terminal.test.cjs` › "programs may write the clipboard through OSC 52, but a read request never sends the clipboard to the program"
- A screen's approval stamp binds only to the rows of the last write that carried it, on the same mounted terminal — a late parse callback must not authorise stale rows — test: `tests/approval-aba.test.cjs` › "xterm pending writes and late callbacks cannot bind a new epoch to stale rows or a remounted terminal"
- Hidden and zero-sized terminals are never resized, and showing one again fits the same xterm instance — a resize to nothing reflows the CLI's screen and loses its prompt — test: `tests/terminal-visibility.test.cjs` › "hidden and zero-sized terminals never resize; showing them again fits the same instance"
- A small card shows only its agent splits while the hidden shell panes stay mounted — unmounting a pane drops its xterm and screen — test: `tests/terminal-visibility.test.cjs` › "a single visible agent fills the card while hidden shell panes remain rendered, and expansion restores splits"

## Not ours
- What a typed line means (prompt, command, protocol reply) and the PTY itself — Terminal (electron/features/terminal)
- Presenting the conversation, choices and approvals over a terminal — Reading view
- Parsing an agent's screen into choices, footers and sign-in steps — Activity pane (src/features/agents)
- Expanding a project, the card header and its menu — workspace (src/features/workspace)
- Window zoom — app window (electron/app/window-zoom.cjs)
- The terminal font and renderer settings themselves — Settings
