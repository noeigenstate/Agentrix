---
name: builtin-skill-format
description: The strict format every built-in Agentrix skill (resources/skills/<name>/SKILL.md) must follow — fixed front matter fields and order, fixed body sections, explicit trigger timing. Use when adding or editing a built-in skill, or the code that loads, validates or delivers them.
---

# Built-in skill format

Built-in skills are the system prompts Agentrix gives every Claude Code and Codex session it starts. They must be
uniform so the app can validate, show and deliver them without special cases. The loader rejects a file that breaks
this format, and `npm test` checks every file in `resources/skills/`.

## Front matter

Exactly these keys, in this order, each on one line, no other keys, no quotes unless the value needs them:

| Key | Value |
| --- | --- |
| `name` | kebab-case, equal to the folder name |
| `description` | English, one paragraph: start with the trigger condition (`Use when …`, `Use before …`, `Use on …`, `Use at …` or `Use whenever …`), including first-open and yield-to-project conditions when applicable; then state what it does |
| `trigger` | the default trigger: `always`, `auto` or `first-open` |
| `when` | Chinese, one sentence: exactly when it takes effect (shown under 触发) |
| `requires` | `none`, `any-agent` (Codex or Claude Code, at least one), `codex`, `claude` or `both` |
| `title` | the Chinese name shown in Settings › 技能, 2–8 characters |
| `summary` | Chinese, one or two sentences, at most 90 characters, what it makes agents do |

Claude Code and Codex read `description` to decide whether to use a skill.

Triggers:
- `always`: read and follow before every task in every session. The first agent session Agentrix starts in a project
  also gets "this is its first run in this project" with it (claimed once per project, like `first-open`); the skill's
  body says what the first run does, and every later session gets the plain instruction.
- `auto`: listed with its description; read when a task fits it.
- `first-open`: read and run before the first task of the first session Agentrix starts in a project, only when the
  project does not already have this skill; afterwards it behaves as `auto`.

Every built-in yields to the project's own copy: when the project has a skill with the same `name` in `skills/`,
`.claude/skills/` or `.codex/skills/`, or names it in `AGENTS.md` or `CLAUDE.md`, the built-in is not delivered in that
project and the project's copy governs.

`title`, `summary` and `when` are shown through `t()`: add their English to the end of `electron/locales/en.json`.

## Body

English (agents read it), these sections in this order, each an `##` heading, no others at that level:

1. `# <English title>` — one line.
2. `## When this applies` — the trigger timing in full, including the yield-to-project rule and, for `first-open`
   and for an `always` skill with a first-run step, what happens on that first run.
3. `## What to do` — numbered steps.
4. `## Rules` — bullets; the non-negotiables.
5. `## Done when` — checkable completion criteria and the report the agent gives.

No personal data (names, emails, user names, home paths, hosts, keys); write `<home>`, `<user>`, `<host>`, `<secret>`.
No Agentrix-repo paths or workflows: built-ins serve any project.
