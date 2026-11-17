---
name: worker-handoff
description: Use when writing a brief for a worker (Codex or Claude) that changes code in this repository, and when a worker finishes such a change; lists the cheap checks that otherwise send work back for another round.
---

# Handing work over without extra rounds

In the 1.6.0 cycle most second and third rounds with a worker were not about the feature but about checks the worker
could have run itself. Put these in every code brief, and run them before reporting done:

1. **Only the touched tests.** The changed test files and the test files that import a changed module directly.
   Never the whole suite or broad sweeps; never the GUI or clipboard suites (CI only).
2. **Test hygiene for new tests.** `node --test tests/test-hygiene.test.cjs`: no fixed sleeps, `setImmediate` chains or
   busy loops; wait on the event or inject the clock. Do not add to its allowlist.
3. **Module boundaries.** `node scripts/module-boundaries.cjs`: a BOUNDARY.md holds at most 8 invariants (reword, do not
   add), and each invariant ends with a citation in the accepted `test: \`file\` › "name"` form.
4. **Dynamic loads.** If a file listed under `dynamicLoads` in `scripts/affected-tests-map.json` changed, update its
   digest (sha256 of the file with CRLF turned into LF) and run `tests/affected-tests.test.cjs`.
5. **Process launches.** If a spawn or exec changed, run `node scripts/generate-codex-launch-sites.cjs --write` and
   `tests/codex-app-server-only.test.cjs`.
6. **Behaviour pinned by CI smokes.** If user-visible behaviour changed, search `scripts/*smoke*.mjs` for strings and
   assertions of the old behaviour and update them by reading; say which smoke files changed. They run only in CI.
7. **No machine dependence.** A test that finds `claude` or `codex` must use a stand-in; build PATH from the stand-in
   folder plus system folders and assert the stand-in resolves. Containment checks must hold across drives (an
   absolute `path.relative` result) and short (8.3) names.
8. **English text.** New interface text gets its English in a root `locale-additions-<lane>.json`; tests read English
   from `electron/locales/en.json`, merging that file only if it exists.
9. **TypeScript.** `node node_modules/typescript/bin/tsc --noEmit`.

A worker whose sandbox cannot start processes (Codex on Windows) runs what it can in-process and lists the rest for the
lead; the lead runs them and sends back only real failures.
