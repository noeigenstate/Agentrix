---
name: builtin-skill-format
description: The strict format every built-in Agentrix skill (resources/skills/<name>/SKILL.md) must follow — fixed front matter fields and order, fixed body sections, explicit trigger timing. Use when adding or editing a built-in skill, or the code that loads, validates or delivers them.
---

# Built-in skill format

Built-in skills are the system prompts Agentrix gives every Claude Code and Codex session it starts. They must be
uniform so the app can validate, show and deliver them without special cases. The loader rejects a file that breaks
this format, and `npm test` checks every file in `resources/skills/`.

## Front matter

Exactly these keys, in this order, each on one line, no other keys, no quotes unless the value needs them. The first
seven are required; `seats`, `fresh` and `duties` are optional and, when present, follow `summary` in that order:

| Key | Value |
| --- | --- |
| `name` | kebab-case, equal to the folder name |
| `description` | English, one paragraph: start with the trigger condition (`Use when …`, `Use before …`, `Use on …`, `Use at …` or `Use whenever …`), including first-run conditions when applicable; then state what it does |
| `trigger` | the default trigger: `always` or `auto` |
| `when` | Chinese, one sentence: exactly when it takes effect (shown under 触发) |
| `requires` | `none`, `any-agent` (Codex or Claude Code, at least one), `codex`, `claude` or `both` |
| `title` | the Chinese name shown in Settings › 技能, 2–8 characters |
| `summary` | Chinese, one or two sentences, at most 90 characters, what it makes agents do |
| `seats` | optional: the team's seat ids, comma-separated, each matching `^[a-z][a-z0-9-]{0,31}$`, no repeats, in chart order; the first seat is the lead |
| `fresh` | optional, only with `seats`: the seat ids, a subset of `seats`, that always run as a fresh instance |
| `duties` | optional, only with `seats`: entries `id=名称\|职责\|职责明细[\|产出]` joined by `; `, exactly one per seat; the name is 2–6 Chinese characters and each field at most 40 characters |

Claude Code and Codex read `description` to decide whether to use a skill.

Triggers:
- `always`: read and follow before every task in every session. The first agent session Agentrix starts in a project
  also gets "this is its first run in this project" with it (claimed once per project); the skill's body says what the
  first run does, and every later session gets the plain instruction.
- `auto`: listed with its description; read when a task fits it.

An `auto` skill also has the switch 首次打开项目时先运行一次 in Settings (`firstOpenRun`, off by default). With it on, the
skill is read and run before the first task of the first agent session Agentrix starts in a project (claimed once per
project); afterwards it behaves as plain `auto`. The switch does nothing for `always`. A stored `first-open` trigger from
an older version loads as `auto` with the switch on.

`title`, `summary`, `when` and the name, duty, detail and output fields of `duties` are shown through `t()`: add their
English to the end of `electron/locales/en.json`.

## Extensions

A built-in is always delivered; it never yields to a project copy. A project skill in `skills/`, `.claude/skills/` or
`.codex/skills/` whose name equals a built-in's name is moved out of the project automatically during the project scan
(kept in a recovery folder, not deleted), so the built-in applies whatever the copy says. Naming the built-in in
`AGENTS.md` or `CLAUDE.md` does not change this.

To extend a built-in, name the skill `<system name>-<id>`, with `<id>` matching `[a-z0-9]+(-[a-z0-9]+)*` (for example
`code-standard-team`); the longest built-in name that is a prefix of it is its base. An extension is never moved out and
is delivered right after its base: agents follow the base first, then the extension's additions, and where they conflict
the system skill wins. Saving, importing or creating a user skill whose name equals a built-in's name is refused.

## Body

English (agents read it), these sections in this order, each an `##` heading, no others at that level:

1. `# <English title>` — one line.
2. `## When this applies` — the trigger timing in full, including, for an `auto` skill run on first open and for an
   `always` skill with a first-run step, what happens on that first run.
3. `## What to do` — numbered steps.
4. `## Rules` — bullets; the non-negotiables.
5. `## Done when` — checkable completion criteria and the report the agent gives.

A skill that declares `seats` has exactly one team region in its body, outside code fences:

```
<!-- agentrix:team -->
| Seat | Role | Duty | Outputs | Model | Launch |
| --- | --- | --- | --- | --- | --- |
| <seat id> | <English role> | <English duty> | <English outputs> | <model · effort[ · fast]> | <launch> |
<!-- /agentrix:team -->
```

One row per seat, in `seats` order, keyed by the seat id in the first column. Role, Duty and Outputs are English and
delivered as written. Agentrix rewrites only the Model and Launch cells from the project's seats and the installed
agents; the shipped cells must equal what it renders for the defaults (both agents installed, a Claude lead, the newest
Sol), and a test checks this. The Model cell is the model, the effort and the word `fast` when on, joined by ` · `. The
Launch cell is one of `this session`, `Agent call, model "<alias>", effort "<effort>", description starts with [<seat>]`
or `helper <codex or claude> --seat <id> --model <model> --effort <effort> [--fast] --detach, then wait`. The helper
is named only as `helper`; the region holds no paths.

No personal data (names, emails, user names, home paths, hosts, keys); write `<home>`, `<user>`, `<host>`, `<secret>`.
No Agentrix-repo paths or workflows: built-ins serve any project.
