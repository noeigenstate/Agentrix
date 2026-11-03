const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { timeoutScale } = require('../scripts/wait.mjs');
const { cliInputDraft, isCliIdle, hasCliInput } = require('../src/features/reading/cli-panel.ts');
const { parseAgentScreen } = require('../src/features/agents/agent-screen.ts');

// Read the actual fixture literals without importing its Electron smoke runner.
const filename = path.resolve(__dirname, '../scripts/reading-smoke.mjs');
const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const literals = {};
const functions = {};
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'idle') {
    assert.ok(ts.isStringLiteral(node.initializer)); literals[node.name.getText(source)] = node.initializer.text;
  }
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'fixturePrompt') literals.fixturePrompt = new Function('path', 'root', `return (${node.initializer.getText(source)});`)(path, path.resolve(__dirname, '..'));
  if (ts.isVariableDeclaration(node) && ['fixtureIdle', 'waitForFixtureIdle'].includes(node.name.getText(source))) functions[node.name.getText(source)] = node.initializer.getText(source);
  ts.forEachChild(node, visit);
}
visit(source);
const fixtureIdle = new Function('parseAgentScreen', 'hasCliInput', 'isCliIdle', 'cliInputDraft', `return (${functions.fixtureIdle});`)(parseAgentScreen, hasCliInput, isCliIdle, cliInputDraft);

test('fixture readiness rejects partial frames, helper input and an ordinary shell prompt', () => {
  const frame = ['─'.repeat(40), '❯ ', '─'.repeat(40), '  ⏸ manual mode on'];
  assert.equal(fixtureIdle(frame), true);
  assert.equal(fixtureIdle(frame.slice(0, 3)), true, 'a complete input box stays idle without a recognised status footer');
  assert.equal(fixtureIdle(frame.slice(0, 2)), false, 'an unfinished input box is not ready');
  assert.equal(fixtureIdle(frame.map(row => row === '❯ ' ? '❯ Clear-Host; Write-Host pending' : row)), false, 'the idle-rendering script itself is not an empty input');
  assert.equal(fixtureIdle(['reading-fixture> ']), false);
  assert.equal(fixtureIdle([]), false);
  const codex = ['› ', '', 'gpt-6.1-sol · high · 100% context left'];
  assert.equal(fixtureIdle(codex, 'codex'), true);
  assert.equal(fixtureIdle(codex, 'claude'), false, 'provider changes require that provider\'s input evidence');
  assert.equal(fixtureIdle(frame, 'codex'), false);
});

