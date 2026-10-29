---
name: model-routing
description: Use before every task in any project, before doing any of it yourself, unless the project has its own model-routing skill; route the task among an architect, core engineer, execution engineer and visual verifier, with fallbacks for either installed agent, fixed model settings and cross review.
trigger: always
when: 每个任务开始前生效；项目已有同名技能时以项目为准
requires: any-agent
title: 模型路由
summary: 每个任务由 Opus 规划审架构，Sol 处理核心代码，Sonnet 做常规功能和前端，Terra 验证界面。GPT 默认 max + fast，Claude 默认 high。
---

# Routing work between models

## When this applies

Read and follow this skill before every task in every session, before planning or doing the work.
If the project has its own model-routing skill in skills/, .claude/skills/ or .codex/skills/, or names it as a word
in its root AGENTS.md or CLAUDE.md, follow that project's skill instead of this built-in.

## What to do

1. Check the installed agents and the project's model settings, then choose the matching setup below.
2. Have the architect plan the work, define separate file scopes and agree the shared contracts before implementation.
3. Route the builds by difficulty, integrate in dependency order and run the project's checks.
4. Complete stage 4 architecture review and UI acceptance where applicable, resolve findings and report the result.

### Roles

The lead session is the **orchestrator**: it splits the task, manages context, routes each part to a model, schedules by
dependency and holds the permissions (commits, pushes, releases, secrets). Workers get only what their brief grants and
do their task themselves; a worker never hands it on to another.

| Role | Takes |
| --- | --- |
| Orchestrator | Plans, briefs, decides, reviews every diff, verifies and releases; takes a task over only when its worker failed |
| Architect | Technology choices, design, task breakdown, interface contracts, architecture review |
| Core engineer | Complex implementation, cross-module refactors, debugging, fixing failing tests |
| Execution engineer | Routine features, front-end components and polish, unit tests, maintenance, docs |
| Visual and verification | UI checks, reading screenshots, driving the interface, small quick tasks |

Pick by the task, not by the side of the code: a hard cross-module change goes to the core engineer wherever it lives,
a routine tweak or a doc edit to the execution engineer, a one-line fix or a screenshot check to the visual engineer.
Review is cross-model where two models exist and never by the author: a fresh worker reviews.

### Stages

Every task goes through these; skip a stage only when the task has nothing for it (a back-end-only fix has no front-end
build and no screenshot pass, a CSS-only change has no core build).

| Stage | What happens | Output |
| --- | --- | --- |
| 1 Plan | Architect: split the task, set constraints, write the interface contract and the acceptance criteria | A written plan |
| 2A Core build | Core engineer in worktree A | Complex logic, refactors, debugging, failing-test fixes |
| 2B Routine build | Execution engineer in worktree B | Routine features, front end, tests, docs |
| 3 Integrate and test | Orchestrator merges the branches in dependency order, runs build and tests | A green merged tree |
| 4 Cross review | Architecture review by the architect; UI and interaction acceptance by the visual engineer | Findings with file, line and failure |
| Final acceptance | Tests pass, every finding is fixed or dismissed with a reason, the user has seen the key changes | Done |

### Model settings

- **GPT models** (Sol, Terra and any other `gpt-*`): default `model_reasoning_effort=max` and `service_tier="fast"`.
- **Claude models** (Opus, Sonnet, Haiku): default effort `high` (`effort: "high"` on an Agent call, `--effort high` for a command-line Claude worker).
- **Whenever Codex is installed**, before the first task of a project, ask the user with options, not an open question
  (the AskUserQuestion tool in Claude Code, a numbered list in Codex):
  1. max + fast (default, recommended): quickest, spends more of the plan's limits
  2. max, fast off: same depth, slower, spends less
  3. Custom: the effort (low, medium, high, xhigh, max) and fast on or off, per model if wanted

  Use the answer for every Codex run in that project. If the session's startup note already carries the project's choice,
  use it and do not ask again; otherwise keep the answer for the session.
