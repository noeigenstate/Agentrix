---
name: model-routing
description: Use before any task that changes the project; the lead session is the orchestrator and decides by its own judgment who does the work, itself or any seats of the project's team (by default orchestrator, product, architect, designer, developer, reviewer, QA, researcher, DevOps and security, plus any library or project roles the owner adds), each with fixed model settings; the seats are a toolbox and no stage or seat is mandatory.
trigger: always
when: 每个任务开始前
requires: any-agent
title: 模型路由
summary: 总指挥按席位把任务分给产品、架构、设计、开发、审查、测试、研究、运维和安全角色，能并行的尽量并行。审查和测试由全新实例独立完成。
seats: orchestrator, product, architect, designer, developer, reviewer, qa, researcher, devops, security
library: frontend, backend, desktop, database, ai, docs, performance, a11y
authors: developer, frontend, backend, desktop, database, ai, performance
fresh: reviewer, qa, a11y
duties: orchestrator=总指挥|任务调度|任务调度、依赖管理、状态追踪、冲突协调|任务图、执行状态; product=产品|需求与规划|需求分析、功能定义、优先级|PRD、验收标准; architect=架构师|系统架构|架构设计、技术选型、模块拆分|设计文档、接口规范; designer=设计师|交互与视觉|用户体验、交互、视觉|界面规范、页面原型; developer=开发|编码与实现|编码、功能、缺陷修复|提交、模块; reviewer=审查|独立审查|代码与质量审查|审查意见、风险报告; qa=测试|测试验证|测试用例、自动化、回归、截图验收|测试报告; researcher=研究|技术研究|调研、方案比较、检索|研究报告; devops=运维|构建与交付|构建、环境、部署、回滚|构建产物、部署报告; security=安全|安全与权限|权限、依赖漏洞、安全审计|安全报告; frontend=前端|前端开发|界面组件、状态、样式与交互|界面改动、截图; backend=后端|后端开发|接口、服务、数据流与稳定性|接口改动、测试; desktop=桌面端|桌面开发|窗口、系统集成、打包与更新|代码改动、打包验证; database=数据库|数据与存储|表结构、迁移、查询与索引|迁移脚本、查询改动; ai=人工智能|模型接入|提示词、模型接入、评测与成本|提示词改动、评测报告; docs=文档|文档编写|说明、变更记录、使用指南|文档改动; performance=性能|性能优化|性能剖析、瓶颈、启动与内存|剖析报告、优化改动; a11y=无障碍|无障碍验证|键盘、对比度、读屏与焦点|无障碍报告
---

# Orchestrating the team

## When this applies

Read this skill before any task that changes the project. The lead session is the orchestrator, and the orchestration is
its own judgment: who does the work, in what order, and how it is checked. The team's seats are a toolbox. No seat, stage
or meeting is mandatory, and nothing here is a process to walk through. A plain question that changes nothing needs no
orchestration.
This skill is the single home of routing. To add project-specific routing rules, extend it with a skill named
model-routing-<id>; follow this skill first, and where the two conflict this skill wins.

## What to do

1. Read the task and decide how to staff it: do it yourself, or call the seats that will make the result better or faster. Pick what the task needs, for example an Architect when the split across modules is unclear, a Designer when the look or interaction is open, a Developer for the build, a Reviewer or QA when an independent check is worth its cost.
2. Tell the owner in one or two lines who you chose and why, then start. The owner can change it at any time.
3. Launch the seats you chose with the settings in the team table, in parallel where their work is independent.
4. Check the result yourself to the depth the risk calls for, and report what was done, by whom, and what was verified.

### The team

The lead session is the **orchestrator**: it reads the task, decides the staffing, briefs the workers it calls, integrates
their work and holds the permissions (commits, pushes, releases, secrets). It may do any part of the work itself. Each
seat is a role with a fixed model, effort and fast setting. Agentrix writes the table from the project's routing (the
roles on its team and their models) and the installed agents when it delivers this skill; the table as shipped shows
the defaults with both agents installed and a Claude lead. The project's `.agentrix/routing.json` holds the current
settings; a table delivered when the session started can be older than the file, so read the file when they may differ.

