const { test } = require('node:test');
const assert = require('node:assert/strict');
const { signInScreen } = require('../src/features/cli-screens/index.ts');
const { parseAgentScreen } = require('../src/features/agents/agent-screen.ts');

// Screens captured from Claude Code 2.1.296 and Codex 0.162 with empty config folders.
const claudeArt = ['PS C:\\work\\demo> claude', 'Welcome to Claude Code v2.1.296', '..........................................................', '       █████████                                        *', '.......█ █   █ █..........................................'];

test('Claude\'s sign-in link, wrapped over rows, with its code field', () => {
  const url = 'https://example.test/authorize?state=' + 'a'.repeat(170);
  const rows = [...claudeArt, '', " Browser didn't open? Use the url below to sign in (c to copy)", '',
    ...url.match(/.{1,100}/g), 'Press', '', ' Paste code here if prompted >'];
  assert.deepEqual(signInScreen('claude', rows, '2.1.296', 100), {
    lines: ["Browser didn't open? Use the url below to sign in", 'Press'],
    url,
    code: null, input: 'code', enter: false, cancel: false,
  });
});

test('Claude after signing in waits for Enter', () => {
  const screen = signInScreen('claude', [...claudeArt, '', ' Login successful. Press Enter to continue…']);
  assert.equal(screen.enter, true); assert.equal(screen.input, null);
});

test('Codex device sign-in: the page, the one-time code and Escape to cancel', () => {
  const rows = ["  Welcome to Codex, OpenAI's command-line coding agent", '', '  Finish signing in via your browser', '', '  1. Open this link in your browser and sign in', '',
    '  https://auth.openai.com/codex/device', '', '  2. Enter this one-time code after you are signed in (expires in 15 minutes)', '', '  P4DP-8OSZ4', '',
    '  Continue only if you started this login in Codex. If a website or another person gave you this code, cancel.', '', '  Press esc to cancel'];
  assert.deepEqual(signInScreen('codex', rows), {
    lines: ['Finish signing in via your browser', '1. Open this link in your browser and sign in', '2. Enter this one-time code after you are signed in (expires in 15 minutes)',
      'Continue only if you started this login in Codex. If a website or another person gave you this code, cancel.'],
    url: 'https://auth.openai.com/codex/device', code: 'P4DP-8OSZ4', input: null, enter: false, cancel: true,
  });
});

test('Codex API key field under its mark', () => {
  const rows = ['   ⠸⣿⣿⣿⡆   ⢰⣿⣿⣿⠇', '     ⠉⠙⠛⠿⠿⠿⠛⠋⠁', "  Welcome to Codex, OpenAI's command-line coding agent", '> Use your own OpenAI API key for usage-based billing',
    '  Paste or type your API key below.', '╭API key──────────╮', '│Paste or type your API key │', '╰─────────────────╯', '  Press enter to save', '  Press esc to go back'];
  assert.deepEqual(signInScreen('codex', rows), {
    lines: ['> Use your own OpenAI API key for usage-based billing', 'Paste or type your API key below.'], url: null, code: null, input: 'key', enter: false, cancel: true,
  });
});

test('an ordinary screen is no sign-in', () => {
  assert.equal(signInScreen('claude', ['A tool printed Login successful', '  ⎿  Invalid code', 'Press']), null);
  assert.equal(signInScreen('claude', ['Login successful. Press Enter to continue…'], '2.1.292'), null);
  assert.equal(signInScreen('claude', ['❯ explain https://example.com/a', '  ⎿  Done']), null);
  assert.equal(signInScreen('codex', ['› hello', '• Hi there']), null);
});

test("a sign-in line under the CLI's working footer is what it printed, not a sign-in page", () => {
  const fs = require('node:fs'), path = require('node:path');
  const idle = fs.readFileSync(path.join(__dirname, 'fixtures/screens/claude-idle-2-1-296.txt'), 'utf8').split('\n');
  const top = idle.findIndex(row => /^─{10,}$/.test(row.trim()));
  // /login done: its result stays above the input; the input itself may be missed for a moment while Claude redraws.
  const afterLogin = [...idle.slice(0, top - 1), '❯ /login', '  ⎿  Login successful', '', ...idle.slice(top - 1)];
  assert.equal(signInScreen('claude', afterLogin), null);
  assert.equal(signInScreen('claude', afterLogin.filter(row => !/^❯ Try/.test(row))), null);
  // The footer as the user's screen showed it, with the model line headed by ●.
  assert.equal(signInScreen('claude', ['  ⎿  Login successful', '─'.repeat(60), '─'.repeat(60), '● Opus 5.5 · demo · ctx 58%', '⏵⏵ auto mode on (shift+tab to cycle) · ← for agents']), null);
  // Its own sign-in page has no footer and still opens the popup.
  assert.notEqual(signInScreen('claude', [' Login successful. Press Enter to continue…']), null);
  // Codex: its footer under the input, and its model line as it prints fast mode.
  assert.equal(signInScreen('codex', ['• Signed in with your ChatGPT account', '', '› ', '', '  GPT-6.1-Sol high fast · /srv/app · 828K window', '  ? for shortcuts']), null);
  const status = parseAgentScreen('codex', ['› ', '', '  GPT-6.1-Sol high fast · /srv/app · 828K window']).status;
  assert.deepEqual([status.model, status.effort, status.fast], ['GPT-6.1-Sol', 'high', true]);
});
