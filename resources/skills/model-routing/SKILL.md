---
name: model-routing
description: Use before any task that changes the project, however small (a new feature or a change to one, a bug fix or debugging, a UI tweak, tests, a refactor, a review or a release), before doing any of it yourself; route the task among an architect, core engineer, execution engineer and visual verifier, with fallbacks for either installed agent, fixed model settings and cross review.
trigger: auto
when: 新增或修改功能、调试和修复缺陷、改界面、规划、审查或发布时生效，再小的改动也算
requires: any-agent
title: 模型路由
summary: Fable 主控并规划跨模块任务，Opus 规划单模块并审架构，Sol 写核心代码，Sonnet 做常规功能和界面。GPT 默认 high + fast，Claude 默认 high。
---

# Routing work between models

## When this applies

Read and follow this skill before any task that changes the project, however small, before planning or doing the work:
a new feature or a change to one, debugging or a bug fix, a UI tweak, tests, a refactor, a review or a release. Every
such change goes to a worker and the orchestrator never builds it alone. A task too small for a roundtable (one worker
and a one-line fix, for example) skips the roundtable with a stated reason, but is still routed. A plain question that
changes nothing needs no routing.
This skill is the single home of routing. To add project-specific routing rules, extend it with a skill named
model-routing-<id>; follow this skill first, and where the two conflict this skill wins.

## What to do

