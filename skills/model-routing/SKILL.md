---
name: model-routing
description: Who does what in this project — clear non-design tasks and all debugging go to Codex first, design and polish go to a Sonnet subagent, and the lead model (Opus) plans, briefs, decides, reviews, verifies and releases. Use at the start of every task, before doing any of it yourself.
---

# Routing work between models

The owner's rule: clear non-aesthetic tasks to Codex, aesthetic tasks to Sonnet, the lead model comes up with the
ideas; debugging goes to Codex too, and the lead steps in only when Codex cannot solve it.

## 1. Sort the task before touching it

| The task | Who | How |
| --- | --- | --- |
| Clear and non-visual: a bug with a known shape, CI diagnosis, parsing, main-process data, test scripts, refactors, doc edits | Codex | `codex exec` in the background (below) |
| Debugging anything, including the reading view | Codex first | It investigates and fixes; the lead takes over only if it fails |
| Judged by eye: layout, visual polish, CSS look, icons, motion, design concepts built as code | Sonnet subagent | Agent tool, `model: "sonnet"` |
| Drawing concepts to choose from | Codex's image tool | See `design-polish` |
| Ideas, the plan, choosing between options, reviewing, verifying, releasing | Lead (Opus) | Itself |

Split a big request into small tasks, one Codex run per task, and run independent ones in parallel; never let two
workers touch the same files. Every brief carries `skills/code-standard/SKILL.md`.

## 2. Codex

Write the prompt to a scratch file, then run it in the background:

```
codex exec -m gpt-6.1-sol -c model_reasoning_effort=max -c service_tier='"fast"' -C <repo> -o <scratch>/out.md - < <scratch>/prompt.md > <scratch>/log.txt 2>&1
```

Codex runs with no approvals and full access, so the scope comes from the prompt alone:
- What it may touch: the exact files to change, or "read-only" for an investigation.
- Never: commit, push, release, re-run CI jobs, run the app or its desktop suites. Its sandbox cannot run Electron.
- Secrets: helper scripts read a token from `git credential fill` inside themselves. Never print it or write it to a
  file.
- Its report: the root cause with evidence, then the change as a diff (applied, or proposed for an investigation).
- An "at capacity" error at the end of a run can come after the work is done: check the outputs before running it
  again.

## 3. Sonnet subagent

A brief it can act on alone:
- The chosen concept (image paths), what was wrong before, the files it may change, and the behaviour it must keep.
- The house rules: AGENTS.md, the `design-polish` skill, the 界面清晰化 look (sharp wallpaper, frosted panes, white ink, no
  dark overlay), and the Catalina appearance unchanged.
- How to check: `tsc`, `npm test`, a build, screenshots from an isolated probe (`AGENTRIX_DATA_DIR` in a new folder,
  the Catalina theme) at several window sizes, then the relevant desktop suites one at a time.
- Never: the owner's real Agentrix, its sessions or the system clipboard. Never commit, push or release.
- Its report: the files changed, the checks run with results, and the screenshot paths.

## 4. The lead's part

- Before sending a task out: pin down the requirement, and pick from concepts with the owner when the look is open.
- After it comes back: read every diff, open every screenshot, and run the checks Codex cannot (the app, the desktop
  suites, real-CLI probes with isolated profiles and a local stand-in API).
- Workers that may launch Electron at the same time each wrap every launch in `withGuiLock` from `scripts/gui-lock.mjs`. The lead
  wraps its whole run of suites in it too.
- When a suite fails, run it against the last commit in a `git worktree` (junction its `node_modules` to the repo's) to tell a
  regression from an old failure. Remove the junction with `rmdir` before removing the worktree.
- Release only when the owner asks.
- Take over a task only when its worker failed, or when it is one quick lookup that is faster than writing a brief.
