# Boundary: Activity pane

The pane beside an expanded project's terminal — the main model and its tasks, the models it called, context and usage — and the main-process readers that turn the agent's own records and account reads into that data.

## Owns
- `src/features/agents/ActivityPane.tsx`
- `src/features/agents/ResetCountdown.tsx`
- `src/features/agents/reset-count.ts`
- `src/features/agents/action-text.ts`
- `electron/features/agents/agent-calls.cjs`
- `electron/features/agents/agent-usage.cjs`
- `electron/features/agents/token-rate.cjs`
- `electron/features/agents/agent-settings.cjs`
- `electron/features/agents/claude-account-usage.cjs`
- `electron/features/agents/codex-account-usage.cjs`

## Interface
- `ActivityPane` (`src/features/agents/ActivityPane.tsx`) — the pane; rendered by the workspace's ProjectPanel from a `ProjectTerminal`
- `actionText` (`src/features/agents/action-text.ts`) — the words for the agent's current step (with `stepVerb`), shared by the reading view and the decision inbox
- `UsageMeter` (`electron/features/agents/agent-usage.cjs`) — per-session meter main.cjs feeds records to and publishes as `agentUsage` (with `claudeProvider`, `codexProvider`, `claudeAccount`, `claudeAccountFiles`)
- `agentSettings` (`electron/features/agents/agent-settings.cjs`) — model, effort and fast mode from an agent's own records; used by main.cjs and the dispatch helper
- `TokenRates` (`electron/features/agents/token-rate.cjs`) — output tokens over response time; the one rate calculation, also the dispatch helper's
- `CodexAccountUsage` (`electron/features/agents/codex-account-usage.cjs`) — the read-only Codex plan-limit and reset-count client; main.cjs owns a one-shot `check` per open local project and a polling `watch` per active Codex session, sharing a verified account scope
- `ClaudeAccountUsage` (`electron/features/agents/claude-account-usage.cjs`) — the read-only Claude plan-limit poller (with `readClaudeAccount`)
- `dispatch` (`electron/features/agents/agent-calls.cjs`) — `AgentCalls.dispatch(event)`, reached as `session.usage.calls.dispatch` with events Dispatch has already authenticated and validated

## May import
- `src/shared/**`
- `src/features/agents/AgentBrandIcon.ts`
- `src/features/reading/model-name.ts`
- `src/features/reading/useNow.ts`
- `src/features/terminal/terminal-screen.ts`
- `src/features/home/send-to-agent.ts`
- `electron/agent-actions.cjs`
- `electron/prompt-queue.cjs`

## Invariants
- Each model is shown from its own records: the main model is its latest reply's (configured only until the first reply), its rows are the user's prompts and its own steps, never another worker's or a prompt's model; a called model's effort and speed are its own recorded values, unknown (null) when absent, never taken from the parent, configuration or dispatch declaration — guessed routing hides which model really ran — test: `tests/activity-route.test.cjs` › "the main model section: the model its latest reply records"; test: `tests/agent-calls.test.cjs` › "Claude Agent calls keep their own effort and leave unrecorded effort and speed unknown"
- A token rate is output tokens over the time the model's responses took, from the agent's own records; tool waits and process time never count, and missing or backward timing gives no rate — one honest number shared with the dispatch helper's end line — test: `tests/agent-usage-rate.test.cjs` › "Claude rejects missing identities, models, usage, zero/backward intervals and unknown ancestry"
- Unknown is never shown as zero: an unknown reset count, context window or total stays unknown (尚未查询, 未提供次数, 次数未知, —) — zero means none left, and the owner acts on it — test: `tests/reset-count.test.cjs` › "unknown is never zero"
- Official Codex account scopes use home/cwd and an internal fingerprint of account, location and proxy environment variables: equivalent copies share reads, related differences isolate them, and credential values never enter keys or logs in plaintext. A local project-open check proves the default route by config preflight (`project-open-v1`), never invented session metadata; it shares the five-second throttle and backoff with a matching session, retains its answer for handover and drops closed-project late answers — duplicate reads and another scope's count must not reach the pane — test: `tests/codex-account-usage.test.cjs` › "account environment fingerprints share terminal copies"; test: `tests/codex-account-usage.test.cjs` › "project open, reopen and a concurrent session share one read"; test: `tests/codex-account-usage.test.cjs` › "closing a project drops its late answer"
- The pane shows state and never acts on its own: its one action types /usage into Codex after a cancellable 10-second countdown, account reads use only read-only calls (no reset, login or credential renewal), and it has no manual completion control or editor launch — a reset is costly and completion is automatic (AGENTS.md) — test: `tests/boundary-activity-pane.test.cjs` › "the pane never acts on its own"
- SSH projects never read local transcripts, child logs, prompts or rollouts — the local machine's files belong to another conversation — test: `tests/agent-calls-rate.test.cjs` › "SSH calls never read local child, prompt, log or rollout files"
- A dispatched worker that ended cleanly shows 已完成 and leaves 3 s later; every other end stays until the lead's next round — a failed worker must not be missed — test: `tests/dispatch-events.test.cjs` › "failures survive the launch Stop and leave on the next delivered notification plus Stop or user round"
- token-rate.cjs and agent-settings.cjs also run in the plain-Node dispatch helper (packaged and over SSH): they require only Node built-ins and the helper's other runtime files — a new require here breaks every packaged and remote dispatch — test: `tests/boundary-dispatch.test.cjs` › "the helper's runtime modules require only Node built-ins and each other"

## Not ours
- Declaring, authenticating and validating dispatched workers — Dispatch (integration/dispatch.cjs, dispatch-events.cjs)
- Round completion, its notification and acknowledgment — Completion
- Parsing the agent's steps from transcripts and rollouts — electron/agent-actions.cjs
- Reading the CLI's screen (questions, choices, sign-in, resets said on screen) — Terminal's terminal-screen.ts and the agent-screen files
- How a model id is named for people — Reading view (model-name.ts)
- Typing text into the agent — Home (send-to-agent.ts)
- When the pane shows and project expansion — Workspace (ProjectPanel.tsx)
- Installing agents and the agents settings page — Settings (AgentsSettings.tsx, electron/agents.cjs)
