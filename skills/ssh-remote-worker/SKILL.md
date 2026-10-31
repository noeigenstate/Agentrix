---
name: ssh-remote-worker
description: Use when changing how an SSH project's terminals talk to the server (electron/remote-connection.cjs, integration/remote-worker.py, the bootstrap in electron/ssh-config.cjs), adding a request the worker answers, or when SSH terminals open slowly, ask for the password again, or one terminal's trouble reaches another.
---

# SSH terminals and the remote worker

## How it fits together

- One SSH process per host (`RemoteLink`, keyed by ssh path, config file, host and askpass) carries every terminal
  opened there. Its first stdin line is `remote-worker.py`, zlib-compressed and base64 (the bootstrap in
  `sshArguments` decompresses it). A terminal after the first opens without another handshake, login or password.
- Each terminal is a channel (`RemoteConnection`): every message both ways carries `channel`. Agentrix sends
  `{op: "open", channel, path, codingPath, projectId, token, cols, rows, readingNote}` and the worker answers with its
  terminal output, then `ready`; `{op: "shutdown", channel}` closes only that terminal. The SSH process ends when the
  last channel leaves (stdin closes, the worker exits on EOF).
- A message without `channel` from the worker is about the whole connection: an `error` there fails every terminal.
  So does SSH exiting (its stderr is shown in each terminal).
- In the worker, `serve()` reads the messages; each `Channel` has its own `Worker`, request pool and input pool, and
  opens in a thread of its own so a slow folder or Git read never holds the other terminals' keys.
  `Worker.lock` makes a shutdown that arrives while the shell starts wait for it.

## When changing it

- Change both ends together: the worker is sent fresh on every connection, so there is no old worker to stay
  compatible with. Keep the fake worker in `tests/helpers/ssh-fixture.cjs` speaking the same protocol: the Windows
  tests and five desktop smokes (sessions, editor-terminals, git, navigation, themes-markdown) run through it.
- Requests a terminal makes (files, Git, Codex/Claude status) go through its own channel; nothing is shared between
  workers but the process, `os.environ`, stdout (written under one lock), and sanitized Claude account reads.
- `claude-account` is a read-only host-side GET. Hooks register only configuration paths and whether a route override
  is present through the host-local socket; those paths are removed before forwarding the event over SSH. Credentials
  are freshly read on that host, never refreshed, rewritten, cached, logged or returned. Only validated usage windows
  and fixed status words leave the query. The process shares numeric results per remote configuration for at least
  60 seconds, honors Retry-After and backs off; each project's route is checked before any cached result is returned.
  The desktop poller is bound to its live channel and discards cancelled or replaced-session answers. Dashboard quota
  scopes already separate SSH hosts from one another and from local accounts.
- Claude skills have one delivery channel: SessionStart prints `hookSpecificOutput.additionalContext`. startup/resume
  deduplicate by CLI session id and bundle `key`; compact/clear always deliver again. Startup arguments carry only a
  short pointer. State and read-only skill references live below the remote worker's own
  `~/.local/state/agentrix/ssh-skills/`, outside Claude's files; fingerprinted references survive a closed terminal so
  a resumed session's auto-skill paths still exist. The bundle remains `files/instructions/key`. Codex keeps its own
  delivery path; follow the skills module's measured protocol when changing it.

## Testing

- `node --test tests/ssh-connection.test.cjs`: real OpenSSH against a local ssh2 server. On Windows it uses the fake
  worker; on Linux (the CI job "Linux SSH integration") it runs the real Python worker and PTY.
- `python -m unittest discover -s tests -p "*_test.py"`: `serve()` with channels runs on Windows too (the PTY is
  stubbed); PTY tests are skipped off Linux.
- `node --test tests/remote-claude-account.test.cjs tests/remote-ssh-cards.test.cjs`: fake-account validation,
  cancellation, host quota scopes and real-shaped question screens over an isolated OpenSSH connection.
- `python -m unittest discover -s tests -p "remote*_test.py"`: remote-only fake credentials, route checks, numeric
  replies, backoff, hook transport and SessionStart delivery. Inject the HTTP opener; never use a developer login.
- A local `python -u -c '<bootstrap>'` fed the compressed worker checks the bootstrap; it stops at `SIGHUP` on Windows,
  which is expected (the server is always Linux).
- For a real server, use a scratch SSH config and known_hosts in the test output folder and a temporary askpass file
  that is deleted right after; never put the password on a command line or in the repository.
