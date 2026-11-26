# Boundary: Dispatch

The dispatch helper that every command-line Codex or Claude worker is started through — it builds the real command, confirms the worker started, and reports its routing, rate and end — and the main-process gate that accepts its events for the activity pane. Claude --fast reaches its CLI as a JSON settings argv element. Claude aliases accept their own family at the bundled CLAUDE_ALIAS_FLOOR (currently major 5, minor 5) or newer, ignoring date and context/speed suffixes; older versions remain mismatches. A release bump changes the one floor constant in routingVerdict; no caller option or environment variable sets it.

The helper pins the run's model, effort and fast settings.
Claude reports the pinned launch effort. The model and fast setting still come from worker records.
Scoped builds register alongside overlapping runs. Removed roundtable commands fail before launch, and the legacy skip flag is ignored.
Legacy events retain their role and meeting metadata for call history.
The Codex shell wrappers request native launch. The local and SSH native launches keep a separate baseline next to the live sidecar so the helper can identify flags copied from the original routing table even when the seat environment variable is absent.
Local and SSH Claude wrappers read the lead file at launch. It carries model, effort, fast flag and seat-map JSON.
Local and SSH conductor conversations also read an optional fifth line, `ultracode`, and add the setting to the selected hook JSON.
Six-line legacy files still take the seat map from line six.
The local Claude wrappers attach the role tools through Intercept. The SSH wrapper attaches the remote MCP server to conductor conversations.
SSH Codex receives that server from its own channel at thread start or resume. A conversation opened in native mode needs to reopen after enabling conductor mode to connect it.
Readers also accept the legacy three-line and six-line forms. Hooks and the helper read accepted seats from the private sidecar at invocation.
The helper puts one standing-rules section before every brief and tells roles to skip absent skills. Normal briefs inline the
code standards when the base and extensions fit the 8 KiB source budget. Small or oversized briefs keep the path references.
Claude roles can run commands and tests. They decide whether to run tests and which ones the task needs.
The CLI permission rules and SDK worker policy deny explicit Git commit, push and reset --hard operations.
Both CLI paths allow Bash, plus PowerShell on Windows. Writable roles use acceptEdits and follow their assigned file scope.
Read-only roles leave project files untouched and use dontAsk with editing, planning, questions and MCP tools disabled.
The legacy plan argument selects this read-only behavior.
Read-only runs check the Git working tree after execution even with no allow globs. Changes are reported with unknown authorship and do not trigger restoration, quarantine or failure.
Custom IDs select enabled roles directly. A Developer specialty selects the enabled specialty first and falls back to Developer when enabled.
Launch defaults preserve the declared spelling — test: `tests/dispatch.test.cjs` › "custom and enabled specialty seats supply dispatch defaults while the original spelling is reported"
Claude's terminal Agent and Task hooks report provisional and final input by tool-use ID.
Unsupported Agent and Task seat choices produce a notice and leave the input untouched. The dispatch declaration and the Agent hook's first observation carry the seat expectation used by call history.
SSH applies seat sidecar updates in channel order. A failed update leaves the previous sidecar available.

