---
name: unity-role-check
description: Check that a role dispatched by Agentrix can run Unity with the user's license (batchmode project creation). Use after changing how Codex or Claude roles are launched, sandboxed or given permissions, and before releasing such a change.
---

# Unity role check

Unity reads its license through a per-account channel `LicenseClient-<account>` served by Unity Hub's licensing client. A role that runs as another account (for example the Codex elevated sandbox account) or without network cannot reach it and Unity aborts with exit code 199.

## Setup (once per machine)
- Unity Hub from winget (`Unity.UnityHub`) is an MSIX app: no admin needed. The owner signs in and activates a Personal license in the Hub GUI; only they can do this.
- Install the editor from the Hub GUI (Installs → Install Editor, no modules). The editor installer needs a UAC click, which a background `unity install` cannot show.
- Do not run `irm https://unity.com/install.ps1 | iex` as-is: unless `UNITY_CLI_SKIP_SETUP=1` it installs Unity skills into every agent client (Claude Code, Codex).

## Check
1. Baseline as the user: `Unity.exe -batchmode -quit -nographics -createProject <tmp>/self-proj -logFile <tmp>/self.log` → exit 0, log shows `Successfully connected to LicenseClient-<account>` and `Successfully resolved entitlement details`.
2. Role: dispatch a writable role in an empty git folder (outside the repo, `allow ["**"]`) that runs the same command and reports exit code, the `Licensing|license|entitlement` log lines, `whoami` and `curl.exe -s -o NUL -w "%{http_code}" https://example.com`.
3. Code under test that is not installed yet: run `node <worktree>/integration/dispatch.cjs codex --role exec ... --cwd <work> --brief <brief.md> --out <out.md> --allow "**"` with `AGENTRIX_DATA_DIR=<tmp>/data` and `AGENTRIX_BOOTSTRAP` unset, so the user's running Agentrix is never touched.

Pass: exit 0, `whoami` is the user's account, HTTP 200. Fail signature: `Connection to channel LicenseClient-<account> refused` … `Unable to connect to the Unity Licensing Client; aborting.` (exit 199).

`Code 10 while verifying Licensing Client signature … ignoring` and `Access token is unavailable` also appear in passing runs; they are not failures.
