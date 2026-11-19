---
name: model-routing
description: Use before any task that changes the project, however small (a new feature or a change to one, a bug fix or debugging, a UI tweak, tests, a refactor, a review or a release), before doing any of it yourself; route the task across the seats of the project's team (by default orchestrator, product, architect, designer, developer, reviewer, QA, researcher, DevOps and security, plus any library or project roles the owner adds), each with fixed model settings, run independent work in parallel and have fresh instances review and test it.
trigger: auto
when: 新增或修改功能、调试和修复缺陷、改界面、规划、审查或发布时生效，再小的改动也算
requires: any-agent
title: 模型路由
summary: 总指挥按席位把任务分给产品、架构、设计、开发、审查、测试、研究、运维和安全角色，能并行的尽量并行。审查和测试由全新实例独立完成。
seats: orchestrator, product, architect, designer, developer, reviewer, qa, researcher, devops, security
library: frontend, backend, desktop, database, ai, docs, performance, a11y
authors: developer, frontend, backend, desktop, database, ai, performance
fresh: reviewer, qa, a11y
duties: orchestrator=总指挥|任务调度|任务调度、依赖管理、状态追踪、冲突协调|任务图、执行状态; product=产品|需求与规划|需求分析、功能定义、优先级|PRD、验收标准; architect=架构师|系统架构|架构设计、技术选型、模块拆分|设计文档、接口规范; designer=设计师|交互与视觉|用户体验、交互、视觉|界面规范、页面原型; developer=开发|编码与实现|编码、功能、缺陷修复|提交、模块; reviewer=审查|独立审查|代码与质量审查|审查意见、风险报告; qa=测试|测试验证|测试用例、自动化、回归、截图验收|测试报告; researcher=研究|技术研究|调研、方案比较、检索|研究报告; devops=运维|构建与交付|构建、环境、部署、回滚|构建产物、部署报告; security=安全|安全与权限|权限、依赖漏洞、安全审计|安全报告; frontend=前端|前端开发|界面组件、状态、样式与交互|界面改动、截图; backend=后端|后端开发|接口、服务、数据流与稳定性|接口改动、测试; desktop=桌面端|桌面开发|窗口、系统集成、打包与更新|代码改动、打包验证; database=数据库|数据与存储|表结构、迁移、查询与索引|迁移脚本、查询改动; ai=人工智能|模型接入|提示词、模型接入、评测与成本|提示词改动、评测报告; docs=文档|文档编写|说明、变更记录、使用指南|文档改动; performance=性能|性能优化|性能剖析、瓶颈、启动与内存|剖析报告、优化改动; a11y=无障碍|无障碍验证|键盘、对比度、读屏与焦点|无障碍报告
---

# Routing work across the team

## When this applies

Read and follow this skill before any task that changes the project, however small, before planning or doing the work:
a new feature or a change to one, debugging or a bug fix, a UI tweak, tests, a refactor, a review or a release. Every
such change goes to a worker and the orchestrator never builds it alone. A task too small for a roundtable (one worker
and a one-line fix, for example) skips the roundtable with a stated reason, but is still routed. A plain question that
changes nothing needs no routing.
This skill is the single home of routing. To add project-specific routing rules, extend it with a skill named
model-routing-<id>; follow this skill first, and where the two conflict this skill wins.

## What to do

1. Check the installed agents, the team table below and the lead's run mode (native or terminal). Launch only seats in the team table. Decide which of them the task needs and record the reason for every one you skip.
2. Discover: Product writes the requirement and its acceptance criteria while Researcher compares options and gathers the facts the plan needs, in parallel.
3. Design: Architect plans the work by module, with separate file scopes and the shared contracts, while Designer specifies the interaction and visuals, in parallel.
4. Hold a roundtable: every worker restates its task from the whole plan, the orchestrator checks the restatement against the plan and corrects misreadings, everyone confirms, and the owner sees the minutes as tables.
5. Build: Developer workers in parallel worktrees with disjoint `--allow` scopes, one per specialty the plan needs, each on its specialty's seat when the team table has one, else on the developer seat's model; Performance and Docs build here too.
6. Verify: every reviewer seat, QA, Security and Accessibility, each a fresh instance, in parallel on the integrated result; send every confirmed finding back to the worker that owns the file.
7. Integrate and deliver: the orchestrator merges in dependency order and runs the project's checks; DevOps builds, deploys or rolls back only when a release is requested. Then consolidate the round into the shared project memory and report the result.

### The team

The lead session is the **orchestrator**: it splits the task, manages context, routes each part to a seat, schedules by
dependency, runs independent work in parallel and holds the permissions (commits, pushes, releases, secrets). It takes a
task over only when its worker failed. Workers get only what their brief grants and do their task themselves; a worker
never hands it on to another.

