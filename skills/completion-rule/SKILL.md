---
name: completion-rule
description: When a project counts as finished in Agentrix (等待你查看, the white glow, the completion notification): every task and subtask done, long-running services excluded. Use before changing completion state, the prompt queue, `.panel-signal` CSS or the completion smoke.
---

# A project is finished only when all of its work is done

The owner's rule: one task or subagent finishing never lights the card; the whole project's work must be done.

**Signal on screen**
- A grid card that is finished and not yet seen breathes a white glow from its edge inward. The glow has no line and no coloured ring.
- A viewed round draws nothing.
- Focus mode draws no edge at all.
- Working (blue) and error (red) edges stay.

**Finished means all of these** (`electron/completion-work.cjs`, the gate in `main.cjs` `applyActivity`):
- The parent's turn has ended.
- Every tracked background job has an end receipt, matched by task or tool-use id:
  - Claude Code background agents and Bash: a `<task-notification>` of any status, a TaskStop/KillShell result, or a TaskOutput terminal status;
  - Codex child agents: FINAL_ANSWER, a wait or list status, close or interrupt.
- A recorded queued message holds completion until its own round ends.
- Every other agent terminal of the project is complete.

**Never tracked; these never block:**
- Long-running services: dev and preview servers, watchers, `tail -f`, attached `docker compose up` (`SERVICE_COMMANDS`).
- Codex shell sessions, yielded cells and native commands left after the parent's turn. Nothing wakes the agent when they end.
- A todo or plan list. An agent that ends its turn to ask something is waiting for the owner.

**Expiry**
- A submission the agent never records, such as an answer typed into a question, is dropped after the queue's 20 s grace. It releases the completion; it never turns the round 已中断.
- A tracked job with no end receipt expires 12 h after launch: 已中断, no success alert.
- Discarded history (SSH record eviction) fails closed.

**Never**
- Rearm a completion from idle or background callbacks.
- Add a manual completion control.

**Testing**
- Record sequences in `tests/completion-work.test.cjs` and `tests/backend-activity.test.cjs`.
- `npm run test:completion`.
- Before shipping a rule change, replay the real transcripts read-only and report how many completions it delays (median, p90) and how many hit the fallback.
