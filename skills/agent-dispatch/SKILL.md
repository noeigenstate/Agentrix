---
name: agent-dispatch
description: Use whenever a session inside Agentrix starts a Codex or Claude Code worker from the command line (codex exec, claude -p) — launch it only through Agentrix's dispatch helper, which declares the assignment to the app and reports how the worker ended; covers the helper's arguments, the event protocol and what the activity pane shows. Also use when changing the helper, the event server or the called-models pane.
---

# Dispatching command-line workers

The activity pane's 调用的模型 shows command-line workers only from what the helper declares at the start and reports at
the end — never from guessing a command line. A session inside Agentrix finds the helper's path in its startup note
(`Dispatch helper: node "<path>/dispatch.cjs"`); outside Agentrix (no `AGENTRIX_BOOTSTRAP`) the helper just runs the
worker.

## Launching

```
node "<helper>" codex --role 执行 --title "Fix the cmd prompt reflow" --model gpt-6.1-sol --effort max --fast \
  --cwd <dir> --brief <brief.md> --out <answer.md> [--image <png> …] [--read-only]
node "<helper>" claude --role 审查 --title "Architecture review" --model opus --effort high \
  --permission <plan|acceptEdits> --cwd <dir> --brief <brief.md> --out <answer.md>
```

The helper builds the real command itself (`codex exec -m … -c model_reasoning_effort=… -c service_tier="fast" --json -C … -o <out> -` /
`claude -p --model … --effort … --permission-mode … --output-format json`; the helper reads these streams itself and
sends only the token rate while the worker runs), feeds the
brief on stdin, so what is declared is what runs. It exits with the worker's exit code and writes a log next to `--out`
(`<out>.log`). `--role`: 执行, 调查 or 审查. `--title`: one line, what the worker does.

## Signals to the lead

The lead starts the helper as a background command and learns from its output that the task is really running. The
helper prints exactly one start line, then exactly one end line, on its stdout:

```
[dispatch] started <id> codex model gpt-6.1-sol effort max fast on · routing ok · pid <n> session <session id>
[dispatch] started <id> codex model gpt-6.1-terra effort high fast off · routing MISMATCH (declared gpt-6.1-sol max fast on) · …
[dispatch] failed to start <id>: <reason>          (instead of "started"; the helper then exits non-zero)
[dispatch] ended <id> codex model gpt-6.1-sol effort max fast on · 43 token/s (5,210 output tokens in 121 s) · exit 0 reason exit · out <answer path>
```

The start line is the lead's proof that the task started and that model routing worked: it states what the worker
itself reports it is running — Codex's header (`model:`, `reasoning effort:`, the service tier when shown, `session
id:`), Claude's session start (model, effort) — and compares it with what was declared. `routing ok` when they match;
`routing MISMATCH (declared …)` otherwise, with the actual values first; a value the worker does not report is written
`unreported`, never assumed. "Started" is printed only once the worker is confirmed running — its process alive and its
session reported — within 30 seconds, else "failed to start". The lead reads the start line right after launching (the
one line it may read from a running background task): on "failed to start" it fixes the brief or relaunches; on a
mismatch it stops the worker and relaunches with the intended settings, or tells the owner why the actual model is
acceptable. It gets the end line when the background task finishes.

Both lines carry the model name, effort and mode (`fast on` / `fast off`, Claude's `fast`/`standard` speed when recorded).
The end line adds the worker's average output rate: output tokens divided by the time its model responses took, from
the worker's own records — Codex's `--json` stream read by the helper (usage per turn and timestamps), Claude's final
`--output-format json` result (`usage.output_tokens`, `duration_api_ms`). Reasoning tokens already inside output tokens
are not added again. No usable record: `token/s unreported`.

## Events to Agentrix

Events over the session's authenticated event pipe (`pipeName`, `sessionKey` from `AGENTRIX_BOOTSTRAP`), one JSON line
each: `dispatch-start` and `dispatch-end` at the same moments as the two lines above, and in between only the token
rate, live:

| type | fields |
| --- | --- |
| `dispatch-start` | `id` (uuid), `agent` (codex/claude), `role`, `title`, `model`, `effort`, `fast` (as the worker reports them; `declared` holds the declared three when they differ), `cwd`, `brief`, `out`, `sessionId`, `startedAt` |
| `dispatch-rate` | `id`, `outputTokens`, `activeMs` — running totals, sent after each finished model response of the worker (at most once per 2 s) |
| `dispatch-end` | `id`, `model`, `effort`, `fast`, `exitCode`, `reason` (`exit`, `killed`, `capacity`, `error`, `unconfirmed`), `outputTokens`, `activeMs` (null when unreported), `endedAt` |

`dispatch-start` shows the row as 运行中 with the model, effort and mode the worker reports (a mismatch is noted in the
row's tooltip). `dispatch-end` with `reason` exit and
code 0 shows 已完成 and the row is removed 3 seconds later; any other end (未能启动 for unconfirmed, 模型满载, 已停止,
出错退出（代码 N）) stays visible until the lead's next round so it is not missed. The helper finds the reason from the
worker's exit code and the end of its own output (e.g. "at capacity"). `dispatch-rate` makes the running row's model
group show its token/s while the worker runs (the same TokenRates as other calls); `dispatch-end`'s totals are the
last word. The rate is the only thing sent while a worker runs.

## Rules

- Start every command-line Codex or Claude worker through the helper, as a background command; never `codex exec` /
  `claude -p` directly.
- Right after launching, read the helper's start line; treat anything but `[dispatch] started … routing ok` as a launch
  to fix before relying on the worker.
- Claude Code's own Agent tool calls stay as they are: their transcript records are already structured.
- The app no longer parses Bash command lines, briefs or logs to find workers.