Each seat is a role with a fixed model, effort and fast setting. Agentrix writes the table from the project's routing
(the roles on its team and their models) and the installed agents when it delivers this skill; the table as shipped
shows the defaults with both agents installed and a Claude lead.

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
- Launch only seats in the team table. A seat named elsewhere in this skill (the stages, the role library, an example)
  but missing from the table is not on this project's team: skip it without a reason and give its work to the seat
  that covers it (a specialty to Developer, documentation to the worker that made the change, accessibility to QA).
- The Developer seat may split into specialty workers (frontend, backend, desktop, database, ai) when the plan has
  independent parts, each in its own worktree. A specialty with its own row in the team table launches as that seat,
  as its row says; any other runs on the developer seat's model with `--seat developer/<specialty>`.
- Every helper worker call passes `--seat <id>`; every Agent call's `description` starts with `[<seat>]`, for example
  `[designer] Mockup of the settings page`. Agentrix shows each worker under its seat in the Agent tab.
- Quick lookups are not a seat. Searching, reading logs and reading files to find something go to the lookup
  operation's model (see Operation models), launched as its row says for the lead's agent, several in one call, and the
  orchestrator keeps only the conclusion: every tool call in a long session re-reads its whole context. The orchestrator
  still reads for itself what it must judge exactly: a diff under review, a CI verdict it acts on, the steps of a
  release. When the lookup operation's model is not available, it does the lookup itself.
- Every reviewer seat (Reviewer and any project role that reviews), QA and Accessibility are always fresh instances
  that neither planned nor wrote the work. Every reviewer seat uses a model that no author seat (Developer, its
  specialty seats, Performance) runs, wherever the account has an available model at least as strong.

### Role library

These roles are not on this project's team, so they are never launched. The owner adds one in Agentrix's model
routing; it then moves into the team table with its own model. When one would clearly help a task, say so in the plan.

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

### Operation models

Seats say who does a kind of task; operations say which model runs a specific step inside any session, whoever does
the task: lookups, background helper calls, sub-agents started without a model, memory upkeep and Codex's review pass.
Operation slots apply inside every session Agentrix starts, workers included. When they disagree, the owner's explicit
instruction for a task wins, then a seat's model when a worker is launched, then the operation slot, then the agent's
built-in default. Each column says what applies in a conversation led by that agent. Agentrix fills the Claude and
Codex cells from the project's saved operations when it delivers this skill; the table as shipped shows the defaults.
Compaction and titles are listed so their models are not guessed: Agentrix cannot set them.

<!-- agentrix:operations -->
| Operation | Name | Covers | Claude | Codex |
| --- | --- | --- | --- | --- |
| lookup | Lookup | Searching, listing and reading files, log excerpts | haiku · high; agentrix-lookup in native mode, else Agent call, model "haiku", effort "high" | haiku · high; helper claude --seat researcher --model haiku --effort high --permission plan --detach, then wait |
| background | Background helpers | Claude Code's own light background calls; titles and web-page summaries move with it | haiku | not controllable |
| subagent | Sub-agent default | Sub-agents started without an explicit model | follows the conversation | follows the conversation |
| memory | Memory | Extracting and consolidating memories | not controllable | Codex default |
| review | Review pass | Codex's built-in review (/review, review/start) | not controllable (review is the Reviewer seat) | Codex default |
| compaction | Compaction | Compacting a long conversation's context | not controllable (built into Claude Code / Codex) | not controllable (built into Claude Code / Codex) |
| titles | Titles | Conversation titles | not controllable (moves with background) | not controllable (built into Codex) |
<!-- /agentrix:operations -->

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

### Stages

Run independent work in parallel as much as possible: start every worker whose inputs are ready in the same turn.

| Stage | Seats | What happens | Output |
| --- | --- | --- | --- |
| 1 Discover | Product, Researcher, in parallel | Product writes the requirement, its priorities and the acceptance criteria first; Researcher compares options and checks facts | PRD with acceptance criteria, research report |
| 2 Design | Architect, Designer, in parallel | Architect splits the work by module, sets constraints and writes the cross-module contract; Designer specifies interaction and visuals, with mockups where the change is visible | Written plan, interface specification |
| 3 Roundtable | Every worker of the round | Every worker gets the whole plan, changes nothing and restates its task; the orchestrator checks and corrects misreadings; all confirm | Minutes, shown to the owner as tables |
| 4 Build | Developer and its specialty seats, Performance, Docs, in parallel | One worktree and a disjoint `--allow` scope per worker; a specialty without its own seat runs on the developer seat's model; Performance measures before it changes code; Docs writes the documentation the change needs | Code changes and tests per module; measurements; documentation |
| 5 Verify | Every reviewer seat, QA, Security, Accessibility, in parallel, fresh | Independent review, testing and UI acceptance, security audit and accessibility check of the integrated result | Findings with file, line and failure; test report; security report; accessibility report |
| 6 Integrate and deliver | Orchestrator, then DevOps | The orchestrator merges in dependency order and runs the checks; DevOps builds, deploys or rolls back only when a release is requested | A green merged tree; build artifacts and deployment report when released |
| 7 Consolidate | Orchestrator | Writes the round's results and architecture changes into the shared project memory and adjusts the module boundaries | The next round starts from them |
| Final acceptance | Orchestrator | Checks pass, every finding is fixed or dismissed with a reason, the owner has seen the key changes | Done |