`wait_roles` returns when any selected role ends, its receipt is lost, a selected hidden terminal starts waiting for the owner, or the timeout elapses.
A wait returns immediately while a selected role has an active owner wait. Summary rows retain the wait and current menu id and kind.
Wait returns full details for roles whose lifecycle or owner-wait state changed during the call. Other selected roles get one-line summaries.
For a recognised hidden Claude menu, the wait line also reports the menu id, kind, title and offered options. The conversation's
`answer_role` uses that id through the authenticated control channel. The worker checks the current PTY sequence and choice.
The helper retains up to 20 worker refusals in receipts and the authenticated end event. A successful run with refusals ends with reason `permission` and its original exit code.
The hidden worker's permission hook never waits on the event endpoint to send its decision. On Windows Node reads Claude's
input directly and hands the report off to a separate process with its own stdio. The bridge forwards the first decision
line, terminates the decision child and exits. Node and the PowerShell status hooks bound connect and write together to
750 ms. Node exits after the attempt, even with a pending Windows pipe connection. AGENTRIX_HOOK_TRACE adds timing marks
on stderr without including hook payloads or session keys.
The Windows Claude hook uses UTF-8 on its redirected streams without accessing the pseudoterminal's console code pages.
Seat routing and permission decisions end in LF. The SessionStart command reports the conversation path.
Test: `tests/agent-event-worker-permission.test.cjs` › "the Windows bridge forwards the decision with the child still holding stdout open".
SDK bookkeeping denials stay in the policy audit. Only denied work is included in the run’s refusal list.
An accepted stop keeps reason `killed` with any bounded tree-stop failure in the end line and authenticated event. Artifact settlement requires worker exit evidence.
The end line includes the count and first action. Role status, wait and result expose the structured list.
A Claude role keeps its early session-based start. The first provider model updates signed routing and the detached
receipt as it arrives. Status and the final line expose the resulting verdict.
All briefs ask roles to report blocked actions under Needs approval. Claude briefs direct roles to finish with plain text and avoid owner dialogs.
Roles defer choices affecting scope, reversibility or product behavior under Needs decision. On settlement, that answer heading adds a fixed end-line note and a boolean to detached role status and results.
`roles_status` shows full running roles and the ten newest endings first observed in the last ten minutes. Each ending is summarized on one line with its reason and refusal count.
`earlierEnded` counts endings past the ten-minute window. `omittedRecentEnded` counts recent endings beyond the cap. `role_result` gives full details.
A writable `start_role` may create a local Git worktree and returns its branch and folder after confirmation.
It returns the abbreviated base commit. A same-project `cwd` uses its own HEAD by default and when `from` is explicitly `HEAD`.
Other explicit refs resolve in the project repository.
A failed checkout or launch rolls back the new worktree and branch.
Codex roles keep their declared seats and start without a Windows or SSH sandbox readiness probe.
The first confirmed dispatch of either provider shows a one-time notice in the lead conversation and saves the acknowledgment in the application profile.
Local MCP roles own marked temp folders for their briefs, answers and logs. The detached helper records process IDs and stamps confirmed settlement before publishing its final receipt.
The MCP sweeps asynchronously on startup and when it observes an end, at most once a minute. It expires settled folders after seven days,
removes marked orphans after 30 days, and can evict read results oldest first above 256 folders. POSIX ownership and mode are checked again before removal,
links are removed without following them, and failed removals back off without consuming the sweep cap. `role_result` explains when cleanup removed an answer.

When a dynamic load changes, review its declared targets and reason in `scripts/affected-tests-map.json`, then run
`node scripts/affected-tests.mjs --repin <repo-relative file>` and `node --test tests/affected-tests.test.cjs`.
The pin tracks loads, loader calls and the declarations their arguments use. Unresolved dependencies use a normalized whole-file digest.

The S0 wire contract is shared by the later migrations. `readEnvelope(input, {channel, format, versions, legacy})` returns
`{value, version, legacy}`. Only an omitted version reads as v0, and journal readers retain that path for historical rows.
`readKeyValue(text, {format, versions})` and `writeKeyValue(fields, {format, versions})` use UTF-8 LF records up to 16 KiB.
`readRoleResult(input)` reads the file contract. Its source is `finish-role`, `final-text`, or the 1.6.4 transition's `legacy-heading`.
`readSessionMode(text)` returns the mode and `readLeadSeat(text)` returns `{model, effort, fast, ultracode, seatsMap}`.
The shell file readers take the new format; the migration owns fallback to the old file when the new file is absent.
The detached run file uses version 2. The future `--events jsonl` path and the in-process callback use `WIRE_FIELDS.dispatch`.
The default dispatch output stays human-readable.
The wire contract and its baseline are checked by `tests/wire-format.test.cjs` and `tests/self-format-guard.test.cjs`.

## Owns
- `integration/dispatch.cjs`
- `integration/dispatch-outbox.cjs`
- `integration/role-tools.cjs`
- `integration/role-artifacts.cjs`
- `integration/agent-event.cjs`
- `electron/features/agents/dispatch-events.cjs`
- `electron/features/agents/dispatch-intake.cjs`
- `electron/features/agents/dispatch-inbox.cjs`
- `electron/features/agents/dispatch-control.cjs`
- `electron/features/agents/dispatch-registration.cjs`