<!-- agentrix:team -->
| Seat | Role | Duty | Outputs | Model | Launch |
| --- | --- | --- | --- | --- | --- |
| orchestrator | Orchestrator | Task scheduling: dependency management, status tracking, conflict coordination | Task graph, execution status | opus · high | this session |
| product | Product | Requirements and planning: requirement analysis, feature definition, priorities | PRD, acceptance criteria | opus · high | Agent call, model "opus", effort "high", description starts with [product] |
| architect | Architect | System architecture: architecture design, technology choices, module split | Design document, interface specification | opus · high | Agent call, model "opus", effort "high", description starts with [architect] |
| designer | Designer | Interaction and visuals: user experience, interaction, visual design | Interface specification, page mockups | sonnet · high | Agent call, model "sonnet", effort "high", description starts with [designer] |
| developer | Developer | Coding and implementation: code, features, bug fixes | Code changes, modules | gpt-6.2-sol · high · fast | helper codex --seat developer --model gpt-6.2-sol --effort high --fast --detach, then wait; specialties: --seat developer/<frontend or backend or desktop or database or ai> |
| reviewer | Reviewer | Independent review: code and quality review | Review findings, risk report | opus · high | Agent call, model "opus", effort "high", description starts with [reviewer] |
| qa | QA / Tester | Testing and verification: test cases, automation, regression, screenshot acceptance | Test report | sonnet · high | Agent call, model "sonnet", effort "high", description starts with [qa] |
| researcher | Researcher | Technical research: investigation, option comparison, lookups | Research report | sonnet · high | Agent call, model "sonnet", effort "high", description starts with [researcher] |
| devops | DevOps | Build and delivery: build, environments, deployment, rollback | Build artifacts, deployment report | gpt-6.2-sol · high · fast | helper codex --seat devops --model gpt-6.2-sol --effort high --fast --detach, then wait |
| security | Security | Security and permissions: permissions, dependency vulnerabilities, security audit | Security report | opus · high | Agent call, model "opus", effort "high", description starts with [security] |
<!-- /agentrix:team -->

- "Agent call" is the lead's own subagent; "helper" is the dispatch helper (see Launching workers), started detached
  and then collected with `wait`. A Codex lead launches Claude seats through `helper claude`.
- A seat has model settings only when it is in the team table. Work that would suit a role outside it goes to whichever
  seat the orchestrator sees fit, or the orchestrator does it.
- The Developer seat may split into specialty workers (frontend, backend, desktop, database, ai), each in its own
  worktree. A specialty with its own row in the team table launches as that seat, as its row says; any other runs on
  the developer seat's model with `--seat developer/<specialty>`.
- Every helper worker call passes `--seat <id>`; every Agent call's `description` starts with `[<seat>]`, for example
  `[designer] Mockup of the settings page`. Agentrix shows each worker under its seat in the Agent tab.
- A worker does its own task and does not start another worker.

### Role library

These roles are not on this project's team and have no model settings. The owner adds one in Agentrix's model routing;
it then moves into the team table with its own model. When one would clearly help a task, say so.

<!-- agentrix:library -->
| Seat | Role | Duty | Outputs |
| --- | --- | --- | --- |
| frontend | Frontend | Front-end development: UI components, state, styling, interaction | UI changes, screenshots |
| backend | Backend | Back-end development: interfaces, services, data flow, reliability | Interface changes, tests |
| desktop | Desktop | Desktop development: windows, system integration, packaging, updates | Code changes, packaging check |
| database | Database | Data and storage: schema, migrations, queries, indexes | Migrations, query changes |
| ai | AI | Model integration: prompts, model access, evaluation, cost | Prompt changes, evaluation report |
| docs | Docs | Documentation: guides, change log, usage | Documentation changes |
| performance | Performance | Performance tuning: profiling, bottlenecks, startup, memory | Profiling report, optimizations |
| a11y | Accessibility | Accessibility verification: keyboard, contrast, screen readers, focus | Accessibility report |
<!-- /agentrix:library -->

### Seats and model settings

Seats decide. An explicit instruction from the owner in the conversation wins for that task only; the Orchestrator states the deviation in its plan.

- Read the model, effort and fast setting of every worker from its seat and state them when you launch it. Do not ask
  the owner about effort or fast; the owner changes seats in Agentrix's model routing.
- Without a delivered table (the skill read outside Agentrix), use the defaults shown above. With only Claude installed,
  Developer is opus · high and DevOps is sonnet · high, and every seat is an Agent call. With only Codex installed, every
  seat is the newest Sol at high effort with fast on, launched through `helper codex`, and the orchestrator is this session.
- GPT models default to high effort with fast on; Claude models default to high effort.
- A model missing from the account: use the next one down in the same family for that seat (Opus to Sonnet) and say so
  in the plan.

