const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
// Node 24 can require ESM TypeScript directly, erasing the type-only import.
const { parseAgentScreen } = require('../src/features/agents/agent-screen.ts');

const emptyStatus = { model: null, effort: null, context: null, mode: null, notes: [] };
const emptyScreen = { banner: null, status: emptyStatus, choice: null, overlay: 'none' };
const claudeBanner = {
  product: 'Claude Code', version: '2.1.293', model: 'Opus 5.5', effort: 'high',
  plan: 'Claude Max', directory: 'C:\\work\\demo-app',
};
const codexBanner = {
  product: 'OpenAI Codex', version: '0.161.0', model: null, effort: null,
  plan: null, directory: 'C:\\work\\demo-app',
};
const codexStatus = context => ({ ...emptyStatus, model: 'GPT-6.1-Sol', effort: 'high', context });
const option = (number, label, selected = false, detail = '', hotkey = null) =>
  ({ number, label, detail, hotkey, selected });
const readFixture = name => fs.readFileSync(path.join(__dirname, 'fixtures/screens', name + '.txt'), 'utf8').split('\n');
const resumeScreen = (sessions, escape, context = []) => ({ ...emptyScreen, choice: {
  title: 'Resume a previous session', kind: 'menu', options: sessions.map(([label, age], index) => option(index + 1, label, index === 0, age)), context,
  hint: `enter resume · esc ${escape === 'new' ? 'start new' : 'exit'}`, escape,
} });
const claudeScreen = fields => ({ ...emptyScreen, banner: claudeBanner, ...fields });
// Codex 0.162.1 in a conversation of the reading view's own probes (GPT-6-Sol, its default effort, one warning).
const freshBanner = { ...codexBanner, version: '0.162.1', model: 'GPT-6-Sol', effort: 'default' };
const freshStatus = { ...emptyStatus, model: 'GPT-6-Sol', effort: 'default', notes: ['⚠ 1 warning · f2 to view'] };
const codexScreen = fields => ({ ...emptyScreen, banner: codexBanner, ...fields });
const codexFooterScreen = (context, fields) => codexScreen({
  banner: { ...codexBanner, model: 'GPT-6.1-Sol', effort: 'high' }, status: codexStatus(context), ...fields,
});