## Interface
- `createDispatchControl` (`electron/features/agents/dispatch-control.cjs`) — the authenticated execution-control channel and its helper client, connectDispatchControl; registration refusals carry a closed code, and authenticated refusals also carry leadMode on the frame and client error.
- `resolveRegistration` (`electron/features/agents/dispatch-registration.cjs`) — main's current-session, worker-cwd board and lead-mode binding, or a coded refusal; test: `tests/dispatch-registration.test.cjs` › "a worker in a worktree registers against the board its helper admitted it on; a board from another Git common directory is refused with project_mismatch; a worker outside Git is bound from its authenticated declaration and no wider".
- `USAGE` (`integration/dispatch.cjs`) — the helper's command line (`node dispatch.cjs <codex|claude> … [--seat <id>[/<specialty>]] [--detach]`, `wait <run id> … [--timeout <s>] [--cwd <dir>]`, and `stop <run id> [--reason] [--no-resume]` for the planner to stop a worker whose owner intervention conflicts with its task); detached helpers retain receipts beside the team journal (standalone helpers use a per-directory temporary store), and wait returns 75 while runs remain active, otherwise 0 with worker exit codes in the end lines; receipts are advisory and main's signed events are authoritative, receipt replacement retries sharing violations without interrupting event delivery, and a per-run socket nonce distinguishes helper identity from PID reuse; a normal owner intervention never stops a worker: it is resumed in the same session after its current run; sessions learn its path from the startup note (skills/agent-dispatch)
- `[dispatch]` (`integration/dispatch.cjs`) — the started / failed to start / ended lines, and a Codex worker's request lines (opened, unanswered, resolution); events carry kind, the requested model and verified routing, and a model reported after the start follows as dispatch-routing; outputTokens/activeMs are the meter's timed pair and totalOutputTokens is the invocation's cost count; resumed Codex never falls back to stdout totals
- `createRoleTools` (`integration/role-tools.cjs`) — creates the role tools. The module also exports `serve`, which replies once per MCP request and cancels pending waits when stdin closes.
- `runtimeFiles` (`integration/dispatch.cjs`) — the electron modules the helper carries; copied by scripts/after-pack.cjs and electron/remote-connection.cjs
- `acceptDispatch` (`electron/features/agents/dispatch-events.cjs`) — receives signed dispatch events. The same file exports readEnvelope, readKeyValue, writeKeyValue and WIRE_FIELDS.
- `createDispatchIntake` (`electron/features/agents/dispatch-intake.cjs`) — main's intake and per-terminal inbox binding/disposal for a session's dispatch-* events over the app shell's deps; holds the per-project dispatchAccounts, read by dispatchReading and cleared by clearDispatchAccount
- `dispatchAccount` (`electron/features/agents/dispatch-events.cjs`) — a Codex worker's dispatch-account report (its own app-server's account kind, observation time, account name and merged quota, read afresh for each report, sent only between dispatch-start and dispatch-end; an accepted report makes main send `agents:usage-changed` for the project) rebuilt from known fields as the limits payload an account read gives; acceptDispatch takes it only for a running Codex call and hands it to main's per-project store. The pane's Codex section uses it only when the project has no running Codex session and its own account read named no account, or named the same one; a report past two account intervals reads as stale. The name is made in the helper with main's account key, which the control registration gives only to local runs: without it (no control channel, an SSH run) the report names no account; account identifiers never leave the helper — test: `tests/dispatch-codex-usage.test.cjs` › "a dispatched Codex worker reports its app-server account and quota, and the pane shows them without a native session"
- `shellEvent` (`integration/agent-event.cjs`) — a Bash terminal's own reports, as zsh-integration.zsh sends them: shell-ready, shell-prompt, agent-started, agent-exited, and hook-channel (the claude wrapper fell back to command hooks; command names the proxy variable)
- `readRoleResult` (`electron/features/agents/dispatch-events.cjs`) — reads a versioned result object from JSON text or a parsed value. Also exports readSessionMode and readLeadSeat for shell text.

