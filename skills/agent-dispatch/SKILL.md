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

The helper builds the real command itself (`codex exec -m … -c model_reasoning_effort=… -c service_tier="fast" -C … -o <out> -` /
`claude -p --model … --effort … --permission-mode …`), feeds the
brief on stdin, so what is declared is what runs. It exits with the worker's exit code and writes a log next to `--out`
(`<out>.log`). `--role`: 执行, 调查 or 审查. `--title`: one line, what the worker does.

## Signals to the lead

The lead starts the helper as a background command and learns from its output that the task is really running. The
helper prints exactly one start line, then exactly one end line, on its stdout:

```
[dispatch] started <id> codex gpt-6.1-sol max fast pid <n> session <session id>
[dispatch] failed to start <id>: <reason>          (instead of "started"; the helper then exits non-zero)
[dispatch] ended <id> exit <code> reason <exit|killed|capacity|error> out <answer path>
```

"Started" is printed only once the worker is confirmed running: its process is alive and it has reported its session
(Codex prints `session id:` in its header; Claude creates its session) — within 30 seconds, else "failed to start". The
lead reads the start line right after launching (it is the one line it may read from a running background task),
relaunches or fixes the brief on "failed to start", and gets the end line when the background task finishes.

## Events to Agentrix

Two events over the session's authenticated event pipe (`pipeName`, `sessionKey` from `AGENTRIX_BOOTSTRAP`), one JSON
line each, sent at the same moments as the two lines above — nothing in between:

| type | fields |
| --- | --- |
| `dispatch-start` | `id` (uuid), `agent` (codex/claude), `role`, `title`, `model`, `effort`, `fast`, `cwd`, `brief`, `out`, `sessionId`, `startedAt` |
| `dispatch-end` | `id`, `exitCode`, `reason` (`exit`, `killed`, `capacity`, `error`, `unconfirmed`), `endedAt` |

`dispatch-start` shows the row as 运行中 with the declared model, effort and mode. `dispatch-end` with `reason` exit and
code 0 shows 已完成 and the row is removed 3 seconds later; any other end (未能启动 for unconfirmed, 模型满载, 已停止,
出错退出（代码 N）) stays visible until the lead's next round so it is not missed. The helper finds the reason from the
worker's exit code and the end of its own output (e.g. "at capacity"). Dispatched rows show no token rate.

## Rules

- Start every command-line Codex or Claude worker through the helper, as a background command; never `codex exec` /
  `claude -p` directly.
- Right after launching, read the helper's start line; treat anything but `[dispatch] started` as a failed launch.
- Claude Code's own Agent tool calls stay as they are: their transcript records are already structured.
- The app no longer parses Bash command lines, briefs or logs to find workers.
