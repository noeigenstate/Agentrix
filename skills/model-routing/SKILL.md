---
name: model-routing
description: Who does what in this project (with a fallback table for when only Claude Code or only Codex is installed) — the lead orchestrates; Opus 5.5 is the architect, GPT-6.1-Sol the core engineer (complex code, refactors, debugging, test fixes), Sonnet 5.5 the execution engineer (routine features, front end, tests, docs), GPT-6.1-Terra the visual and verification engineer (UI checks, screenshots, interface driving, small tasks). Five steps — Opus plans by module; every worker holds a roundtable with the lead before work and the owner sees the minutes as tables; Sol and Sonnet build in separate worktrees; Opus integrates and runs the tests, Opus reviews the architecture and GPT-6.1-Terra accepts the UI and interaction; the lead consolidates the round into the shared project memory; then final acceptance. GPT models always run at max effort in fast mode, Claude models at high effort. Use at the start of every task, before doing any of it yourself.
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

The owner's pipeline, one round of five steps. Every task goes through these; skip a step only when the task has nothing
for it (a back-end-only fix has no 3B and no Terra pass, a CSS-only change has no 3A; a task too small for a roundtable,
such as one worker and a one-line fix, runs with `--skip-meeting <reason>`).

| Step | Who | What it produces |
| --- | --- | --- |
| 1 Analysis and planning | Lead (Opus 5.5) | Requirement breakdown by module, architecture constraints, interface contracts, acceptance criteria |
| 2 Roundtable | Lead and every worker | Each worker restates its task from the whole plan, the lead answers, everyone confirms; minutes shown to the owner as tables |
| 3A Core | GPT-6.1-Sol (Codex) in worktree A | Complex logic (main process, data, parsing), cross-module refactors, CI diagnosis, all debugging, failing-test fixes |
| 3B Routine and front end | Sonnet subagent in worktree B | Routine features, React components, CSS, layout and polish, unit tests, maintenance, docs |
| 4a Integration and automated tests | Lead | Both branches merged in dependency order; build, unit tests, desktop suites |
| 4b Cross review | Opus 5.5 subagent + GPT-6.1-Terra (Codex) | Opus: cross-module architecture review. Terra: UI and interaction acceptance |
| 5 Consolidation | Lead | The round's results and architecture changes written into the shared project memory; BOUNDARY.md files adjusted |
| Final acceptance | Lead, then the owner | Tests pass + every review finding resolved + the owner confirms key changes |

Concept images to choose from still come from Codex's image tool (see `design-polish`). Every brief carries
`skills/code-standard/SKILL.md`. Workers do their task themselves and never delegate further.

## Model settings (fixed)

- **GPT models** (Sol, Terra, and any other `gpt-*`): default `model_reasoning_effort=max` and `service_tier="fast"`.
- **Claude models** (Sonnet and Opus subagents): default `effort: "high"` on the Agent call (`--effort high` for a command-line Claude worker).
- **First run in a project, whenever Codex is installed** (every case in the table below, including a Codex lead
  session): before the first task, ask the owner with options, not an open question. In Claude Code use the
  AskUserQuestion tool; in Codex, a numbered list:
  1. max + fast (default, recommended): quickest, spends more of the plan's limits
  2. max, fast off: same depth, slower, spends less
  3. Custom: pick the effort (low / medium / high / xhigh / max) and fast on or off, per model if wanted

  Use the answer for every Codex run in that project. If the session's startup note (Agentrix) already carries this
  project's choice, use it and don't ask again; otherwise keep it for the session and ask again in the next one.
- **The owner can change these at any time in conversation** ("Terra 用 high", "关掉 fast", "Sonnet 用 max"): apply the
  change from the next worker on, per model or per family, and state the settings in use when you launch a worker.
  Without an instruction, the defaults above hold.

## When only one agent is installed

