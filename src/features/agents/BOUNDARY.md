# Boundary: Sub-agent view

A sub-agent's split beside a terminal's conversation: who it is, its state, speed and time, its conversation followed live (read-only), and the owner's word for it —
a text box and 停下 that go to the main process, never to a terminal — plus the relay that carries such a word to the planner's own terminal when main asks.

## Owns
- `src/features/agents/SubagentPane.tsx`
- `src/features/agents/SubagentInput.tsx`
- `src/features/agents/SubagentChip.tsx` and `subagent-chip.css`
- `src/features/agents/parent-relay.ts`

## Interface
- `SubagentPane` (`src/features/agents/SubagentPane.tsx`) — one view of one sub-agent call; the terminal grid renders one per open view
- `SubagentChip` (`src/features/agents/SubagentChip.tsx`) — the header chip and popover that list the called models where a narrow window hides the activity pane; the project header renders it
- `startParentRelay` (`src/features/agents/parent-relay.ts`) — starts listening for the planner relays main sends; returns the stop function; App mounts it once

## May import
- `src/shared/**`
- `src/features/agents/ActivityPane.tsx`
- `src/features/agents/AgentBrandIcon.ts`
- `src/features/agents/subagent-splits.ts`
- `src/features/home/send-to-agent.ts`
- `src/features/reading/ConversationFeed.tsx`

## Invariants
- SubagentPane and SubagentInput never write terminal input, the clipboard or the screen; the owner's word leaves only through `interveneAgent` and `stopAgent`, and startParentRelay sends a main-requested message through sendToAgent with preserveDraft, refusing a draft, a dialog or a missing input and never clearing input — a stray write would land in the planner's terminal or erase the owner's draft — test: `tests/boundary-activity-pane.test.cjs` › "a sub-agent view opens only on the owner’s click on a row, reads the sub-agent’s record and speaks to it through the main process only"; test: `tests/parent-relay.test.cjs` › "each relay is sent to its terminal the normal way and the outcome goes back by id: null for sent, the text for an error"
- The chip lists the pane's own rows (`CallsCard`, so a row is the one button that toggles a view) and calls no store function itself; it exists only for a terminal with a viewable sub-agent and opens or closes only on the owner's click, never expanding a project — a second path that opened views, or a click that fell through to the card, would break "opens only on the owner's click" — test: `tests/subagent-pane.test.cjs` › "the narrow window's header chip"
- A finished or lost view takes no word: the box is off and says why in its own hint, 停下 is not shown, and a send that gets through is dropped — the agent can no longer act on it — test: `tests/subagent-pane.test.cjs` › "a finished or lost view takes no word: the box is off and says why in its hint, 停下 is gone, and a keypress that gets through still sends nothing"
- A word is sent trimmed on Enter (Shift+Enter is a new line, an IME composition sends nothing) and shows under the conversation as queued only after main accepted it; a refusal shows beside the box and keeps the text — the owner must not believe a word was passed on when it was not — test: `tests/subagent-pane.test.cjs` › "Enter sends the trimmed word; Shift+Enter, an empty box and an IME composition send nothing; a sent word clears the box and is handed on"
- Every relay main sends is answered once by its id, null when sent and the error text otherwise, including a send that throws — main waits for that answer — test: `tests/parent-relay.test.cjs` › "a send that throws is an error for main, never a missing answer, and stopping lets go of the listener"
- A view follows its call's feed only, re-reading when main reports a newer revision for that very call, with one read in flight — another call's change must not redraw it — test: `tests/subagent-pane.test.cjs` › "a feed is read at once and again only when the main process reports a newer revision for this very call"

## Not ours
- Which views are open and the call rows that open them — Activity pane (`subagent-splits.ts`, `ActivityPane.tsx`)
- Where a view sits in the grid — Terminal view (`ProjectTerminals.tsx`)
- Interventions, relays and the sub-agent feed in the main process — Activity pane (`electron/features/agents`)
- The conversation renderer — Reading view (`ConversationFeed`)
