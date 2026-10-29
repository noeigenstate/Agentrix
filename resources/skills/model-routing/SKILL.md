---
name: model-routing
title: 模型路由
summary: 谁来做什么：Opus 规划与审查架构，GPT-6.1-Sol 写核心代码并调试，Sonnet 做日常与前端，GPT-6.1-Terra 验收界面并处理小任务。GPT 默认 max + fast，Claude 默认 high；只装了一个 Agent 时也有对应分工。
description: Who does what on a task, for any project. The lead session orchestrates; Opus plans and reviews the architecture, GPT-6.1-Sol writes the core code and debugs, Sonnet does routine work and front end, GPT-6.1-Terra checks the interface and takes small tasks. Four stages - plan, build in separate worktrees, integrate and test, cross review, then final acceptance. GPT models default to max effort in fast mode, Claude models to high effort. Covers four setups - Claude Code or Codex leading with both installed, Claude Code only, Codex only. Use at the start of every task, before doing any of it yourself.
---

# Routing work between models

## Roles

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

## Stages

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

## Model settings

- **GPT models** (Sol, Terra and any other `gpt-*`): default `model_reasoning_effort=max` and `service_tier="fast"`.
- **Claude models** (Opus, Sonnet, Haiku): default effort `high` (`effort: "high"` on an Agent call, `--effort high` for `claude -p`).
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

## Which setup you are in

Check first: `claude --version` and `codex --version` (a startup note may already say which agents are installed).

### 1. Claude Code leads, both installed

| Role | Model |
| --- | --- |
| Orchestrator | The lead Claude session |
| Architect and architecture review | Opus (the lead, or a fresh `opus` subagent for the review) |
| Core engineer | GPT-6.1-Sol via `codex exec` |
| Execution engineer | Sonnet subagent |
| Visual and verification, small tasks | GPT-6.1-Terra via `codex exec` |

- Sonnet: an Agent call with `model: "sonnet"`, `effort: "high"`, working in worktree B (`isolation: "worktree"` or its path in the brief).
- Sol, in the background, brief in a file:

  ```
  codex exec -m gpt-6.1-sol -c model_reasoning_effort=max -c service_tier='"fast"' -C <worktree-a> -o <out.md> - < <prompt.md> > <log.txt> 2>&1
  ```

- Terra takes small tasks the same way with `-m gpt-6.1-terra`, and UI acceptance read-only with the screenshots attached:
  `-s read-only -i <shot1.png> -i <shot2.png>`.

### 2. Codex leads, both installed

| Role | Model |
| --- | --- |
| Orchestrator and core engineer | GPT-6.1-Sol (the lead session; `codex exec` for a separate core worker) |
| Architect and architecture review | Opus via `claude -p` |
| Execution engineer | Sonnet via `claude -p`, run inside worktree B |
| Visual and verification, small tasks | GPT-6.1-Terra via `codex exec` |

- Opus, read-only, brief on stdin and the answer in a file:

  ```
  claude -p --model opus --effort high --permission-mode plan < <brief.md> > <answer.md>
  ```

- Sonnet edits files, so start it inside worktree B:

  ```
  cd <worktree-b> && claude -p --model sonnet --effort high --permission-mode acceptEdits < <brief.md> > <report.md>
  ```

- Terra: `codex exec -m gpt-6.1-terra -c model_reasoning_effort=max -c service_tier='"fast"' -C <dir> -o <out.md> - < <prompt.md>`;
  for UI acceptance add `-s read-only -i <screenshot.png>`.

### 3. Claude Code only

Every worker is an Agent call with `model` set and `effort: "high"`; worktrees through `isolation: "worktree"`. Split by difficulty:

| Role | Model |
| --- | --- |
| Orchestrator, architect | The lead Claude session (Opus) |
| Core engineer (complex code, refactors, debugging) | Opus subagent |
| Execution engineer (routine work, front end, tests, docs) | Sonnet subagent |
| Visual and verification | Sonnet subagent that reads screenshots |
| Small quick tasks | Haiku subagent |
| Architecture review, UI acceptance | A fresh Opus or Sonnet subagent that did not build it |

### 4. Codex only

Every worker is a background `codex exec -m <model> -c model_reasoning_effort=max -c service_tier='"fast"' -C <worktree>` run.

| Role | Model |
| --- | --- |
| Orchestrator, architect, core engineer, architecture review | GPT-6.1-Sol |
| Execution engineer (routine work, front end), visual and verification, small tasks | GPT-6.1-Terra |

The author never reviews its own change: Sol reviews Terra's code (`-s read-only`), Terra checks the screens of Sol's work
(`-s read-only -i <png>`), each as a fresh run.

## 1. Plan

Write the plan before any worker starts:
- The requirement split into tasks, each with an owner and an exact file scope. No file appears in two tasks.
- The interface contract between them (shared types, payloads, names, test hooks). Write it first so every worker builds
  against the same shape.
- Acceptance criteria that can be checked: test names, measured numbers, the screenshots and states to see.

## 2. Build in worktrees

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

## 3. Integrate and test

- Read every diff against the project's conventions and the contract before accepting it; send a diff that breaks them back with the specific lines.
- Commit each worktree on its branch, merge in dependency order (the side that defines data first), resolve conflicts against the contract, not by taking one side.
- Run the project's type check, tests and build. When a test fails, run it on the last commit to tell a regression from an old failure.
- Remove the worktrees and branches when done.

## 4. Review

Run both on the merged result, in parallel where the setup allows:
- **Architecture:** the architect, read-only, given the diff range and the contract, not your conclusions. It checks module boundaries, data flow, duplication and consistency. Findings: file:line, the failure, severity.
- **UI and interaction:** the visual engineer, read-only, with screenshots of each state and the acceptance criteria. Findings: what is wrong, where, which rule.

Each confirmed finding goes back to the worker that owns the file, then stage 3 runs again.

## 5. Final acceptance

Done only when all tests pass, every review finding is fixed or dismissed with a reason, and the user has seen the key
changes (screenshots for UI, a short summary for behaviour). Release only when the user asks.
