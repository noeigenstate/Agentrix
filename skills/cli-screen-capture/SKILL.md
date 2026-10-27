---
name: cli-screen-capture
description: When a Claude Code or Codex update changes a screen the reading view parses (a picker, a dialog, the footer, an input box), capture the real screen in isolation and turn it into a parser fixture before changing the parser.
---

# Capturing a CLI screen for the reading view's parsers

The reading view parses CLI state in `src/features/agents/agent-screen.ts`,
`src/features/agents/sign-in-screen.ts` and `src/features/reading/cli-panel.ts`. Interactive slash and shell commands
use the live terminal popup (`src/features/reading/ReadingTerminalPopup.tsx` and `src/features/reading/reading-terminal.ts`)
instead of reformatting captured rows. A CLI update that moves one row can still break state detection: a choice card
that never opens, a sign-in card that stays, or an input mistaken for a dialog. Fix the parser from real terminal rows,
never from a screenshot or memory.

## Steps

1. Write a probe under `.test-output/` that launches Agentrix with an isolated profile (`AGENTRIX_DATA_DIR` in a new
   folder, `terminalRenderer: 'dom'`) and reads the rows from `[data-terminal-id="<id>"] .xterm-rows > div`
   (turn non-breaking spaces into plain ones, trim the ends).
2. Keep the user's CLI state untouched:
   - Codex: point `CODEX_HOME` at a folder of the run with fake rollouts (`sessions/YYYY/MM/DD/rollout-…-<id>.jsonl`,
     `session_meta` with the project `cwd`), `auth.json` holding a placeholder API key
     (`{"OPENAI_API_KEY":"<secret>"}`), and a `config.toml` with `sandbox_mode`,
     `[windows] sandbox = "unelevated"` and `[projects.'<folder>'] trust_level = "trusted"` for the project and the
     repository root, so no sign-in, sandbox or trust prompt comes first. Nothing is sent to a model.
   - Claude Code: run it in `<repo>/.test-output/slash-live-project` (already trusted), only local commands, and leave
     dialogs with Esc so no setting changes.
   - Send only navigation keys (Tab, arrows, Esc, Ctrl+C); never Enter on a list of real sessions.
3. Save the rows as `tests/fixtures/screens/<agent>-<what>.txt` with personal paths replaced (`<project-root>`), and add
   its full expectation to the `expected` table in `tests/agent-screen.test.cjs` (every fixture must have one).
4. Change the parser, run `npm test`, then confirm against the live CLI with the probe or `scripts/slash-live.mjs`.

## Prompts that need a model turn (Codex approvals)

An approval only shows after the model asks for a tool. Never use the real sign-in: point Codex at a stand-in on
`127.0.0.1` instead (`scripts/codex-approval-probe.mjs` does it and checks the reading view).

- `config.toml`: `model = "gpt-6-sol"` (an older model name first shows a "Meet GPT-6 Sol" choice),
  `model_provider = "standin"` with `[model_providers.standin]` `base_url = "http://127.0.0.1:<port>/v1"`,
  `wire_api = "responses"`, `env_key` naming a variable set in the app's environment; `approval_policy = "on-request"`
  (`untrusted` is refused since 0.162) and `sandbox_mode = "read-only"`.
- Answer `POST /v1/responses` with Server-Sent Events: `response.created`, one `response.output_item.done`, then
  `response.completed` with zero usage. Codex 0.162 gives GPT-6 its tools in code mode, so ask for one with a
  `custom_tool_call` named `exec` whose `input` is JavaScript: `await tools.exec_command({cmd: "…", sandbox_permissions:
  "require_escalated", justification: "…"})` for a command, `await tools.apply_patch("*** Begin Patch\n…")` for an edit.
- Codex also asks the same server for a title; reply to anything else with a plain assistant message, and to the output
  of your own call (its `call_id`) with one too.
- Leave each prompt with Esc ("No, and tell Codex what to do differently"): nothing runs, nothing is remembered.

## Lessons

- Screen-derived Electron permission cards are informative and terminal-only for legacy local TUI and SSH sessions: approval,
  rejection, cancellation and navigation must happen manually in the source terminal. The backend independently
  rejects all screen-derived permission-card sends. Opening the source terminal must not send keys. Explicit native
  modes use an owned structured CLI channel; follow `skills/native-approvals/SKILL.md` for those cards.

- Permission text identifies screen content, never a unique approval request. Epochs and observation IDs are not
  native CLI request IDs. A structured adapter must atomically respond to the exact native pending
  session/turn/request identity; local observation hashes and notifications are insufficient. Never restore an
  epoch-only card approval route.

- For Claude Code and Codex, the ABA regression covers mounted old cards and newly reviewed copies after
  A → B → identical A, including B hidden inside one transport batch: expect ZERO card PTY keys, including
  reject/cancel/navigation, while source-terminal navigation and explicit manual input still work. Native
  experimental guard tests may check observed epoch semantics; they do not show that Electron card approvals
  are enabled or safe.

- An offline CLI fixture must retain the command's real output or error above its next empty input. Clearing it before
  the screen publisher observes it erases completion evidence. Test the final coalesced frame and keep empty idle alone
  insufficient for success. Capture the input row after drawing the full frame: bottom-of-screen scrolling can move it.