Skip any seat a task does not need and record the reason in the plan: a back-end-only fix has no Designer and no
screenshot pass, a change that adds no permission, file-read, process or dependency surface has no Security pass, and
DevOps runs only for a requested release. Verification runs on what was integrated, so stage 6's merge and checks come
before stage 5's verdicts are final; findings loop back to stage 4.

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

### 1-2. Discover and design

Write the plan before any build starts. Product and Researcher work first and in parallel, then Architect and Designer
in parallel, each given what the earlier seats produced:
- Product: the requirement, its priorities and checkable acceptance criteria (test names, measured numbers, the
  screenshots and states to see), written before the design.
- Researcher: the options compared with their trade-offs and the facts the plan depends on, with sources.
- Architect: the requirement split into tasks by module, each with an owner seat and an exact file scope; no file
  appears in two tasks. A good split lets each worker stay inside its own module without touching the others. Each
  task's module and its boundary file, if the project keeps one: the task's file scope is that module's owned files, or
  a part of them; a task that needs another module is split, or the architect changes the boundary first. The interface
  contract between tasks (shared types, payloads, names, test hooks), written first so every worker builds against the
  same shape. Back-end modules get their design (data, interfaces, IPC, storage, failure handling) in the plan.
- Designer: the interaction and visual specification of every visible change, with mockups the owner can compare.
- The orchestrator: the seats the task uses, the reason for each skipped seat, any deviation from a seat the owner
  asked for, and a ledger for the task (the owner's words that decide the work, the plan's decisions and known
  pitfalls), given to every worker with `--ledger` so no brief re-states them from memory.

### 3. Roundtable

Before anyone builds, the roundtable lets the planner check that its brief reached each worker as meant. The planner is
the orchestrator, who holds the architect's plan; the steps below are addressed to it. Every worker
gets the whole plan plus its own task, changes nothing and restates its own task. Do not propose alternatives or reopen
decisions: design debate is outside the roundtable and the planner decides. `--meeting` needs a git repository. Pick a
**new meeting id every round** (`<topic>-r1`, `<topic>-r2`, `[\w.-]{1,64}`) and keep it through that round's understanding, confirmation, minutes and consolidation;
reusing an earlier round's id is refused, and once a round is consolidated its meeting is closed, so its confirmations
no longer open builds.

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

### 4. Build in worktrees

One branch and worktree per parallel build worker (Developer, a specialty seat, Performance or Docs), from the current
HEAD, with dependencies shared (a link to the main `node_modules`):

```
git worktree add <scratch>/wt-frontend -b work/<topic>-frontend
git worktree add <scratch>/wt-backend -b work/<topic>-backend
```

A task with one worker may run in the project itself. Every brief holds:
- The seat, the goal, what was wrong before, the files the worker may change, the behaviour it must keep, the contract
  from the plan and Product's acceptance criteria.
- The `code-standard` skill's rules and the project's own conventions and code standards, pasted in.
- Never: commit, push, release, touch secrets, or touch anything outside its worktree.
- Its report: files changed, the checks it ran with results, what it left open; for debugging, the root cause with evidence.

Debugging starts on the developer seat, front end included: the worker finds the root cause with evidence before it
changes code. A Codex run has no approvals, so its scope comes from the prompt alone. An "at capacity" error at the end
of a run can come after the work is done: check the outputs before rerunning.

Performance measures first (profile, timings, memory), changes only what the measurements point to and reports both
before and after. Docs writes or updates the documentation the change needs, from the plan's contract.

