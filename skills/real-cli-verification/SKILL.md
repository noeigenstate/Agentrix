---
name: real-cli-verification
description: Use when a change depends on how the real Claude Code or Codex CLI behaves (SDK or app-server messages, hooks, resume, permissions, settings, transcripts), or when reviewing such a change. A fake CLI only proves what we assumed, so check the behaviour against the installed CLI with a fake key, a throwaway profile and a local stub.
---

# Verify against the real CLI

A fake CLI answers the way we think the real one does. Round r12 shipped two bugs that way: a hook answering `defer` paused every tool, and deduplicating by `message.id` lost every block after the first, because the real CLI writes one record per content block.

## When
- Anything that reads SDK or app-server messages, or answers hooks and permission callbacks.
- Resume, session switching, transcript reading, settings precedence, environment and routing.
- A review finding or a worker's claim about what the CLI does. Test it; do not take it on trust.

## How
Run offline. Nothing reaches an account.
1. Use the installed `claude` or `codex` binary, at the version the app pins.
2. Set a fake key and a throwaway `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `CLAUDE_CONFIG_DIR` or `CODEX_HOME`, and `AGENTRIX_DATA_DIR`. Keep the path short: PowerShell 5.1 cannot write past 260 characters.
3. Point the CLI at a local HTTP stub. The app clears `ANTHROPIC_*` from the SDK child, so inject the stub address through the throwaway `CLAUDE_CONFIG_DIR/settings.json` `env`.
4. Make the stub realistic: stream events, thinking before text, `tool_use` then a closing turn, `usage` with the cache fields. Find the last user message rather than assuming it is the last entry.
5. Reproduce first. Show the check failing before the fix and passing after it.

Standing checks: `AGENTRIX_REAL_CLAUDE=<path to claude> node --test tests/claude-sdk-real-cli*.test.cjs`. Drive the product's own `queryOptions`, policy and normalizer, not a copy of their options.

## Compare with the real terminal
The native view changes the display, never what the agent can do. `tests/claude-parity-real-cli.test.cjs` runs the SDK path and the real terminal through one stub and fails on a new difference. Add a behaviour there before calling it equal. A stub that never triggers a behaviour on either path, such as automatic compaction, proves nothing about it: say so.

## GUI checks
Name the suites you want. Never ask anyone to run every GUI smoke: `session`, `workspace`, `editor-terminals`, `clipboard`, `composer` and `gpu-terminal` write the system clipboard and run only on GitHub Actions. Run GUI checks one at a time, with nothing else loading the machine. Unit tests stay green while these break, so run them after any change to launching or restoring a session.

## What it cannot prove
A stub says nothing about the real service accepting a request, or about real long sessions. Say so in the report, and have those checked on a real account.

## Fixes breed regressions
In r12 most findings of each later review came from the previous batch of fixes. Review the increment after a fix batch, and look for what the fix itself broke.