// Real Claude 2.1.314 / Codex 0.166.0 captures. Keep redraw artifacts in the expectations;
// these permission labels are informative screen text, never permission-request identities.
const capturedClaudeBanner = { ...claudeBanner, version: '2.1.314', model: null, effort: null, plan: null, directory: '<project-root>' };
const capturedCodexBanner = { ...codexBanner, version: '0.166.0', directory: '~\\Desktop\\agentrix\\.test-output\\slash-live-project' };
const capturedClaude = fields => ({ ...emptyScreen, banner: capturedClaudeBanner, ...fields });
const capturedCodex = fields => ({ ...emptyScreen, banner: capturedCodexBanner, ...fields });
const capturedQuestion = (agent, fields = {}) => ({ agent, tabs: [], position: null, multi: false, submit: null, notes: null, review: null, ...fields });
const capturedChoices = {
  "claude-api-key": {
    kind: "menu", title: "Detected a custom API key in your environment", context: ["ANTHROPIC_API_KEY: sk-ant-...e-local-standin-only","Do you want to use this API key?"],
    options: [
      option(1, "Yes"),
      option(2, "No (recommended)", true),
    ], hint: "Enter to confirm · Esc to cancel",
  },
  "claude-bash-amend": {
    kind: "permission", title: "Do you want to proceed?", context: ["Bash command","Local choice probe; cancel without running","printf local-probe > choice-probe-write.txt"],
    options: [
      option(1, "Yes, and tell Claude what to do next", true),
      option(2, "Yes, and always allow access to <project-root> from this"),
      option(3, "Nooject"),
    ], hint: "Esc to cancel",
  },
  "claude-bash": {
    kind: "permission", title: "Do you want to proceed?", context: ["Bash command","Local choice probe; cancel without running","printf local-probe > choice-probe-write.txt"],
    options: [
      option(1, "Yes", true),
      option(2, "Yes, and always allow access to <project-root> from this"),
      option(3, "Nooject"),
    ], hint: "Esc to cancel · Tab to amend",
  },
  "claude-edit": {
    kind: "permission", title: "Do you want to make this edit to choice-probe-edit.txt?", context: ["Edit file","choice-probe-edit.txt","1 -before","1 +after"],
    options: [
      option(1, "Yes", true),
      option(2, "Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session"),
      option(3, "Nohift+tab)"),
    ], hint: "Esc to cancel · Tab to amend",
  },
  "claude-mcp-url-waiting": {
    kind: "permission", title: "MCP server “localprobe” wants to open a URL", context: ["Local MCP choice URL; do not open this link","https://choice-probe.example.invalid/authorize"],
    options: [
      option(1, "Accept", true),
      option(2, "Decline"),
    ], hint: "Esc to cancel · ←/→ to switch",
  },
  "claude-mcp": {
    kind: "permission", title: "Do you want to proceed?", context: ["Tool use","localprobe — Choice Probe Tool: (MCP)","About the localprobe — Choice Probe Tool:","│ Local fixture only: show an input form and do nothing."],
    options: [
      option(1, "Yes", true),
      option(2, "Yes, and don't ask again for localprobe — Choice Probe commands in <repo-root>\\.tes…"),
      option(3, "No"),
    ], hint: "Esc to cancel · Tab to amend",
  },
  "claude-multi": {
    kind: "question", title: "Which checks should the local probe include?", context: [],
    options: [
      { ...option(1, "Parser", true, "Read screen rows"), role: "answer", checked: false },
      { ...option(2, "UI", false, "Inspect the reading card"), role: "answer", checked: false },
      { ...option(3, "Type something"), role: "input", checked: false },
      { ...option(4, "Chat about this"), role: "chat" },
    ], hint: "Enter to select · ↑/↓ to navigate · Esc to cancel",
    question: capturedQuestion("claude", {"multi":true,"submit":{"selected":false}}),
  },
  "claude-plan-waiting": {
    kind: "permission", title: "Exit plan mode?", context: ["Claude wants to exit plan mode"],
    options: [
      option(1, "Yes, and switch to default (ask each time) for this session", true),
      option(2, "No"),
    ], hint: null,
  },
  "claude-review-waiting": {
    kind: "question", title: "Ready to submit your answers?", context: ["⚠ You have not answered all questions"],
    options: [
      { ...option(1, "Submit answers", true), role: "answer" },
      { ...option(2, "Cancel"), role: "answer" },
    ], hint: null,
    question: capturedQuestion("claude", {"tabs":[{"label":"Format","answered":false},{"label":"Checks","answered":false}],"review":[]}),
  },
  "claude-single-input": {
    kind: "question", title: "Which output format should the local probe use?", context: [],
    options: [
      { ...option(1, "Text", false, "Plain text"), role: "answer" },
      { ...option(2, "JSON", false, "Structured text"), role: "answer" },
      { ...option(3, "Type something.", true), role: "input" },
      { ...option(4, "Chat about this"), role: "chat" },
    ], hint: "Enter to select · ↑/↓ to navigate · ctrl+g to edit in Notepad · Esc to cancel",
    question: capturedQuestion("claude"),
  },
  "claude-single": {
    kind: "question", title: "Which output format should the local probe use?", context: [],
    options: [
      { ...option(1, "Text", true, "Plain text"), role: "answer" },
      { ...option(2, "JSON", false, "Structured text"), role: "answer" },
      { ...option(3, "Type something."), role: "input" },
      { ...option(4, "Chat about this"), role: "chat" },
    ], hint: "Enter to select · ↑/↓ to navigate · Esc to cancel",
    question: capturedQuestion("claude"),
  },
  "claude-tabs-second": {
    kind: "question", title: "Which checks should the local probe include?", context: [],
    options: [
      { ...option(1, "Parser", true, "Read screen rows"), role: "answer", checked: false },
      { ...option(2, "UI", false, "Inspect the reading card"), role: "answer", checked: false },
      { ...option(3, "Type something"), role: "input", checked: false },
      { ...option(4, "Chat about this"), role: "chat" },
    ], hint: "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
    question: capturedQuestion("claude", {"tabs":[{"label":"Format","answered":false},{"label":"Checks","answered":false}],"multi":true,"submit":{"selected":false}}),
  },
  "claude-tabs": {
    kind: "question", title: "Which output format should the local probe use?", context: [],
    options: [
      { ...option(1, "Text", true, "Plain text"), role: "answer" },
      { ...option(2, "JSON", false, "Structured text"), role: "answer" },
      { ...option(3, "Type something."), role: "input" },
      { ...option(4, "Chat about this"), role: "chat" },
    ], hint: "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
    question: capturedQuestion("claude", {"tabs":[{"label":"Format","answered":false},{"label":"Checks","answered":false}]}),
  },
  "claude-trust": {
    kind: "menu", title: "Accessing workspace:", context: ["<project-root>","Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source","project, or work from your team). If not, take a moment to review what's in this folder first.","Claude Code'll be able to read, edit, and execute files here.","Security guide"],
    options: [
      option(1, "No, exit", true),
      option(2, "Yes, I trust this folder"),
    ], hint: "Enter to confirm · Esc to cancel",
  },
  "claude-web": {
    kind: "permission", title: "Do you want to allow Claude to fetch this content?", context: ["Fetch","Claude wants to fetch content from choice-probe.example.invalid","url: https://choice-probe.example.invalid/","prompt: Read the title only"],
    options: [
      option(1, "Yes", true),
      option(2, "Yes, and don't ask again for choice-probe.example.invalid"),
      option(3, "No, and tell Claude what to do differently (esc)"),
    ], hint: null,
  },
  "claude-write": {
    kind: "permission", title: "Do you want to create choice-probe-new.txt?", context: ["Create file","choice-probe-new.txt","1 Local probe; cancel without writing"],
    options: [
      option(1, "Yes", true),
      option(2, "Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session"),
      option(3, "Nohift+tab)"),
    ], hint: "Esc to cancel · Tab to amend",
  },
  "codex-command-reopened": {
    kind: "permission", title: "Would you like to run the following command?", context: ["Environment: local","Reason: Local choice probe; cancel this command","$ Set-Content -LiteralPath 'choice-probe-write.txt' -Value 'local'"],
    options: [
      option(1, "Yes, proceed", true, "", "y"),
      option(2, "Yes, and don't ask again for commands that start with `Set-Content -LiteralPath choice-probe-write.txt -Value local`", false, "", "p"),
      option(3, "No, and tell Codex what to do differently", false, "", "esc"),
    ], hint: "Press enter to confirm or esc to cancel",
  },
  "codex-mcp-tool-approval": {
    kind: "permission", title: "Allow the localprobe MCP server to run tool \"choice_probe\"?", context: [],
    options: [
      option(1, "Allow", true, "Run the tool and continue"),
      option(2, "Allow for this session", false, "Run the tool and remember this choice for this session"),
      option(3, "Always allow", false, "Run the tool and remember this choice for future tool calls"),
      option(4, "Cancel", false, "Cancel this tool call"),
    ], hint: "enter to submit | esc to cancel",
  },
  "codex-mcp-url": {
    kind: "permission", title: "Action required", context: ["Server: localprobe","Local MCP choice URL; do not open this link","URL","https://choice-probe.example.invalid/authorize","Complete the requested action in your browser, then return here."],
    options: [
      option(1, "Open link", true),
      option(2, "Back"),
    ], hint: "tab / ↑ ↓ move · enter select · esc close",
  },
  "codex-patch": {
    kind: "permission", title: "Would you like to make the following edits?", context: ["Description: Apply proposed file edits","Destination: <project-root>\\choice-probe-new.txt"],
    options: [
      option(1, "Yes, proceed", true, "", "y"),
      option(2, "Yes, and don't ask again for these files", false, "", "a"),
      option(3, "No, and tell Codex what to do differently", false, "", "esc"),
    ], hint: "Press enter to confirm or esc to cancel",
  },
  "codex-permissions": {
    kind: "permission", title: "Would you like to grant these permissions?", context: ["Environment: local","Reason: Local choice probe; cancel this grant","Permission rule: network"],
    options: [
      option(1, "Yes, grant these permissions for this turn", true, "", "y"),
      option(2, "Yes, grant for this turn with strict auto review", false, "", "r"),
      option(3, "Yes, grant these permissions for this session", false, "", "a"),
      option(4, "No, continue without permissions", false, "", "d"),
    ], hint: "Press enter to confirm or esc to cancel",
  },
  "codex-plan-complete": {
    kind: "permission", title: "Implement this plan?", context: [],
    options: [
      option(1, "Yes, implement this plan", true, "Switch to Default and start coding"),
      option(2, "Yes, clear context and implement", false, "Fresh thread with this plan"),
      option(3, "No, stay in Plan mode", false, "Continue planning with the model"),
    ], hint: "enter select · esc back",
  },
  "codex-question-last": {
    kind: "question", title: "Which checks should the local probe include?", context: [],
    options: [
      { ...option(1, "Parser", true, "Read screen rows"), role: "answer" },
      { ...option(2, "UI", false, "Inspect the reading card"), role: "answer" },
      { ...option(3, "None of the above", false, "Optionally, add details in notes (tab)"), role: "answer" },
    ], hint: "tab to add notes | enter to submit all | ←/→ to navigate questions | esc to interrupt",
    question: capturedQuestion("codex", {"position":{"index":2,"count":2},"notes":{"open":false,"text":""}}),
  },
  "codex-question-notes": {
    kind: "question", title: "Which output format should the local probe use?", context: [],
    options: [
      { ...option(1, "Text", true, "Plain text"), role: "answer" },
      { ...option(2, "JSON", false, "Structured text"), role: "answer" },
      { ...option(3, "None of the above", false, "Optionally, add details in notes (tab)"), role: "answer" },
    ], hint: "tab or esc to clear notes | enter to submit answer",
    question: capturedQuestion("codex", {"position":{"index":1,"count":2},"notes":{"open":true,"text":""}}),
  },
  "codex-question": {
    kind: "question", title: "Which output format should the local probe use?", context: [],
    options: [
      { ...option(1, "Text", true, "Plain text"), role: "answer" },
      { ...option(2, "JSON", false, "Structured text"), role: "answer" },
      { ...option(3, "None of the above", false, "Optionally, add details in notes (tab)"), role: "answer" },
    ], hint: "tab to add notes | enter to submit answer | ←/→ to navigate questions | esc to interrupt",
    question: capturedQuestion("codex", {"position":{"index":1,"count":2},"notes":{"open":false,"text":""}}),
  },
  "codex-script-command": {
    kind: "permission", title: "Would you like to run the following command?", context: ["Environment: local","Reason: Create hello.txt in the project?","$ Set-Content -LiteralPath 'hello.txt' -Value 'hi'"],
    options: [
      option(1, "Yes, proceed", true, "", "y"),
      option(2, "Yes, and don't ask again for commands that start with `Set-Content -LiteralPath hello.txt -Value hi`", false, "", "p"),
      option(3, "No, and tell Codex what to do differently", false, "", "esc"),
    ], hint: "Press enter to confirm or esc to cancel",
  },
  "codex-script-edit": {
    kind: "permission", title: "Would you like to make the following edits?", context: ["Description: Apply proposed file edits","Destination: <project-root>\\notes.md"],
    options: [
      option(1, "Yes, proceed", true, "", "y"),
      option(2, "Yes, and don't ask again for these files", false, "", "a"),
      option(3, "No, and tell Codex what to do differently", false, "", "esc"),
    ], hint: "Press enter to confirm or esc to cancel",
  },
};