A non-interactive Claude Code worker (the helper's terminal path) under `--permission acceptEdits` can edit files, but every shell command is refused and it
cannot commit. Its brief says so: it writes the code and the tests, then you run them in its worktree, send failures back
by resuming the same session, and commit on its branch once they pass.

### 5. Verify

Run every verifier on the team on the integrated result, in parallel, each a fresh instance that neither planned nor
wrote the work, given the diff range, the contract and the acceptance criteria, not your conclusions:
- **Every reviewer seat:** independent code and quality review, read-only. It checks module boundaries, data flow, duplication,
  consistency and the code standard. Findings: file:line, the failure, severity.
- **QA:** the tests the acceptance criteria name, regression of what the change touches, and UI acceptance where the
  change is visible: screenshots of each state with a realistic data set, the state each one shows, and a click test on
  every control against the project's own interaction rules. Findings: what is wrong, where, which rule or criterion.
- **Security:** permissions, every new file-read, process or network surface, input that reaches a shell or a path, and
  new or updated dependencies. Findings: file:line, the exposure, severity.
- **Accessibility:** keyboard paths, focus order and visibility, contrast, and the screen-reader names and roles of every
  changed control, checked in the running UI. Findings: where, which rule, severity.

Each confirmed finding goes back to the worker that owns the file (a command-line worker through `--resume`), then the
merge and checks of stage 6 run again and the affected verifier checks the fix.

### 6. Integrate and deliver

- Read every diff against the project's conventions and the contract before accepting it; send a diff that breaks them back with the specific lines.
- Commit each worktree on its branch, merge in dependency order (the side that defines data first), resolve conflicts against the contract, not by taking one side.
- Validate a resolved file that has a format (parse a JSON file, for example) before committing, and never chain the
  commit after a resolving script on a separate line, where it runs even when the script fails.
- Run the project's type check, tests and build. When a test fails, run it on the last commit to tell a regression from an old failure.
- Before anything reaches the main branch, run the project's full CI-equivalent locally, including desktop or end-to-end
  suites where it has them, and get its remote CI green on a pushed branch. Move the main branch only to a commit that
  is green there, so it never needs "fix CI" commits; unit tests alone can miss regressions only those suites catch.
- DevOps runs only when the owner requested a release: it builds the artifacts, prepares the environment, deploys and
  rolls back on failure, and reports what it built and where it went. The orchestrator keeps the permission to release.
- Remove the worktrees and branches when done, removing any dependency link inside a worktree first.

### 7. Consolidate

When the round is integrated and verified, write down what it produced so the next round starts from it: a file with the
headings `### Results` (what each module now does, the checks that passed, the findings and how each was settled)
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

- The lead is the Orchestrator and holds permissions; workers stay within their brief and never delegate further.
- Seats decide every worker's model, effort and fast setting. An explicit instruction from the owner in the conversation wins for that task only; the Orchestrator states the deviation in its plan.
- Every helper worker call passes `--seat`; every Agent call's description starts with `[<seat>]`.
- Run independent work in parallel: Product with Researcher, Architect with Designer, Developer and its specialty seats with Performance and Docs, and every reviewer seat with QA, Security and Accessibility.
- Launch only seats in the team table; a seat missing from it is skipped without a reason.
- Skip a seat of the team only when the task does not need it, and record the reason in the plan.
- Route every change to a worker, however small; the lead never builds alone. A task too small for a roundtable skips it with a stated reason.
- Product writes the acceptance criteria before the design; every later seat checks against them.
- Every reviewer seat, QA and Accessibility are fresh instances that neither planned nor wrote the work; every reviewer seat uses a model no author seat runs wherever an available model is at least as strong.
- QA accepts visible changes from screenshots of each state with a realistic data set and a click test on every control.
- Security reviews permissions, new file-read or process surfaces and dependencies whenever a change adds them.
- DevOps builds, deploys or rolls back only when a release is requested.
- Quick lookups go to the lookup operation's model (see Operation models), not a seat; the orchestrator keeps the conclusion and reads itself only what it must judge exactly.
- Codex always runs in native mode. Claude workers follow the lead's run mode and never cross: native-mode lead, native subagents, API billing; terminal-mode lead, terminal subagents, subscription billing. Dispatch and billing are separate questions.
- Use separate worktrees for parallel builds, with no overlapping file ownership.
- Paste the project's code-standard rules into every worker brief and review every diff against them before accepting it.
- Start command-line workers only through the dispatch helper with `--detach`, then collect results with `wait`; read the start line to confirm the launch and routing, and act on `failed to start` or `routing MISMATCH`.
- Give a worker that changes files `--allow` for its scope and reject any `OUT OF SCOPE` result.
- Hold the roundtable before the build and consolidate the round after verification; show the owner the minutes as tables.
- State unavailable-model substitutions in the plan.
- Follow the owner's authorization for commits, builds, app launches and releases; release only when requested.

## Done when

- The relevant checks pass and every verifier's finding (reviewer seats, QA, Security, Accessibility) is fixed or explicitly dismissed with a reason.
- The owner has seen the key behavior changes and, for UI work, the verified screens.
- Report the seats used and skipped with reasons, any deviation from a seat, the files changed, checks and results,
  model substitutions and any remaining limitations.
