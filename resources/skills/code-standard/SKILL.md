---
name: code-standard
description: Use before every task, and apply it to every code change; on its first run in a project, which the session note announces, review the existing code and propose a staged plan before changing anything; follow the project's own conventions and linters alongside it, and otherwise reduce redundancy and complexity while preserving behavior and interfaces.
trigger: always
when: 每个任务开始前生效；在项目里第一次运行时先审查现有代码并提出接入计划
requires: none
title: 代码规范
summary: 首次运行先审查现有代码，报告主要问题和分阶段计划，经用户同意后再动手。之后每次代码变更都减少冗余和复杂度，保持行为与接口不变。
---

# Code standard

## When this applies

Read and follow this skill before every task in every session. The session note carries one line per skill; it is the
first run only when the line telling you to read this file ends with "this is its first run in this project" (the same
words after another skill's line are that skill's first run, not this one's). On the first run, review the existing code
against these rules, report the most important problems and a staged plan, and ask whether to start and whether to record
the project's own conventions as an extension skill named code-standard-<id> (for example code-standard-team). Change no
code and write no file until the user agrees. In every other session, apply the rules to every code change, whether
writing, changing or reviewing code.
This skill is always delivered and a project copy of it is not needed. Project-specific conventions go in an extension
named code-standard-<id>; follow this skill first, and where the two conflict this skill wins. The project's linters and
formatters still apply to the code you write.

## What to do

1. If the session note's line telling you to read this file ends with "this is its first run in this project", review
   the existing code against the rules below without changing code or writing files. Otherwise skip to step 4 and apply
   the rules to every code change.
2. Report the most important problems, with specific evidence, and a staged plan for addressing them.
3. Ask whether to start on the plan and whether to record the project's own conventions as an extension skill named
   code-standard-<id>. Change no code and write no file until the user agrees; wait for that agreement before any
   change.
4. Once agreed, do what was agreed, including writing the extension if requested. Afterwards apply these rules to every
   code change, while preserving existing behavior, external interfaces and expected results.
5. Make changes in stages and verify each stage with the existing tests. If work is split across workers, put the rules
   in every brief; the lead reviews each returned diff and sends violations back with the specific lines.

## Rules

- **No redundant code.** Remove duplicated logic, pointless intermediate variables, needless wrapper functions and boilerplate.
- **Simple control flow.** Avoid redundant if/else, deep nesting and tangled branches; use early returns and pattern matching where clearer.
- **Concise code.** Shorten verbose expressions and functions without trading clarity for fewer lines.
- **Clear structure.** Split functions and modules with unclear responsibilities; extract only truly reused logic, without over-abstraction.
- **Readability.** Use consistent naming and formatting. Comment complex business logic's reasons, remove meaningless comments, and match surrounding style and comment density.
- **No code smells.** Fix duplication, overlong functions, oversized modules, over-design and unnecessary dependencies.
- Preserve behavior, external interfaces and expected results. Prefer idiomatic language features; add no unnecessary abstractions, patterns or dependencies.
- On the first run (the session note's line for this file ends with "this is its first run in this project"), do not change code or write any file until the user agrees to the proposed plan and work.
- Apply the rules to every subsequent code change, verify each stage, and follow the project's own conventions and linters where they add to these rules.

## Done when

- On the first run, the user has received the most important findings and staged plan, and has been asked whether to start and whether to add a code-standard-<id> extension.
- Until agreement, no code has changed and no file has been written. Report that the plan is awaiting the user's decision.
- After agreement, each change follows the rules and the relevant existing tests pass.
- Finish with a summary of redundancy removed, complexity reduced, validation results and problems left.