const expected = {
  "claude-investigation-api-key": { ...emptyScreen, choice: capturedChoices["claude-api-key"] },
  "claude-investigation-bash-amend": capturedClaude({ choice: capturedChoices["claude-bash-amend"] }),
  "claude-investigation-bash": capturedClaude({ choice: capturedChoices["claude-bash"] }),
  "claude-investigation-edit": capturedClaude({ choice: capturedChoices["claude-edit"] }),
  "claude-investigation-mcp-form-field": capturedClaude({ waiting: {"title":"MCP server “localprobe” requests your input"} }),
  "claude-investigation-mcp-form-waiting": capturedClaude({ waiting: {"title":"MCP server “localprobe” requests your input"} }),
  "claude-investigation-mcp-form": capturedClaude({ waiting: {"title":"MCP server “localprobe” requests your input"} }),
  "claude-investigation-mcp-url-waiting": capturedClaude({ choice: capturedChoices["claude-mcp-url-waiting"] }),
  "claude-investigation-mcp-url": capturedClaude({ choice: capturedChoices["claude-mcp-url-waiting"] }),
  "claude-investigation-mcp": capturedClaude({ choice: capturedChoices["claude-mcp"] }),
  "claude-investigation-multi": capturedClaude({ choice: capturedChoices["claude-multi"] }),
  "claude-investigation-plan-waiting": capturedClaude({ choice: capturedChoices["claude-plan-waiting"] }),
  "claude-investigation-plan": capturedClaude({ choice: capturedChoices["claude-plan-waiting"] }),
  "claude-investigation-review-waiting": capturedClaude({ choice: capturedChoices["claude-review-waiting"] }),
  "claude-investigation-review": capturedClaude({ choice: capturedChoices["claude-review-waiting"] }),
  "claude-investigation-single-input": capturedClaude({ choice: capturedChoices["claude-single-input"] }),
  "claude-investigation-single-reopened": capturedClaude({ choice: capturedChoices["claude-single-input"] }),
  "claude-investigation-single": capturedClaude({ choice: capturedChoices["claude-single"] }),
  "claude-investigation-tabs-second": capturedClaude({ choice: capturedChoices["claude-tabs-second"] }),
  "claude-investigation-tabs": capturedClaude({ choice: capturedChoices["claude-tabs"] }),
  "claude-investigation-tall": { ...emptyScreen, waiting: {"title":null} },
  "claude-investigation-trust": { ...emptyScreen, choice: capturedChoices["claude-trust"] },
  "claude-investigation-web": capturedClaude({ choice: capturedChoices["claude-web"] }),
  "claude-investigation-write": capturedClaude({ choice: capturedChoices["claude-write"] }),
  "codex-investigation-command-reopened": capturedCodex({ choice: capturedChoices["codex-command-reopened"] }),
  "codex-investigation-command": capturedCodex({ choice: capturedChoices["codex-command-reopened"] }),
  "codex-investigation-mcp-form": capturedCodex({ waiting: {"title":"Local MCP choice form"} }),
  "codex-investigation-mcp-tool-approval": capturedCodex({ choice: capturedChoices["codex-mcp-tool-approval"] }),
  "codex-investigation-mcp-url": capturedCodex({ choice: capturedChoices["codex-mcp-url"] }),
  "codex-investigation-patch": capturedCodex({ choice: capturedChoices["codex-patch"] }),
  "codex-investigation-permissions": capturedCodex({ choice: capturedChoices["codex-permissions"] }),
  "codex-investigation-plan-complete": capturedCodex({ choice: capturedChoices["codex-plan-complete"] }),
  "codex-investigation-question-last": capturedCodex({ choice: capturedChoices["codex-question-last"] }),
  "codex-investigation-question-notes": capturedCodex({ choice: capturedChoices["codex-question-notes"] }),
  "codex-investigation-question": capturedCodex({ choice: capturedChoices["codex-question"] }),
  "codex-investigation-script-command": capturedCodex({ choice: capturedChoices["codex-script-command"], banner: { ...capturedCodexBanner, directory: "~\\Desktop\\agentrix\\.test-output\\codex-approval-1793373092906\\approval" } }),
  "codex-investigation-script-edit": capturedCodex({ choice: capturedChoices["codex-script-edit"], banner: { ...capturedCodexBanner, directory: "~\\Desktop\\agentrix\\.test-output\\codex-approval-1793373092906\\approval" } }),
  'codex-bang-typed': { ...emptyScreen, banner: { ...codexBanner, version: '0.163.0', model: 'GPT-6-Sol', effort: 'default' }, status: { ...emptyStatus, model: 'GPT-6-Sol', effort: 'default', notes: ['Shell mode'] } },
  'claude-bang-typed': { ...emptyScreen, banner: { ...claudeBanner, version: '2.1.302', model: null, effort: null, plan: null } },
  'claude-bang-empty-typed': { ...emptyScreen, banner: { ...claudeBanner, version: '2.1.302', model: null, effort: null, plan: null } },
  'claude-bang-running': { ...emptyScreen, banner: { ...claudeBanner, version: '2.1.302', model: null, effort: null, plan: null }, status: { ...emptyStatus, mode: 'manual mode on' } },
  'claude-bang-output': { ...emptyScreen, banner: { ...claudeBanner, version: '2.1.302', model: null, effort: null, plan: null }, status: { ...emptyStatus, mode: 'manual mode on' } },
  'claude-bang-empty-running': { ...emptyScreen, banner: { ...claudeBanner, version: '2.1.302', model: null, effort: null, plan: null }, status: { ...emptyStatus, mode: 'manual mode on' } },
  'claude-bang-empty-done': { ...emptyScreen, banner: { ...claudeBanner, version: '2.1.302', model: null, effort: null, plan: null }, status: { ...emptyStatus, mode: 'manual mode on' } },
  'claude-bang-multiline': { ...emptyScreen, banner: { ...claudeBanner, version: '2.1.302', model: null, effort: null, plan: null }, status: { ...emptyStatus, mode: 'manual mode on' } },
  'claude-bang-empty-model-working': { ...emptyScreen, banner: { ...claudeBanner, version: '2.1.302', model: null, effort: null, plan: null }, status: { ...emptyStatus, mode: 'manual mode on' } },
  'claude-2-1-302-start': { ...emptyScreen, banner: { product: 'Claude Code', version: '2.1.302', model: null, effort: null, plan: null, directory: 'C:\\work\\demo-app' }, status: { ...emptyStatus, mode: 'manual mode on' } },
  'claude-2-1-302-status': emptyScreen,
  'claude-2-1-302-config': emptyScreen,
  'codex-0-163-status': { ...emptyScreen, banner: { ...codexBanner, version: '0.163.0', model: 'GPT-6-Sol', effort: 'default', directory: null }, status: freshStatus },
  'codex-0-163-model': { ...emptyScreen, banner: { ...codexBanner, version: '0.163.0', directory: null }, choice: {
    title: 'Select Model and Effort', kind: 'menu', context: [], hint: 'enter select · esc back', options: [
      option(1, 'GPT-6.1-Sol', false, 'Latest workhorse model for coding and everyday work.'),
      option(2, 'GPT-6-Astra', false, 'Frontier intelligence for the most demanding work.'),
      option(3, 'GPT-6-Sol (current)', true, 'Previous generation workhorse model.'),
      option(4, 'GPT-6-Luna', false, 'Fast and affordable model for easier tasks.'),
      option(5, 'GPT-5.6-Sol', false, 'Older generation workhorse model.'),
      option(6, 'GPT-5.6-Terra', false, 'Older balanced model for straightforward work.'),
      option(7, 'GPT-5.6-Luna', false, 'Older fast and efficient model.'),
      option(8, 'GPT-5.5', false, 'Legacy coding model.'),
    ],
  } },
  'codex-0-163-permissions': { ...emptyScreen, banner: { ...codexBanner, version: '0.163.0', directory: null } },
  'codex-0-163-plugins': { ...emptyScreen, banner: { ...codexBanner, version: '0.163.0', directory: null } },
  'codex-0-163-memories': { ...emptyScreen, banner: { ...codexBanner, version: '0.163.0', model: 'GPT-6-Sol', effort: 'default', directory: null }, status: freshStatus, choice: {
    title: 'Enable memories?', kind: 'menu', context: ['Memories are disabled in this TUI session.'], hint: 'enter select · esc back', options: [
      option(1, 'Yes, enable', true, 'Save on the server for new threads without changing this thread'),
      option(2, 'Not now', false, 'Keep memories disabled'),
    ],
  } },
  'claude-startup': claudeScreen({ status: { ...emptyStatus, mode: 'manual mode on' } }),
  'claude-after-deny': claudeScreen({ status: {
    ...emptyStatus, model: 'Opus 5.5', effort: 'high', context: 'ctx 4%', mode: 'manual mode on',
  } }),
  'claude-permission': claudeScreen({ choice: {
    kind: 'permission', title: 'Do you want to create hello.txt?',
    context: ['Create file', 'hello.txt', '1 hi'],
    options: [
      option(1, 'Yes', true),
      option(2, 'Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)'),
      option(3, 'No'),
    ], hint: 'Esc to cancel · Tab to amend',
  } }),
  'claude-model-menu': claudeScreen({ choice: {
    kind: 'menu', title: 'Select model', context: [
      'Switch between Claude models. Your pick becomes the default for new sessions. For other/previous model names,',
      'specify with --model.',
    ], options: [
      option(1, 'Default (recommended)', false, 'Opus 5.5 · Best for everyday, complex tasks'),
      option(2, 'Opus 5.5 ✔', true, 'For complex work and everyday tasks'),
      option(3, 'Fable 5.1', false, 'For your toughest challenges'),
      option(4, 'Sonnet 5.5', false, 'Most efficient for simpler tasks'),
      option(5, 'Haiku 5.5', false, 'Fastest for quick answers'),
      option(6, 'Haiku 4.5', false, 'Fastest for quick answers'),
      option(7, 'Sonnet 5', false, 'Efficient for routine tasks'),
      option(8, 'Opus 5', false, 'Best for everyday, complex tasks'),
      option(9, 'Fable 5', false, 'Most capable for your hardest and longest-running tasks'),
      option(10, 'Opus 4.8', false, 'Best for everyday, complex tasks'),
    ], hint: 'Enter to set as default · s to use this session only · Esc to cancel',
  } }),
  'claude-slash-typed': claudeScreen({ overlay: 'slash' }),
  'claude-mention': claudeScreen({ overlay: 'mention' }),
  'claude-shortcuts': claudeScreen({ overlay: 'shortcuts' }),
  // Codex 0.162.1 before the first message: no context part in its footer.
  'codex-fresh-default': codexScreen({ banner: { ...codexBanner, version: '0.162.1', model: 'GPT-6-Sol', effort: 'default' }, status: {
    ...emptyStatus, model: 'GPT-6-Sol', effort: 'default', notes: ['⚠ 1 warning · f2 to view'],
  } }),
  'codex-fast-done': codexScreen({ banner: { ...codexBanner, version: '0.162.1', model: 'GPT-6-Sol', effort: 'default' }, status: {
    ...emptyStatus, model: 'GPT-6-Sol', effort: 'default', notes: ['⚠ 1 warning · f2 to view'],
  } }),
  'codex-startup': codexFooterScreen('872K wi…', { status: {
    ...codexStatus('872K wi…'), notes: ['⚠ 1 warning · f2 to view'],
  } }),
  'codex-permission': codexScreen({ choice: {
    kind: 'permission', title: 'Would you like to run the following command?', context: [
      'Environment: local',
      'Reason: Allow creating hello.txt containing hi in this workspace? The filesystem sandbox is read-only.',
      "$ Set-Content -LiteralPath 'hello.txt' -Value 'hi' -NoNewline -Encoding ascii",
    ], options: [
      option(1, 'Yes, proceed', true, '', 'y'),
      option(2, "Yes, and don't ask again for commands that start with `Set-Content -LiteralPath hello.txt -Value hi -NoNewline -Encoding ascii`", false, '', 'p'),
      option(3, 'No, and tell Codex what to do differently', false, '', 'esc'),
    ], hint: 'Press enter to confirm or esc to cancel',
  } }),
  // Codex 0.162 asking before it writes a file (apply_patch outside what the sandbox may write).
  'codex-edit-permission': codexScreen({ banner: { ...codexBanner, version: '0.162.1' }, choice: {
    kind: 'permission', title: 'Would you like to make the following edits?', context: [
      'Description: Apply proposed file edits',
      'Destination: C:\\work\\demo-app\\notes.md',
    ], options: [
      option(1, 'Yes, proceed', true, '', 'y'),
      option(2, "Yes, and don't ask again for these files", false, '', 'a'),
      option(3, 'No, and tell Codex what to do differently', false, '', 'esc'),
    ], hint: 'Press enter to confirm or esc to cancel',
  } }),
  'codex-model-menu': codexScreen({ choice: {
    kind: 'menu', title: 'Select Model and Effort', context: [], options: [
      option(1, 'GPT-6.1-Sol (current)', true, 'Latest workhorse model for coding and everyday work.'),
      option(2, 'GPT-6-Astra', false, 'Frontier intelligence for the most demanding work.'),
      option(3, 'GPT-6-Sol', false, 'Previous generation workhorse model.'),
      option(4, 'GPT-6-Luna', false, 'Fast and affordable model for easier tasks.'),
      option(5, 'GPT-5.6-Sol', false, 'Older generation workhorse model.'),
      option(6, 'GPT-5.6-Terra', false, 'Older balanced model for straightforward work.'),
      option(7, 'GPT-5.6-Luna', false, 'Older fast and efficient model.'),
    ], hint: 'enter select · esc back',
  } }),
  'codex-slash-typed': codexFooterScreen('872K wi…', { overlay: 'slash' }),
  'codex-mention': codexFooterScreen('828K wi…', { overlay: 'mention' }),
  'codex-shortcuts': codexFooterScreen('828K wi…', { overlay: 'shortcuts' }),
  // Claude Code 2.1.296 at its prompt: the effort over the input box ("◉ xhigh · /effort"), the model and mode under it.
  'claude-idle-2-1-296': { ...emptyScreen, banner: { ...claudeBanner, version: '2.1.296', effort: 'xhigh', directory: '~\\work\\demo-app' },
    status: { ...emptyStatus, model: 'Opus 5.5', effort: 'xhigh', mode: 'auto mode on' } },
  // Claude Code 2.1.301 at work, a long dictated message left unsent in its input, wrapped over three rows (see
  // cli-panel.test.cjs): no choice, nothing over it.
  'claude-wrapped-draft': { ...emptyScreen, banner: { ...claudeBanner, version: '2.1.301', model: null, effort: null, plan: null, directory: '~\\work\\demo-app' } },
  // Claude Code 2.1.302's /usage during a round: the capture has no banner, input footer or choice.
  'claude-usage-working': emptyScreen,
  // Claude Code 2.1.302's /config during a round: settings and its filter hint are not an agent choice or footer.
  'claude-config-working': emptyScreen,
  // Codex 0.162's resume list, drawn by "codex resume", by /resume inside a conversation, with nothing to resume, and
  // as Codex draws it on Linux.
  'codex-resume-start': resumeScreen([['整理发布说明', '2s ago'], ['修复阅读视图的滚动', '2s ago'], ['合并远端主分支', '2s ago']], 'new'),
  'codex-resume-inside': resumeScreen([['整理发布说明', '13s ago'], ['修复阅读视图的滚动', '13s ago'], ['合并远端主分支', '13s ago']], 'back'),
  'codex-resume-empty': resumeScreen([], 'new', ['No sessions yet']),
  // Codex 0.162.1 draws /memories' dialog over its conversation, input and footer still below it; the dialog asks.
  'codex-memories-dialog': codexScreen({ banner: freshBanner, status: freshStatus, choice: {
    kind: 'menu', title: 'Enable memories?', context: ['Memories are disabled in this TUI session.'], options: [
      option(1, 'Yes, enable', true, 'Save on the server for new threads without changing this thread'),
      option(2, 'Not now', false, 'Keep memories disabled'),
    ], hint: 'enter select · esc back',
  } }),
  'codex-memories-dialog-before': codexScreen({ banner: freshBanner, status: freshStatus }),
  // /plugins takes the input's place: its list's cursor row is no input, and its key hints are no footer.
  'codex-plugins-view': emptyScreen,
  'codex-plugins-view-before': codexScreen({ banner: freshBanner, status: freshStatus }),
  'codex-resume-linux': resumeScreen([['合并远端主分支', '3h ago'], ['修复阅读视图', '10h ago'], ['整理发布说明', '11h ago'], ['继承 Claude 日志', '2d ago'], ['查找 resume 记忆', '20d ago'],
    ['合并主分支', '26d ago'], ['删除显示和系统监控功能', '28d ago'], ['删除所有 mcp、plugin 和 skill', '35d ago']], 'new'),
};