1. Check the installed agents and the project's model settings, then choose the matching setup below.
2. Have the architect plan the work by module, define separate file scopes and agree the shared contracts before implementation.
3. Hold a roundtable: every worker restates its task from the whole plan, the planner (the orchestrator, checking against the architect's plan) checks the restatement and corrects misreadings, everyone confirms, and the user sees the minutes as tables.
4. Route the builds by difficulty, integrate in dependency order and run the project's checks.
5. Complete stage 4 architecture review and UI acceptance where applicable, resolve findings, consolidate the round into the shared project memory and report the result.

### Roles

The lead session is the **orchestrator**: it splits the task, manages context, routes each part to a model, schedules by
dependency and holds the permissions (commits, pushes, releases, secrets). Workers get only what their brief grants and
do their task themselves; a worker never hands it on to another.

| Role | Takes |
| --- | --- |
| Orchestrator | Plans, briefs, decides, reviews every diff, verifies and releases; takes a task over only when its worker failed, or for one quick lookup faster than writing a brief |
| Architect | Task breakdown by module, technology choices, front-end and interaction design, cross-module contracts, architecture review |
| Core engineer | Back-end design (main process, IPC, storage, data flow and their contracts), complex implementation, cross-module refactors, debugging, fixing failing tests |
| Execution engineer | Routine features, front-end components and polish, unit tests, maintenance, docs |
| Visual and verification | UI checks, reading screenshots, driving the interface, small quick tasks |

Simple lookups go to the smallest model. Searching, reading logs and reading files to find something go to a Haiku subagent
(an Agent call with `model: "haiku"`, or `agentrix-lookup` where the session has it; a Codex lead starts a read-only Haiku
worker through the helper), several in one call, and the orchestrator keeps only the conclusion: every tool call in a long
session re-reads its whole context. The orchestrator still reads for itself what it must judge exactly: a diff under review,
a CI verdict it acts on, the steps of a release. With no Haiku available, it does the lookup itself.

Back-end design and debugging go almost entirely to the core engineer: in the plan the architect splits the work and
names the back-end modules, the core engineer drafts their design (data, interfaces, IPC, storage, failure handling) and
the architect checks it against the module split; every debugging task, front end included, starts with the core engineer.

Pick by the task, not by the side of the code: a hard cross-module change goes to the core engineer wherever it lives,
a routine tweak or a doc edit to the execution engineer, a one-line fix or a screenshot check to the visual engineer.
Review is cross-model where two models exist and never by the author: a fresh worker reviews.

### Where Fable fits

Fable, where the account has it, takes the judgments that cost most when wrong, not the volume of implementation:

| Position | Model |
| --- | --- |
| Orchestrator (briefs, integration, checking review findings, acceptance, failure attribution) | Fable |
| Plan for a task that crosses modules or changes a protocol or contract | Fable |
| Plan for a task inside one module | Opus |
| Architecture review | Opus, always: the planner's model never reviews its own plan or code |
| Core engineer | GPT-6.1-Sol; Fable only by escalation |

Escalate a core build to Fable only when one of these holds, and say which in the plan: the core engineer is unavailable
(not installed, or its usage limit is spent), the same defect is being fixed a second time, or the change crosses three or
more modules. Code Fable writes is reviewed by Opus. Without Fable, Opus takes these positions as before and a fresh Opus
reviews.

### Stages

Every task goes through these; skip a stage only when the task has nothing for it (a back-end-only fix has no front-end
build and no screenshot pass, a CSS-only change has no core build; a task too small for a roundtable, such as one worker
and a one-line fix, skips it with a recorded reason).

| Stage | What happens | Output |
| --- | --- | --- |
| 1 Plan | Architect: split the task by module, set constraints, write the cross-module contract and the acceptance criteria; the core engineer drafts the back-end design | A written plan |
| 2 Roundtable | Every worker gets the whole plan, changes nothing and restates its task; the planner checks and corrects misreadings; all confirm | Minutes, shown to the user as tables |
| 3A Core build | Core engineer in worktree A | Complex logic, refactors, debugging, failing-test fixes |
| 3B Routine build | Execution engineer in worktree B | Routine features, front end, tests, docs |
| 4a Integrate and test | Orchestrator merges the branches in dependency order, runs build and tests | A green merged tree |
| 4b Cross review | Architecture review by the architect; UI and interaction acceptance by the visual engineer | Findings with file, line and failure |
| 5 Consolidate | Orchestrator writes the round's results and architecture changes into the shared project memory and adjusts the module boundaries | The next round starts from them |
| Final acceptance | Tests pass, every finding is fixed or dismissed with a reason, the user has seen the key changes | Done |

### Language and reports

- Every worker writes its visible messages, restatements and reports in the user's language: the language the user writes to
  the orchestrator in. Code, identifiers and commit messages follow the project's own convention. Say this in every brief.
- The orchestrator reports to the user in that language. It states the execution logic, then for each problem the cause, the
  fix and the result, with the evidence (tests, CI, review verdicts). A problem still open says so and says what comes next.

### Model settings

- **GPT models** (Sol and any other `gpt-*`): default `model_reasoning_effort=high` and `service_tier="fast"`.
- **Claude models** (Fable, Opus, Sonnet, Haiku): default effort `high` (`effort: "high"` on an Agent call, `--effort high` for a command-line Claude worker).
- **Whenever Codex is installed**, before the first task of a project, ask the user with options, not an open question
  (the AskUserQuestion tool in Claude Code, a numbered list in Codex):
  1. high + fast (default, recommended): quick, spends more of the plan's limits
  2. high, fast off: same depth, slower, spends less
  3. Custom: the effort (low, medium, high, xhigh, max) and fast on or off, per model if wanted

  Use the answer for every Codex run in that project. If the session's startup note already carries the project's choice,
  use it and do not ask again; otherwise keep the answer for the session.
- **The user can change these at any time in conversation** ("Sol on high", "turn fast off", "Sonnet on max"): apply the
  change from the next worker on, per model or per family, and state the settings in use when you launch a worker.
  Without an instruction the defaults hold.
- A model missing from the account: use the next one down in the same family for that role (Fable to Opus, Opus to Sonnet)
  and say so in the plan.

### Which setup you are in

Check first: `claude --version` and `codex --version` (a startup note may already say which agents are installed).

#### 1. Claude Code leads, both installed

| Role | Model |
| --- | --- |
| Orchestrator | The lead Claude session (Fable where the account has it) |
| Architect | Fable for a cross-module or protocol plan, Opus for a single-module plan (see Where Fable fits) |
| Architecture review | A fresh `opus` subagent |
| Core engineer | GPT-6.1-Sol, a Codex worker (see Launching workers); Fable by escalation |
| Execution engineer | Sonnet subagent |
| Visual and verification, small tasks | A fresh Sonnet subagent that reads screenshots |

- Sonnet: an Agent call with `model: "sonnet"`, `effort: "high"`, working in worktree B (`isolation: "worktree"` or its path in the brief).
- Sol, as a background command, brief in a file:

  ```
  node "<helper>" codex --role <role> --title "<one line>" --model gpt-6.1-sol --effort high --fast --cwd <worktree-a> --brief <prompt.md> --out <out.md>
  ```

- Visual checks, small tasks and UI acceptance go to a Sonnet subagent the same way; UI acceptance by one that did not build the change, given the screenshot paths.

#### 2. Codex leads, both installed

| Role | Model |
| --- | --- |
| Orchestrator and core engineer | GPT-6.1-Sol (the lead session; a Codex worker for a separate core worker) |
| Architect and architecture review | Opus, a Claude worker |
| Execution engineer | Sonnet, a Claude worker run inside worktree B |
| Visual and verification, small tasks | Sonnet, a Claude worker (fresh for UI acceptance) |

- Opus, read-only, brief in a file and the answer in a file:

  ```
  node "<helper>" claude --role <role> --title "<one line>" --model opus --effort high --permission plan --cwd <dir> --brief <brief.md> --out <answer.md>
  ```

- Sonnet edits files, so point it at worktree B:

  ```
  node "<helper>" claude --role <role> --title "<one line>" --model sonnet --effort high --permission acceptEdits --cwd <worktree-b> --brief <brief.md> --out <report.md>
  ```

- Visual checks and UI acceptance: the same Sonnet command, `--permission plan` and the screenshot paths in the brief.

#### 3. Claude Code only

Every worker is an Agent call with `model` set and `effort: "high"`; worktrees through `isolation: "worktree"`. Split by difficulty:

| Role | Model |
| --- | --- |
| Orchestrator, architect | The lead Claude session (Fable where the account has it, otherwise Opus) |
| Core engineer (complex code, refactors, debugging) | Opus subagent; Fable by escalation |
| Execution engineer (routine work, front end, tests, docs) | Sonnet subagent |
| Visual and verification | Sonnet subagent that reads screenshots |
| Small quick tasks | Haiku subagent |
| Architecture review, UI acceptance | A fresh Opus or Sonnet subagent that did not build it |

#### 4. Codex only

Every worker is a background Codex worker (`node "<helper>" codex --model <model> --effort high --fast --cwd <worktree> …`).

| Role | Model |
| --- | --- |
| Orchestrator, architect, core engineer, architecture review | GPT-6.1-Sol |
| Execution engineer, visual and verification, small tasks | GPT-6.1-Sol, in a separate session |

The author never reviews its own change: review and UI acceptance are a fresh Sol run (`--read-only`, with `--image <png>` for screens).

### Launching workers

Command-line workers (Codex, or Claude Code through `claude -p`) are started through the dispatch helper, never by
typing `codex exec` or `claude -p` yourself. The helper's path is in the session's startup note (`Dispatch helper: node
"<path>/dispatch.cjs"`); it declares the worker to Agentrix, so the activity pane's called models shows it, and reports how
it ended. Outside Agentrix there is no startup note: start the same workers directly (`codex exec -m <model> -c
model_reasoning_effort=<effort> -c service_tier='"fast"' -C <dir> -o <out.md> - < <brief.md>`, `claude -p --model <model>
--effort <effort> --permission-mode <mode> < <brief.md>`) with the same settings.

```
node "<helper>" codex --role <role> --title "<one line>" --model <model> --effort <effort> [--fast] --cwd <dir> --brief <brief.md> --out <answer.md> [--image <png> …] [--read-only] [--allow <glob> …] [--ledger <ledger.md>] [--resume <session>] [--meeting <id>] [--skip-meeting <reason>]
node "<helper>" claude --role <role> --title "<one line>" --model <model> --effort <effort> --permission <plan|acceptEdits> --cwd <dir> --brief <brief.md> --out <answer.md> [--allow <glob> …] [--ledger <ledger.md>] [--resume <session>] [--meeting <id>] [--skip-meeting <reason>]
node "<helper>" minutes --cwd <dir> --meeting <id> --out <minutes.md> [--issues <issues.json>] [--language zh|en]
node "<helper>" consolidate --cwd <dir> --meeting <id> --summary <summary.md>
```

- `--role` says what the worker does (execution, investigation or review; the helper's usage text lists the exact words).
- Run the helper as a background command. It feeds the brief on stdin, exits with the worker's exit code and writes a log
  next to `--out` (`<out>.log`).
- Right after launching, read its `[dispatch] started …` line: it confirms the start and names the settings the worker
  reports. `routing ok` means reported values match, not that unverified settings are proven; `routing unverified` means
  the model itself is unreported. Verify missing settings before relying on them. On `[dispatch] failed to start` fix the
  brief or relaunch; on `routing MISMATCH` stop the worker and relaunch with the intended settings, or tell the user why
  the actual model is acceptable.
- While the worker runs, the activity pane shows its token/s live. When the task finishes, read the `[dispatch] ended …` line: its exit code, reason and the final average token/s.
- `--allow <glob>` (repeatable) for every worker that changes files: the task's file scope. The helper adds any
  `BOUNDARY.md` of the modules involved to the brief and checks the git working tree afterwards. An end line with
  `OUT OF SCOPE: <files>` is rejected: revert those files and send the work back, or split the task.
- `--ledger <file>` for a task with decisions to keep: the ledger goes before the brief and the worker's
  `## Findings for the ledger` section is appended to it, so the next worker knows what earlier ones learned.
- `--resume <session>` (the start line's `session`) for a follow-up on the same work, so the worker keeps its context.
- In a git repository the helper keeps a team folder in the repository's git directory, shared by every worktree and never
  committed: the project memory (workers' findings and the orchestrator's round summaries, read first by every worker), a
  journal of the roundtables, and a board of the workers running now. It refuses a build whose `--allow` overlaps a
  running worker's, refuses a build without a confirmed roundtable for the same `--allow` (`--skip-meeting <reason>` is
  the recorded exception), and refuses a new round's roundtable while the last round is not consolidated. Outside a git
  repository none of this applies.
- Every worker starts with the project memory, the list of what the others are working on now and the repository's
  state, put before its brief by the helper.

### 1. Plan

Write the plan before any worker starts:
- The requirement split into tasks by module, each with an owner and an exact file scope. No file appears in two tasks.
  A good split lets each worker stay inside its own module without touching the others.
- Each task's module and its boundary file, if the project keeps one: the task's file scope is that module's owned
  files, or a part of them. A task that needs another module is split, or the architect changes the boundary first.
- The interface contract between them (shared types, payloads, names, test hooks). Write it first so every worker builds
  against the same shape.
- Acceptance criteria that can be checked: test names, measured numbers, the screenshots and states to see.
- A ledger for the task: the user's words that decide the work, the plan's decisions and known pitfalls, given to every
  worker with `--ledger` so no brief re-states them from memory.

### 2. Roundtable

Before anyone builds, the roundtable lets the planner check that its brief reached each worker as meant. The planner is
the orchestrator, who holds the architect's plan; the steps below are addressed to it. Every worker
gets the whole plan plus its own task, changes nothing and restates its own task. Do not propose alternatives or reopen
decisions: design debate is outside the roundtable and the planner decides. `--meeting` needs a git repository. Pick a
**new meeting id every round** (`<topic>-r1`, `<topic>-r2`, `[\w.-]{1,64}`) and keep it through that round's understanding, confirmation, minutes and consolidation;
reusing an earlier round's id is refused, and once a round is consolidated its meeting is closed, so its confirmations
no longer open builds.

1. **Understanding.** One run per worker, in parallel, each in its own worktree, with the role and `--allow` it will have
   at work plus `--meeting <id>` (never `--read-only`: the same session builds later; the helper checks that no file
   changed). The brief is the whole plan and that worker's task; the helper adds the request to end with a
   `## Roundtable understanding` block (Goal, Files, Provides, Uses, Done when, Questions and risks). Under Questions and
   risks, list only points where the brief is ambiguous or contradicts itself, and facts in the code that make it
   impossible as written; write `none` if there are none. For a Claude worker use `--permission plan`:

   ```
   node "<helper>" codex --role <role> --meeting <id> --title "<one line>" --model <model> --effort <effort> --fast --cwd <worktree> --brief <plan.md> --out <meeting.md> --allow '<module glob>'
   ```

2. **The planner's check.** Check each restatement against what the plan meant. Correct misreadings and answer real ambiguities,
   contradictions or code facts that block the brief as written; check that shared interfaces match and file scopes are
   disjoint. The planner decides design questions outside this check. Write the clarifications, corrections and answers
   to `issues.json`, and build the minutes (two Markdown tables, plus the same as an HTML page beside it; a worker's
   unresolved confirmation questions are appended to its questions cell, marked as open in the minutes language):

   ```
   [{ "issue": "<ambiguity, misreading or blocker>", "raisedBy": "<worker>", "answer": "<your answer>", "result": "<settled | changed the plan | open>" }]
   node "<helper>" minutes --cwd <repo> --meeting <id> --out <minutes.md> --issues <issues.json> [--language zh|en]
   ```

3. **Confirmation.** Resume each worker's session with `minutes.md` as the brief. Check that the minutes record its task
   as restated, with the planner's corrections, and that its shared interfaces match the others'. The helper requests
   `## Roundtable confirmation` and `Status: confirmed`; use `Status: open` only for a misreading that is still
   uncorrected, followed by bullets naming it. Correct that misreading and repeat from the minutes. A build refused for
   lack of a confirmed roundtable gets this same flow back from the helper:
   hold the roundtable with `--meeting <new id>` and the build's `--allow`, then resume that session for the build.

   ```
   node "<helper>" codex --role <role> --meeting <id> --resume <session> --title "<one line>" --model <model> --effort <effort> --fast --cwd <worktree> --brief <minutes.md> --out <confirm.md> --allow '<same globs>'
   ```

4. **The user.** Run `minutes` again after the confirmations and show both tables in your reply and the path of the HTML
   page, then start the build; the user can change the plan at any time.

The build then resumes each worker's meeting session with the same `--allow` globs. A subagent started through an Agent
call has no helper session: give it the whole plan, ask it to change nothing and restate its task, and show what it
restated beside the minutes. An investigation or review worker may take part with `--meeting` too; the gates apply only
to execution runs.

### 3. Build in worktrees

One branch and worktree per parallel task, from the current HEAD, with dependencies shared (a link to the main
`node_modules`):

```
git worktree add <scratch>/wt-a -b work/<topic>-a
git worktree add <scratch>/wt-b -b work/<topic>-b
```

A task with one side may run in the project itself. Every brief holds:
- The goal, what was wrong before, the files the worker may change, the behaviour it must keep, the contract from stage 1.
- The `code-standard` skill's rules and the project's own conventions and code standards, pasted in.
- Never: commit, push, release, touch secrets, or touch anything outside its worktree.
- Its report: files changed, the checks it ran with results, what it left open; for debugging, the root cause with evidence.

A Codex run has no approvals, so its scope comes from the prompt alone. An "at capacity" error at the end of a run can
come after the work is done: check the outputs before rerunning.

A command-line Claude worker under `--permission acceptEdits` can edit files, but every shell command is refused and it
cannot commit. Its brief says so: it writes the code and the tests, then you run them in its worktree, send failures back
by resuming the same session, and commit on its branch once they pass.

### 4a. Integrate and test

- Read every diff against the project's conventions and the contract before accepting it; send a diff that breaks them back with the specific lines.
- Commit each worktree on its branch, merge in dependency order (the side that defines data first), resolve conflicts against the contract, not by taking one side.
- Validate a resolved file that has a format (parse a JSON file, for example) before committing, and never chain the
  commit after a resolving script on a separate line, where it runs even when the script fails.
- Run the project's type check, tests and build. When a test fails, run it on the last commit to tell a regression from an old failure.
- Before anything reaches the main branch, run the project's full CI-equivalent locally, including desktop or end-to-end
  suites where it has them, and get its remote CI green on a pushed branch. Move the main branch only to a commit that
  is green there, so it never needs "fix CI" commits; unit tests alone can miss regressions only those suites catch.
- Remove the worktrees and branches when done, removing any dependency link inside a worktree first.

### 4b. Review

Run both on the merged result, in parallel where the setup allows:
- **Architecture:** the architect, read-only, given the diff range and the contract, not your conclusions. It checks module boundaries, data flow, duplication and consistency. Findings: file:line, the failure, severity.
- **UI and interaction:** the visual engineer, read-only, with screenshots of each state, the state each one shows, the acceptance criteria and the project's own interaction rules. Findings: what is wrong, where, which rule.

Each confirmed finding goes back to the worker that owns the file (a command-line worker through `--resume`), then stage 4a runs again.

### 5. Consolidate

When the round is integrated and reviewed, write down what it produced so the next round starts from it: a file with the
headings `### Results` (what each module now does, the checks that passed, the review findings and how each was settled)
and `### Architecture changes` (module boundaries moved, files that changed owner, new invariants; "none" with the reason
when nothing changed). Then:

```
node "<helper>" consolidate --cwd <repo> --meeting <id> --summary <summary.md>
```

The helper appends it to the project memory under `## Round <n> · <meeting id> · <date time>`, where every later worker
reads it first and the meeting is closed. `consolidate` is refused while a worker of that meeting still runs, so let the
round's builds and review fixes end first. Adjust the module-boundary files the round touched in the same round; the
project memory itself is not committed. The next round's roundtable (a new meeting id) is refused until this is done.

## Rules

- The lead orchestrates and holds permissions; workers stay within their brief and never delegate further.
- Route every change to a worker, however small; the lead never builds alone. A task too small for a roundtable skips it with a stated reason.
- Route by difficulty and responsibility, not by renderer versus main-process location.
- Fable orchestrates and plans cross-module work and writes code only by escalation; Opus reviews, and the planner's model never reviews its own work.
- Hand searches, log reads and file reads to a Haiku subagent and keep the conclusion; read yourself only what you must judge exactly.
- Use separate worktrees for parallel builds, with no overlapping file ownership.
- Paste the project's code-standard rules into every worker brief and review every diff against them before accepting it.
- GPT models default to high effort with fast mode; Claude models default to high effort. Honor the user's chosen settings.
- Start command-line workers only through the dispatch helper as background commands, read the start line to confirm the launch and routing, and act on `failed to start` or `routing MISMATCH`.
- Give a worker that changes files `--allow` for its scope and reject any `OUT OF SCOPE` result.
- Hold the roundtable before the build and consolidate the round after the review; show the user the minutes as tables.
- Use the one-agent fallback when needed and state unavailable-model substitutions in the plan.
- Review is stage 4: architecture review plus UI and interaction acceptance, with fresh reviewers who did not build the work.
- Follow the user's authorization for commits, builds, app launches and releases; release only when requested.

## Done when

- The relevant checks pass and every review finding is fixed or explicitly dismissed with a reason.
- The user has seen the key behavior changes and, for UI work, the verified screens.
- Report the files changed, checks and results, model substitutions and any remaining limitations.
