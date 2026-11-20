---
name: agent-dispatch
description: Use when changing Agentrix's worker engine (integration/dispatch.cjs), the conductor's role tools it serves over MCP (integration/role-tools.cjs, `dispatch.cjs mcp`), the shell shims, the event server or the called-models pane. Sessions never run the engine themselves: a conductor starts roles with the start_role tool, and native mode runs the real CLI.
---

# Dispatching command-line workers

> Sessions no longer call this engine. A lead in conductor mode starts roles with the role tools (`start_role`, `roles_status`,
> `role_result`, `stop_role`), which `dispatch.cjs mcp` serves and which run the engine below in-process; the shell shims refuse
> `codex exec` and `claude -p` in conductor mode and run the real CLI in native mode. The commands below are the engine's own
> interface, for its code and tests.

The activity pane's 调用的模型 shows command-line workers only from what the helper declares at the start and reports at
the end — never from guessing a command line. A session inside Agentrix finds the helper's path in its startup note
(`Dispatch helper: node "<path>/dispatch.cjs"`); outside Agentrix (no `AGENTRIX_BOOTSTRAP`) the helper just runs the
worker.

## Launching

```
node "<helper>" codex --detach --role 执行 --title "Fix the cmd prompt reflow" --model gpt-6.1-sol --effort high --fast \
  --cwd <dir> --brief <brief.md> --out <answer.md> [--image <png> …] [--read-only]   [--allow <glob> …] [--ledger <ledger.md>] [--resume <session id>] \
  [--meeting <id>] [--skip-meeting <reason>]
node "<helper>" claude --detach --role 审查 --title "Architecture review" --model opus --effort high \
  --permission <plan|acceptEdits> --cwd <dir> --brief <brief.md> --out <answer.md>
node "<helper>" minutes --cwd <dir> --meeting <id> --out <minutes.md> [--issues <issues.json>] [--language zh|en]
node "<helper>" consolidate --cwd <dir> --meeting <id> --summary <file.md>
```

A Codex worker runs only on `codex app-server`, which the helper starts itself with the declared model, effort, speed, folder and sandbox. If app-server cannot start, the helper fails with the reason on its end line and does not fall back to another way of running Codex. A Claude worker runs through the app's Claude runtime where it is available, else as `claude -p --model … --effort … --permission-mode … --output-format stream-json --verbose`, whose stream the helper reads itself. The helper gives the
brief to the worker itself, so what is declared is what runs. Without `--detach`, it exits with the worker's exit code; either mode writes a log next to `--out`
(`<out>.log`). `--role`: 执行 / exec, 调查 / investigate or 审查 / review (English aliases become the corresponding Chinese
role in events). `--help` lists all six values. `--title`: one line, what the worker does.

Detached starts return after the start receipt (up to about 60 seconds); if the session is still unknown, the receipt says it follows in `wait`. Start parallel workers with several detached calls, then one `node "<helper>" wait <id-a> <id-b> --cwd <dir>`. `wait` defaults to 540 seconds and refuses timeouts above 570 seconds. Exit 75 means runs remain active: read their last-activity lines and call `wait` again. Exit 0 means all named runs ended; inspect each end line for its worker exit code. `stop <id>` also works for detached runs. Run `wait` with the Bash tool timeout set to `600000` ms, or pass a `--timeout` below the shell's command limit (Claude Bash otherwise stops at 120 seconds). Keep calling `wait` in the same turn; do not end the turn while detached runs remain active. For `wait`, `--cwd` is the worker's folder or any folder in the same Git repository; standalone runs require the worker's folder. `stop` requires Git. Main's signed dispatch events are authoritative; local receipts only report progress to the lead.

## Scope, shared context and follow-ups

