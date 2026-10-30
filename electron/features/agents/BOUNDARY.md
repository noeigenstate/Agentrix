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
- `electron/reading-history*.cjs`

## Interface
- `ActivityPane` (`src/features/agents/ActivityPane.tsx`) — the pane; rendered by the workspace's ProjectPanel from a `ProjectTerminal`
- `actionText` (`src/features/agents/action-text.ts`) — the words for the agent's current step (with `stepVerb`), shared by the reading view and the decision inbox
- `UsageMeter` (`electron/features/agents/agent-usage.cjs`) — per-session meter main.cjs feeds records to and publishes as `agentUsage` (with `claudeProvider`, `codexProvider`, `claudeAccount`, `claudeAccountFiles`)
- `agentSettings` (`electron/features/agents/agent-settings.cjs`) — model, effort and fast mode from an agent's own records; used by main.cjs and the dispatch helper
- `TokenRates` (`electron/features/agents/token-rate.cjs`) — output tokens over response time; the one rate calculation, also the dispatch helper's
- `CodexAccountUsage` (`electron/features/agents/codex-account-usage.cjs`) — the read-only Codex plan-limit and reset-count client; main.cjs uses `openProject`/`closeProject` for private, serialized project-check lifetimes and a polling `watch` per active Codex session, sharing a verified account scope
- `ClaudeAccountUsage` (`electron/features/agents/claude-account-usage.cjs`) — the read-only Claude plan-limit poller (with `readClaudeAccount`)
- `dispatch` (`electron/features/agents/agent-calls.cjs`) — `AgentCalls.dispatch(event)`, reached as `session.usage.calls.dispatch` with authenticated events; retains evaluation metadata and invokes the injected finished hook once per accepted end
- `ReadingHistory` (`electron/reading-history.cjs`) — validates restored local transcript identities, prepares the latest page and serves `terminal:conversationPage(id, { key, cursor })` through agents IPC; `beforeCursor` alone indicates earlier history

## May import
- `src/shared/**`
- `src/features/agents/AgentBrandIcon.ts`
- `src/features/terminal/terminal-screen.ts`
- `src/features/home/send-to-agent.ts`
- `electron/agent-actions.cjs`
- `electron/prompt-queue.cjs`
- `electron/session-*.cjs`
- `electron/claude-sessions.cjs`
- `electron/conversation*` (the record parser and the shared grouping rule)
- `electron/oversized-record.cjs`
- `electron/features/dashboard/records-routing.cjs`

## Invariants
- Each model is shown from its own records: the main model is its latest reply's (configured only until the first reply), its rows are the user's prompts and its own steps, never another worker's or a prompt's model; a called model's effort and speed are its own recorded values, unknown (null) when absent, never taken from the parent, configuration or dispatch declaration — guessed routing hides which model really ran — test: `tests/activity-route.test.cjs` › "the main model section: the model its latest reply records"; test: `tests/agent-calls.test.cjs` › "Claude Agent calls keep their own effort and leave unrecorded effort and speed unknown"
- A token rate is output tokens over the time the model's responses took, from the agent's own records; tool waits and process time never count, and missing or backward timing gives no rate — one honest number shared with the dispatch helper's end line — test: `tests/agent-usage-rate.test.cjs` › "Claude rejects missing identities, models, usage, zero/backward intervals and unknown ancestry"; token-rate.cjs and agent-settings.cjs stay usable in the plain-Node dispatch helper with only Node built-ins and helper runtime files — test: `tests/boundary-dispatch.test.cjs` › "the helper's runtime modules require only Node built-ins and each other"
- Unknown is never shown as zero: an unknown reset count, context window or total stays unknown (尚未查询, 未提供次数, 次数未知, —) — zero means none left, and the owner acts on it — test: `tests/reset-count.test.cjs` › "unknown is never zero"
- Official Codex scopes use home/cwd and a process-keyed HMAC of account, location and proxy environment variables: equivalent copies share reads, related differences isolate them, and credential values never enter keys or logs in plaintext. Project checks prove the default route by config preflight (`project-open-v1`), share the five-second throttle and backoff, retain only fresh answers for replay and drop closed-project late answers; startup queues them one at a time after restore and login PATH readiness, skipping last-used Claude projects — duplicate reads and another account's stale limits must not reach the pane — test: `tests/codex-account-usage.test.cjs` › "account fingerprints use a random runtime HMAC key"; test: `tests/codex-account-usage.test.cjs` › "project opens serialize background reads"; test: `tests/codex-account-usage.test.cjs` › "expired project answers never replay"; test: `tests/codex-account-usage.test.cjs` › "startup project checks follow restore"
- The pane shows state and never acts on its own: its one action types /usage into Codex after a cancellable 10-second countdown, account reads use only read-only calls (no reset, login or credential renewal), and it has no manual completion control or editor launch — a reset is costly and completion is automatic (AGENTS.md) — test: `tests/boundary-activity-pane.test.cjs` › "the pane never acts on its own"
- SSH projects never read local transcripts, child logs, prompts or rollouts — the local machine's files belong to another conversation — test: `tests/agent-calls-rate.test.cjs` › "SSH calls never read local child, prompt, log or rollout files"
- A dispatched worker that ended cleanly shows 已完成 and leaves 3 s later; an unconfirmed start groups under its declared model, shows 未能启动 and leaves after 5 s or an earlier review; other failures stay until the lead's next round. Dispatch receipts survive conversation resets and dismissed receipts reject delayed duplicates — failures must be visible without dropping terminal-owned runs or resurrecting stale rows — test: `tests/agent-calls.test.cjs` › "unconfirmed dispatches expire after five seconds without removing other failures or reviving duplicates"; test: `tests/dashboard-records.test.cjs` › "run and grade hooks retain only local evaluation metadata"
- A reading cursor is an opaque main-owned capability for one terminal, verified transcript identity and binding generation; growth preserves it while rotation, truncation, boundary rewriting and rebinding reject it — a renderer cannot select another file or reuse another session's page — test: `tests/reading-history.test.cjs` › "a rewritten cursor boundary is rejected even when the same inode is regrown beyond its original size"

## Not ours
- Declaring, authenticating and validating dispatched workers — Dispatch (integration/dispatch.cjs, dispatch-events.cjs)
- Round completion, its notification and acknowledgment — Completion
- Parsing the agent's steps from transcripts and rollouts — electron/agent-actions.cjs
- Reading the CLI's screen (questions, choices, sign-in, resets said on screen) — Terminal's terminal-screen.ts and the agent-screen files
- How a model id is named for people — Reading view (model-name.ts)
- Typing text into the agent — Home (send-to-agent.ts)
- When the pane shows and project expansion — Workspace (ProjectPanel.tsx)
- Installing agents and the agents settings page — Settings (AgentsSettings.tsx, electron/agents.cjs)
