# Boundary: Completion

Decides from an agent's own records when a round is working, complete or interrupted, counting background workers and
their receipts, and keeps the in-memory list of prompts sent and not yet finished. Covers only the four files in Owns,
not the rest of electron/.

## Owns
- `electron/completion-work.cjs`
- `electron/completion-history.cjs`
- `electron/prompt-queue.cjs`
- `electron/codex-activity.cjs`

## Interface
- `CompletionWork` (`electron/completion-work.cjs`) — outstanding background work per terminal; the round state main publishes
- `CompletionHistory` (`electron/completion-history.cjs`) — replays the transcript prefix before the display window to the completion counter
- `CodexActivityReader` (`electron/codex-activity.cjs`) — reads the bound interactive Codex rollout into turn snapshots
- `monitorActivity` (`electron/codex-activity.cjs`) — one-read-at-a-time poller with an optional file watch
- `PromptQueue` (`electron/prompt-queue.cjs`) — prompts sent and not yet finished, and the round's task title and summary
- `promptText` (`electron/prompt-queue.cjs`) — a record's human prompt, or null for machine and bookkeeping messages
- `promptSummary` (`electron/prompt-queue.cjs`) — the short task sentence for cards and spoken names
- `messageText` (`electron/prompt-queue.cjs`) — the text blocks of a message content
- `promptKey` (`electron/prompt-queue.cjs`) — the comparable form of a prompt
- `promptCommand` (`electron/prompt-queue.cjs`) — the slash command a prompt runs
- `ownMessage` (`electron/prompt-queue.cjs`) — messages the CLI writes as the user

## May import
- `electron/session-restore.cjs`
- `electron/session-files.cjs`
- `electron/transcript-window.cjs`
- `electron/oversized-record.cjs`
- `electron/terminal-title.cjs`

## Invariants
- Outstanding background work keeps the project working after the main round ends, while mainTurn still reports the main round as it ended — the card shows both, and only the project gate folds them — test: `tests/completion-work.test.cjs` › "pending work keeps the project working after main interruption without changing the main round"
- Persistent services (dev servers, watchers, follow-mode tails) never count as pending work — they never end, so the project would never complete — test: `tests/completion-work.test.cjs` › "Claude services never become pending work"
- In Codex only child agents hold completion; shells and yielded cells do not — they cannot wake an ended parent — test: `tests/completion-work.test.cjs` › "Codex shell sessions and yielded cells do not hold completion"
- Missing receipts fail closed: lost work ends as interrupted 12 hours after launch, and uncertain history is interrupted, never complete — a false complete is worse than a late one — test: `tests/completion-work.test.cjs` › "missing receipts and discarded history fail closed while partial history holds completion"
- A child agent's completion or a stale turn never completes the interactive parent — only the bound interactive rollout owns the card — test: `tests/codex-activity.test.cjs` › "a child completion and stale turn never complete the interactive parent"
- A turn that started before the read window stays unknown, whatever later records say — completion is never inferred from partial history — test: `tests/codex-activity.test.cjs` › "a turn started before the window stays unknown despite later activity and completion records"
- Injected and machine messages are never prompts, so they cannot start a round, replace the task or rearm an acknowledged completion — AGENTS.md: idle and background callbacks must not rearm completion — test: `tests/prompt-source.test.cjs` › "real main-process conversation callbacks ignore injections without rearming acknowledged completion"
- Completion only observes: it opens transcripts read-only, writes no file, starts no process, and keeps prompts in memory — it runs on every poll of the user's real sessions — test: `tests/boundary-completion.test.cjs` › "completion only observes"

## Not ours
- Arming, acknowledging and showing project completion and its notification — project state (`electron/state.cjs`, unowned) and `electron/main.cjs`
- Following an agent's tool steps for the activity pane — `electron/agent-actions.cjs` (unowned)
- Tailing Claude transcripts for the reading view — `electron/transcript-tail.cjs` (unowned)
- Finding rollout files and session metadata — `electron/session-files.cjs` (unowned)
- Matching a terminal title to its thread — Terminal (`sameThread` in `electron/terminal-title.cjs`)
- Showing rounds, prompts and workers — Activity pane
- Dispatched workers' events — Dispatch
