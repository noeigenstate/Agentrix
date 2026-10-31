---
name: release-flow
description: Publish a new Agentrix version — bump, update notes, the full local test pass, commit, tag, push and watch CI. Use when asked to 发布新版本 / release.
---

# Releasing Agentrix

1. **Version.** `npm version X.Y.Z --no-git-tag-version` (updates package.json and package-lock.json).
2. **Docs.** `docs/usage.md` names the version four times (the `AGENTRIX_VERSION=` lines and the macOS zip name);
   replace them all.
3. **Update notes.** Replace `WHATS_NEW` in `src/features/guide/guide.ts` with this release's changes: each note is
   `{ title, text }`, a short Chinese title (2 to 6 characters, what changed) and one plain sentence of what the user sees,
   no internals and no repeating the title. Add the English of every title and sentence to the end of
   `electron/locales/en.json` (keep the older entries). The notes show as a list in the guide, which opens on this page
   after an update, and on the About page; about seven fit the guide card, a longer list scrolls.
4. **Local checks, in order.** Prefer `node scripts/ci-preflight.mjs local` from the main checkout, which runs the Windows
   CI job's own steps under CI conditions, then `node scripts/ci-preflight.mjs remote` before tagging. By hand: `npm run build`, `npm test`, `python -m unittest discover -s tests -p '*_test.py'`,
   then the sixteen desktop suites one at a time (each starts Electron with its own isolated profile; never run
   them in parallel or against the real app): `test:desktop`, `test:path-refresh`, `test:sessions`,
   `test:restore-slow`, `test:completion`, `test:gpu-terminal`, `test:workspace`, `test:editor-terminals`,
   `test:themes-markdown`, `test:visual`, `test:navigation`, `test:git`, `test:cmd`, `test:material`,
   `test:composer`, `test:reading`.
   For a follow-up changing only test fixtures, docs and version metadata after a recorded full pass, verify that
   `electron/`, `src/`, `integration/`, `assets/` and dependency definitions are unchanged. Reuse the unaffected local
   desktop results; rerun the changed unit/fixture tests and their packaged desktop cases in the failing environment.
   Rebuild and verify the new version's artifacts. The entire CI matrix must still pass before publication.
5. **Look at the pictures.** `test:workspace` saves `guide-whats-new.png` and `guide-shortcuts.png` in its
   `.test-output/workspace-*` folder: check the notes fit and read well before committing.
6. **Commit.** Stage everything except local-only files (`.claude/`, personal product drafts under `docs/`), scan
   the staged diff for personal data (user names, home paths, host addresses, emails, secrets) and commit as
   `Release X.Y.Z: <the user-visible changes>` with a bulleted body.
7. **Tag and push.** `git tag vX.Y.Z`, push `main`, then push the tag. Both pushes run the build workflow; only the
   tag's run adds the "Publish GitHub Release" job, which waits for every build and uploads the installers.
8. **CI.** Query the runs for the full commit SHA (`/actions/runs?head_sha=<full sha>`; a short SHA returns
   nothing). Read the token from `git credential fill` inside the script and never print it. The jobs: Windows x64,
   Linux x64, Linux arm64, macOS Apple silicon, and Linux SSH integration (the real-ssh check of the remote worker).
   Wait for both runs, then confirm the release lists its assets.
9. **A failed job.** The tag's release is published only if every build passes. Read the failed step from the job
   log (`/actions/jobs/<id>/logs`; search for `Error:` and `Timed out`, since passing test names also contain
   "failed"), and download the run's `desktop-test-screenshots` artifact: each smoke saves `failure.png` when it fails.
   A passing branch run alone does not prove a tag failure is environmental: allocator-dependent transcript loss can
   appear only on one runner. Reproduce the exact assertion before deciding. Rerun unchanged jobs only for a diagnosed
   environment or timing failure, within the session's publication authorization; ask only if that authorization is
   absent. A demonstrated code defect needs a new commit and patch version, preserving the old tag. A smoke that passed and
   then timed out in its cleanup ("isolated shell exit") lost the `exit` typed right after Ctrl+C on a slow runner: a
   cleanup sends `exit` again every few seconds until the shell has gone (as `git-smoke.mjs` does).