- **Skill edits need the lead.** A worker must put suggested skill changes under `## Skill proposals` in its answer.
  It must not edit, add or delete any `SKILL.md` in project, built-in or global skill folders unless `--allow` names
  that exact file without wildcards. A broad scope such as `skills/**` does not approve skill edits. The helper
  snapshots skills before launch, preserves each unapproved new version under `<out>.skill-proposals-<run id>/`
  (with `index.json` naming edits, creations and deletions). Only files inside a worker's separate Git worktree are
  restored to the pre-run bytes, including uncommitted contents. Global, built-in and shared-checkout changes are
  report-only, marked "changed during the run, author unknown", and stay live. Scans skip node_modules and .git;
  snapshot limits degrade to report-only with a note on the end line. The end line reports
  `N skill proposals restored and awaiting the lead` and `M skill changes left live (author unknown)` separately.
  `dispatch-end.skillProposals` counts only restored proposals; `dispatch-end.skillChangesLeftLive` counts changes
  left live. Both come from `index.json`'s `proposal.restored`. Read the preserved versions and approve specific paths
  in a follow-up; report-only changes remain live and their authorship is unknown.

- `--allow <glob>` (repeatable, relative to the git root): the only files the worker may change. The helper snapshots
  the working tree before and after (its own answer, log and ledger excluded) and reports every other changed file as
  out of scope: the end line says `· scope ok` or `· OUT OF SCOPE: <files>`, `dispatch-end` carries `outOfScope`, and
  the reason becomes `scope` (the pane shows 越界, files in the tooltip). The brief is also prefixed with the
  `BOUNDARY.md` of every module the globs touch (`skills/module-boundary`) and the allowed paths, with the instruction
  to stop and name the file it would need rather than step outside. Outside a git tree the end line says
  `scope unchecked`. The lead rejects or reverts an out-of-scope result; it never accepts one silently.
- `--ledger <file>`: the task's shared context (owner's words, decisions, pitfalls). Its text goes before the brief, and
  the worker is told to end its answer with `## Findings for the ledger`; those bullets are appended to the ledger under
  `### <time> · <title> · <agent> <model> · session <id>`. One ledger per task, in the project (not under `.dispatch/`
  if it should be kept); the next worker on the task gets everything earlier ones learned, so briefs stay short and
  never repeat the owner's decisions by memory. In a git repository the findings also go to the project memory
  (below), so a worker on another module reads them without a ledger.