Check first: `claude --version` and `codex --version` (Agentrix also states which agents are installed in the session's
startup note). The roles stay; the models filling them change. Review stays cross-model where two models exist, and
never by the author's own context: a fresh worker reviews.

| Role | Both installed | Claude Code only | Codex only |
| --- | --- | --- | --- |
| Orchestrator | Lead session | Lead Claude session | Lead Codex session |
| Architect / planner | Opus 5.5 | Opus 5.5 (lead, or an `opus` subagent) | GPT-6.1-Sol (lead) |
| Core engineer | GPT-6.1-Sol | Opus 5.5 subagent | GPT-6.1-Sol via the dispatch helper |
| Execution engineer | Sonnet 5.5 subagent | Sonnet 5.5 subagent | GPT-6.1-Terra via the dispatch helper |
| Visual and verification | GPT-6.1-Terra | Sonnet 5.5 subagent (reads screenshots) | GPT-6.1-Terra via the dispatch helper with `--image <png>` |
| Small quick tasks | GPT-6.1-Terra | Haiku 5.5 subagent | GPT-6.1-Terra |
| Architecture review | Opus 5.5 subagent | Opus 5.5 subagent (fresh) | GPT-6.1-Sol via the dispatch helper with `--read-only` (fresh) |
| UI acceptance | GPT-6.1-Terra | Sonnet 5.5 subagent (fresh, not the builder) | GPT-6.1-Terra (fresh, not the builder) |

- **Claude Code only:** every worker is an Agent call with `model` set and `effort: "high"`; worktrees through
  `isolation: "worktree"`. Opus takes Sol's hard work; Sonnet keeps routine work and front end and also does the visual
  checks Terra would; Haiku takes one-line fixes and lookups.
- **Codex only:** every worker is a background Codex run through the dispatch helper
  (`--model <model> --effort max --fast --cwd <worktree>`); Sol takes architecture, core code, debugging and the architecture review; Terra takes routine
  work, front end, small tasks and UI checks. The author never reviews its own change: Sol reviews Terra's code, Terra
  checks the screens of Sol's.
- **Settings stay fixed** in every case: GPT max + fast, Claude high.
- **A model missing from the account** (e.g. no Opus access): use the next one down in the same family for that role
  (Opus → Sonnet, Sol → Terra) and say so in the plan.

## 1. Plan (lead)

Write the plan before any worker starts:
- The requirement split into tasks by module, each with an owner (3A or 3B) and an exact file scope. No file appears in
  both. A good split lets each worker stay inside its own module without touching the others.
- The interface contract between them: shared types (`src/shared/types.ts`), IPC payloads, CSS class names, test
  hooks. The lead writes shared types itself before 3A and 3B start, so both build against the same shape.
- Acceptance criteria that can be checked: test names, measured numbers, the screenshots and states Terra must see.
- Each task's module and its `BOUNDARY.md` (`skills/module-boundary`): the task's file scope is that module's Owns (or
  a part of it). A task that needs to change another module is split, or the boundary is changed first by the architect.
- A ledger for the task (`<scratch>/<topic>-ledger.md`, or in the repo when it should be kept): the owner's words that
  decide the work, decisions made in the plan, known pitfalls. Every worker on the task gets it with `--ledger`, so
  briefs never re-state the owner's decisions from memory and findings carry over from one worker to the next. In a git
  repository every worker's findings also go to the project memory (`<git common dir>/agentrix/memory.md`), which every
  worker reads first, so the workers of one round and of later rounds know what the others did.

## 2. Roundtable

Before anyone builds, every worker gets the whole plan plus its own task, changes nothing and restates its understanding;
the lead checks it against the plan. In a git repository the dispatch helper enforces this: it refuses a build whose
session has no confirmed roundtable for the same `--allow` (`--skip-meeting <reason>` is the recorded exception) and
refuses a new round's roundtable while the last round is not consolidated (step 5). `--meeting` needs a git repository.
Pick a **new meeting id every round** (`<topic>-r1`, `<topic>-r2`, `[\w.-]{1,64}`) and keep it through that round's
understanding, confirmation, minutes and consolidation; reusing an earlier round's id is refused, and once a round is
consolidated its meeting is closed, so its confirmations no longer open builds.

