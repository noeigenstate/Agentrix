---
name: release-flow
description: Publish a new Agentrix version — a beta prerelease on the one `beta` branch first, then, after the owner approves, the stable release. Covers the bump, update notes, the full local test pass, commit, tag, push and watching CI. Use when asked to 发布新版本 / release.
---

# Releasing Agentrix

## The default: a beta first, stable after approval

Every release goes out as a beta first. The owner's rule: at most one branch, a test version, and only after the owner
agrees does it become the stable release.

- **One branch: `beta`.** Create it from `main` when it does not exist (`git switch -c beta main`). Release work lives
  there. Never create a `ci/preflight-*` branch or run `ci-preflight remote` for a beta.
  Beta dispatches default to Windows only; `full_matrix=true` explicitly enables all platforms.
- **Beta version `X.Y.Z-beta.N`** (N starts at 1 and rises for each further beta of the same X.Y.Z):
  `npm version X.Y.Z-beta.N --no-git-tag-version`. Write the update notes (step 3) now. Leave the versions in
  `docs/usage.md` (step 2) alone until the stable bump.
- **Check, commit, tag, push.** Local checks (step 4), commit (step 6), then `git tag vX.Y.Z-beta.N` on `beta` and push
  the branch and the tag. A push to the `beta` branch triggers nothing; the tag matches `v*`. Beta tags run only Windows
  and its three desktop shards, skipping macOS, Linux and Linux SSH. They publish only the Windows installer,
  its `.blockmap`, `latest.yml` and Windows checksums as a GitHub **prerelease** (`--prerelease --latest=false`).
  Installed Windows copies on the beta channel (Settings › About › 更新通道) receive it; stable-channel copies do not.
  A failed job is step 9; a code defect needs a new commit and the next beta number, keeping the old tag.
- **Before requesting stable approval:** dispatch the workflow on `beta` with `full_matrix=true`, fix all failures and
  obtain a green full-platform run. Then report the beta and that result to the owner. Nothing merges to `main` and no
  stable tag exists until the owner approves. Stable releases always require the full matrix.
- **After the owner approves:** on `beta`, `npm version X.Y.Z --no-git-tag-version`, replace the `docs/usage.md`
  versions (step 2), finish the notes, commit `Release X.Y.Z: …`; then `git switch main`, `git merge --ff-only beta`,
  `git tag vX.Y.Z`, push `main` first and wait until its run is green; only then push the tag. Pushed back to back,
  neither run can reuse the other and both build the full matrix in parallel. After the green `main` run the tag run
  reuses it (step 7) and publishes in about 1–2 minutes, and only if every job is green. The code is the code the beta
  tag already passed; the bump changes only the version, docs and notes. If `main` has moved and cannot be
  fast-forwarded, rebase `beta` onto it, publish the rewritten branch with `git push --force-with-lease origin beta`
  (it was already pushed with its beta tag), and tag a new beta (N+1) on the rebased commit first; the earlier beta
  tags stay on their old commits.
- **Delete `beta`** once the stable release is published (`git push origin --delete beta` if it was pushed, and
  `git branch -d beta`), so only `main` remains.

The numbered steps below apply to both; where a step differs for a beta or outside this flow, it says so.

1. **Version.** `npm version X.Y.Z --no-git-tag-version` for the stable bump (updates package.json and
   package-lock.json); `X.Y.Z-beta.N` for a beta.
2. **Docs.** At the stable bump only, `docs/usage.md` names the version four times (the `AGENTRIX_VERSION=` lines and
   the macOS zip name); replace them all.
3. **Update notes.** Replace `WHATS_NEW` in `src/features/guide/guide.ts` with this release's changes: each note is
   `{ title, text }`, a short Chinese title (2 to 6 characters, what changed) and one plain sentence of what the user sees,
   no internals and no repeating the title. Add the English of every title and sentence to the end of
   `electron/locales/en.json` (keep the older entries). The notes show as a list in the guide, which opens on this page
   after an update, and on the About page; about seven fit the guide card, a longer list scrolls.
4. **Local checks, in order.** Prefer `node scripts/ci-preflight.mjs local` from the main checkout, which runs the Windows
   CI job's own steps under CI conditions. In the beta flow that is the only preflight: the beta tag's run is the remote
   check. Outside the beta flow, run `node scripts/ci-preflight.mjs remote` before tagging. By hand: `npm run build`, `npm test`, `python -m unittest discover -s tests -p '*_test.py'`,
   then the sixteen desktop suites one at a time (each starts Electron with its own isolated profile; never run
   them in parallel or against the real app): `test:desktop`, `test:path-refresh`, `test:sessions`,
   `test:restore-slow`, `test:completion`, `test:gpu-terminal`, `test:workspace`, `test:editor-terminals`,
   `test:themes-markdown`, `test:visual`, `test:navigation`, `test:git`, `test:cmd`, `test:material`,
   `test:composer`, `test:reading`.
   For a follow-up changing only test fixtures, docs and version metadata after a recorded full pass, verify that
   `electron/`, `src/`, `integration/`, `assets/` and dependency definitions are unchanged. Reuse the unaffected local
   desktop results; rerun the changed unit/fixture tests and their packaged desktop cases in the failing environment.
   Rebuild and verify the new version's artifacts. Before publication the required matrix must pass: Windows for beta
   tags, all platforms for stable releases. Full-platform validation on `beta` precedes the stable approval request.
   The tag's release is published from its tested builds (step 7).
5. **Look at the pictures.** `test:workspace` saves `guide-whats-new.png` and `guide-shortcuts.png` in its
   `.test-output/workspace-*` folder: check the notes fit and read well before committing.
