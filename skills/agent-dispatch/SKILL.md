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
  --cwd <dir> --brief <brief.md> --out <answer.md> [--image <png> …] [--read-only]   [--allow <glob> …] [--ledger <ledger.md>] [--resume <session id>]
node "<helper>" claude --detach --role 审查 --title "Architecture review" --model opus --effort high \
  --permission <plan|acceptEdits> --cwd <dir> --brief <brief.md> --out <answer.md>
```

A Codex worker runs only on `codex app-server`, which the helper starts itself with the declared model, effort, speed, folder and sandbox. If app-server cannot start, the helper fails with the reason on its end line and does not fall back to another way of running Codex. A Claude worker runs through the app's Claude runtime where it is available, else as `claude -p --model … --effort … --permission-mode … --output-format stream-json --verbose`, whose stream the helper reads itself. The helper gives the
brief to the worker itself, so what is declared is what runs. Without `--detach`, it exits with the worker's exit code; either mode writes a log next to `--out`
(`<out>.log`). `--role`: 执行 / exec, 调查 / investigate or 审查 / review (English aliases become the corresponding Chinese
role in events). `--help` lists all six values. `--title`: one line, what the worker does.

Detached starts return after the start receipt (up to about 60 seconds); if the session is still unknown, the receipt says it follows in `wait`. Start parallel workers with several detached calls, then one `node "<helper>" wait <id-a> <id-b> --cwd <dir>`. `wait` defaults to 540 seconds and refuses timeouts above 570 seconds. Exit 75 means runs remain active: read their last-activity lines and call `wait` again. Exit 0 means all named runs ended; inspect each end line for its worker exit code. `stop <id>` also works for detached runs. Run `wait` with the Bash tool timeout set to `600000` ms, or pass a `--timeout` below the shell's command limit (Claude Bash otherwise stops at 120 seconds). Keep calling `wait` in the same turn; do not end the turn while detached runs remain active. For `wait`, `--cwd` is the worker's folder or any folder in the same Git repository; standalone runs require the worker's folder. `stop` requires Git. Main's signed dispatch events are authoritative; local receipts only report progress to the lead.

## Scope, shared context and follow-ups

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
  a Codex thread resumed on app-server (keeps the session's own folder; a build run is writable and a `--read-only` run stays read-only) or `claude -p --resume`. Pass the whole session id: a shortened one starts a new session.
  Use it for a follow-up on the same work (a review finding, a failing test) instead of re-explaining in a new worker.

A worker reads its surroundings: a ledger or answer lying in a sibling folder is context too. Keep unrelated tasks'
ledgers out of reach of a worker that must not know them.

## Shared memory

Roundtables, minutes and round consolidations were removed: `--meeting`, `minutes` and `consolidate` fail before launch
with one `[dispatch]` line, and the legacy `--skip-meeting` flag is accepted and ignored. Runs with overlapping `--allow`
are no longer refused. What remains is the shared team folder (the Team module, `electron/features/team/team.cjs`).

**The team folder** is `<common>/agentrix/`, `<common>` being `git rev-parse --git-common-dir` from the worker's `--cwd`:
every worktree of one repository sees the same folder, and nothing in it is committed. Outside a git repository there is
no team folder and nothing here applies.
- `memory.md` — the project memory: every worker's `## Findings for the ledger` (also with `--ledger`, which gets them
  too).
- `journal.jsonl` — one JSON object per line, appended by the helper: `end` (a run's end: id, agent, title, session,
  role, model, reason, token totals) and the control and input records of interventions.
- `board/<run id>.json` — one per running worker (id, title, role, agent, model, cwd, allow, the helper's pid, start
  time), written by an atomic rename at the start and removed on every way out. An entry whose pid is not alive is
  stale: it is ignored and removed when seen.

**What every worker reads first** (when the team folder exists): the ledger first when `--ledger` is given, then these
three parts, then the boundary and allowed-files parts:
1. `# Project memory` — the path of `memory.md`, then its newest text within 24 KB (cut at the start, marked `…`).
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
- A Claude worker (`claude -p`) can read only inside its `--cwd`: paste anything else it needs (a review report, a
  plan in the scratch folder) into the brief, or copy it into its worktree. A Codex worker can read outside it.
- Right after launching, read the helper's start line. On `routing unverified`, establish the model before relying on
  routing; on `routing ok`, check any unverified settings separately. Act on `failed to start` or `routing MISMATCH`.
- Before widening one worker's `--allow`, compare it with every live worker's globs (the board): nothing refuses an
  overlap, so two workers given a shared file such as `electron/locales/en.json` overwrite each other. Hand a file to
  the worker that needs it and take it from the other; the lead adds strings or one-line wiring a worker may not touch.
- A follow-up fix after review goes to a fresh session with a focused brief (findings, file:line, done-when) and the
  same module globs. Resuming a long build session costs far more (observed: about 50 min per resume against 5–8 min
  fresh).
- A Codex worker that adds a dependency may pass its tests in its own sandbox while the package never reaches the
  shared `node_modules` (worktrees link it as a junction): after merging, run `npm ci` in the main checkout and the
  worker's tests again before trusting its "tests pass".
- A worker that cannot run commands (a helper-run Claude under `acceptEdits`) ships untested code: tell it which test
  loaders it must satisfy. Example: tests transpile `.ts` with JSX enabled, so `const f = <T>(…) =>` is read as a tag
  and every test that loads the file fails; use `function f<T>(…)` there.
- `--role 调查` with `--allow` writes only inside those globs.
- Claude Code's own Agent tool calls stay as they are: their transcript records are already structured.
- The app no longer parses Bash command lines, briefs or logs to find workers.