10. **Short temp paths on Windows CI.** The runner's temp folder is an 8.3 name (`<home>\…`). A test
   comparing a path the app resolved with `fs.promises.realpath` (native: it spells the long name out) must expect
   `fs.realpathSync.native`, not `fs.realpathSync` (which keeps `RUNNER~1`). To reproduce locally, set `TEMP` and
   `TMP` to the `ShortPath` of a long-named folder (`(New-Object -ComObject Scripting.FileSystemObject).GetFolder(<dir>).ShortPath`).
11. **A race only CI hits.** CI runs a 1024×768 window on two slow cores. To reproduce locally, run a temporary copy
   of the smoke that, right after `firstWindow()`, sets `setContentSize(1024, 768)` and slows the renderer through
   CDP: `(await page.context().newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: 6 })`. The window
   size alone did not reproduce it; rate 4 trips earlier, unrelated timing checks. Log `terminal:resize` from
   `ipcMain` with timestamps to see whether a refit lands mid-output. A step that resizes terminals and then types
   must `await terminalsSettled(page)` first. Delete the temporary copy afterwards.
12. **A pixel off in a full-screen panel.** Right after a project opens full screen, it flies in scaled a little
   (`[data-focus-motion]` on the app shell), so every measured top is a fraction off and a rounded position can differ
   by 1px between runs. Before measuring positions, `await page.waitForFunction(() => !document.querySelector('[data-focus-motion]'))`.
13. **A network error before any test.** `npm ci` failing with `ECONNRESET` ("network read") in "Install locked
   dependencies" is the runner's connection, not the release: no smoke ran and none left a picture. The install steps
   retry once by themselves; if it still fails, re-run the failed jobs under the session's publication authorization and the release publishes
   when they pass. Hand the diagnosis to Codex (read-only, the token only inside its scripts) per `model-routing`.
14. **Offline completion fixtures need received input.** A fresh task fixture includes a `user_message`, not only
   `task_started` and `task_complete`. Those callbacks must never rearm notifications themselves. Keep historical
   completed/resumed fixture records distinct; use the actual conversation reader and store in the regression.
15. **Isolated local installer output.** Build with `npm run dist -- --config.directories.output=<output>` in a new
   test-output folder, so packaging cannot overwrite a running checkout build. Validate the installer, update feed,
   blockmap and packaged runtime there, and launch GUI checks with their own data profiles. Package from the main
   checkout, not from a worktree whose `node_modules` is a junction to it: there electron-builder leaves out
   `app.asar.unpacked`, and `verify-update-artifacts.cjs` fails on the missing `node-pty` `conpty.node`.
16. **Injected provider transcripts.** A smoke that intercepts the conversation endpoint must model a provider switch
   explicitly: set the fixture snapshot to empty, publish an empty conversation packet, await the reader clearing,
   then publish the new provider's entries. The real main log may already be empty, so its no-op reset emits no packet.
17. **Slow PowerShell unit subprocesses.** Use `10000 * timeoutScale` from `scripts/wait.mjs` for the PATH-check child,
   matching the workflow's existing scale. Keep every case and assertion; validate with an injected startup delay above
   the original ten-second cap. A killed child with empty output is not a failed PATH assertion.
18. **Locale defaults and fixtures.** Chinese UI locators need `language: 'zh'` in each isolated smoke profile's
   persisted settings, including full-sixteen and platform CI scripts; preserve their assertions. Keep a separate
   fresh profile with no language field to verify the real English first paint. Headless locale and fixture tests
   cover unset/invalid defaults, explicit preferences, renderer startup and native translation fallbacks.
19. **Unpacked and installed checks differ.** Run the normal desktop suites against `win-unpacked`. An extracted
   installer payload contains its uninstaller and correctly reports installed update eligibility; use it only for
   installed-runtime checks. Enable `AGENTRIX_TEST_GUIDE=1` to inspect onboarding in an isolated profile.
20. **Drag release coordinates matter.** A pointer release can arrive without the last move. Reproduce it by
   activating a drag and releasing through CDP at the destination without a final move; check the persisted order.
   Normal drag fixtures wait for stable cell geometry and the exact preview order before releasing, retaining the
   cancellation, terminal, click and keyboard assertions. A blind retry does not establish the cause of a failure.
