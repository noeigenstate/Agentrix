---
name: agent-dispatch
description: Use whenever a session inside Agentrix starts a Codex or Claude Code worker from the command line (codex exec, claude -p) — launch it only through Agentrix's dispatch helper, which declares the assignment to the app and relays the worker's own live events; covers the helper's arguments, the event protocol and what the activity pane shows. Also use when changing the helper, the event server or the called-models pane.
---

# Dispatching command-line workers

The activity pane's 调用的模型 shows command-line workers only from what is declared and then confirmed — never from
guessing a command line. A session inside Agentrix finds the helper's path in its startup note
(`Dispatch helper: node "<path>/dispatch.cjs"`); outside Agentrix (no `AGENTRIX_BOOTSTRAP`) the helper just runs the
worker.

## Launching

```
node "<helper>" codex --role 执行 --title "Fix the cmd prompt reflow" --model gpt-6.1-sol --effort max --fast \
  --cwd <dir> --brief <brief.md> --out <answer.md> [--image <png> …] [--read-only]
node "<helper>" claude --role 审查 --title "Architecture review" --model opus --effort high \
  --permission <plan|acceptEdits> --cwd <dir> --brief <brief.md> --out <answer.md>
```

The helper builds the real command itself (`codex exec -m … -c model_reasoning_effort=… -c service_tier="fast" --json -C …
-o <out> -` / `claude -p --model … --effort … --permission-mode … --output-format stream-json --verbose`), feeds the
brief on stdin, so what is declared is what runs. It exits with the worker's exit code and writes a log next to `--out`
(`<out>.log`). `--role`: 执行, 调查 or 审查. `--title`: one line, what the worker does.

## Events

Sent over the session's authenticated event pipe (`pipeName`, `sessionKey` from `AGENTRIX_BOOTSTRAP`), one JSON line
each, `type` plus these fields:

| type | fields |
| --- | --- |
| `dispatch-start` | `id` (uuid), `agent` (codex/claude), `role`, `title`, `model`, `effort`, `fast`, `cwd`, `brief`, `out`, `startedAt` |
| `dispatch-session` | `id`, `sessionId` (Codex `thread.started.thread_id` / Claude `session_id`), `model` as the worker reports it |
| `dispatch-usage` | `id`, `outputTokens`, `activeMs` for one finished model response (the worker's own usage events) |
| `dispatch-step` | `id`, `text` — the worker's current step, short |
| `dispatch-end` | `id`, `exitCode`, `reason` (`exit`, `killed`, `capacity`, `error`), `endedAt` |

A declared call shows at once (准备中 until `dispatch-session` confirms it, then 运行中); `dispatch-end` moves it to
审核中, and the lead's next round reviews it as before. A start without a confirming session within a minute, or an end
with `reason` other than `exit` and code 0, shows the failure in words. Rate comes only from `dispatch-usage`.

## Rules

- Start every command-line Codex or Claude worker through the helper; never `codex exec` / `claude -p` directly.
- Claude Code's own Agent tool calls stay as they are: their transcript records are already structured.
- The app no longer parses Bash command lines, briefs or logs to find workers.