### Language and reports

- Every worker writes its visible messages, restatements and reports in the owner's language: the language the owner
  writes to the orchestrator in. Code, identifiers and commit messages follow the project's own convention. Say this in
  every brief.
- The orchestrator reports to the owner in that language. It states the execution logic, then for each problem the
  cause, the fix and the result, with the evidence (tests, CI, review verdicts). A problem still open says so and says
  what comes next.

### Run mode and billing

Dispatching a worker and paying for it are two questions. How a worker is dispatched (the helper, the roundtable, the
`--allow` scope, its entry in the left sidebar) never decides how it is billed, and billing never decides how it is
dispatched. Billing follows the run mode only: native mode (the Claude Agent SDK with the API key saved in Agentrix, or
the Codex app-server) or terminal mode (Claude Code in a terminal, on the subscription).

| Lead | Worker | How the worker runs | Billing |
| --- | --- | --- | --- |
| Codex | Codex | Native mode: the Codex app-server, for the lead and every worker | Codex account |
| Claude, native mode | Claude | The lead's native subagent (an Agent call), or the dispatch helper, which follows the lead's mode | API |
| Claude, terminal mode | Claude | The terminal's own subagent (Claude Code's Agent tool), or the dispatch helper, which runs the worker as a hidden interactive Claude Code session | Subscription |
| Claude, either mode | Codex | The dispatch helper, native mode | Codex account |
| Codex | Claude | The dispatch helper, following Claude's run mode in Settings | API or subscription, see below |

- **Codex always runs in native mode.** There is no terminal mode for Codex, as lead or as worker.
- **A Claude lead's Claude workers follow the lead's run mode and never cross.** A lead in native mode has its workers
  run native, billed to the API. A lead in terminal mode has them run on the subscription. A terminal-mode lead never
  starts a Claude worker on the API, and a native-mode lead never starts one on the subscription. This holds for the
  helper's `claude` command too: Agentrix binds the authenticated lead's mode to the call, so the Settings choice does
  not apply to a Claude lead's workers. A native lead's Claude worker that Agentrix refuses fails; it does not fall back to
  the subscription. Agent calls remain the lead's own subagents and follow the same mode.
- **A Codex lead starts Claude workers with the helper's `claude` command.** The helper asks Agentrix to run the worker
  as a native Claude session. Agentrix applies Claude's run mode from Settings:

  | Setting | The worker runs |
  | --- | --- |
  | API, then terminal when credits run out (default) | Native, billed to the API, while the saved key is ready and credits remain; otherwise as below |
  | API only | Native, billed to the API; it fails to start without a usable key |
  | Terminal only (subscription) | As below |

- **Under a terminal-mode lead, a Claude worker runs as a hidden interactive Claude Code session**, billed to the
  subscription exactly like the owner's terminal. It is not a project terminal: it never appears in the grid, is never
  restored and never arms a completion notification. It shows in the Agent tab with its own rate. When it asks for a
  confirmation its row reads "waiting for your confirmation"; the owner clicks that row and answers in the worker's own
  terminal inside the split. The owner's keys go only to that worker, only while it waits, and nothing is answered
  automatically. When the worker stops, its final answer is written to `--out`. Only an authenticated terminal-mode lead
  on a local project gets this; SSH projects and Codex leads keep the paths below.
- **A Codex lead's Claude workers are unchanged:** they follow the Settings table above and, without the native path,
  take the non-interactive call below.
- **Without the native path, the helper runs Claude Code non-interactively** (streamed output), billed to the
  subscription. This is not an interactive terminal worker.
  The helper takes the same path when it has no connection to Agentrix, outside the app for example, and says so in a
  `[dispatch] transport … claude-cli fallback` line. It never takes this path for a native-mode lead.

### Launching workers

An Agent call names the seat first in its description and takes the seat's model and effort:

```
Agent({ description: "[qa] Accept the settings page", model: "sonnet", effort: "high", prompt: "<brief>" })
```

