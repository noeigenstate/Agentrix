# Boundary: Sub-agent view

A sub-agent's split beside a terminal's conversation: who it is, its state, speed and time, its conversation followed live (read-only), and the owner's word for it —
a text box and 停下 that go to the main process, never to a terminal — plus the relay that carries such a word to the planner's own terminal when main asks.

## Owns
- `src/features/agents/SubagentPane.tsx`
- `src/features/agents/SubagentInput.tsx`
- `src/features/agents/parent-relay.ts`

## Interface
- `SubagentPane` (`src/features/agents/SubagentPane.tsx`) — one view of one sub-agent call; the terminal grid renders one per open view
- `startParentRelay` (`src/features/agents/parent-relay.ts`) — starts listening for the planner relays main sends; returns the stop function; App mounts it once

## May import
- `src/shared/**`
- `src/features/agents/ActivityPane.tsx`
- `src/features/agents/AgentBrandIcon.ts`
- `src/features/agents/subagent-splits.ts`
- `src/features/home/send-to-agent.ts`
- `src/features/reading/ConversationFeed.tsx`

## Invariants
- The conversation is read-only and nothing here writes to a terminal, the clipboard or the screen; the owner's word leaves only through `interveneAgent` and `stopAgent` — a sub-agent has no terminal of its own, and a stray write would land in the planner's — test: `tests/boundary-activity-pane.test.cjs` › "a sub-agent view opens only on the owner’s click on a row, reads the sub-agent’s record and speaks to it through the main process only"
- A finished or lost view takes no word: the box and 停下 are off and a send that gets through is dropped — the agent can no longer act on it — test: `tests/subagent-pane.test.cjs` › "a finished or lost view takes no word: box and button are off, a note says why, and a keypress that gets through still sends nothing"
- A word is sent trimmed on Enter (Shift+Enter is a new line, an IME composition sends nothing) and shows under the conversation as queued only after main accepted it; a refusal shows beside the box and keeps the text — the owner must not believe a word was passed on when it was not — test: `tests/subagent-pane.test.cjs` › "Enter sends the trimmed word; Shift+Enter, an empty box and an IME composition send nothing; a sent word clears the box and is handed on"
- Every relay main sends is answered once by its id, null when sent and the error text otherwise, including a send that throws — main waits for that answer — test: `tests/parent-relay.test.cjs` › "a send that throws is an error for main, never a missing answer, and stopping lets go of the listener"
- A view follows its call's feed only, re-reading when main reports a newer revision for that very call, with one read in flight — another call's change must not redraw it — test: `tests/subagent-pane.test.cjs` › "a feed is read at once and again only when the main process reports a newer revision for this very call"

## Not ours
- Which views are open and the call rows that open them — Activity pane (`subagent-splits.ts`, `ActivityPane.tsx`)
- Where a view sits in the grid — Terminal view (`ProjectTerminals.tsx`)
- Interventions, relays and the sub-agent feed in the main process — Activity pane (`electron/features/agents`)
- The conversation renderer — Reading view (`ConversationFeed`)
