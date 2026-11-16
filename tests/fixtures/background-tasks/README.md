# Background-task evidence and standalone contract

The tests reuse `../claude-user-round-background.json` rather than copying its records. It is a sanitised real Claude
Code **2.1.312** transcript. The original record order and timestamps are preserved. It proves Bash
`run_in_background`, the launch receipt's `toolUseResult.backgroundTaskId`, and completion notifications with both a
`task-id` and `tool-use-id`, first enqueued and then delivered as user records. A queued completion proves the task ended;
delivery does not extend its lifetime. The capture contains no exit code and no meaningful command output.

The **2.1.317 / 2.1.322** files under `../real-cli/` are hook captures, not background-shell transcript captures.
They do not establish polling/cancellation transcript shapes or an exit-code field. The BashOutput / TaskOutput and
KillShell / TaskStop cases in the test file are explicitly synthetic compatibility cases matching the existing
`AgentCalls.apply` contract. The plain "running in background with ID" acknowledgment is also a compatibility case.
The installed SDK's `sdk-tools.d.ts` documents Bash `stdout`, `stderr`, `backgroundTaskId`, and the successful TaskStop
receipt's `task_id` / `task_type`; it does not establish a background-shell exit code in this transcript capture.

## API for integration

```js
const { BackgroundTasks, attach } = require('./background-tasks.cjs');
const background = new BackgroundTasks(terminalId);
background.apply(record); // Feed raw live AND workOnly historical records through this same method.
const agentUsage = attach(usageSnapshot, background.snapshot());
```

Feed historical `workOnly` records **before** `claude-activity.cjs` returns early, so tasks launched before the display
window are not lost. Reset the tracker when its terminal's transcript binding changes. Overlapping history and live
records are idempotent. The stable public `id` is the Bash launch's tool-use ID, scoped by `terminalId`; the CLI task ID
is an internal alias. Finished rows add `endedAt`. All entries have `exitCode: null` until a real transcript field is
established. A tail is the last 200 lines of the latest nonempty inline stdout/stderr observation; `lastOutputAt` is the
record's observation timestamp, and an identical tail does not advance it. Missing output has neither field.

The tracker performs no filesystem reads, process checks, timers, completion/notification callbacks or CLI commands.
It never follows `output-file`, `rawOutputPath` or `persistedOutputPath`. Silence, Stop, a final assistant reply, an
unrecognized acknowledgment or an elapsed interval do not prove a background task ended. If its end receipt is absent,
the row retains the last observed running state. There is no verified replacement completion signal in these captures;
any future additional signal must identify the task and its terminal binding and report an actual end, not idle time.

Finished snapshots retain the latest ten entries, with completion no more than thirty minutes ago. Lightweight receipt
identities survive their rows until reset so replay cannot resurrect expired work. `attach` returns a new usage object
with copied background entries, preserves existing usage fields, and accepts a null usage snapshot.

The lead owns usage wiring after D1, the shared `AgentUsage.background` type and boundary/test registration. D3-ui owns
the read-only split and the approved project/tab/small-card indicators. BG changes no completion or acknowledgment rule.
