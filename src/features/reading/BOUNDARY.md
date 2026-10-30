# Boundary: Reading view

The document view of an agent terminal: the conversation as a timeline, the composer that types into the CLI, the
choice, question and approval cards drawn from its screen, the result card of the latest round, and the switch between
reading and the raw terminal.

## Owns
- `src/features/reading/**`

## Interface
- `ReadingView` (`src/features/reading/ReadingView.tsx`) — the reading view of one agent terminal; the file also exports Markdown, the renderer the review card and skill pane reuse
- `ModeSwitch` (`src/features/reading/ModeSwitch.tsx`) — the title bar's reading / terminal switch for the terminal in use
- `setReading` (`src/features/reading/reading-mode.ts`) — reading or raw terminal per terminal; the file also exports readingShown, syncReading and useTerminalChoice
- `writeChoiceKeys` (`src/features/reading/choice-keys.ts`) — presses a choice by position; the file also exports selectedChoiceIndex and writeChoiceKeys
- `hasCliInput` (`src/features/reading/cli-panel.ts`) — what the CLI's input line holds; the file also exports isAtPrompt, cliInputDraft and isCliIdle
- `sameMessage` (`src/features/reading/pending-prompts.ts`) — whether a sent message is the one still in the CLI input
- `lastRound` (`src/features/reading/result-round.ts`) — the latest round of a conversation; the file also exports CHECKS and changeLabel
- `ReadingQuestion` (`src/features/reading/ReadingQuestion.tsx`) — the card for an agent's question, reused on the decision page
- `NativeApprovalCard` (`src/features/reading/NativeApprovalCard.tsx`) — the card for a native approval request
- `terminalApprovalCopy` (`src/features/reading/approval-action.ts`) — the text that sends a screen permission request to its terminal
- `FileCards` (`src/features/reading/FileCards.tsx`) — the preview cards of the files a reply names; the file also exports previewable
- `replyFiles` (`src/features/reading/reply-files.ts`) — the local pictures, pages and videos a reply names

## May import
- `src/shared/**`
- `electron/conversation-blocks.mjs` (the conversation grouping rule the main process and the renderer share)
- `src/features/agents/agent-screen*.ts`
- `src/features/agents/sign-in-screen.ts`
- `src/features/agents/action-text.ts`
- `src/features/agents/AgentBrandIcon.ts`
- `src/features/files/file-popup.ts`
- `src/features/voice/voice-input.ts`
- `src/features/terminal/terminal-*.ts`
- `src/features/terminal/active-terminal.ts`

## Invariants
- A permission card drawn from the screen never sends approval keys, whatever identity it holds; it only sends the reader to the terminal — screen text cannot target a native request — test: `tests/approval-aba.test.cjs` › "retained permission dispatch rejects all targets even with fresh, absent or fabricated identity"
- A native approval card sends the backend's exact token and a supported decision once, never through the screen parser or PTY keys — test: `tests/native-approval-ui.test.cjs` › "native UI sends exact backend token and supported decision once, without parser or PTY"
- Enter on a focused button presses that button, never the highlighted option; Cancel never approves — a keyboard user must not approve by accident — test: `tests/reading-ui.test.cjs` › "Enter on a focused button presses that button, never the highlighted option (Cancel never approves)"
- A session change (A to B to A), another split's selection or unmounting cancels every delayed key — keys meant for one session must never reach another — test: `tests/reading-ui.test.cjs` › "session A to B to A, terminal selection and unmount cancel every delayed command key"
- A message the agent queued is never sent again, and a stalled send retries a bounded number of times — a resend runs the task twice — test: `tests/reading-ui.test.cjs` › "unrelated user records cannot discard a stalled prompt; retries stay bounded and queued prompts never resend"
- Editing keys are sent only for what the CLI's screen shows unambiguously, never guessed from prose — a guessed key edits the wrong text — test: `tests/reading-ui.test.cjs` › "ambiguous prose on both sides of an image never causes guessed editing keystrokes"
- Interactive reading requires an active agent in a live terminal; an identity-checked restored history may show read-only until its CLI draws input, and a different thread invalidates readiness; a page capability alone never cancels a send — test: `tests/reading-ui.test.cjs` › "a restored preview cannot send until its own CLI input is ready, and a different thread disables it again"; test: `tests/reading-ui.test.cjs` › "reading view requires an active agent and a live terminal session"
- A waiting notice hands the reader to the terminal at most once, and a manual switch cancels the automatic return — a handoff must not be rearmed by later screen updates — test: `tests/reading-ui.test.cjs` › "one automatic handoff per notice and manual toggles cancel automatic return"

## Not ours
- Parsing the agent's screen, sign-in steps and tool actions — Activity pane (src/features/agents)
- The terminal pane, its keys and the screen registry — Terminal view (src/features/terminal)
- What a written line means to the backend and the approval channel — Terminal (electron/features/terminal)
- Reading transcripts into conversation records — Activity pane (electron/features/agents)
- Round completion and its notification — Completion
- The decision and review pages that reuse these cards — home (src/features/home)
- File previews — files (src/features/files)