Codex workers, and Claude workers started from the command line, go through the dispatch helper. Agentrix reroutes
a call made from inside a running Claude Code or Codex session: a `codex exec`, or Claude's non-interactive call, run from
its shell tool is turned into a helper dispatch, shows in the Agent tab with a self-started tag, and takes the lead's run
mode. It is read-only unless it asks for write access. Commands the owner types in a terminal or with `!`, and scripts, run the real CLI as before.
Prefer calling the helper yourself, because then you set the seat, role, brief, output file and `--allow` scope. A rerouted call made from inside a
dispatched worker is refused with `dispatch.intercept_nested`: a worker cannot start another worker except through the dispatcher.
A Codex planner whose `shell_environment_policy` is `inherit = "core"` drops AGENTRIX_* but keeps PATH, so its codex exec or Claude non-interactive call is refused as nested by design; give such a planner the dispatch helper command directly. The helper runs Codex on the app-server (native mode) and runs Claude as described in
Run mode and billing. The helper's path is in the session's startup note (`Dispatch helper: node
"<path>/dispatch.cjs"`); it declares the worker to Agentrix, so the activity pane's called models shows it under its
seat, and reports how it ended. The helper also works outside Agentrix, where there is no startup note: run
`integration/dispatch.cjs` from an Agentrix checkout with Node. With no connection to Agentrix it still runs Codex on the
app-server (native mode) and runs Claude non-interactively. Codex workers always go through the helper. Only when no
helper can be had, start a Claude worker directly with Claude's non-interactive call, passing the same model, effort and
permission mode and the brief on standard input.

```
node "<helper>" codex --detach --seat <id>[/<specialty>] --role <role> --title "<one line>" --model <model> --effort <effort> [--fast] --cwd <dir> --brief <brief.md> --out <answer.md> [--image <png> …] [--read-only] [--allow <glob> …] [--ledger <ledger.md>] [--resume <session>] [--meeting <id>] [--skip-meeting <reason>]
node "<helper>" claude --detach --seat <id>[/<specialty>] --role <role> --title "<one line>" --model <model> --effort <effort> --permission <plan|acceptEdits> --cwd <dir> --brief <brief.md> --out <answer.md> [--allow <glob> …] [--ledger <ledger.md>] [--resume <session>] [--meeting <id>] [--skip-meeting <reason>]
node "<helper>" wait <run id> [<run id> …] --cwd <dir> [--timeout <seconds>]
node "<helper>" minutes --cwd <dir> --meeting <id> --out <minutes.md> [--issues <issues.json>] [--language zh|en]
node "<helper>" consolidate --cwd <dir> --meeting <id> --summary <summary.md>
```

Detached starts return after the start receipt (up to about 60 seconds); if the session is still unknown, the receipt says it follows in `wait`. Start parallel workers with several detached calls, then one `node "<helper>" wait <id-a> <id-b> --cwd <dir>`. `wait` defaults to 540 seconds and refuses timeouts above 570 seconds. Exit 75 means runs remain active: read their last-activity lines and call `wait` again. Exit 0 means all named runs ended; inspect each end line for its worker exit code. `stop <id>` also works for detached runs. Run `wait` with the Bash tool timeout set to `600000` ms, or pass a `--timeout` below the shell's command limit (Claude Bash otherwise stops at 120 seconds). Keep calling `wait` in the same turn; do not end the turn while detached runs remain active. For `wait`, `--cwd` is the worker's folder or any folder in the same Git repository; standalone runs require the worker's folder. `stop` requires Git. Main's signed dispatch events are authoritative; local receipts only report progress to the lead.

