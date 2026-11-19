---
name: code-standard-agentrix
description: Extends the system code-standard skill for the Agentrix repository — use whenever writing, refactoring or reviewing code in this repo, after the system code-standard, and put both in every worker brief. Adds only this repo's checks; where it conflicts with the system skill, the system skill wins.
---

# Code standard — Agentrix additions

The base is the system `code-standard` skill (its source in this repo is `resources/skills/code-standard/SKILL.md`):
read and follow it first. This extension adds only what is particular to this repository.

## Additions

1. **Review every diff.** The lead reviews each worker's diff against the system code-standard before accepting it, and
   sends a diff that breaks it back with the specific lines. Both skills go into every worker brief.
2. **Stay in the module.** A change stays inside its module's `BOUNDARY.md` scope (`skills/module-boundary`); a change
   that needs another module is split or the boundary is changed first by the architect.
3. **Check each stage.** Run the repo's type check (`npx tsc --noEmit -p .`) and the tests touched by the change before
   handing a stage back; unit tests passing is the minimum, not the acceptance.
4. **Keep behaviour.** Refactors keep existing behaviour and external interfaces, and the tests that pin them still pass.
5. **No personal data.** Committed files hold no names, emails, user names, home paths, hosts or keys; write `<home>`,
   `<user>`, `<host>`, `<secret>`.
6. **Import the code under test.** New tests import the module. They never slice source text to run it in a `vm`.
7. **Share seat and other cross-process rules.** Keep each rule used by main and renderer in one shared `.mjs` module.
8. **Remove compatibility members.** Remove a deprecated or compatibility member within one release of the change that replaced it.
9. **Keep changes short.** Changed lines stay under 200 characters. New or changed functions stay under 80 lines.