test('reading smoke keeps real PTY input, command results and later choices in its frame', { skip: process.platform !== 'win32', timeout: 20000 * timeoutScale }, async t => {
  const { Terminal } = require('@xterm/xterm');
  const pty = require('node-pty');
  assert.ok(literals.fixturePrompt); assert.ok(literals.idle);
  const terminal = new Terminal({ cols: 120, rows: 30 });
  // Unopened xterm parses PTY output and answers cursor queries; no DOM, window or Electron is started.
  // Exercise the fixture's isolation from newer PSReadLine history predictions, including /fix-issue after /fix-issue 42.
  const prediction = "if ((Get-Command Set-PSReadLineOption).Parameters.ContainsKey('PredictionSource')) { Set-PSReadLineOption -PredictionSource History }; ";
  const shell = pty.spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NoExit', '-ExecutionPolicy', 'Bypass', '-Command', 'Set-PSReadLineOption -HistorySaveStyle SaveNothing; ' + prediction + literals.fixturePrompt], {
    name: 'xterm-256color', cols: 120, rows: 30, cwd: path.dirname(filename), env: process.env,
  });
  let disposed = false;
  const output = shell.onData(data => { if (!disposed) terminal.write(data); });
  const replies = terminal.onData(data => { if (!disposed) shell.write(data); });
  t.after(() => { disposed = true; output.dispose(); replies.dispose(); shell.kill(); terminal.dispose(); });
  const rows = () => Array.from({ length: terminal.rows }, (_, index) => terminal.buffer.active.getLine(terminal.buffer.active.baseY + index)?.translateToString(true) ?? '');
  const wait = async (check, label) => {
    const until = Date.now() + 5000 * timeoutScale;
    while (Date.now() < until) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
    assert.fail(label + '\n' + rows().join('\n'));
  };
  const idleReady = new Function('waitFor', 'fixtureIdle', `return (${functions.waitForFixtureIdle});`)(wait, fixtureIdle);
  shell.write("Write-Output 'FIXTURE_READY'\r");
  await wait(() => rows().some(row => row.trim() === 'FIXTURE_READY'), 'isolated PowerShell starts');
  shell.write(literals.idle);
  await idleReady(rows, 'initial idle');
  assert.equal(terminal.buffer.active.cursorX, 2); assert.equal(terminal.buffer.active.cursorY, 1);
  shell.write('/status');
  await wait(() => cliInputDraft('claude', rows(), parseAgentScreen('claude', rows())) === '/status', 'actual typed text is in the fixture input');
  assert.equal(rows()[0], '─'.repeat(40)); assert.equal(rows()[1], '❯ /status');
  assert.equal(rows()[2], '─'.repeat(40)); assert.equal(rows()[3], '  ⏸ manual mode on');
  shell.write('\b'.repeat('/status'.length));
  await wait(() => cliInputDraft('claude', rows(), parseAgentScreen('claude', rows())) === '', 'clear only the unsubmitted draft');
  // The desktop script must wait for the stand-in shell to finish redrawing before its next action.
  shell.write('Start-Sleep -Milliseconds 180; ' + literals.idle);
  let redrawReady = false;
  const redraw = idleReady(rows, 'post-status redraw').then(() => { redrawReady = true; });
  await wait(() => !fixtureIdle(rows()), 'idle helper is still executing or in the real input');
  assert.equal(redrawReady, false, 'a partial/helper frame cannot release the next command');
  await redraw;
  assert.ok(fixtureIdle(rows()));
  assert.equal(terminal.buffer.active.cursorX, 2); assert.equal(terminal.buffer.active.cursorY, 1);
  shell.write('/fix-issue 42');
  await wait(() => cliInputDraft('claude', rows(), parseAgentScreen('claude', rows())) === '/fix-issue 42', 'next project command echoes in the newly empty actual input');
  assert.equal(fixtureIdle(rows()), false, 'a nonempty input cannot satisfy readiness');
  shell.write('\b'.repeat('/fix-issue 42'.length));
  await wait(() => fixtureIdle(rows()), 'clear unsubmitted project draft before helper execution');
  shell.write("Write-Output 'HOOK_EXECUTED'\r");
  await wait(() => rows().some(row => row.startsWith('HOOK_EXECUTED')), 'PowerShell still executes fixture hook commands');
  shell.write(literals.idle); await idleReady(rows, 'before shell commands');
  // The live popup must retain the actual errors after each slash command, including one after Shift+Tab.
  for (const command of ['/status', '/fix-issue 42', '/fix-issue', '/unknown-reading-command']) {
    if (command === '/fix-issue') {
      shell.write('\x1b[Z');
      await idleReady(rows, 'Shift+Tab preserves physical input');
    }
    shell.write(command);
    await wait(() => cliInputDraft('claude', rows(), parseAgentScreen('claude', rows())) === command, 'physical slash receipt: ' + command);
    shell.write('\r'); // Exactly one Enter, after receipt. Native PowerShell executes the unmodified command.
    await idleReady(rows, 'executed slash result: ' + command);
    const resultRows = rows();
    assert.equal(resultRows[terminal.buffer.active.cursorY].trim(), '❯', 'scrolling keeps the physical cursor in the new box');
    assert.equal(terminal.buffer.active.cursorX, 2);
    assert.ok(resultRows.some(row => row.includes('CommandNotFoundException')), 'the live terminal keeps the real error: ' + command);
    assert.ok(resultRows.some(row => row.trim() === '+ ' + command));
  }
  for (const command of ['!echo reading-fixture', '!true']) {
    shell.write('\x15'); await new Promise(resolve => setTimeout(resolve, 60));
    shell.write(command); await new Promise(resolve => setTimeout(resolve, 150));
    shell.write('\r');
    await idleReady(rows, 'executed shell result');
    assert.ok(rows().some(row => command === '!true' ? row.includes('(Bash completed with no output)') : row.trim() === '⎿ reading-fixture'));
  }
  shell.write("Clear-Host; Write-Host 'Would you like to run the following command?'; Write-Host ''; Write-Host '  $ npm test'; Write-Host ''; Write-Host ([string][char]0x203A + ' 1. Yes, proceed (y)'); Write-Host '  2. No, and tell Codex what to do differently (esc)'; Write-Host ''; Write-Host 'Press enter to confirm or esc to cancel'\r");
  await wait(() => parseAgentScreen('codex', rows()).choice?.title === 'Would you like to run the following command?', 'permission frame renders');
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(parseAgentScreen('codex', rows()).choice?.options.length, 2, 'returning to PowerShell does not clear or redraw the choice frame');
  assert.ok(rows().every(row => !/^\s*(?:PS .*?>|reading-fixture>)/.test(row)), 'no extra prompt below fixture states');
});
