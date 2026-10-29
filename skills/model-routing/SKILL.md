---
name: model-routing
description: Who does what in this project — the lead orchestrates; Opus 5.5 is the architect, GPT-6.1-Sol the core engineer (complex code, refactors, debugging, test fixes), Sonnet 5.5 the execution engineer (routine features, front end, tests, docs), GPT-6.1-Terra the visual and verification engineer (UI checks, screenshots, interface driving, small tasks). Four stages — Opus plans; Sol and Sonnet build in separate worktrees; Opus integrates and runs the tests; Opus reviews the architecture and GPT-6.1-Terra accepts the UI and interaction; then final acceptance. GPT models always run at max effort in fast mode, Claude models at high effort. Use at the start of every task, before doing any of it yourself.
---

# Routing work between models

## Roles

A request enters as one natural-language sentence from the owner (or the CLI). The lead session is the
**orchestrator**: it decomposes the task, manages context, routes each part to a model, schedules by dependency and
holds the permissions (commits, pushes, releases, the GUI lock, secrets). Workers get only what their brief grants.

| Model | Role | Takes |
| --- | --- | --- |
| Claude Opus 5.5 | Architect / planner | Technology choices, complex design, task breakdown, architecture consistency (stage 1 and the stage 4 architecture review) |
| GPT-6.1-Sol | Core engineer | Complex implementation, cross-module refactors, debugging, fixing failing tests |
| Claude Sonnet 5.5 | Efficient execution engineer | Routine features, front-end components and polish, unit tests, code maintenance, docs |
| GPT-6.1-Terra | Visual and verification engineer | UI checks, reading screenshots, driving the interface (probe scripts under the GUI lock), small quick tasks |

Pick by the task, not by the side of the code: a hard cross-module change in the renderer still goes to Sol, a routine
main-process tweak or a doc edit to Sonnet, a one-line fix or a screenshot check to Terra. Review is cross-model: no
model accepts its own work (Opus reviews what Sol and Sonnet built, Terra verifies what anyone changed on screen).

## Stages

The owner's pipeline. Every task goes through these stages; skip a stage only when the task has nothing for it
(a back-end-only fix has no 2B and no Terra pass, a CSS-only change has no 2A).

| Stage | Who | What it produces |
| --- | --- | --- |
| 1 Analysis and planning | Lead (Opus 5.5) | Requirement breakdown, architecture constraints, interface contracts, acceptance criteria |
| 2A Core | GPT-6.1-Sol (Codex) in worktree A | Complex logic (main process, data, parsing), cross-module refactors, CI diagnosis, all debugging, failing-test fixes |
| 2B Routine and front end | Sonnet subagent in worktree B | Routine features, React components, CSS, layout and polish, unit tests, maintenance, docs |
| 3 Integration and automated tests | Lead | Both branches merged in dependency order; build, unit tests, desktop suites |
| 4 Cross review | Opus 5.5 subagent + GPT-6.1-Terra (Codex) | Opus: cross-module architecture review. Terra: UI and interaction acceptance |
| Final acceptance | Lead, then the owner | Tests pass + every review finding resolved + the owner confirms key changes |

Concept images to choose from still come from Codex's image tool (see `design-polish`). Every brief carries
`skills/code-standard/SKILL.md`. Workers do their task themselves and never delegate further.

## Model settings (fixed)

- **GPT models** (Sol, Terra, and any other `gpt-*`): always `model_reasoning_effort=max` and `service_tier="fast"`.
- **Claude models** (Sonnet and Opus subagents): always `effort: "high"` on the Agent call.

## 1. Plan (lead)

Write the plan before any worker starts:
- The requirement split into tasks, each with an owner (2A or 2B) and an exact file scope. No file appears in both.
- The interface contract between them: shared types (`src/shared/types.ts`), IPC payloads, CSS class names, test
  hooks. The lead writes shared types itself before 2A and 2B start, so both build against the same shape.
- Acceptance criteria that can be checked: test names, measured numbers, the screenshots and states Terra must see.

## 2. Build in two worktrees

Create one branch and worktree per side from the current HEAD, junction `node_modules` into each:

```
git worktree add <scratch>/wt-a -b work/<topic>-a
git worktree add <scratch>/wt-b -b work/<topic>-b
cmd /c mklink /J <scratch>\wt-a\node_modules <repo>\node_modules
```

A task with only one side may run in the repo itself; worktrees are for parallel 2A + 2B work.

**2A, Sol.** Brief in a scratch file, run in the background:

```
codex exec -m gpt-6.1-sol -c model_reasoning_effort=max -c service_tier='"fast"' -C <scratch>/wt-a -o <scratch>/out.md - < <scratch>/prompt.md > <scratch>/log.txt 2>&1
```

Codex runs with no approvals and full access, so the scope comes from the prompt alone:
- What it may touch: the exact files, or "read-only" for an investigation.
- Never: commit, push, release, re-run CI jobs, run the app or its desktop suites (its sandbox cannot run Electron).
- Secrets: helper scripts read a token from `git credential fill` inside themselves; never print it or write it.
- Its report: the root cause with evidence, the change, the tests it ran.
- An "at capacity" error at the end of a run can come after the work is done: check the outputs before rerunning.

A small quick task (a one-line fix, a rename, a screenshot question) goes to Terra with the same command and the same
rules, `-m gpt-6.1-terra`, attaching any screenshots with `-i`.

**2B, Sonnet.** Agent tool with `model: "sonnet"`, `effort: "high"`, working in worktree B (pass its path in the brief, or
`isolation: "worktree"`). The brief holds:
- The chosen concept, what was wrong before, the files it may change, the behaviour it must keep, the contract from stage 1.
- House rules: AGENTS.md, `design-polish`, `design-acceptance` (grayscale checklist, five questions).
- Checks: `tsc`, `npm test`, a build, screenshots from an isolated probe (`AGENTRIX_DATA_DIR` in a new folder) in dark and
  light at several widths, wrapped in `withGuiLock` from `scripts/gui-lock.mjs`.
- Never: the owner's real Agentrix, its sessions or the system clipboard; never commit, push or release.
- Its report: files changed, checks with results, screenshot paths, measured numbers.

## 3. Integrate and test (lead)

- Read every diff against `code-standard` and the stage-1 contract before accepting it.
- Commit each worktree on its branch, then merge into the working branch in dependency order (the side that defines data
  first). Resolve conflicts against the contract, not by taking one side.
- Run `npx tsc --noEmit -p .`, `npm test`, `npm run build`, then the relevant desktop suites one at a time under the GUI lock.
- When a suite fails, run it against the last commit in a `git worktree` to tell a regression from an old failure.
- Remove worktrees when done: `rmdir` the `node_modules` junction first, then `git worktree remove`, then delete the branches.

## 4. Review

Run both in parallel on the merged result:

- **Opus 5.5, architecture.** Agent tool with `model: "opus"`, `effort: "high"`, read-only. Give it the diff range and the
  stage-1 contract, not the lead's conclusions. It checks module boundaries, data flow across main/renderer/IPC,
  duplication, and accuracy rules (e.g. main vs sub-agent data never mixed). Findings: file:line, the failure, severity.
- **GPT-6.1-Terra, UI and interaction.** Read-only Codex run with the screenshots attached:

  ```
  codex exec -m gpt-6.1-terra -c model_reasoning_effort=max -c service_tier='"fast"' -s read-only -C <repo> -i <shot1.png> -i <shot2.png> -o <scratch>/terra.md - < <scratch>/terra-prompt.md
  ```

  The prompt gives the acceptance criteria, the states each screenshot shows, the `design-acceptance` checklist and the
  interaction rules in AGENTS.md (small cards, completion glow). Findings: what is wrong, where, which rule.

Each confirmed finding goes back to the worker that owns the file (Sol or Sonnet), then stage 3 runs again.

## 5. Final acceptance

Done only when: all tests pass, every review finding is fixed or explicitly dismissed with a reason, and the owner has
seen the key changes (screenshots for UI, a short summary for behaviour). Release only when the owner asks.

## The lead's own work

Plan, brief, decide, integrate, verify and release. Take over a task only when its worker failed, or when it is one quick
lookup faster than writing a brief.
