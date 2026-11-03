# Boundary: Native session view

The view of an agent session that runs without a terminal — Claude through the Agent SDK on the owner's API key, Codex through its app-server — drawn from the structured events the main process publishes: the conversation, the steps, the requests waiting on the owner, the message box, and the notice when Claude's session moves to the terminal.

The events' envelope and types are contract §1 (`src/shared/agent-events.ts`). Item `content`, request and plan payloads are read tolerantly by `native-model.ts` and `native-words.ts` (the field names each one reads are listed at the top of those files), and a field that is absent stays absent.

## Owns
- `src/features/native-session/**`

## Interface
- `NativeSessionView` (`src/features/native-session/NativeSessionView.tsx`) — the view of one terminal's session, or nothing when there is none; the file also exports `NativeSession`, the view once the session is known; the grid cell renders it
- `NativePathNote` (`src/features/native-session/NativePathNote.tsx`) — the notice over a card whose Claude session moved to the terminal, with its reason and unsent text available to copy without submission
- `useNativeEntries` (`src/features/native-session/native-store.ts`) — every terminal's session as the window knows it; the file also exports `ensureNativeSession`, `refreshNativeSession`, `nativeShown`, `terminalSwitch`, `dismissNative`, `dismissNote`, `noteTerminalSwitch` and `useUsageRevision`
- `launchRoute` (`src/features/native-session/native-bridge.ts`) — whether a new Claude or Codex session starts native, in the terminal or not at all, from the settings and whether a key is saved; the file also exports `nativeBridge`, the one reader of `window.agentrix.nativeSession`, and the bridge's types
- `receiptWord` (`src/features/native-session/native-words.ts`) — how receipts, states, routes, money and quota windows read; the file also exports `money`, `clockWords`, `windowWords`, `reasonWords` and `routeWord`

## May import
- `src/shared/**`
- `src/features/reading/ReadingView.tsx`
- `src/features/agents/AgentBrandIcon.ts`

## Invariants
- Events are subscribed before a snapshot is asked for; the events that arrive meanwhile are folded on top of it, a sequence at or below the last is a repeat, and a gap or an unknown session or connection epoch asks for one new snapshot — a view built on a partial stream shows a conversation that never happened — test: `tests/native-session-ui.test.cjs` › "the window subscribes first and asks for a snapshot after"
- A field no event carries stays null and is shown as 未知, never as zero or a guess, and a thinking step with no summary shows nothing — an invented value hides what the provider really said — test: `tests/native-session-ui.test.cjs` › "words: receipts, routes, money and quota windows"
- A request waits for the owner: nothing is allowed by itself, the card shuts while its answer goes and opens again with the reason if refused, and an ended session has none — approval is the owner's click — test: `tests/native-session-ui.test.cjs` › "a request is allowed once or denied by the owner’s click only"
- A secret answer lives only in the card's fields until it is sent, and the view logs and stores nothing — a key typed into a question must not outlive the question — test: `tests/native-session-ui.test.cjs` › "questions are answered one by one with options, your own words or a secret"
- The message box stays usable while the agent works; what is sent shows as sent until the runtime echoes it, a refusal brings the words back, and an ended session takes none — the owner's words are neither lost nor sent twice — test: `tests/native-session-ui.test.cjs` › "Enter sends the trimmed message at once"
- A replayed event shows in the conversation but is never news: it does not refresh the usage panel, and the view raises no notice or completion of its own — completion belongs to main, once per real round (AGENTS.md) — test: `tests/native-session-ui.test.cjs` › "a replayed event never counts as news for the usage panel"
- The view writes to no terminal, reads the bridge only through `native-bridge.ts` and has no way to expand a project: typing, selecting and copying in a small card only select its split (AGENTS.md) — test: `tests/native-session-ui.test.cjs` › "the native view writes to no terminal, never expands a project"
- The launcher starts a native session only by the settings: without the bridge or the settings it starts the terminal as before, a missing key under "API, then terminal" starts the terminal with its reason and under "API only" starts nothing, and a session moved to the terminal gives its cell to the terminal's reading view; unsent text stays available for copying and is never submitted by recovery — test: `tests/native-session-ui.test.cjs` › "the launcher starts a native session or a terminal by the settings"; test: `tests/native-session-ui.test.cjs` › "terminal fallback exposes unsent text for copying without submitting it or claiming delivery"

## Not ours
- Starting, resuming, stopping and answering a session, the API key, the settings store and the usage ledger — main (`electron/features/native-session`, `claude-sdk`, `codex-app-server`)
- The event envelope and types — `src/shared/agent-events.ts`
- The terminal reading view and its composer — Reading view; the terminal pane and the grid — Terminal view
- The activity pane's usage card — Activity pane (`src/features/agents/ApiUsage.tsx`); the settings page — Settings (`src/features/settings/AgentRuntimeSettings.tsx`)
- Round completion and its notification — Completion