## May import
- `electron/features/agents/token-rate.cjs`
- `electron/features/agents/agent-settings.cjs`
- `electron/features/agents/codex-account-usage.cjs`
- `electron/oversized-record.cjs`
- `electron/session-files.cjs`
- `electron/transcript-tail.cjs`
- `electron/boundaries.cjs`
- `electron/features/team/*.cjs` (Team's board, context, end journal and inbox interfaces)
- `electron/features/dashboard/records-routing.cjs`
- `electron/features/routing/agent-seat.cjs` and `electron/features/agents/call-seat.cjs` (Claude Agent and Task hook seat routing, model family and launch seat resolution)
- `electron/features/cli-adapters/workers.cjs` and `electron/features/cli-adapters/worker-git.cjs` (worker approvals, terminal answers and linked worktree detection)

## Invariants
- A worker is known only from the helper's declarations, never shell commands, prompt filenames or stdout; events require the session's key at admission and project, well-formed fields and at most 16 KB, are persisted to the run's outbox, MAC'd and sequenced before main is woken, and are acknowledged and applied once; a declaration creates a starting row with an unconfirmed notice after 15 s without a start; a missing acknowledgment replays on a wake or the 60 s sweep without restarting the model request, and a terminal restart retains admitted-run authority without accepting another run under its earlier key; refusals count each (run, seq, code) once and log once per (run, code) without owner banners — dispatch-input records carry provider/session/input identifiers and channel origins, never message text; resumed owner inputs retain admitted owner control IDs, while initial/resumed helper briefs remain planner input. Source facts persist in the team journal and are validated by main; guessed routing is misleading and any local process can reach the pipe — test: `tests/dispatch-e2e.test.cjs` › "main preserves the admitted row and inbox across host restart and reports a forged late event by code"; test: `tests/dispatch-e2e.test.cjs` › "main binds delivery before launch and publishes the fifteen-second starting notice without a worker start"; test: `tests/dispatch-inbox.test.cjs` › "an unadmittable frame is counted once across wakes and sweeps and logged once per run and code"; test: `tests/dispatch-inbox.test.cjs` › "any order, duplication or loss of wake-ups applies each event once in seq order; a forged MAC or an unknown key is refused with its code"; test: `tests/dispatch-outbox.test.cjs` › "a failed wake retains signed events on disk and only an authenticated acknowledgment removes them"; test: `tests/dispatch-events.test.cjs` › "Bash commands, prompt filenames and helper stdout text never create or update a call"; test: `tests/dispatch-events.test.cjs` › "bad keys, projects, unknown ids, malformed fields and oversized payloads are rejected"
- Workers can start while another worker has overlapping scope. What is declared is what runs: the helper builds the CLI's argv itself from its options, validates the optional seat and its specialty, carries it on both declaration and start events, and rejects unknown, repeated, missing or conflicting ones, and rejects absolute or parent-traversing --allow globs before admission — a loose option lets a worker run other settings than reported — test: `tests/dispatch.test.cjs` › "helper constructs exact Codex/Claude argv and rejects incomplete or ambiguous options"; test: `tests/dispatch-e2e.test.cjs` › "unsafe allow globs fail at argument parsing before admission or launch"; test: `tests/dispatch-team.test.cjs` › "a scoped build starts while a worker with overlapping scope is still running"; test: `tests/dispatch-team.test.cjs` › "removed roundtable options fail once before dispatch or detach"
- "started" is printed and sent only from the worker's own records (its session, and Codex's turn context) within 30 s (60 s for a detached helper) — while it runs, or from everything it left once it exits — never from its exit alone; otherwise exactly one failed-start line and an unconfirmed start/end pair — the start line is the lead's proof the task ran, and a fast worker did run. Detached receipts keep the first confirmed launch and confirmation times and the settlement time. Role tools use these times and retain observation-based timing for legacy receipts. An answer becomes readable once the engine reports settlement — test: `tests/dispatch.test.cjs` › "a worker that exits right after its records is confirmed from them; without them it still failed to start"; test: `tests/dispatch-detach.test.cjs` › "detached helper uses an independent process group, file stdio and the original start receipt"; test: `tests/dispatch.test.cjs` › "detached Codex and Claude write engine timing and expose it to wait without changing the end line"; test: `tests/role-tools.test.cjs` › "role timing follows the engine across delayed queries, running roles, stops and legacy receipts"
- Claude effort is the setting passed at launch. Other routing fields come from worker records; a reported mismatch names the declaration and missing fields are marked unverified — routing mistakes must be visible — test: `tests/dispatch.test.cjs` › "Claude reports the launched effort while verifying model and fast mode from runtime records"; test: `tests/dispatch.test.cjs` › "reported mismatches and missing settings never borrow the declaration"; Codex app-server's own thread, settings and reroute reports count as its records — test: `tests/dispatch.test.cjs` › "a model app-server reports after the start reaches the called-models row and replaces the placeholder"
- Helpers and hooks never wait for Agentrix's events, and a helper waits for main's control registration at most 2 s, and a refused registration is told by its code; an authenticated native-lead refusal fails a Claude worker's startup without launching the subscription CLI, while Codex keeps running without execution control; startup instructions stay on the command line, and SessionStart reports the conversation path; a detached Codex worker's blocking request is immediately refused through its protocol response, and a foreground worker keeps its ten-minute timeout — reconnecting the app cannot lose instructions or duplicate delivery, and an unattended run cannot stall; the first event the pipe cannot deliver prints one line, `[dispatch] events not delivered to Agentrix (<errno or timeout>)`, once per process — test: `tests/dispatch.test.cjs` › "a pipe that cannot be reached is said once on the worker’s output and the worker still runs"; test: `tests/dispatch.test.cjs` › "without bootstrap or with a stalled pipe the worker still runs and finishes promptly"; test: `tests/dispatch-control.test.cjs` › "a registration main verifies within 2 s succeeds: neither the helper wait nor the channel idle limit cuts it short"; test: `tests/routing-launch.test.cjs` › "Node and PowerShell SessionStart report the conversation for startup, resume, compact and clear without stdout context"; test: `tests/dispatch.test.cjs` › "a blocking worker request is declined after the timeout and the worker finishes"; test: `tests/dispatch.test.cjs` › "a detached Codex role declines blocking requests immediately and records declined items"; test: `tests/dispatch-control.test.cjs` › "registration rejection reports the failed binding without exposing credentials"; test: `tests/dispatch-startup.test.cjs` › "a Codex worker under a native lead still starts after a project-mismatch control refusal"
- Everything the helper loads from electron/ is carried in runtimeFiles and requires only Node built-ins and other carried files — plain Node cannot read app.asar and an SSH host has only the copies — test: `tests/boundary-dispatch.test.cjs` › "the helper's runtime modules require only Node built-ins and each other"
- Tests start workers only through an injected fake CLI (launch, resolveExecutable, or a fake-only PATH with no AGENTRIX_CODEX_EXECUTABLE and the profile's install folders the test's own, which the helper's Codex search also reads), never the CLI installed on the machine (a test that injects only `launch` also names its `locate`, as the Codex search follows install folders whatever PATH says; the helper's own search runs no `--version`) — results must not depend on the machine — test: `tests/boundary-dispatch.test.cjs` › "dispatch tests start workers only through an injected fake CLI"; test: `tests/dispatch.test.cjs` › "a worker start runs no `codex --version`: the helper locates Codex with a probe that runs nothing"
- SKILL.md follows the same allowed file patterns and restoration rules as other project files. Out-of-scope changes are quarantined before restoration in an exclusive linked worktree and reported in shared checkouts — test: `tests/dispatch-scope.test.cjs` › "overlapping workers keep in-scope skill edits and preserve peer changes"; test: `tests/dispatch-scope.test.cjs` › "N1: exclusive scope violations are quarantined only in a linked worktree (main=false)"

## Not ours
- Showing dispatched rows, their grouping, wording and how long they stay — Activity pane (agent-calls.cjs, ActivityPane.tsx)
- The rate calculation and reading settings from records — Activity pane (token-rate.cjs, agent-settings.cjs)
- The event pipe server and its bootstrap file — electron/events.cjs and electron/features/terminal-events/bootstrap-file.cjs
- Telling a session where the helper is — the startup note (electron/features/agents/handoff.cjs)
- Copying the runtime into packaged builds and onto SSH hosts — scripts/after-pack.cjs, electron/remote-connection.cjs, integration/remote-worker.py
- Which model takes a task and what its brief says — the lead, using the routing guide
- The BOUNDARY.md format and its checker — scripts/module-boundaries.cjs