- `--seat` names the worker's seat from the team table (with `/<specialty>` for a Developer specialty that has no seat
  of its own); `--role` says
  what the worker does (execution, investigation or review; the helper's usage text lists the exact words).
- Read-only seats (Product, Architect, every reviewer seat, Researcher, Security, and QA or Accessibility when it only
  reads screenshots) run a
  Claude worker with `--permission plan` or a Codex worker with `--read-only`; a seat that edits files gets
  `--permission acceptEdits` or write access, in its own worktree.
- Start the helper with `--detach`, then call `node "<helper>" wait <run id> --cwd <dir>`. It feeds the brief on stdin and writes a log
  next to `--out` (`<out>.log`).
- Right after launching, read its `[dispatch] started …` line: it confirms the start and names the settings the worker
  reports. `routing ok` means reported values match, not that unverified settings are proven; `routing unverified` means
  the model itself is unreported. Verify missing settings before relying on them. On `[dispatch] failed to start` fix the
  brief or relaunch; on `routing MISMATCH` stop the worker and relaunch with the seat's settings, or tell the owner why
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

### Tools the orchestrator may use

None of these is required. Use one when it earns its cost.

**A written plan.** For work across several modules, a plan with one task per worker, an exact file scope each and the
shared contract (types, payloads, names) lets workers build in parallel without colliding. The orchestrator writes it,
or asks the Architect.

**A ledger.** `--ledger <file>` carries the owner's words, decisions and known pitfalls to every worker of a task.

**Worktrees.** One branch and worktree per parallel worker that changes files, from the current HEAD, with dependencies
shared (a link to the main `node_modules`). A single worker may run in the project itself.

```
git worktree add <scratch>/wt-frontend -b work/<topic>-frontend
```

**A brief.** A worker knows only its brief: the goal, what was wrong before, the files it may change, the behaviour it
must keep, the project's code standard, and what to report. A Codex run has no approvals, so its scope comes from the
prompt alone. A non-interactive Claude Code worker (the helper's terminal path) under `--permission acceptEdits` can
edit files but every shell command is refused, so the orchestrator runs its tests.

**A roundtable.** When several workers share an interface, a roundtable lets the orchestrator check that each brief was
read as meant before anyone builds. `--meeting` needs a git repository and a new id per round (`<topic>-r1`,
`[\w.-]{1,64}`).

1. **Understanding.** One run per worker, in parallel, each in its own worktree, with the seat, role and `--allow` it
   will have at work plus `--meeting <id>` (never `--read-only`: the same session builds later; the helper checks that
   no file changed). The brief is the whole plan and that worker's task; the helper adds the request to end with a
   `## Roundtable understanding` block (Goal, Files, Provides, Uses, Done when, Questions and risks). Under Questions and
   risks, list only points where the brief is ambiguous or contradicts itself, and facts in the code that make it
   impossible as written; write `none` if there are none. For a Claude worker use `--permission plan`:

   ```
   node "<helper>" codex --detach --seat <id> --role <role> --meeting <id> --title "<one line>" --model <model> --effort <effort> [--fast] --cwd <worktree> --brief <plan.md> --out <meeting.md> --allow '<module glob>'
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
   node "<helper>" codex --detach --seat <id> --role <role> --meeting <id> --resume <session> --title "<one line>" --model <model> --effort <effort> [--fast] --cwd <worktree> --brief <minutes.md> --out <confirm.md> --allow '<same globs>'
   ```

4. **The owner.** Run `minutes` again after the confirmations and show both tables in your reply and the path of the HTML
   page, then start the build; the owner can change the plan at any time.

The build then resumes each worker's meeting session with the same `--allow` globs. A subagent started through an Agent
call has no helper session: give it the whole plan, ask it to change nothing and restate its task, and show what it
restated beside the minutes. A read-only seat (Product, Architect, Designer, Researcher, any reviewer seat, QA, Security, Accessibility) may take
part with `--meeting` too; the gates apply only to execution runs.

**An independent check.** A reviewer, QA, Security or Accessibility worker that neither planned nor wrote the work,
given the diff range and the requirement, not the orchestrator's conclusions. Each confirmed finding goes back to the
worker that owns the file, or the orchestrator fixes it.

**A round summary.** `node "<helper>" consolidate --cwd <repo> --meeting <id> --summary <summary.md>` appends a summary
(headings `### Results` and `### Architecture changes`) to the shared project memory, which every later helper worker
reads first, and closes the meeting.

**Without a roundtable.** The helper refuses a build with `--allow` that has no confirmed roundtable; pass
`--skip-meeting <reason>` and it starts.

## Rules

- The orchestrator decides the staffing, the order and the checks of every task by its own judgment; no seat, stage or meeting is required.
- The orchestrator holds the permissions: commits, pushes, releases and secrets follow the owner's authorization, and a release happens only when requested.
- A seat's model, effort and fast setting come from the team table; an explicit instruction from the owner in the conversation wins for that task.
- Every helper worker call passes `--seat`; every Agent call's description starts with `[<seat>]`.
- Start command-line workers only through the dispatch helper with `--detach`, then collect results with `wait`; read the start line and act on `failed to start` or `routing MISMATCH`.
- Give a worker that changes files `--allow` for its scope, and deal with any `OUT OF SCOPE` result before accepting the work.
- A worker does not start another worker.
- Codex always runs in native mode. Claude workers follow the lead's run mode and never cross: native-mode lead, native subagents, API billing; terminal-mode lead, terminal subagents, subscription billing.

## Done when

- The task is done and checked to the depth its risk calls for.
- The owner has been told who did the work and why, the files changed, what was verified and what was not, and any remaining limits.
