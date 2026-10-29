---
name: module-boundary
description: Use before changing code in a module that has a BOUNDARY.md, before briefing a worker on one, and when adding or editing a BOUNDARY.md — the strict format, the limits, and how npm test enforces it (paths, interfaces, imports, invariants tied to tests, no exceptions).
---

# Module boundaries

A module's `BOUNDARY.md` (in its main folder) says what the module owns, what others may use, what it may use, and
what must always hold. It is executable: `tests/module-boundaries.test.cjs` checks every file against the code, so a
boundary that drifts from the code fails `npm test`. Only the architect (Opus, the lead) edits a BOUNDARY.md; a worker
that finds one wrong says so in its report.

## Format

Exactly these sections, in this order, each a `##` heading, every entry one `- ` bullet line:

```
# Boundary: <module name>

<one or two sentences: what the module is for>

## Owns
- `<path glob>`                      repo-relative, `*` within a name, `**` across folders

## Interface
- `<name>` (`<file>`) — <what it is for>

## May import
- `<path glob>`                      outside Owns; `src/shared/**` style

## Invariants
- <rule> — <why> — test: `<test file>` › "<test name>"

## Not ours
- <responsibility> — <module that owns it>
```

Limits: Owns ≥ 1; Interface ≤ 12; May import ≤ 12; Invariants 1–8; Not ours ≤ 8. More than that means the module
does too much: split it rather than grow the list.

## What the check enforces

1. Every Owns glob matches at least one file, and no file is owned by two modules.
2. Every Interface file exists and contains the name.
3. A file in Owns imports (relative `import`/`require`) only files in its own Owns or in May import.
4. A file outside Owns imports this module's files only through its Interface files.
5. Every invariant names a test file that exists and contains a test whose name contains the quoted text.
6. No exceptions: the words `except`, `unless`, `例外` and `除非` may not appear in Interface, May import or
   Invariants. Needing one means the boundary is drawn wrong: move the code or redraw the boundary.

Tests (`tests/**`) and build scripts are not owned and may import anything.

## When code changes

- A change that needs a new import across a boundary: add it to May import, or to the other module's Interface, in the
  same change, and say why in the commit.
- A change that breaks an invariant: the test fails; fix the code, not the invariant.
- Each release, the architecture review lists invariants and cross-module imports per module and removes or merges
  what no longer holds.