test('every checked-in screen fixture has an explicit expectation', () => {
  assert.deepEqual(fs.readdirSync(path.join(__dirname, 'fixtures/screens')).sort(),
    Object.keys(expected).map(name => name + '.txt').sort());
});
for (const [name, result] of Object.entries(expected)) {
  test(name + ': full structured screen', () => {
    assert.deepEqual(parseAgentScreen(name.startsWith('claude') ? 'claude' : 'codex', readFixture(name)), result);
  });
}

for (const agent of ['claude', 'codex']) {
  test(agent + ': empty screen and plain PowerShell are empty state', () => {
    for (const rows of [[], ['', '  ', '\r'], ['PS C:\\work\\demo-app> ']]) {
      assert.deepEqual(parseAgentScreen(agent, rows), emptyScreen);
    }
  });
  test(agent + ': historical options are dismissed by later input or conversation', () => {
    const rows = readFixture(agent + '-permission');
    const marker = agent === 'claude' ? '❯' : '›';
    for (const suffix of [[marker + ' Continue', '● Done'], ['● Permission denied'], [marker]]) {
      assert.equal(parseAgentScreen(agent, [...rows, ...suffix]).choice, null);
    }
  });
  test(agent + ': only the final live list is parsed', () => {
    const rows = [...readFixture(agent + '-permission'), ...readFixture(agent + '-model-menu')];
    assert.deepEqual(parseAgentScreen(agent, rows).choice, expected[agent + '-model-menu'].choice);
  });
  test(agent + ': ordinary numbered conversation is not a choice', () => {
    assert.equal(parseAgentScreen(agent, ['Here are the results:', '  1. First', '  2. Second']).choice, null);
  });
}