1. **Understanding.** One run per worker, in parallel, each in its own worktree. Pass the role and the `--allow` the
   worker will have at work, plus `--meeting` (never `--read-only`: the same session builds later; the helper checks that
   no file changed). The brief is the whole plan and that worker's task. The helper appends the request to end with the
   block `## Roundtable understanding` (Goal / Files / Provides / Uses / Done when / Questions and risks):

   ```
   node "<helper>" codex --role 执行 --meeting <id> --title "<one line>" --model gpt-6.1-sol --effort max --fast --cwd <scratch>/wt-a --brief <scratch>/plan-sol.md --out <scratch>/meet-sol.md --allow '<module glob>' [--ledger <scratch>/<topic>-ledger.md]
   node "<helper>" claude --role 执行 --meeting <id> --title "<one line>" --model sonnet --effort high --permission plan --cwd <scratch>/wt-b --brief <scratch>/plan-sonnet.md --out <scratch>/meet-sonnet.md --allow '<module glob>'
   ```

   A meeting run that changes a file or ends in anything but a clean exit counts as invalid, whatever it answered.
2. **The lead's check.** Read each answer against the plan: do the workers agree on the interfaces they share, are the
   files disjoint, are the questions real? Answer them, then write the disagreements and answers to `issues.json` and
   build the minutes:

   ```
   [{ "issue": "<question or disagreement>", "raisedBy": "<worker>", "answer": "<the lead's answer>", "result": "<settled | changed the plan | open>" }]
   node "<helper>" minutes --cwd <repo> --meeting <id> --out <scratch>/minutes.md --issues <scratch>/issues.json [--language zh|en]
   ```

   `minutes.md` is two Markdown tables (each worker's understanding and status; the issues) and `minutes.html` beside it
   is the same as a page. A worker's unresolved confirmation questions are appended to its questions cell, prefixed
   `未解决：` (`Open: ` with `--language en`), so an `open` worker's questions show without being copied by hand.
3. **Confirmation.** Resume each worker's session with `minutes.md` as the brief; the helper appends the request to end
   with `## Roundtable confirmation` and `Status: confirmed`, or `Status: open` and what is unresolved:

   ```
   node "<helper>" codex --role 执行 --meeting <id> --resume <session> --title "<one line>" --model gpt-6.1-sol --effort max --fast --cwd <scratch>/wt-a --brief <scratch>/minutes.md --out <scratch>/confirm-sol.md --allow '<same globs>'
   ```

   On any `open`, answer it, add it to `issues.json` and repeat from the minutes; change the plan if the answer changes it.
   A build refused for lack of a confirmed roundtable gets this same flow back from the helper: hold the roundtable with
   `--meeting <new id>` and the build's `--allow`, then resume that session for the build with the same globs.
4. **The owner.** Run `minutes` again after the confirmations and show the owner both tables in the reply (the contents
   of `minutes.md`) and the path of `minutes.html`. Then start the build; the owner can change the plan at any time.

A subagent started through the Agent tool has no helper session and is not gated: give it the whole plan, ask it to change
nothing and restate its task, answer in the same conversation, and show what it restated beside the minutes. A 调查 or 审查 worker
may take part with `--meeting` too; gates apply only to 执行 runs.

## 3. Build in two worktrees

Create one branch and worktree per side from the current HEAD, junction `node_modules` into each:

```
git worktree add <scratch>/wt-a -b work/<topic>-a
git worktree add <scratch>/wt-b -b work/<topic>-b
cmd /c mklink /J <scratch>\wt-a\node_modules <repo>\node_modules
```

A task with only one side may run in the repo itself; worktrees are for parallel 3A + 3B work.

**Launching command-line workers.** Sol, Terra (and Opus or Sonnet when Codex leads) start only through Agentrix's
dispatch helper (`skills/agent-dispatch/SKILL.md`), never by typing `codex exec` or `claude -p`. The helper's path is in
the session's startup note (`Dispatch helper: node "<path>/dispatch.cjs"`); outside Agentrix the same workers may be
started directly with `codex exec` / `claude -p` and the same settings. Run it as a background command:

```
node "<helper>" codex --role 执行 --title "<one line>" --model <model> --effort max --fast --cwd <dir> --brief <brief.md> --out <answer.md> [--image <png> …] [--read-only] [--allow <glob> …] [--ledger <ledger.md>] [--resume <session>] [--meeting <id>] [--skip-meeting <reason>]
node "<helper>" claude --role 审查 --title "<one line>" --model <model> --effort high --permission <plan|acceptEdits> --cwd <dir> --brief <brief.md> --out <answer.md>
```

Right after launching, read its `[dispatch] started …` line: it confirms the start and shows which settings the worker
actually reports. `routing ok` means reported values match, not that unverified settings are proven; `routing unverified`
means the model itself is unreported. Verify missing settings before relying on them. On `[dispatch] failed to start` fix
the brief or relaunch; on `routing MISMATCH` stop the worker and relaunch with the intended settings, or tell the owner
why the actual model is acceptable. While the worker runs, the activity pane shows its token/s live. When the task finishes, read the `[dispatch] ended …` line for the exit code, reason and the final average token/s.

- `--allow <glob>` for every worker that changes files: its task's file scope. The helper adds the module's
  `BOUNDARY.md` to the brief and checks the working tree afterwards; an end line with `OUT OF SCOPE: <files>` (pane: 越界)
  is rejected — revert those files and send the work back, or split the task — never accepted silently.
- `--ledger <file>` for every task that has one: the ledger goes before the brief and the worker's `## Findings for the
  ledger` are appended to it (and to the project memory). Read the new findings before the next worker starts.
- `--resume <session>` (the start line's `session`) for a follow-up on the same work — a review finding, a failing
  test — so the worker keeps its context instead of a new brief re-explaining it. The build of a roundtable worker
  resumes its meeting session with the same `--allow` globs; a build without a confirmed roundtable for them is refused.
- Every worker starts with the project memory, the list of what the others are working on now and the repository's state,
  put before its brief by the helper. The helper also refuses a worker whose `--allow` overlaps a running worker's: split
  the scope or run them one after the other.

**3A, Sol.** Resume its roundtable session, run in the background through the helper:

```
node "<helper>" codex --role 执行 --title "<one line>" --model gpt-6.1-sol --effort max --fast --cwd <scratch>/wt-a --brief <scratch>/prompt.md --out <scratch>/out.md --allow '<module glob>' --ledger <scratch>/<topic>-ledger.md --resume <meeting session>
```

Codex runs with no approvals and full access, so the scope comes from the prompt and `--allow`:
- What it may touch: `--allow` with the exact files or module globs, or `--read-only` for an investigation.
- Never: commit, push, release, re-run CI jobs, run the app or its desktop suites (its sandbox cannot run Electron).
- Secrets: helper scripts read a token from `git credential fill` inside themselves; never print it or write it.
- Its report: the root cause with evidence, the change, the tests it ran.
- An "at capacity" error at the end of a run can come after the work is done: check the outputs before rerunning.

A small quick task (a one-line fix, a rename, a screenshot question) goes to Terra with the same command and the same
rules, `--model gpt-6.1-terra`, attaching any screenshots with `--image`.

**3B, Sonnet.** Agent tool with `model: "sonnet"`, `effort: "high"`, working in worktree B (pass its path in the brief, or
`isolation: "worktree"`); a Sonnet that took part in the roundtable through the helper builds as
`claude … --permission acceptEdits --resume <meeting session>` with the same `--allow`. The brief holds:
- The chosen concept, what was wrong before, the files it may change, the behaviour it must keep, the contract from stage 1.
- House rules: AGENTS.md, `design-polish`, `design-acceptance` (grayscale checklist, five questions).
- Checks: `tsc`, `npm test`, a build, screenshots from an isolated probe (`AGENTRIX_DATA_DIR` in a new folder) in dark and
  light at several widths, wrapped in `withGuiLock` from `scripts/gui-lock.mjs`.
- Never: the owner's real Agentrix, its sessions or the system clipboard; never commit, push or release.
- Its report: files changed, checks with results, screenshot paths, measured numbers.

## 4. Integrate and review

### Integrate and test (lead)

- Read every diff against `code-standard` and the stage-1 contract before accepting it.
- Commit each worktree on its branch, then merge into the working branch in dependency order (the side that defines data
  first). Resolve conflicts against the contract, not by taking one side.
- Run `npx tsc --noEmit -p .`, `npm test`, `npm run build`, then the relevant desktop suites one at a time under the GUI lock.
- A merge conflict (usually both sides appending to `electron/locales/en.json`) is resolved and the file validated
  (`JSON.parse`) before `git commit`; never chain the commit after a resolving script on a separate line, where it runs even
  when the script fails.
- When a suite fails, run it against the last commit in a `git worktree` to tell a regression from an old failure.
- Remove worktrees when done: `rmdir` the `node_modules` junction first, then `git worktree remove`, then delete the branches.

### Review

Run both in parallel on the merged result:

- **Opus 5.5, architecture.** Agent tool with `model: "opus"`, `effort: "high"`, read-only. Give it the diff range and the
  stage-1 contract, not the lead's conclusions. It checks module boundaries, data flow across main/renderer/IPC,
  duplication, and accuracy rules (e.g. main vs sub-agent data never mixed). Findings: file:line, the failure, severity.
- **GPT-6.1-Terra, UI and interaction.** Read-only Codex run with the screenshots attached:

  ```
  node "<helper>" codex --role 审查 --title "UI acceptance" --model gpt-6.1-terra --effort max --fast --read-only --cwd <repo> --image <shot1.png> --image <shot2.png> --brief <scratch>/terra-prompt.md --out <scratch>/terra.md
  ```

  The prompt gives the acceptance criteria, the states each screenshot shows, the `design-acceptance` checklist and the
  interaction rules in AGENTS.md (small cards, completion glow). Findings: what is wrong, where, which rule.

Each confirmed finding goes back to the worker that owns the file (Sol or Sonnet) — a command-line worker through
`--resume` with its session — then the integration runs again.

## 5. Consolidate (lead)

When the round is integrated and reviewed, write down what it produced so the next round starts from it. The summary is
a file with two headings; "none" is fine under the second when nothing about the architecture changed, with why:

```
### Results
- what each module now does, the checks that passed, the review findings and how each was settled
### Architecture changes
- module boundaries moved, files that changed owner, new invariants — or "none: <why>"
```

```
node "<helper>" consolidate --cwd <repo> --meeting <id> --summary <scratch>/round-summary.md
```

The helper appends it to the project memory under `## Round <n> · <meeting id> · <date time>`, where every later worker
reads it first and the meeting is closed. `consolidate` is refused while a worker of that meeting still runs, so let the
round's builds and review fixes end first. Adjust the `BOUNDARY.md` files the round touched (Owns, Interface, Invariants,
Not ours) in the same round and commit them; the project memory itself is not committed. The next round's roundtable
(a new meeting id) is refused until this step is done.

## Final acceptance

Done only when: all tests pass, every review finding is fixed or explicitly dismissed with a reason, and the owner has
seen the key changes (screenshots for UI, a short summary for behaviour). Release only when the owner asks.

## The lead's own work

Plan, brief, decide, integrate, verify and release. Take over a task only when its worker failed, or when it is one quick
lookup faster than writing a brief.