- **The user can change these at any time in conversation** ("Terra on high", "turn fast off", "Sonnet on max"): apply the
  change from the next worker on, per model or per family, and state the settings in use when you launch a worker.
  Without an instruction the defaults hold.
- A model missing from the account: use the next one down in the same family for that role (Opus to Sonnet, Sol to Terra)
  and say so in the plan.

### Which setup you are in

Check first: `claude --version` and `codex --version` (a startup note may already say which agents are installed).

#### 1. Claude Code leads, both installed

| Role | Model |
| --- | --- |
| Orchestrator | The lead Claude session |
| Architect and architecture review | Opus (the lead, or a fresh `opus` subagent for the review) |
| Core engineer | GPT-6.1-Sol, a Codex worker (see Launching workers) |
| Execution engineer | Sonnet subagent |
| Visual and verification, small tasks | GPT-6.1-Terra, a Codex worker |

- Sonnet: an Agent call with `model: "sonnet"`, `effort: "high"`, working in worktree B (`isolation: "worktree"` or its path in the brief).
- Sol, as a background command, brief in a file:

  ```
  node "<helper>" codex --role <role> --title "<one line>" --model gpt-6.1-sol --effort max --fast --cwd <worktree-a> --brief <prompt.md> --out <out.md>
  ```

- Terra takes small tasks the same way with `--model gpt-6.1-terra`, and UI acceptance read-only with the screenshots attached:
  `--role <role> --read-only --image <shot1.png> --image <shot2.png>`.

#### 2. Codex leads, both installed

| Role | Model |
| --- | --- |
| Orchestrator and core engineer | GPT-6.1-Sol (the lead session; a Codex worker for a separate core worker) |
| Architect and architecture review | Opus, a Claude worker |
| Execution engineer | Sonnet, a Claude worker run inside worktree B |
| Visual and verification, small tasks | GPT-6.1-Terra, a Codex worker |

- Opus, read-only, brief in a file and the answer in a file:

  ```
  node "<helper>" claude --role <role> --title "<one line>" --model opus --effort high --permission plan --cwd <dir> --brief <brief.md> --out <answer.md>
  ```

- Sonnet edits files, so point it at worktree B:

  ```
  node "<helper>" claude --role <role> --title "<one line>" --model sonnet --effort high --permission acceptEdits --cwd <worktree-b> --brief <brief.md> --out <report.md>
  ```

- Terra: `node "<helper>" codex --role <role> --title "<one line>" --model gpt-6.1-terra --effort max --fast --cwd <dir> --brief <prompt.md> --out <out.md>`;
  for UI acceptance add `--read-only --image <screenshot.png>`.

#### 3. Claude Code only

Every worker is an Agent call with `model` set and `effort: "high"`; worktrees through `isolation: "worktree"`. Split by difficulty:

| Role | Model |
| --- | --- |
| Orchestrator, architect | The lead Claude session (Opus) |
| Core engineer (complex code, refactors, debugging) | Opus subagent |
| Execution engineer (routine work, front end, tests, docs) | Sonnet subagent |
| Visual and verification | Sonnet subagent that reads screenshots |
| Small quick tasks | Haiku subagent |
| Architecture review, UI acceptance | A fresh Opus or Sonnet subagent that did not build it |

#### 4. Codex only

Every worker is a background Codex worker (`node "<helper>" codex --model <model> --effort max --fast --cwd <worktree> …`).

| Role | Model |
| --- | --- |
| Orchestrator, architect, core engineer, architecture review | GPT-6.1-Sol |
| Execution engineer (routine work, front end), visual and verification, small tasks | GPT-6.1-Terra |

The author never reviews its own change: Sol reviews Terra's code (`--read-only`), Terra checks the screens of Sol's work
(`--read-only --image <png>`), each as a fresh run.

### Launching workers