// Claude Code 2.1.299's Bash prompt, as captured (through a stand-in model).
const claudeBash = ['❯ RUNBASH 请照做', '', '  Creating hello.txt', '  ⎿  $ Set-Content -LiteralPath hello.txt -Value hi', '', '─'.repeat(60), ' Bash command',
  ' Tip: auto mode handles these prompts for you — choose "switch to auto mode" below', ' Create hello.txt', '╌'.repeat(60), ' Set-Content -LiteralPath hello.txt -Value hi', '╌'.repeat(60),
  ' This command requires approval', '', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. Yes, and don’t ask again for: Set-Content *',
  '   3. Yes, and switch to auto mode · auto mode handles these prompts for you', '   4. No', '', ' Esc to cancel · Tab to amend'];
test('Claude 2.1.299\'s Bash prompt is a choice of four', () => {
  const choice = parseAgentScreen('claude', claudeBash).choice;
  assert.equal(choice.kind, 'permission');
  assert.equal(choice.title, 'Do you want to proceed?');
  assert.deepEqual(choice.options.map(option => [option.number, option.selected]), [[1, true], [2, false], [3, false], [4, false]]);
});
test('a numbered Claude menu in a form not known yet is still laid out, never left with nothing to answer', () => {
  const extra = [...claudeBash.slice(0, -2), '   ctrl+e to explain this command', '', ' Esc to cancel · Tab to amend'];
  const choice = parseAgentScreen('claude', extra).choice;
  assert.equal(choice.kind, 'permission', 'an unexpected row under the options');
  assert.deepEqual(choice.options.map(option => option.label), ['Yes', 'Yes, and don’t ask again for: Set-Content *', 'Yes, and switch to auto mode · auto mode handles these prompts for you', 'No']);
  const fresh = ['● Bash(rm -rf build)', '', '─'.repeat(60), ' Auto mode paused on a risky command', ' rm -rf build', '', ' Run it anyway', ' ❯ 1. Allow once', '     just this time', '   2. Deny', '', ' Enter to confirm · Esc to cancel', '', '  ⏸ manual mode on · ? for shortcuts'];
  assert.deepEqual(parseAgentScreen('claude', fresh).choice, { title: 'Run it anyway', kind: 'menu', hint: 'Enter to confirm · Esc to cancel', context: ['Auto mode paused on a risky command', 'rm -rf build'],
    options: [{ number: 1, label: 'Allow once', detail: 'just this time', selected: true, hotkey: null }, { number: 2, label: 'Deny', detail: '', selected: false, hotkey: null }] });
  assert.equal(parseAgentScreen('claude', [...fresh.slice(0, -2), '● Permission denied']).choice, null, 'answered: conversation came after it');
  assert.equal(parseAgentScreen('claude', [...fresh, '─'.repeat(60), '❯ ', '─'.repeat(60)]).choice, null, 'Claude\'s input is back');
  assert.equal(parseAgentScreen('claude', ['Pick one:', '  1. First', '  2. Second', 'Esc to cancel']).choice?.kind ?? null, null, 'no cursor on an option');
});
test('padding and trailing carriage returns preserve every fixture without mutating input', () => {
  for (const [name, result] of Object.entries(expected)) {
    const rows = Object.freeze(readFixture(name).map(row => row.replace(/\r$/, '') + '   \r'));
    assert.deepEqual(parseAgentScreen(name.startsWith('claude') ? 'claude' : 'codex', rows), result, name);
  }
});