6. **Commit.** Stage everything except local-only files (`.claude/`, personal product drafts under `docs/`), scan
   the staged diff for personal data (user names, home paths, host addresses, emails, secrets) and commit as
   `Release X.Y.Z: <the user-visible changes>` with a bulleted body (a beta: `Beta X.Y.Z-beta.N: <the changes>`).
7. **Tag and push.** A beta: `git tag vX.Y.Z-beta.N` on `beta`, push the branch, then the tag; nothing goes to `main`.
   The stable release: `git tag vX.Y.Z` on `main` after the fast-forward, push `main`, wait for its run to go green, then push the tag. Pushes of `main` and of
   tags first run the "Select tested build" job, which looks
   for a successful run of this workflow on exactly this commit (the stable `main` push's own run, or outside the beta
   flow the `remote` preflight's dispatch run; every required job really run, installer artifacts not expired).
   Beta reuse needs five successful jobs and the Windows artifact; stable reuse needs all nine jobs and all four
   platform artifacts. A Windows-only run cannot satisfy stable reuse. If it finds one, build and test jobs are skipped; only
   the tag's run adds the "Publish GitHub Release" job, which downloads that run's installers, checks their sha256
   sums and the version, and publishes exactly the tested files in about 1–2 minutes (as a prerelease for a beta tag).
   If no such run exists, the run builds and tests the required platforms: Windows for beta, all platforms for stable.
   The release page's "## Changes in X.Y.Z" list is printed from `WHATS_NEW` by `node scripts/release-notes.mjs
   --version X.Y.Z` (the English of each note); it fails if a note has no English.
8. **CI.** Query the runs for the full commit SHA (`/actions/runs?head_sha=<full sha>`; a short SHA returns
   nothing). Read the token from `git credential fill` inside the script and never print it. The jobs: Windows x64
   (build, then the "Windows desktop interaction / terminals / reading" shards that run the packaged desktop suites in
   parallel against the uploaded `win-unpacked`), Linux x64, Linux arm64, macOS Apple silicon, and Linux SSH integration (the real-ssh check of the
   remote worker). Beta runs skip the non-Windows jobs unless a beta branch dispatch sets `full_matrix=true`.
   Wait for the tag's run (and, for stable, the `main` run), then confirm the release lists its
   assets: for a beta, only the Windows installer, its `.blockmap`, `latest.yml` and checksums, marked as a prerelease.
   The beta release body names it as a Windows test build and omits macOS/Linux installation instructions. Outside the beta flow, to
   rehearse the release without
   publishing, dispatch the workflow on the release commit with `release_dry_run=true`: it runs the reuse check, the
   download, the sha256 and version checks and the notes, prints what it would publish and creates or edits nothing.
   Dispatch it only after the preflight run on that commit has finished, and never on a tag whose run is still
   building: a run on the same ref cancels the one in progress (main and tag pushes are different refs).
9. **A failed job.** The tag's release is published only if every build passes. Read the failed step from the job
   log (`/actions/jobs/<id>/logs`; search for `Error:` and `Timed out`, since passing test names also contain
   "failed"), and download the failing job's screenshot artifact: each smoke saves `failure.png` when it fails. The
   Windows suites are split over the three desktop shards, each uploading its own artifact: the interaction shard (which
   runs `test:workspace`, so `guide-whats-new.png` is there) keeps `desktop-test-screenshots`, the others are
   `desktop-test-screenshots-terminals` and `desktop-test-screenshots-reading`.
   A passing branch run alone does not prove a tag failure is environmental: allocator-dependent transcript loss can
   appear only on one runner. Reproduce the exact assertion before deciding. Rerun unchanged jobs only for a diagnosed
   environment or timing failure, within the session's publication authorization; ask only if that authorization is
   absent. A demonstrated code defect needs a new commit and the next beta number (or, for a stable release, a patch
   version), preserving the old tag. A smoke that passed and
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
   and leave those five suites to the CI run: in the beta flow the beta tag's run, which must be green before the owner is
   asked to approve; outside it `ci-preflight remote`, which must be green before main moves.
30. **Wrapper changes on a Windows machine.** The Bash/zsh wrapper tests (`linux-integration`, `zsh-integration`) and the
   real SSH worker test (`ssh-connection` with the native worker) run only on Linux and macOS, so `npm test` here skips them.
   After any change to `integration/*.bash`, `integration/*.zsh` or `remote-worker.py`, get a full CI run before
   integrating further (on `beta`, dispatch with `full_matrix=true`; outside it, `ci-preflight remote`), and read the failed jobs' logs (`/actions/jobs/<id>/logs`) for the `✖` lines. Python's
   `os.makedirs(path, mode)` applies `mode` only to the last folder: create a private tree one folder at a time.
31. **Aliased temp paths break path checks on CI only.** Runners give temp folders under aliases: macOS `TMPDIR` lives in
   `/var/folders`, a link to `/private/var`; Windows `TEMP` is an 8.3 short path (`C:\Users\RUNNER~1\…`) and the checkout is on
   `D:`. Code that realpaths one side and compares it with the unresolved other side (or a test that compares paths as strings)
   passes on a developer machine and fails on every runner. Compare resolved paths on both sides (or by file identity), and before
   pushing reproduce locally: point `TEMP`/`TMP` at a `subst` drive and at the short form (`for %I in ("%TEMP%") do @echo %~sI`).
32. **Local replica from a worktree.** `ci-preflight local` writes a `.ps1` per step whose path must stay under 260 characters:
   run it from a short path (`subst R: <worktree>`; run `npm test` itself from the long path, since realpath tests notice the
   drive alias). `npm run dist` refuses a junctioned `node_modules`: give the worktree a real one (`npm ci`, then
   `node node_modules/electron/install.js` when the install script was held back).
