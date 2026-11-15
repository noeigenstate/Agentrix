# Real-CLI captures (1.5.0, lane K0b)

Captured from the real Claude Code and Codex CLIs, offline: a fake key, a throwaway profile (HOME, USERPROFILE,
APPDATA, LOCALAPPDATA, CLAUDE_CONFIG_DIR, CODEX_HOME, TEMP), a PATH without any claude or codex (checked with
`where.exe` before every start), and local stubs on 127.0.0.1 for the Anthropic and OpenAI Responses APIs. Nothing of
the owner's profile, key or running Agentrix was read or touched. Platform: Windows 11, win32-x64. Values that come from
the machine (user name, folders, ids, ports) are replaced by placeholders such as `<CWD>`, `<HOME>`, `<uuid-N>`.

Versions: Claude Code 2.1.317 (the pinned SDK 0.3.317 binary) and 2.1.322 (reference); Codex 0.166.0 (the version CI
pins) and 0.169.0 (the registry's latest when captured).

| Item | File | What it holds |
|---|---|---|
| 1 | `claude-2.1.317/hook-payloads.json`, `claude-2.1.322/hook-payloads.json` | One entry per hook event name in the binary (33): whether it fired, how it was triggered, the transports that delivered it, the field list, up to five distinct payloads. Events that never fired say what was tried. Includes the `SendMessage` continuation. |
| 2 | `bash-tool-env.json` | The environment that Claude's Bash tool and Codex's shell tool give their children, with the variables each tool added itself. |
| 3 | `async-hooks.json` | Whether async command hooks are non-blocking and leave the model request byte-identical (answer: YES). |
| 4 | `mcp-tool-hook.json` | What an `mcp_tool` hook pointed at a hook-only MCP server changes (reported, not adopted). |
| 5 | `proxy-honour.json` | Which proxy variables the hook (http) client honours, and the `[::1]` NO_PROXY result. |
| 6 | `codex-layouts.json` | Real npm layouts of `@openai/codex` (private prefix, global with npm 10 and 11, hoisted, upgraded, legacy), the shims, how `bin/codex.js` finds the binary and what it exports to its child. The official installer, WinGet, scoop, volta and pnpm shapes are marked `synthetic`. |
| 7 | `proxy-fallback.json` | With a recording proxy set, command hooks reach main over the named pipe and the proxy sees no hook bytes (answer: YES). |

How to read the timing numbers: they are single observations from one machine with nothing else running. They show an
order of magnitude. They are not bounds for a test.

The lab that produced these files is not part of the repository. It lived in the lane's scratch folder (`kb/`:
`lab.cjs`, `codex-lab.cjs`, `bench-all.cjs`, `proxy-all.cjs`, `proxy7-all.cjs` and the `make-*.cjs` builders) and was
derived from `arch/terminal-events/lab.cjs`.
