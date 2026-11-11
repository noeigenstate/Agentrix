# Boundary: Activity pane

The pane beside an expanded project's terminal — the main model and its tasks, and each agent's run mode and allowance (connection, context, limits, spend, tokens) — the models the agent called, which the left bar's Agent tab lists, and the main-process readers that turn the agent's own records and account reads into that data.

## Owns
- `src/features/agents/ActivityPane.tsx`
- `src/features/agents/ApiUsage.tsx` (per agent: connection, context, limits, API spend and budget)
- `src/features/agents/AgentCalls.tsx` (the called models' list and its rows, with the state words and the rate column)
- `src/features/agents/Metric.tsx` (the one bar and the figures both blocks share)
- `src/features/agents/ResetQuota.tsx` (the limit-reset row and its countdown)
- `src/features/agents/ResetCountdown.tsx`
- `src/features/agents/reset-count.ts`
- `src/features/agents/action-text.ts`
- `src/features/agents/subagent-splits.ts`
- `electron/features/agents/agent-calls.cjs`
- `electron/features/agents/agent-usage.cjs`
- `electron/features/agents/usage-observation.cjs`
- `electron/features/agents/subagent-feed.cjs`
- `electron/features/agents/interventions.cjs`
- `electron/features/agents/token-rate.cjs`
- `electron/features/agents/agent-settings.cjs`
- `electron/features/agents/claude-account-usage.cjs`
- `electron/features/agents/codex-account-usage.cjs`
- `electron/reading-history*.cjs`

## Interface
- `ActivityPane` (`src/features/agents/ActivityPane.tsx`) — the pane: the main model and the allowance block, rendered by the workspace's ProjectPanel from a `ProjectTerminal` and the project id; the file also exports elapsedClock, which the sub-agent view reuses
- `CallsCard` (`src/features/agents/AgentCalls.tsx`) — the called models as rows of two lines whose buttons open a sub-agent view; the left bar's Agent tab and the narrow window's popover list it; the file also exports CALL_STATES, failureWord, rateValue and callModelName, which the sub-agent view reuses The app reaches it through `AgentSidebar.tsx` (a render prop beside it, owned by no boundary) so the files module need not know the agents module.
- `useSplits` (`src/features/agents/subagent-splits.ts`) — the sub-agent views the owner opened beside a terminal (transient, one per terminal: opening another replaces it); the file also exports splitsOf and closeSplit
- `actionText` (`src/features/agents/action-text.ts`) — the words for the agent's current step (with `stepVerb`), shared by the reading view and the decision inbox
- `UsageMeter` (`electron/features/agents/agent-usage.cjs`) — per-session meter main.cjs feeds records to and publishes as `agentUsage` (with `claudeProvider`, `codexProvider`, `claudeAccount`, `claudeAccountFiles`); also exposes retainConnection, retainAccount, retainLimits, accountChanged and quotaRead for retaining dated observations through transient reads and invalidating old quota on an observed account change; a connection that names no account never replaces one of the same kind that does
- `agentSettings` (`electron/features/agents/agent-settings.cjs`) — model, effort and fast mode from an agent's own records; used by main.cjs and the dispatch helper
- `TokenRates` (`electron/features/agents/token-rate.cjs`) — output tokens over response time; the one rate calculation, also the dispatch helper's. Native runtimes feed `nativeClaude` / `nativeCodex` root stream counters and explicit prompt/tool boundaries; live counters replace a response sample, never add its blocks or child usage, and idle retains completed samples — test: `tests/native-rate.test.cjs`; real stream shapes: `tests/native-rate-real-cli.test.cjs`
- `CodexAccountUsage` (`electron/features/agents/codex-account-usage.cjs`) — read-only plan-limit/reset-count polling; `resetAtLimit` separately admits an owner-only reset after a usage limit, deduplicates by backend account and persists cooldown before consuming; every watcher keeps the last dated observation through loading and failed reads (a session's only what it was itself given, the pane's focused reads one that outlives them, until `releaseCache(key)` for a removed project's scope), and `accountScopeId` gives an account/read account one opaque name for every reader
- `ClaudeAccountUsage` (`electron/features/agents/claude-account-usage.cjs`) — the read-only Claude plan-limit poller (with `readClaudeAccount`); SSH injects a sanitized remote read through features/ssh/claude-account.cjs
- `dispatch` (`electron/features/agents/agent-calls.cjs`) — `AgentCalls.dispatch(event)`, reached as `session.usage.calls.dispatch` with authenticated events; retains evaluation metadata and invokes the injected finished hook once per accepted end; `AgentCalls.feed(callId)` — serves `terminal:subagent-feed(terminalId, callId)`: a bounded read-only snapshot (newest 400 entries) of a sub-agent's or dispatched worker's conversation, pushed as `terminal:subagent-feed` events at most 4 per second; items carry stable `id` (`agent:<toolUseId>`, `dispatch:<id>`), `startedAt`, `endedAt` and `viewable`; `running()` feeds the dashboard's live strip
- `createInterventions` (`electron/features/agents/interventions.cjs`) — `{ resolve, pushControl, sendDirect }` → `interveneAgent` / `stopAgent` for `agents:intervene` / `agents:stop`; targets come only from main's own call bindings, the worker receives it directly through the dispatch control channel and the planner learns the receipt from the helper's status line, never through its own input
- `ReadingHistory` (`electron/reading-history.cjs`) — validates restored local transcript identities, prepares the latest page and serves `terminal:conversationPage(id, { key, cursor })` through agents IPC; `beforeCursor` alone indicates earlier history

## May import
- `src/shared/**`
- `src/features/agents/AgentBrandIcon.ts`
- `src/features/terminal/terminal-screen.ts`
- `src/features/home/send-to-agent.ts`
- `src/features/native-session/native-*.ts` (the bridge, store and words for usage and limits)
- `electron/agent-actions.cjs`
- `electron/prompt-queue.cjs`
- `electron/*session*.cjs` (the session helpers and claude-sessions)
- `electron/oversized-record.cjs`
- `electron/conversation*` (the record parser and the shared grouping rule)
- `electron/features/dashboard/records-routing.cjs`
- `electron/features/team/*.cjs` (the team folder and a run's owner inbox)

## Invariants
- Each model is shown from its own records: the main model is its latest reply's (configured only until the first reply), its rows are the user's prompts and its own steps, never another worker's or a prompt's model; a called model's effort and speed are its own recorded values, unknown (null) when absent, never taken from the parent, configuration or dispatch declaration — child user messages carry main-owned sender provenance: dispatch and in-process Agent prompts belong to the observed spawning model, owner intervention IDs alone prove the owner, unknown planner identity stays neutral and message text never classifies origin; replayed source facts and late facts affect presentation only; guessed routing hides which model really ran — test: `tests/activity-route.test.cjs` › "the main model section: the model its latest reply records"; test: `tests/agent-calls.test.cjs` › "Claude Agent calls keep their own effort and leave unrecorded effort and speed unknown"; a dispatched worker's model follows its reports, and until one arrives the row and view show the requested model marked 未确认 (模型未确认 without one), never the internal placeholder — test: `tests/activity-route.test.cjs` › "a dispatched worker that has not reported its model shows the requested one as unconfirmed"
- A token rate is output tokens over the time the model's responses took, from the agent's own records; tool waits and process time never count, and missing or backward timing gives no rate — one honest number shared with the dispatch helper's end line — test: `tests/agent-usage-rate.test.cjs` › "Claude rejects missing identities, models, usage, zero/backward intervals and unknown ancestry"; token-rate.cjs and agent-settings.cjs stay usable in the plain-Node dispatch helper with only Node built-ins and helper runtime files — test: `tests/boundary-dispatch.test.cjs` › "the helper's runtime modules require only Node built-ins and each other"
- Unknown is never shown as zero: an unknown reset count, context window or total stays unknown (尚未查询, 未提供次数, 次数未知, —). Transient account reads retain the last observed connection, allowance and observation time; an observed logout or opaque account-scope change invalidates old values, quota read for one account is never kept for or merged into another's, a read past the interval is the refresh it starts, and a reset timestamp alone never proves a quota reset — test: `tests/usage-observation.test.cjs`; `tests/activity-route.test.cjs`. Zero means none left, and the owner acts on it — test: `tests/reset-count.test.cjs` › "unknown is never zero"
- Official Codex scopes use home/cwd and a process-keyed HMAC of account, location and proxy environment variables: equivalent copies share reads, related differences isolate them, and credential values never enter keys or logs in plaintext. Focused pane reads prove the default route by config preflight (`project-open-v1`), share the five-second throttle, interval and backoff, retain only fresh answers and drop closed-project late answers; opening or restoring background projects never launches an account reader — test: `tests/codex-account-usage.test.cjs` › "account fingerprints use a random runtime HMAC key"; test: `tests/native-project-accounts.test.cjs` › "focused account reads share fresh cache, isolate projects, and never poll in the background"; test: `tests/codex-account-usage.test.cjs` › "opening and restoring background projects never starts account checks"
- The pane shows state and never acts on its own: its one action types /usage into Codex after a cancellable 10-second countdown; polling cannot reset, login or renew credentials. Only an owner usage-limit event and the enabled auto-reset setting admit the separate reset client, with account deduplication, post-reset confirmation and durable cooldown; no PTY write or second consume on an unconfirmed recovery — test: `tests/boundary-activity-pane.test.cjs` › "the pane never acts on its own"; test: `tests/codex-auto-reset.test.cjs` › "two concurrent projects on the same backend account consume only once"
- SSH projects never read local transcripts, child logs, prompts, rollouts or Claude credentials; the remote account uses its own channel and host quota scope — the local machine's files belong to another conversation — test: `tests/agent-calls-rate.test.cjs` › "SSH calls never read local child, prompt, log or rollout files"; test: `tests/remote-claude-account.test.cjs` › "SSH Claude startUsage binds only the remote channel and quota scopes separate hosts from local accounts"
- Finished calls hide after 3 s on success and 30 s on failure, while a live helper keeps its row; hidden failures remain in snapshots, while successful dispatches leave snapshots; all receipts and feeds remain available for an open split. Hidden rows contribute no grouped rate, count or task text. Hiding never acknowledges pending review, changes completion or emits another accounting hook. Dispatch receipts survive resets and hidden receipts reject delayed duplicates ? test: `tests/agent-calls.test.cjs` › "ended dispatches hide after three or thirty seconds without acknowledging failures or reviving duplicates"; test: `tests/dashboard-records.test.cjs` › "run and grade hooks retain only local evaluation metadata"
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