21. **Wrapper test infrastructure.** macOS unit probes explicitly select modern Bash with `AGENTRIX_TEST_BASH="$(brew --prefix bash)/bin/bash"`; product zsh stays unchanged. Wrapper subprocess and parent deadlines use the existing CI `timeoutScale` from `scripts/wait.mjs`, including compile and bounded event waits; retain every case and assertion.

22. **Windows PowerShell fixture module paths.** Preserve `process.env.PSModulePath` in safe-env fixtures, with the known system modules directory only as an unset-variable fallback. An owned module-analysis cache does not justify forcing a system-only module path. Matched cold-cache `-File` children with identical cwd and window settings isolated the first `Join-Path` hang to this one environment key: native path passed, restored minimal path timed out. Use bounded environment reduction and a final one-key pass/fail reversal before assigning cause.
23. **Documentation and language defaults.** Keep `README.md` as canonical English and `README.zh-CN.md` as the Chinese variant. Fresh profiles default to English; preserve explicit saved language preferences.
24. **Reading fixture deadlines.** Parent and polling budgets use the existing CI `timeoutScale` from `scripts/wait.mjs`; a matched 5.5s Enter delay fails the old 5s poll and passes the scaled 15s poll. Keep the physical 600ms settlement, 160ms input handler, exact receipt, one Enter and all assertions unchanged. This proves the budget defect, not the original CI stall cause.
25. **Grid cards at the CI window.** Windows CI opens the desktop smoke at 1024×768, where six projects make ~325×346px cards. A
   change that makes a card's content taller (the agent launcher, a wrapping control) can push a button out of its card
   there while every local default-size run passes. Before tagging, run a temporary copy of `scripts/smoke.mjs` that calls
   `unmaximize()` and `setContentSize(1024, 768)` right after `firstWindow()` (check `innerWidth` is 1024), then delete it.
26. **A smoke that passes and never exits.** A step that printed its assertions and then hung until the 35-minute job
   limit was stuck in `app.close()`, which Playwright waits on with no deadline (and `retry.mjs` waits on its child).
   Close through a bounded teardown, as `scripts/material-teardown.mjs` does: race `app.close()` against
   `15s × timeoutScale`, then kill only that smoke's Electron process tree and fail, so the retry runs. Print PASS only
   after the app has exited.
27. **A race fixed by waiting longer moves it elsewhere.** A fixture that "holds" a fixed time so the code under test
   can observe it is a race on a slower runner; lengthening the hold breaks every test that times the whole run. Make
   the fixture wait for the observable event instead (the dispatch fixture worker stays until the test has read the
   helper's start line, from a release file outside the worker's folder, since the scope check reports any file inside it).
   Prove it at the extreme (hold 0) and at the CI scales (`AGENTRIX_TEST_TIMEOUT_SCALE=2` and `3`), compare each test's
   duration with the previous version, and run all of `npm test` at scale 2 before tagging.
28. **A desktop step that hangs with the app idle.** If the app stops answering `page.evaluate` and `app.evaluate` and its
   Electron process uses no CPU, it is blocked, not looping: a visible `#32770` window titled `Error` on that process is
   Electron's dialog for an uncaught main-process exception. Read the window list (class and title; never screenshot the
   desktop), then run a temporary copy of the smoke that, right after launch, records the stack:
   `app.evaluate(() => process.on('uncaughtException', e => (globalThis.errors ??= []).push(e.stack)))`. Delete the copy
   afterwards. `ci-preflight local` stops each step at the CI job's `timeout-minutes`, so such a hang fails in the job time
   instead of holding the run open. Objects main.cjs keeps per session (for example `s.usageAccount`, which receives every
   terminal chunk through `output()`) must keep the whole interface; a unit test calls each method main calls.
29. **Owner forbids the system clipboard.** `test:sessions`, `test:composer`, `test:workspace`, `test:editor-terminals` and
   `test:clipboard` write the system clipboard. Then run every other local step with `--only` (not a full `local` run)
   and leave those five suites to `ci-preflight remote`, which must be green before main moves.