test('Claude mode symbols and parenthetical cycle hints', () => {
  for (const [symbol, mode] of [['⏵⏵', 'bypass permissions on'], ['⏵⏵', 'accept edits on'], ['⏸', 'plan mode on']]) {
    assert.deepEqual(parseAgentScreen('claude', ['────', '❯', '────', `${symbol} ${mode} (shift+tab to cycle)`]), {
      ...emptyScreen, status: { ...emptyStatus, mode },
    });
  }
});

test('footers use the bottom composer and ignore historical status lines', () => {
  const claude = [...readFixture('claude-after-deny'), '────', '❯', '────', '⏸ plan mode on · ← for agents'];
  assert.deepEqual(parseAgentScreen('claude', claude).status, { ...emptyStatus, mode: 'plan mode on' });
  const codex = [...readFixture('codex-startup'), '› New input', '', 'Other-Model low · /tmp/demo · 90% left', '? for shortcuts'];
  assert.deepEqual(parseAgentScreen('codex', codex).status, {
    ...emptyStatus, model: 'Other-Model', effort: 'low', context: '90% left',
  });
});

test('missing banner fields and footer effort stay null', () => {
  assert.deepEqual(parseAgentScreen('claude', ['Claude Code v2.1.293']), {
    ...emptyScreen, banner: { ...claudeBanner, model: null, effort: null, plan: null, directory: null },
  });
  assert.deepEqual(parseAgentScreen('codex', ['›', 'GPT-6.1-Sol · /tmp/demo · 90% left']).status, {
    ...emptyStatus, model: 'GPT-6.1-Sol', context: '90% left',
  });
});

test('wrapped two-column detail, scroll prefixes, hotkeys, and missing hint', () => {
  assert.deepEqual(parseAgentScreen('codex', [
    'Select Model and Effort', '  ↓ 10. Some Model  For complex', '        work (p)', '  › 11. Other (current)',
  ]).choice, {
    title: 'Select Model and Effort', kind: 'menu', context: [], hint: null,
    options: [option(10, 'Some Model', false, 'For complex work', 'p'), option(11, 'Other (current)', true)],
  });
});

