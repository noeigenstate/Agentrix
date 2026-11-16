# Boundary: Sub-agent view

A sub-agent's split beside a terminal's conversation: who it is, its state, speed and time, its conversation followed live (read-only), and the owner's word for it —
a message composer with Send and Stop that go through the main process, with delivery receipts from the worker. It also hands the left bar the called models of the whole project
as a ready node and a running count (`AgentSidebar`), so the files module never imports the agents module.

## Owns
- `src/features/agents/SubagentPane.tsx`
- `src/features/agents/SubagentInput.tsx` and `subagent-input.css`
- `src/features/agents/SubagentChip.tsx` and `subagent-chip.css`
- `src/features/agents/AgentSidebar.tsx`
- `src/features/agents/BackgroundBadge.tsx` (the 「后台 N 个运行中」 badge)
- `src/features/agents/BackgroundPane.tsx` (a background task's read-only view)
- `src/features/agents/WorkerTerminal.tsx` (a waiting worker's own terminal, in its split)

## Interface
- `SubagentPane` (`src/features/agents/SubagentPane.tsx`) — one view of one sub-agent call; the terminal grid renders one per open view; the file re-exports `BackgroundPane` (`src/features/agents/BackgroundPane.tsx`), a background task's read-only view, for the same slot
- `SubagentChip` (`src/features/agents/SubagentChip.tsx`) — the header chip and popover that list the called models where a narrow window hides the activity pane (and the left bar is collapsed); the project header renders it
- `AgentSidebar` (`src/features/agents/AgentSidebar.tsx`) — the called models of every terminal of the project as a ready node, how many are running and how many background commands run, for the left bar's Agent tab; the app renders it around the files module
- `BackgroundBadge` (`src/features/agents/BackgroundBadge.tsx`) — 「后台 N 个运行中」 for a project's terminals; the project header (the small card's too) renders it

## May import
- `src/shared/**`
- `src/features/agents/AgentCalls.tsx`
- `src/features/agents/AgentBrandIcon.ts`
- `src/features/agents/subagent-splits.ts`
- `src/features/native-session/native-words.ts` (delivery receipt words)
- `src/features/reading/ConversationFeed.tsx`
- `src/features/terminal/terminal-theme.ts` (the worker xterm's colours)
- `src/features/terminal/terminal-font.ts` (its font)
- `src/features/terminal/terminal-fit.ts` (its fit to the split)

## Invariants
- Keys leave this module only from `WorkerTerminal`, the open split of a dispatched worker, and go only to that worker's own terminal (`workerTerminalKeys` with its epoch), only while its feed says `awaiting: 'owner'` (the view is mounted for that time alone) and never to the planner's terminal; Escape inside it is the CLI's key (the split stays open, focus stays) and typing, selecting and copying there never expand a project. The clipboard is written only by `WorkerTerminal`, for an explicit copy of a selection (Ctrl+C with one, Ctrl+Shift+C, ⌘C); it is never read (paste is xterm's own paste event). Everything else here (SubagentPane, SubagentInput, BackgroundPane) writes no terminal input and no clipboard: the owner's word leaves only through `interveneAgent` and `stopAgent`, direct to the worker — test: `tests/boundary-activity-pane.test.cjs` › "a sub-agent view opens only on the owner’s click on a row, reads the sub-agent’s record and speaks to it through the main process only"; test: `tests/subagent-pane.test.cjs` › "a worker waiting for the owner shows its terminal in the split; keys reach only that terminal; Esc reaches the CLI and keeps the split open"
- The Agent tab lists every terminal of the project, not the terminal in use: calls grouped by model, each row marked 终端 N when the project has several and keeping its own (terminal, call) for the one split it opens; a `starting` call reads 启动中 · 未确认 and, once main says `notice: 'unconfirmed'`, offers 停止 (`stopAgent`, disabled while sent, a refusal said in words) and 再等等, only for a call still `starting`; a row's terminal is that terminal's own title; finished calls and commands fold into 「最近完成 N 个」 whether or not main has hidden them (the last 10, none older than 30 minutes), and the quiet empty sentence shows only when nothing at all is listed and a running command of `agentUsage.background` is a row of the 「后台任务」 group whose split is read-only (tail, no word, no stop); the chip lists these same rows (`CallsCard`, so a row is the one button that toggles a view) and calls no store function itself, exists only for a project with a viewable sub-agent or a background task and opens or closes only on the owner's click, never expanding a project; a live call main has hidden (`item.hidden`) is not listed while its view is closed, and an open view keeps its call; 「后台 N 个运行中」 shows on the project header (the small card's too) and the Agent tab, never inside the reading view — a terminal-only list, a second path that opened views, or a click that fell through to the card, would hide a worker or break "opens only on the owner's click" — test: `tests/agent-tab-rows.test.cjs` › "Claude workers from every project terminal remain visible across terminal selection"; test: `tests/agent-tab-rows.test.cjs` › "background tasks are listed with their terminal and age, and 后台 N 个运行中 shows outside the reading view"; test: `tests/subagent-pane.test.cjs` › "the narrow window's header chip"; test: `tests/agent-calls-hidden.test.cjs` › "a hidden call is listed only while its view is open; a model with no call left has no head; the +N counts what is listed; no call at all shows the empty line"
- A finished or lost view takes no word: the box is off and says why in its own hint, 停下 is not shown, and a send that gets through is dropped — the agent can no longer act on it — test: `tests/subagent-pane.test.cjs` › "a finished or lost view takes no word: the box is off and says why in its hint, 停下 is gone, and a keypress that gets through still sends nothing"
- An in-session sub-agent (`agent:`) has no direct channel and its split shows only a grey explanation with no message box; a dispatched worker (`dispatch:`) keeps its message box — test: `tests/subagent-pane.test.cjs` › "a sub-agent of the session shows a grey line instead of a message box; a dispatched worker shows the box as before"
- A word is sent trimmed on Enter (Shift+Enter is a new line, an IME composition sends nothing) and shows under the conversation as queued only after main accepted it; a refusal shows beside the box and keeps the text — owner messages keep the owner avatar and name, including while queued; only main-confirmed owner clientMessageId retires an echo, never matching brief text. A helper resume envelope keeps its planner sender while the admitted owner controls are separate messages; the owner must not believe a word was passed on when it was not — test: `tests/subagent-pane.test.cjs` › "Enter sends the trimmed word; Shift+Enter, an empty box and an IME composition send nothing; a sent word clears the box and is handed on"
- There is no planner relay sender or mounted renderer listener; interventions use worker controls and return receipts — test: `tests/native-session-ui.test.cjs` › "interventions have no planner relay sender or mounted renderer listener"
- A view follows its call's feed only, re-reading when main reports a newer revision for that very call, with one read in flight — another call's change must not redraw it — test: `tests/subagent-pane.test.cjs` › "a feed is read at once and again only when the main process reports a newer revision for this very call"
- The left bar (the files module) imports nothing from agents: its Agent tab takes the called models as a ready node and a running count that the app gets from `AgentSidebar`, and switching to Agent, like to any tab, takes the file-tree focus away while a hidden tree loads nothing — a file view that knew the call list would bind two modules, and a tab switch that left the tree focused would keep it grabbing keys — test: `tests/boundary-activity-pane.test.cjs` › "the files module imports nothing from the agents module: the Agent tab gets its list as a node and a count from the app"

## Not ours
- Which views are open and the call rows that open them — Activity pane (`subagent-splits.ts`, `AgentCalls.tsx`)
- Where a view sits in the grid — Terminal view (`ProjectTerminals.tsx`)
- Interventions, direct worker controls and the sub-agent feed in the main process — Activity pane (`electron/features/agents`)
- The conversation renderer — Reading view (`ConversationFeed`)