Command-line workers (Codex, or Claude Code through `claude -p`) are started through the dispatch helper, never by
typing `codex exec` or `claude -p` yourself. The helper's path is in the session's startup note (`Dispatch helper: node
"<path>/dispatch.cjs"`); it declares the worker to Agentrix, so the activity pane's called models shows it, and reports how
it ended. Outside Agentrix there is no startup note: start the same workers directly (`codex exec -m <model> -c
model_reasoning_effort=<effort> -c service_tier='"fast"' -C <dir> -o <out.md> - < <brief.md>`, `claude -p --model <model>
--effort <effort> --permission-mode <mode> < <brief.md>`) with the same settings.

```
node "<helper>" codex --role <role> --title "<one line>" --model <model> --effort <effort> [--fast] --cwd <dir> --brief <brief.md> --out <answer.md> [--image <png> …] [--read-only]
node "<helper>" claude --role <role> --title "<one line>" --model <model> --effort <effort> --permission <plan|acceptEdits> --cwd <dir> --brief <brief.md> --out <answer.md>
```

- `--role` says what the worker does (execution, investigation or review; the helper's usage text lists the exact words).
- Run the helper as a background command. It feeds the brief on stdin, exits with the worker's exit code and writes a log
  next to `--out` (`<out>.log`).
- Right after launching, read its `[dispatch] started …` line: it names the model, effort and mode the worker itself
  reports, and `routing ok` confirms they match what you asked for. On `[dispatch] failed to start` fix the brief or
  relaunch; on `routing MISMATCH` stop the worker and relaunch with the intended settings, or tell the user why the
  actual model is acceptable.
- While the worker runs, the activity pane shows its token/s live. When the task finishes, read the `[dispatch] ended …` line: its exit code, reason and the final average token/s.

### 1. Plan

Write the plan before any worker starts:
- The requirement split into tasks, each with an owner and an exact file scope. No file appears in two tasks.
- The interface contract between them (shared types, payloads, names, test hooks). Write it first so every worker builds
  against the same shape.
- Acceptance criteria that can be checked: test names, measured numbers, the screenshots and states to see.

### 2. Build in worktrees

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
- Its report: files changed, the checks it ran with results, what it left open.

A Codex run has no approvals, so its scope comes from the prompt alone. An "at capacity" error at the end of a run can
come after the work is done: check the outputs before rerunning.

### 3. Integrate and test

- Read every diff against the project's conventions and the contract before accepting it; send a diff that breaks them back with the specific lines.
- Commit each worktree on its branch, merge in dependency order (the side that defines data first), resolve conflicts against the contract, not by taking one side.
- Run the project's type check, tests and build. When a test fails, run it on the last commit to tell a regression from an old failure.
- Remove the worktrees and branches when done.

### 4. Review

Run both on the merged result, in parallel where the setup allows:
- **Architecture:** the architect, read-only, given the diff range and the contract, not your conclusions. It checks module boundaries, data flow, duplication and consistency. Findings: file:line, the failure, severity.
- **UI and interaction:** the visual engineer, read-only, with screenshots of each state and the acceptance criteria. Findings: what is wrong, where, which rule.

Each confirmed finding goes back to the worker that owns the file, then stage 3 runs again.

## Rules

- The lead orchestrates and holds permissions; workers stay within their brief and never delegate further.
- Route by difficulty and responsibility, not by renderer versus main-process location.
- Use separate worktrees for parallel builds, with no overlapping file ownership.
- Paste the project's code-standard rules into every worker brief and review every diff against them before accepting it.
- GPT models default to max effort with fast mode; Claude models default to high effort. Honor the user's chosen settings.
- Start command-line workers only through the dispatch helper as background commands, read the start line to confirm the launch and routing, and act on `failed to start` or `routing MISMATCH`.
- Use the one-agent fallback when needed and state unavailable-model substitutions in the plan.
- Review is stage 4: architecture review plus UI and interaction acceptance, with fresh reviewers who did not build the work.
- Follow the user's authorization for commits, builds, app launches and releases; release only when requested.

## Done when

- The relevant checks pass and every review finding is fixed or explicitly dismissed with a reason.
- The user has seen the key behavior changes and, for UI work, the verified screens.
- Report the files changed, checks and results, model substitutions and any remaining limitations.