- Disable supported PSReadLine history prediction only inside shell-based CLI fixtures. Suggested suffixes are painted
  into physical rows even when absent from the input buffer. Reproduce with a scratch modern module via the child's
  `PSModulePath`, enable `History` before fixture loading, and verify literal echoes without relaxing exact receipts.

- A repeated command can redraw exactly the same terminal rows. The 100 ms screen subscription can miss its typed
  input even when xterm received it. Confirm the exact live input with `readScreen()` before sending one Enter, and
  carry that receipt into tracking. Never recover by automatically resending Enter. Test four consecutive `/status`
  commands and a different command afterward; a recovery card alone does not prove the normal path is fixed.

- Claude Code 2.1.296 draws its effort over the input box (`◉ xhigh · /effort`) and may head the model line with `●`;
  `/effort` became a centred slider with an Ultracode switch beside it.
- Codex 0.162 prints `fast` after the effort in its footer, and its resume list's Esc means "start new" after
  `codex resume` but "back" after `/resume`.
- Codex 0.162.1's footer has no context part before the first message (`GPT-6-Sol default · <folder>`); a parser that
  needs `· 90% left` never sees Codex idle, and every slash command's popup then waits forever. Capture a fresh
  conversation as well as one in progress. `/fast` there prints `• Service tier set to priority`.
- Codex 0.162.1 may put a tip under its last answer (`  └ Tip: Moving from Claude Code? Use /import …`) and removes it
  when the next command starts. Never anchor on it: rows taken as "the history when the command was sent" must skip
  it, or the anchor vanishes and the whole conversation looks like the command's output. Capture after several
  rounds (a stand-in model with long answers), not only on a fresh screen.
- Codex 0.162 draws its whole conversation in the terminal's alternate screen: no xterm scrollback and no line markers
  tell how far it scrolled, only the rows on screen. It pins the current turn's prompt (`› …`) to the top row once the
  turn scrolled past it. Run the same command several times in a row (`/status` 4×): a repeat prints the same rows
  again, the history's last rows recur in the new output, and once the screen holds nothing but copies, before and
  after read the same. Find where the history ends by the whole run of history rows above a place, never by the last
  one or two rows alone.
- Codex asks "Would you like to run the following command?", "…make the following edits?" (hotkey `(a)` for "don't ask
  again for these files"), "…grant these permissions?" and "<server> needs your approval."; match the family, not one
  title.
- GPT-6's code-mode calls pass their arguments as JavaScript string literals (`tools.apply_patch("…\n…")`): decode the
  literal before reading file names out of a patch.
- A dialog may draw its own search field like the input box (Claude's `/config`): never drop input-looking rows from a
  dialog, only rows known to be chrome.
- Codex 0.162.1 has two more shapes for interactive commands:
  - Some dialogs are drawn over the conversation (`/memories`' "Enable memories?", and probably `/usage`): a box set
    in from the left, beside or over the conversation's own lines, closed by its key hints (`enter select · esc back`),
    with the input and footer still below it. Cut it out by screen column, counting CJK as two cells
    (`codexDialog` in `agent-screen.ts`). It is no idle input.
  - `/plugins` puts its view in the input's place: its list's cursor row (`› No marketplace plugins…`) looks like the
    input, and its hints (`←/→ tabs · enter details · esc close`) look like a footer. Codex's real input has its
    footer right under it, and the prompt Codex pins to its top row has none.
- Sweep every interactive command, not just the one reported: send each from the reading view and confirm its live
  terminal popup opens promptly and stays interactive. Inspect any separately parsed choice or sign-in card too.
  Use Esc only when the CLI shows it as the dialog's cancel key; use the popup's close button to dismiss the popup.
- `/usage` needs a ChatGPT sign-in. A made-up sign-in pointed at a local stand-in got as far as Codex's workspace
  routing:
  - `/wham/accounts/check` needs `accounts` (a list), `account_ordering`, `default_account_id` and an HTTPS
    `workspace_backend_origin`.
  - A throwaway CA given through `CODEX_CA_CERTIFICATE` makes the HTTPS part work.
  - It then stops at "invalid account routing override", so capture `/usage` from someone's real screen instead.
- Keys sent to a CLI to close what looks like a dialog are dangerous: Escape at a working Claude Code interrupts its
  round. A message quoting a dialog's hint (`esc to cancel`) sits in the conversation; a dialog's hints are in its own
  last rows, at the bottom. And Claude's input box is not one row: a long draft wraps over rows indented two spaces
  before the closing rule (Claude Code 2.1.301), and a pasted picture's chip sits in it too. When the input is not
  recognised, the parser must not conclude "dialog". Reproduce with the real CLI: a stand-in API with a slow first
  answer, a long message sent meanwhile, a picture attached by its path (pasted as text, so no clipboard is used),
  and record every key written to the terminal.
- `window.agentrix` is a contextBridge object: a probe cannot patch its methods (the assignment is silently
  ignored), so a counter wrapped around `writeTerminal` always reads zero. Count keys in the main process instead
  (`app.evaluate`, wrapping the pty write or listening on `ipcMain`), or judge by the terminal's screen. Escape while
  Claude works is safe only when its dialog shows its own hint in the bottom rows (`Esc to cancel`, `Esc to clear` in
  `/config`); `esc to interrupt` is its working footer, never a dialog.
