---
name: code-standard
title: 代码规范
summary: 每次写、改、审代码都遵循：去掉冗余、降低复杂度、提高可读性和可维护性，行为和接口保持不变。分阶段改、用现有测试验证，最后总结删了什么、简化了什么、还剩什么问题。
description: Apply this code standard whenever writing, refactoring or reviewing code to reduce redundancy and complexity, improve readability and maintainability, and preserve behavior and interfaces.
---

# Code standard

Goal: less redundant code, lower cognitive complexity, better readability, maintainability and execution efficiency.

The project's own conventions and linters take precedence where they differ.

## Rules

1. **No redundant code.** Remove duplicated logic, pointless intermediate variables, needless wrapper functions and
   boilerplate.
2. **Simple control flow.** Avoid redundant if/else, deep nesting and tangled branches; use early returns and pattern
   matching where they make the code clearer.
3. **Concise code.** Shorten verbose expressions and functions, but never at the cost of readability.
4. **Clear structure.** Split functions and modules whose responsibility is unclear; extract only logic that is
   really reused; no over-abstraction.
5. **Readability.** Consistent naming and formatting; comment complex business logic (why, not what); delete
   meaningless comments. Match the surrounding code's style and comment density.
6. **No code smells.** Fix duplicated code, overlong functions, oversized modules, over-design and unnecessary
   dependencies.

## Principles

- Keep existing behaviour, external interfaces and expected results unchanged.
- Do not trade clarity for fewer lines.
- Add no unnecessary abstractions, design patterns or new dependencies.
- Prefer the language's idiomatic way of doing things.
- Change in stages and verify each stage with the existing tests.
- Finish with a summary: redundancy removed, complexity reduced, problems left.

## For the lead

When work is split across workers (see the model-routing skill), include these rules in every worker brief. The lead
reviews each returned diff against them before accepting it and sends violations back with the specific lines.