test('Allow titles are permissions; a list without a cursor has no selected option', () => {
  assert.deepEqual(parseAgentScreen('codex', ['Allow editing this file?', '  1. Yes (y)', '  2. No (esc)']).choice, {
    kind: 'permission', title: 'Allow editing this file?', context: [], hint: null,
    options: [option(1, 'Yes', false, '', 'y'), option(2, 'No', false, '', 'esc')],
  });
});

test('old popup text above new conversation does not set an overlay', () => {
  for (const agent of ['claude', 'codex']) {
    for (const popup of ['slash-typed', 'mention', 'shortcuts']) {
      const marker = agent === 'claude' ? '❯' : '›';
      const suffix = agent === 'claude' ? ['────', marker, '────'] : [marker, '', 'GPT-6.1-Sol high · /tmp/demo · 90% left'];
      assert.equal(parseAgentScreen(agent, [...readFixture(agent + '-' + popup), marker + ' Continue', '● Done', ...suffix]).overlay, 'none');
    }
  }
});

test('prompts shown before the input exists are choices: Codex update offer, folders to trust, resuming from a summary', () => {
  // Codex 0.162 at start-up, as captured.
  const update = ['', '  Update available · 0.162.0 → 0.162.1', '  Release notes: https://github.com/openai/codex/releases/latest',
    "› 1. Update now (runs `powershell -ExecutionPolicy Bypass -c 'irm https://chatgpt.com/codex/install.ps1 | iex'`)", '  2. Skip',
    '  3. Skip until next version', '  enter continue · esc skip', ''];
  const offer = parseAgentScreen('codex', update).choice;
  assert.equal(offer.title, 'Update available · 0.162.0 → 0.162.1');
  assert.deepEqual(offer.context, ['Release notes: https://github.com/openai/codex/releases/latest']);
  assert.deepEqual(offer.options.map(option => [option.number, option.label.slice(0, 10), option.selected]), [[1, 'Update now', true], [2, 'Skip', false], [3, 'Skip until', false]]);
  assert.equal(offer.hint, 'enter continue · esc skip');
  const codexTrust = ['', '> You are running Codex in C:\work\demo', '', '  Since this folder is not version controlled, we recommend requiring approval of all edits and commands.', '',
    '› 1. Allow Codex to work in this folder without asking for approval', '  2. Require approval of edits and commands', '', '  Press enter to continue'];
  const trusting = parseAgentScreen('codex', codexTrust).choice;
  assert.equal(trusting.title, 'Since this folder is not version controlled, we recommend requiring approval of all edits and commands.');
  assert.equal(trusting.options.length, 2);
  // Claude 2.1.296 hides the numbers and puts the cursor on "No, exit" first.
  const claudeTrust = [' Accessing workspace:', '', ' C:\work\demo', '', ' Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source', ' project, or work from your team).',
    '', ' Security guide', '', ' ❯ No, exit', '   Yes, I trust this folder', '', ' Enter to confirm · Esc to cancel'];
  const trust = parseAgentScreen('claude', claudeTrust).choice;
  assert.equal(trust.title, 'Accessing workspace:');
  assert.equal(trust.context[0], 'C:\work\demo');
  assert.match(trust.context.join(' '), /Quick safety check/);
  assert.deepEqual(trust.options.map(option => [option.number, option.label, option.selected]), [[1, 'No, exit', true], [2, 'Yes, I trust this folder', false]]);
  assert.equal(trust.hint, 'Enter to confirm · Esc to cancel');
  // Claude's own input box with a key hint under it is no choice.
  assert.equal(parseAgentScreen('claude', ['────', '❯ draft', '────', ' Enter to confirm · Esc to cancel']).choice, null);
  const resume = [' This session is 3h 12m old and 230.6k tokens.', ' Resuming the full session will consume a substantial portion of your usage limits.', '',
    ' ❯ 1. Resume from summary (recommended)', '   2. Resume full session as-is', "   3. Don't ask me again", '', ' Enter to confirm · Esc to cancel'];
  assert.deepEqual(parseAgentScreen('claude', resume).choice.options.map(option => option.label), ['Resume from summary (recommended)', 'Resume full session as-is', "Don't ask me again"]);
});

test('a numbered list in a reply is never taken for a choice', () => {
  const reply = ['● Steps:', '  1. Build', '  2. Test', '', '────', '❯ ', '────', '  ? for shortcuts'];
  assert.equal(parseAgentScreen('claude', reply).choice, null);
  const noCursor = ['  Plan', '  1. Build', '  2. Test'];
  assert.equal(parseAgentScreen('codex', noCursor).choice, null);
  // Claude's /help over a conversation (2.1.296, as captured): sent prompts and their output are no options.
  const help = [' ▐▛███▛█   Claude Code v2.1.296', '▝▜██████▀  Opus 5.5 with high effort · Claude Pro', '', '❯ /model', '  ⎿  Kept model as Opus 5.5', '', '❯ /agents',
    '  ⎿  The /agents wizard has been removed.', '', '▔▔▔▔▔▔▔▔▔▔', '   Help  General   Commands   Custom commands', '', '   For more help: https://code.claude.com/docs/en/overview', '', '   Esc to cancel'];
  assert.equal(parseAgentScreen('claude', help).choice, null);
  const numbered = ['❯ 1. Build it', '  ⎿  Interrupted', '', '▔▔▔▔▔▔▔▔▔▔', '   Usage', '   Esc to cancel'];
  assert.equal(parseAgentScreen('claude', numbered).choice, null);
});