- `--resume <session id>` (from the start line's `session`): continues that worker's conversation —
  a Codex thread resumed on app-server (keeps the session's own folder; a build run is writable and a roundtable or `--read-only` run stays read-only) or `claude -p --resume`. Pass the whole session id: a shortened one starts a new session.
  Use it for a follow-up on the same work (a review finding, a failing test) instead of re-explaining in a new worker.

A worker reads its surroundings: a ledger or answer lying in a sibling folder is context too. Keep unrelated tasks'
ledgers out of reach of a worker that must not know them.

## Roundtable, shared memory and rounds

A round is plan → roundtable → build → integrate and review → consolidate (the system `model-routing` skill). The helper backs it
with a team folder and three refusals, so the process does not rest on the lead remembering it. The code is the Team
module (`electron/features/team/`, `team.cjs`; its page for the owner is `minutes-page.cjs`).

The roundtable lets the planner check that each worker received the brief as meant through task restatements and
corrected minutes, with questions limited to ambiguities, contradictions or code facts that make the brief impossible
as written, and design decisions left to the planner.

**The team folder** is `<common>/agentrix/`, `<common>` being `git rev-parse --git-common-dir` from the worker's `--cwd`:
every worktree of one repository sees the same folder, and nothing in it is committed. Outside a git repository there is
no team folder, every rule here is off and the helper behaves as before.
- `memory.md` — the project memory: every worker's `## Findings for the ledger` (also with `--ledger`, which gets them
  too) and the lead's round consolidations.
- `journal.jsonl` — one JSON object per line, appended by the helper: `meeting` (a roundtable answer: meeting id, session,
  agent, model, title, allow, the parsed understanding or confirmation, status), `skip` (a `--skip-meeting` run and its
  reason), `end` (an 执行 run's end, with the meeting it belongs to or null) and `consolidate` (meeting id, time).
- `board/<run id>.json` — one per running worker (title, role, agent, model, cwd, allow, meeting, the helper's pid,
  start time), written at the start and removed on every way out, a refused or failed launch included. An entry whose
  pid is not alive is stale: it is ignored and removed when seen. Checking the overlap and registering happen under one
  exclusive lock file in the folder, so two launches at the same moment cannot both pass.

**`--meeting <id>`** (`[\w.-]{1,64}`) makes the run the roundtable for meeting `<id>`; it needs a git repository (there is
no journal outside one). A meeting id belongs to one round: use a new one every round (`<topic>-r1`, `<topic>-r2`), keep it
for that round's understanding, confirmation and minutes runs, and never reuse an id of an earlier round (refused). Once
the round is consolidated the meeting is closed: its confirmations no longer open builds. Pass the role the worker will have at
work (`--role 执行 --meeting …`); the event role Agentrix receives is `圆桌`, and the gates below still use the real role.
Allowed with every role, not with `--read-only` (a resumed Codex keeps its first sandbox and the same session builds
later; a Claude meeting runs with `--permission plan` and the build resumes it with `acceptEdits`). The worker must change
no file: any change in the git working tree (the helper's own out, log, ledger and memory files excluded) ends the run
with reason `scope` and `OUT OF SCOPE`. An 执行 meeting still needs `--allow`; the globs are shown to the worker as the
files it will change after the roundtable. The start line carries ` · roundtable <id>`; the end line the same and
` · understanding complete|incomplete` or ` · confirmed|open`.
- A first meeting run of a session (no `--resume`, or a resumed session with no understanding yet) gets the
  **understanding request** appended to its brief: read the whole plan, restate your own task without proposing alternatives
  or reopening decisions, change no file, answer in the plan's language and end with exactly

  ```
  ## Roundtable understanding
  - Goal: …
  - Files: …
  - Provides: …
  - Uses: …
  - Done when: …
  - Questions and risks: …
  ```

  (`none` where empty). Each field may continue on following lines until a line starts with `#`; a trailing section
  makes the block incomplete. Parsed into goal / files / provides / uses / doneWhen / questions: status `understood`
  when all six are present and non-empty, with no duplicate fields or a field containing only the template placeholder;
  otherwise `incomplete`.
- A resumed session that already has an understanding in this meeting gets the **confirmation request**: the worker checks
  that the minutes record its task as restated, with the planner's corrections, and that its shared interfaces match the
  others', then ends with `## Roundtable confirmation` and `Status: confirmed`; use `Status: open` only for a misreading
  that is still uncorrected, followed by bullets naming it. Anything else counts as `open`.
- A meeting run that ends with any reason other than `exit` is journaled as `invalid`, whatever its answer says; only
  `confirmed` from a clean run opens the second gate.

**`--skip-meeting <reason>`** lets an 执行 run with `--allow` start without a confirmed roundtable. The reason is
journaled and printed on the start line (` · roundtable skipped: <reason>`).

**The minutes.** `node "<helper>" minutes --cwd <dir> --meeting <id> --out <minutes.md> [--issues <issues.json>] [--language zh|en]`
writes `<minutes.md>` (two Markdown tables) and the same path with `.html` (the page for the owner), from the journal: the
latest understanding of every session in the meeting and its latest status (`confirmed`, `open`, `understood`,
`incomplete`, `invalid`; a missing or unknown status shows as incomplete). A worker's unresolved confirmation questions
(its `Status: open` bullets) are appended to its questions cell, prefixed `未解决：` (`Open: ` with `--language en`).
Rounds are numbered by the order in which meeting ids first appear in the journal. `--issues` is a file the lead writes,
the second table:

```
[{ "issue": "Where do team.cjs and the page live?", "raisedBy": "Sol", "answer": "A new Team module", "result": "settled" }]
```

`--language` defaults to `zh`. The lead runs `minutes` after the understanding runs, sends `minutes.md` as the brief of the
resumed confirmation runs, and runs it again after the confirmations for the owner (Markdown tables in the reply, the
HTML page by path).

**The consolidation.** `node "<helper>" consolidate --cwd <dir> --meeting <id> --summary <file.md>`: the summary must hold
the headings `### Results` and `### Architecture changes` (the latter may say "none" with why). It is appended to
`memory.md` under `## Round <n> · <meeting id> · <yyyy-mm-dd hh:mm>` and journaled, and the meeting is closed. It is
refused while a worker of that meeting still runs: wait for the builds to end first. Both subcommands start no worker and
exit 0, or 1 with one `[dispatch] …` line.

**The gates.** Each refuses with `[dispatch] failed to start <id>: <reason>`, exit 1 and the usual unconfirmed start/end
events, before anything is launched. 调查 and 审查 runs are never gated.
1. **Overlap** — an 执行 run with `--allow` is refused while another live board entry of the same repository is an 执行
   run whose globs overlap: some file of `git ls-files --cached --others --exclude-standard` in this run's worktree
   matches both sets, or a glob string is in both. The reason names the other run's title and up to three shared
   files or globs.
2. **Roundtable** — an 执行 run with `--allow` and without `--meeting` must `--resume` a session whose latest `meeting`
   entry is `confirmed` and whose meeting `allow` equals this run's `--allow` as a set (so repeat the same globs), or
   carry `--skip-meeting`. The reason says which is missing (no meeting for the session, not confirmed, scope differs
   from the one agreed) and how to hold a roundtable: run the worker with `--meeting <new id>` and this run's `--allow`,
   resume that session with the minutes until it is `confirmed`, then resume the same session for the build with the
   same `--allow`. The confirmation of a closed (consolidated) meeting no longer counts.
3. **Consolidation** — a `--meeting` run with a new id is refused while an earlier meeting has an `end` entry and no
   `consolidate` entry. The reason names that meeting and the `consolidate` command.

**What every worker reads first** (when the team folder exists): the ledger first when `--ledger` is given, then these
three parts, then the boundary and allowed-files parts:
1. `# Project memory` — the path of `memory.md`, then its latest two `## Round` sections and everything after the last
   one, the newest text within 24 KB (cut at the start, marked `…`).
2. `# Working now` — every other live board entry: `- <title> (<agent> <model>, <role>): <globs or "no file changes">`.
3. `# Repository` — `git status --short` (at most 40 lines, then `… and N more`) and `git log --oneline -5`.

The handing-back section is always there: findings go to `memory.md`, and to `--ledger` as well when one is given.

## Signals to the lead

The lead starts the helper with `--detach` and reads its start receipt, then calls `node "<helper>" wait <run id> --cwd <dir>` to collect its result. The
helper prints exactly one start line, then exactly one end line, on its stdout:

```
[dispatch] started <id> codex model gpt-6.1-sol effort high fast on · routing ok · pid <n> session <session id>
[dispatch] started <id> codex model unreported effort unreported fast unreported · routing unverified (model, effort, fast) · pid <n> session <session id>
[dispatch] started <id> claude model claude-sonnet-5-5 effort unreported fast off · routing ok (effort unverified) · pid <n> session <session id>
[dispatch] started <id> codex model gpt-6.1-luna effort high fast off · routing MISMATCH (declared gpt-6.1-sol high fast on) · …
[dispatch] failed to start <id>: <reason>          (instead of "started"; the helper then exits non-zero)
[dispatch] ended <id> codex model gpt-6.1-sol effort high fast on · 43 token/s (5,210 output tokens in 121 s) · exit 0 reason exit · scope ok · out <answer path>
```

The start line proves that the worker started and states its reported model, effort and mode. The helper compares
Codex's matching rollout (`turn_context` model and effort; recorded service tier) or Claude's `system/init` record
(model, effort and fast-mode state when present) with the declaration. A reported difference gives
`routing MISMATCH (declared ...)` with the reported values first. If no reported values differ and the model was not
reported, the verdict is `routing unverified`; otherwise matching reported values give `routing ok`. A value the worker does not report stays
`unreported` in the values and is listed after the verdict, including when another reported value mismatches. It is never
assumed from the declaration, so verify an unreported setting before relying on it.
"Started" is printed only from the worker's own records — its session reported (and
Codex's turn context read from its session file) — within 30 seconds (60 for a detached helper), else "failed to start". While the worker runs, its
session file is read every 250 ms (today's and yesterday's `sessions/<y>/<m>/<d>` folders directly, so a new file is
found at once), and a start is reported well within a second of the record. A worker that finishes in a few seconds is
judged on everything it left: once its output is read (at most 0.5 s after it exits), records that confirm it give
"started" and then "ended"; an exit without them is "failed to start". The lead reads the start line right after launching (the
receipt printed by the detached start): on "failed to start" it fixes the brief or relaunches; on a
mismatch it stops the worker and relaunches with the intended settings, or tells the owner why the actual model is
acceptable. It gets the end line from `wait`.

Both lines carry the model name, effort and mode (`fast on` / `fast off`, Claude's `fast`/`standard` speed when recorded).
The end line adds the worker's average output rate: output tokens divided by the time its model responses took, from
the worker's own records, using the app's `TokenRates` calculation. Codex's `thread.started` identifies its read-only
`$CODEX_HOME/sessions/**/rollout-*-<thread id>.jsonl` (default `~/.codex`); the rollout supplies `token_count` /
`token_usage_record`, response timestamps and tool boundaries. Fast mode is recorded as `fast` / `priority` in
`event_msg → thread_settings_applied.thread_settings.service_tier`, or a service tier in session metadata / turn context.
The helper never treats global config or its declared flags as session proof; an absent tier stays `unreported`.
Codex's `--json` remains for the thread id, errors and final turn totals, without estimating rate from process time.
Claude's per-message usage and timestamps supply live samples, excluding forwarded subagents. Its final result
(`usage.output_tokens`, `duration_api_ms`) replaces those totals. Older JSON-only output, or messages without usable
timestamps/boundaries, may provide only final API totals; only that available rate is reported. Reasoning tokens
already inside output tokens are not added again. No usable record: `token/s unreported`.

## Events to Agentrix

After admission and before launch, the helper writes a declaration. Each event is written atomically to the run's
outbox before it wakes main over the authenticated event pipe (`pipeName` from `AGENTRIX_BOOTSTRAP`). The session key
is captured at admission, never written into the outbox, and never passed to the worker. Records carry `version: 1`,
`seq`, `keyId` and an HMAC-SHA256 `mac`; the pipe also carries the session key. Its optional SSH `sequence` is transport
metadata, separate from the authenticated `seq`.

For local terminals the folder is `dispatch-outbox/<bootstrap filename>/<run id>/` beside the bootstrap file, with one
`<seq>.json` per event. Main applies events once, in sequence order, and atomically writes a signed `ack.json` for the
highest applied sequence before reclaiming those files. A pipe write alone never acknowledges an event. A later wake
drains the missing records, and main sweeps registered folders every 60 seconds even when the helper has exited.
Replay never restarts a model request. An earlier key authorizes only its admitted run; a terminal restart cannot
authorize another run with that key. App restart recovery and the remote SSH disk-replay bridge are separate work.

| type | fields |
| --- | --- |
| `dispatch-declared` | `id`, `helperPid`, `agent`, `role`, `title`, `cwd`, `worktree`, `requested: {model, effort, fast}`, optional authenticated `leadMode`, `source: 'dispatch'|'intercept'`, `parentId: null`, `resumed`, `at`; a declaration admits visibility, never proves execution |
| `dispatch-notice` | `id`, `controlFailure` (a safe `stage/category`, or null after recovery), `at`; retained on the same row without ending or discarding it |
| `dispatch-start` | `id` (uuid), `agent` (codex/claude), `role`, `title`, `model`, `effort`, `fast` (as the worker reports them; `declared` holds the declared three when a reported value differs), `cwd`, `brief`, `out`, `sessionId`, `startedAt`; an unconfirmed start uses the declared routing and `unconfirmed: true`, with `sessionId: null` if unknown |
| `dispatch-rate` | `id`, `outputTokens`, `activeMs` — cumulative completed-response totals, checked every 5 s while running; unchanged or unreported totals are skipped |
| `dispatch-end` | `id`, `model`, `effort`, `fast`, `exitCode`, `reason` (`exit`, `killed`, `capacity`, `error`, `unconfirmed`, `scope`), `outputTokens`, `activeMs` (null when unreported), `endedAt`; `outOfScope` (files) with `--allow` |

`dispatch-declared` creates a `starting` row (启动中 · 未确认), showing the requested model as unconfirmed and leaving
unreported effort, speed and rate unknown. A `--resume` invocation sets the item's `resumed: true`. After 15 seconds
without `dispatch-start`, the same item gets `notice: 'unconfirmed'`; that notice does not fail or restart the worker.
Only record-confirmed `dispatch-start` promotes that row to 运行中 and clears its notice, with the model, effort and
mode the worker reports (a mismatch is noted in the row's tooltip). `dispatch-end` with `reason` exit and
code 0 shows 已完成; finished calls hide after 3 seconds on success and 30 seconds on failure while a live helper keeps
its row. Hiding never acknowledges a failure, removes an open feed or repeats accounting. The helper finds the reason from the
worker's exit code and the end of its own output (e.g. "at capacity"). `dispatch-rate` makes the running row's model
group show its token/s while the worker runs (the same TokenRates as other calls); `dispatch-end`'s totals are the
last word. When confirmation times out, or the process exits without confirming records, the helper sends the declared
`dispatch-start` with `unconfirmed: true`, followed by `dispatch-end` reason `unconfirmed` (exit code null if still
unknown). This pair retains the 未能启动 row even without a worker session. The 30-second startup confirmation deadline
and its failed-start/end pair remain separate from the 15-second visibility notice.

## Rules

- Roles start only through the role tools; the engine's command line is for its own code and tests.
- Give every worker that changes files `--allow` for its module, and every task with owner decisions a `--ledger`.
- A roundtable (`--meeting`) and a round summary (`consolidate`) are the orchestrator's choice, never required. A build with
  `--allow` and no roundtable passes `--skip-meeting <reason>`; after a roundtable, resume the confirmed session with the
  same `--allow`.
- A Claude worker (`claude -p`) can read only inside its `--cwd`: paste anything else it needs (a review report, a
  plan in the scratch folder) into the brief, or copy it into its worktree. A Codex worker can read outside it.
- Right after launching, read the helper's start line. On `routing unverified`, establish the model before relying on
  routing; on `routing ok`, check any unverified settings separately. Act on `failed to start` or `routing MISMATCH`.
- Before widening one worker's `--allow`, compare it with every live worker's globs (the board): a shared file such as
  `electron/locales/en.json` is refused as an overlap. Hand a file to the worker that needs it and take it from the
  other; the lead adds strings or one-line wiring a worker may not touch.
- A follow-up fix after review goes to a fresh session with a focused brief (findings, file:line, done-when), with
  `--skip-meeting "<review follow-up of round …>"` and the same module globs. Resuming a long build session costs far
  more (observed: about 50 min per resume against 5–8 min fresh).
- A Codex worker that adds a dependency may pass its tests in its own sandbox while the package never reaches the
  shared `node_modules` (worktrees link it as a junction): after merging, run `npm ci` in the main checkout and the
  worker's tests again before trusting its "tests pass".
- A worker that cannot run commands (a helper-run Claude under `acceptEdits`) ships untested code: tell it which test
  loaders it must satisfy. Example: tests transpile `.ts` with JSX enabled, so `const f = <T>(…) =>` is read as a tag
  and every test that loads the file fails; use `function f<T>(…)` there.
- `--role 调查` with `--allow` writes only inside those globs and needs no roundtable; `--skip-meeting` is accepted only
  for an execution role.
- Claude Code's own Agent tool calls stay as they are: their transcript records are already structured.
- The app no longer parses Bash command lines, briefs or logs to find workers.
