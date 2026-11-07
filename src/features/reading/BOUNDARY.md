# Boundary: Reading view

The document view of an agent terminal: the conversation as a timeline, the composer that types into the CLI, the
terminal popup every confirmation, question, menu and slash command is answered in (no option cards), the result card of
the latest round, and the switch between reading and the raw terminal.

## Owns
- `src/features/reading/**`

## Interface
- `ReadingView` (`src/features/reading/ReadingView.tsx`) — the reading view of one agent terminal; the file also exports Markdown, the renderer the review card and skill pane reuse
- `ModeSwitch` (`src/features/reading/ModeSwitch.tsx`) — the title bar's reading / terminal switch for the terminal in use
- `setReading` (`src/features/reading/reading-mode.ts`) — reading or raw terminal per terminal; the file also exports readingShown, syncReading and useTerminalChoice
- `hasCliInput` (`src/features/reading/cli-panel.ts`) — what the CLI's input line holds; the file also exports isAtPrompt, cliInputDraft and isCliIdle
- `sameMessage` (`src/features/reading/pending-prompts.ts`) — whether a sent message is the one still in the CLI input
- `lastRound` (`src/features/reading/result-round.ts`) — the latest round of a conversation; the file also exports CHECKS and changeLabel
- `ConversationFeed` (`src/features/reading/ConversationFeed.tsx`) — grouped read-only messages and tool steps, independent of composer and terminal state; the reading view, the sub-agent split and a session without a terminal render with it; the file also exports `ConversationDecorations`, the slots the interactive reader fills; user-side messages use main-owned sender metadata (owner or planner), with an unknown planner shown neutrally
- `TimelineStep` (`src/features/reading/feed-parts.ts`) — the parts around a feed that a view without a terminal draws the way the reading view does: timeline steps, pending messages, the working line, the result row, picture chips (and `pastedPicture`, the picture a paste carries), the scroll that follows the newest step and the message box's helpers: `useComposerHistory` (↑↓ through what was sent), `useCommandPalette` with `commandList` and `composerAria` (the "/" list), `useMentions` and `MentionPalette` ("@" files), and `createDictationSend` (the cancellable half-second dictation submit shared with the native composer)
- `QuoteChip` (`src/features/reading/ReadingQuote.tsx`) — the 引用 button on a message (`QuoteAction`) and the one quote chip above the composer; `message-quote.ts` exports quoteExcerpt, withQuote and splitQuote; ConversationFeed offers the button only when its parent supplies quote decorations (the sub-agent split supplies none)
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
- `src/features/voice/VoiceButton.tsx`
- `src/features/terminal/terminal-*.ts`
- `src/features/terminal/active-terminal.ts`

## Invariants
- A live composer stays editable during work, dialogs and unknown output; versioned host CLI state controls status, and a newer observed state from the same PTY may supplement it; positive waiting evidence opens the terminal once and messages queue FIFO until input returns, while an idle frame clears stale waiting immediately and opening while the owner edits never focuses xterm — an ordinary message's Enter must never answer a dialog — test: `tests/reading-popup-coverage.test.cjs` › "busy output and a transient redraw do not open a dialog, and returning to input cancels the timer"; "an inactive dialog opens when activated; dismissal and redraw do not rearm it"
- For terminal sessions, no option card exists in the reading view: screen choices, questions and native requests are answered only in the terminal, and no key is written on the owner's behalf — terminal-session confirmations belong to the terminal; structured native sessions have their own view — test: `tests/native-question-ui.test.cjs` › "question and form cards and managed Claude UI are removed"
- Session changes (A to B to A) and unmounting invalidate picture callbacks; split changes and popup close cancel delayed keys but preserve staged pictures; SSH sends await reserved uploads in paste order, and removal prevents late revival — test: `tests/reading-ui.test.cjs` › "session A to B to A, terminal selection and unmount cancel every delayed command key"; "a staged picture survives"; "SSH Send waits for pending uploads and keeps their paste order"; "removing a pending SSH picture prevents a late upload from reviving it"
- A queued message is never resent, and stalled text sends retry a bounded number of times; local pictures require a newly staged native chip and an image-bearing transcript receipt, with uncertain delivery left visible and never retried as text — test: `tests/reading-ui.test.cjs` › "unrelated user records cannot discard a stalled prompt; retries stay bounded and queued prompts never resend"; "an unaccepted picture stays in the composer instead of sending a false image echo"; "a matching text receipt cannot acknowledge missing pictures, and a later image update can"
- Editing keys are sent only for what the CLI's screen shows unambiguously, never guessed from prose — a guessed key edits the wrong text — test: `tests/reading-ui.test.cjs` › "ambiguous prose on both sides of an image never causes guessed editing keystrokes"
- Interactive reading requires an active agent in a live terminal; an identity-checked restored history may show read-only until its CLI draws input, and a different thread invalidates readiness; input temporarily outside the viewport delays delivery and keeps the composer editable, and a page capability alone never cancels a send — test: `tests/reading-ui.test.cjs` › "a restored preview cannot send until its own CLI input is ready, and a different thread disables it again"; test: `tests/reading-ui.test.cjs` › "reading view requires an active agent and a live terminal session"
- A waiting notice hands the reader to the terminal at most once, and a manual switch cancels the automatic return — a handoff must not be rearmed by later screen updates — test: `tests/reading-ui.test.cjs` › "one automatic handoff per notice and manual toggles cancel automatic return"
- A quote is one bounded `> ` block (at most 6 lines and 400 characters, a quote inside the quoted message stripped first) put before the words of the owner's next ordinary message only; a slash command or shell line keeps it for the next message, a resend adds none, and a failed send returns it while no newer quote was picked — quotes never nest and a command is never altered — test: `tests/reading-ui.test.cjs` › "a command is typed as it is and keeps the quote for the next message"; test: `tests/reading-quote.test.cjs` › "quoting a message that carries a quote takes its words only, so quotes never nest"

## Not ours
- Parsing the agent's screen, sign-in steps and tool actions — Activity pane (src/features/agents)
- The terminal pane, its keys and the screen registry — Terminal view (src/features/terminal)
- What a written line means to the backend and the approval channel — Terminal (electron/features/terminal)
- Reading transcripts into conversation records — Activity pane (electron/features/agents)
- Round completion and its notification — Completion
- The decision and review pages that reuse these cards — home (src/features/home)
- File previews — files (src/features/files)