test('first-run screens captured from the real CLIs open as choices', () => {
  // Claude Code 2.1.296 with an empty config folder: the text style, then the sign-in method.
  const theme = ['.......█ █   █ █..........................................', '', " Let's get started.", '', ' Choose the text style that looks best with your terminal', ' To change this later, run /theme', '',
    '     Auto (match terminal)', ' ❯ ✔ Dark mode', '     Light mode', '     Dark mode (colorblind-friendly)', '     Light mode (colorblind-friendly)', '     Dark mode (ANSI colors only)', '     Light mode (ANSI colors only)', '',
    ' ╌╌╌╌╌╌╌╌', '  1  function greet() {', '  2 -  console.log("Hello, World!");', '  2 +  console.log("Hello, Claude!");', '  3  }', ' ╌╌╌╌╌╌╌╌', '  Syntax theme: Monokai Extended (ctrl+t to disable)'];
  const style = parseAgentScreen('claude', theme).choice;
  assert.equal(style.title, "Let's get started.");
  assert.deepEqual(style.context, ['Choose the text style that looks best with your terminal', 'To change this later, run /theme']);
  assert.deepEqual(style.options.map(option => option.label), ['Auto (match terminal)', 'Dark mode', 'Light mode', 'Dark mode (colorblind-friendly)', 'Light mode (colorblind-friendly)', 'Dark mode (ANSI colors only)', 'Light mode (ANSI colors only)']);
  assert.equal(style.options.findIndex(option => option.selected), 1);
  const login = ['.......█ █   █ █..........................................', '', ' Claude Code can be used with your Claude subscription or billed based on API usage through your Console account.', '', ' Select login method:', '',
    ' ❯ 1. Claude account with subscription · Pro, Max, Team, or Enterprise', '   2. Anthropic Console account · API usage billing', '   3. 3rd-party platform · Amazon Bedrock, Microsoft Foundry, Google Vertex AI'];
  const method = parseAgentScreen('claude', login).choice;
  assert.equal(method.title, 'Select login method:');
  assert.deepEqual(method.options.map(option => [option.number, option.selected]), [[1, true], [2, false], [3, false]]);
  // Codex 0.162 with an empty CODEX_HOME: its cursor is ">", each option has a description, blank rows between them.
  const signIn = ["  Welcome to Codex, OpenAI's command-line coding agent", '', '  Sign in with ChatGPT to use Codex as part of your paid plan', '  or connect an API key for usage-based billing', '',
    '> 1. Sign in with ChatGPT', '     Usage included with Plus, Pro, Business, and Enterprise plans', '', '  2. Sign in with Device Code', '     Sign in from another device with a one-time code', '',
    '  3. Provide your own API key', '     Pay for what you use', '', '  Press enter to continue'];
  const codex = parseAgentScreen('codex', signIn).choice;
  assert.equal(codex.title, 'Sign in with ChatGPT to use Codex as part of your paid plan');
  assert.deepEqual(codex.options.map(option => [option.label, option.detail, option.selected]), [
    ['Sign in with ChatGPT', 'Usage included with Plus, Pro, Business, and Enterprise plans', true],
    ['Sign in with Device Code', 'Sign in from another device with a one-time code', false],
    ['Provide your own API key', 'Pay for what you use', false]]);
  assert.equal(codex.hint, 'Press enter to continue');
});

test('prompts reproduced from the CLIs\' own text open as choices', () => {
  // Codex 0.162 asks before working in a folder it has not been told to trust.
  const trust = ['  Trust this folder?', '', '  Codex can read, edit, and run files here, subject to your permission settings. Folder settings can run code', '  automatically, even without a model request. Continue only if you trust these files. Your trust decision will be saved.', '',
    '› 1. Trust and continue', '  2. Open restricted', '  3. Quit', '', '  Press enter to continue'];
  const folder = parseAgentScreen('codex', trust).choice;
  assert.equal(folder.title, 'Trust this folder?');
  assert.match(folder.context.join(' '), /^Codex can read, edit, and run files here/);
  assert.deepEqual(folder.options.map(option => option.label), ['Trust and continue', 'Open restricted', 'Quit']);
  // Claude's warnings without numbers, the refusal first and under the cursor.
  const bypass = [' WARNING: Claude Code running in Bypass Permissions mode', '', ' In Bypass Permissions mode, Claude Code will not ask for your approval before running potentially dangerous commands.',
    ' By proceeding, you accept all responsibility for actions taken while running in Bypass Permissions mode.', '', ' ❯ No, exit', '   Yes, I accept', '', ' Enter to confirm · Esc to cancel'];
  const warning = parseAgentScreen('claude', bypass).choice;
  assert.equal(warning.title, 'WARNING: Claude Code running in Bypass Permissions mode');
  assert.deepEqual(warning.options.map(option => [option.label, option.selected]), [['No, exit', true], ['Yes, I accept', false]]);
  const mcp = [' New MCP server found in this project: github', '', ' MCP servers may execute code or access system resources. All tool calls require approval.', '',
    ' ❯ Use this MCP server', '   Use this and all future MCP servers in this project', '   Continue without using this MCP server', '', ' Enter to confirm · Esc to cancel'];
  assert.deepEqual(parseAgentScreen('claude', mcp).choice.options.map(option => option.label), ['Use this MCP server', 'Use this and all future MCP servers in this project', 'Continue without using this MCP server']);
});

test("Codex's own resume list opens as a choice of its conversations, wherever it was started", () => {
  // "codex resume" from the shell (as the SSH greeting suggests): Esc starts a new conversation.
  const start = parseAgentScreen('codex', readFixture('codex-resume-start'));
  assert.equal(start.choice.title, 'Resume a previous session');
  assert.deepEqual(start.choice.options.map(option => [option.label, option.selected]), [['整理发布说明', true], ['修复阅读视图的滚动', false], ['合并远端主分支', false]]);
  assert.match(start.choice.options[0].detail, /^\d+s ago$/);
  assert.equal(start.choice.escape, 'new');
  assert.equal(start.choice.hint, 'enter resume · esc start new');
  assert.equal(start.overlay, 'none');
  // /resume inside a conversation: Esc goes back to it.
  const inside = parseAgentScreen('codex', readFixture('codex-resume-inside')).choice;
  assert.equal(inside.options.length, 3); assert.equal(inside.escape, 'back');
  // Nothing to resume yet: the list says so and Esc still starts a new one.
  const empty = parseAgentScreen('codex', readFixture('codex-resume-empty')).choice;
  assert.deepEqual([empty.options, empty.context, empty.escape], [[], ['No sessions yet'], 'new']);
  // As Codex draws it on Linux (over SSH): keys as ^a, and the cursor's place on the rule.
  const linux = parseAgentScreen('codex', readFixture('codex-resume-linux')).choice;
  assert.equal(linux.options.length, 8);
  assert.deepEqual(linux.options.slice(0, 2).map(option => [option.number, option.label, option.detail, option.selected]), [[1, '合并远端主分支', '3h ago', true], [2, '修复阅读视图', '10h ago', false]]);
  assert.equal(linux.options[7].label, '删除所有 mcp、plugin 和 skill');
  assert.deepEqual(linux.context, [], 'every conversation is on screen');
  // More than the screen holds: where the cursor is in the whole list is told.
  const longer = readFixture('codex-resume-linux').map(row => row.replace('1 / 8 · 100%', '1 / 30 · 26%'));
  assert.deepEqual(parseAgentScreen('codex', longer).choice.context, ['1 / 30']);
  // An older layout with the branch between the age and the name.
  const older = parseAgentScreen('codex', [' Resume a previous session', ' Type to search', '   Updated        Branch   Conversation', ' > 3 hours ago    main     合并远端主分支', '   2 days ago     dev      修复滚动', ' enter resume   esc start new']).choice;
  assert.deepEqual(older.options.map(option => [option.label, option.detail, option.selected]), [['合并远端主分支', '3 hours ago · main', true], ['修复滚动', '2 days ago · dev', false]]);
  // Claude's screen never reads as it.
  assert.equal(parseAgentScreen('claude', readFixture('codex-resume-start')).choice?.title === 'Resume a previous session', false);
});
