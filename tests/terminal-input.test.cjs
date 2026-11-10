const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isTerminalResponse, isLocalCommand, acceptShellEvent, SubmissionTracker } = require('../electron/terminal-input.cjs');
const { PromptQueue } = require('../electron/prompt-queue.cjs');
const { registerTerminalIpc } = require('../electron/features/terminal/ipc.cjs');

// Exercise the IPC handler with an isolated session, without loading Electron.
function terminalWriter(agent, activity = 'idle') {
  const calls = { prompts: [], completion: [], forwarded: [], state: 0, polls: 0 };
  const promptQueue = new PromptQueue();
  const submit = promptQueue.submit.bind(promptQueue);
  promptQueue.submit = (text, working) => { calls.prompts.push([text, working]); submit(text, working); };
  const session = {
    projectId: 'project', status: 'running', agent, codexActive: true, codexActivity: activity,
    activityInputAt: 0, submissions: new SubmissionTracker(), promptQueue,
    gate: { input: data => calls.forwarded.push(data) },
  };
  let write;
  const project = { id: 'project', unread: false };
  registerTerminalIpc({
    handle: () => {}, listen: (channel, handler) => { if (channel === 'terminal:write') write = handler; }, getSession: () => session,
    getProjectById: () => project, expectCompletion: id => calls.completion.push(id),
    scheduleState: () => { calls.state++; },
    pollAfterSubmission: (target, isCurrent) => { assert.equal(target, session); assert.equal(isCurrent(), true); calls.polls++; },
    now: () => 1234,
    applyActivity: (_project, s, snapshot) => { calls.interrupted = snapshot; s.codexActivity = snapshot.state; },
  });
  return { session, calls, write: data => write('terminal', data), answer: data => write('terminal', data, true) };
}

test('answers to a CLI signing in reach it as typed but are never a prompt', () => {
  for (const agent of ['claude', 'codex']) {
    const { session, calls, answer, write } = terminalWriter(agent);
    for (const data of ['code-from-the-browser', '\r', 'sk-secret', '\r', '\x1b']) answer(data);
    assert.deepEqual(calls.forwarded, ['code-from-the-browser', '\r', 'sk-secret', '\r', '\x1b']);
    assert.deepEqual(calls.prompts, []); assert.deepEqual(calls.completion, []);
    assert.equal(session.codexActivity, 'idle'); assert.equal(calls.polls, 0);
    // What the reader types next is not run together with the answer.
    write('hello\r'); assert.deepEqual(calls.prompts, [['hello', false]]);
  }
});

test('local commands are classified by the submitted prefix, with history retaining prompt behavior', () => {
  for (const text of ['/model', '/status', '/custom-prompt', '/', '!ls', '!']) assert.equal(isLocalCommand(text), true, text);
  for (const text of ['', 'fix /model handling', 'explain !ls', '#remember this']) assert.equal(isLocalCommand(text), false, text);
});

test('only submissions in active agent sessions request faster transcript pickup', () => {
  for (const agent of ['codex', 'claude']) {
    const { session, calls, write } = terminalWriter(agent);
    for (const data of ['\x1b[I', '\x1b[1;1R', '\r', '\x1b[200~hello\nworld\x1b[201~']) write(data);
    assert.equal(calls.polls, 0, 'typing and bracketed paste do not submit');
    write('\r'); assert.equal(calls.polls, 1);
    write('/model\r'); assert.equal(calls.polls, 2, 'commands may update the transcript too');
    session.codexActive = false;
    write('echo hello\r'); assert.equal(calls.polls, 2);
    session.promptQueue.reset();
  }
});

test('local submissions never queue prompts or change activity and completion for either agent', () => {
  for (const agent of ['claude', 'codex']) for (const activity of ['idle', 'working']) {
    const { session, calls, write } = terminalWriter(agent, activity);
    for (const data of ['/model\r', '/status\r!ls\r', '  /model\r', '/custom-prompt\r']) write(data);
    assert.equal(session.codexActivity, activity);
    assert.equal(session.activityInputAt, 0);
    assert.deepEqual(calls.prompts, []);
    assert.deepEqual(calls.completion, []);
    assert.equal(calls.state, 0);
    assert.deepEqual(calls.forwarded, ['/model\r', '/status\r!ls\r', '  /model\r', '/custom-prompt\r']);
  }
});

test('mixed submissions queue each real prompt and mark working even when commands come first or last', () => {
  for (const activity of ['idle', 'working']) {
    const { session, calls, write } = terminalWriter('claude', activity);
    const data = '/model\rfix the button\r!ls\radd tests\r/status\r';
    write(data);
    assert.deepEqual(calls.prompts, [['fix the button', activity === 'working'], ['add tests', activity === 'working']]);
    assert.deepEqual(session.promptQueue.list().map(item => item.text), ['fix the button', 'add tests']);
    assert.equal(session.codexActivity, 'working');
    assert.equal(session.activityInputAt, 1234);
    assert.deepEqual(calls.completion, ['project']);
    assert.equal(calls.state, 1);
    assert.deepEqual(calls.forwarded, [data]);
    session.promptQueue.reset();
  }
});

test('typed text arms completion on submission; a line of unknown text (a menu choice, a recalled line) does not', () => {
  const typed = terminalWriter('codex');
  typed.write('fix the button\r');
  assert.deepEqual(typed.calls.prompts, [['fix the button', false]]);
  assert.equal(typed.session.codexActivity, 'working');
  assert.deepEqual(typed.calls.completion, ['project']);
  assert.equal(typed.calls.state, 1);
  typed.session.promptQueue.reset();
  // Codex's update prompt answered with the arrows, a /model picker, a line recalled from history: the agent's own
  // records tell whether a round started.
  for (const data of ['\x1b[B\r', '\x1b[A\r', '/model\r\x1b[A\r']) {
    const { session, calls, write } = terminalWriter('codex');
    write(data);
    assert.deepEqual(calls.prompts, []);
    assert.equal(session.codexActivity, 'idle');
    assert.deepEqual(calls.completion, []);
    assert.deepEqual(calls.forwarded, [data]);
  }
});

test('Escape interrupts only a working Claude turn without a pending question', () => {
  for (const agent of ['claude', 'codex']) for (const activity of ['working', 'complete']) for (const waiting of [false, true]) {
    const { session, calls, write } = terminalWriter(agent, activity);
    session.claudeSessionId = 'current'; session.needsInput = waiting ? { message: 'Approve' } : null;
    write('\x1b');
    if (agent === 'claude' && activity === 'working' && !waiting) {
      assert.deepEqual(calls.interrupted, { threadId: 'current', turnId: null, state: 'interrupted', updatedAt: 1234 });
      assert.equal(session.codexActivity, 'interrupted');
    } else assert.equal(calls.interrupted, undefined);
    assert.deepEqual(calls.completion, []); assert.deepEqual(calls.forwarded, ['\x1b']);
  }
});

test('terminal protocol responses do not dirty an empty shell prompt', () => {
  for (const response of [
    '', '\x1b[1;1R', '\x1b[?1;2c', '\x1b[>0;276;0c', '\x1b[0n',
    '\x1b[8;24;80t', '\x1b[I', '\x1b[O', '\x1b[1;1R\x1b[?1;2c',
    '\x1b]10;rgb:ffff/ffff/ffff\x07', '\x1b]11;rgb:0000/0000/0000\x1b\\',
    '\x1bP1+r544e=787465726d\x1b\\',
  ]) assert.equal(isTerminalResponse(response), true, JSON.stringify(response));
});

test('real typing, paste, Enter and mixed user input are still treated as input', () => {
  for (const input of ['codex', 'r', 'c', ' ', '\r', '\n', '中文', '\x7f', '\x1b[A', '\x1b[C', '\x1b[1;5C', '\x1b[200~echo hi\x1b[201~', '\x1b[1;1Rwhoami']) {
    assert.equal(isTerminalResponse(input), false, JSON.stringify(input));
  }
});

test('late startup events cannot overwrite prompt-ready or newer Codex events', () => {
  const session = {};
  assert.equal(acceptShellEvent(session, { type: 'shell-prompt', sequence: 2 }), true);
  assert.equal(acceptShellEvent(session, { type: 'shell-ready', sequence: 1 }), false);
  assert.equal(acceptShellEvent(session, { type: 'shell-prompt', sequence: 2 }), false);
  assert.equal(acceptShellEvent(session, { type: 'codex-started', sequence: 3 }), true);
  assert.equal(acceptShellEvent(session, { type: 'shell-prompt', sequence: 2 }), false);
  assert.equal(acceptShellEvent(session, { type: 'codex-exited', sequence: 4 }), true);
  assert.equal(acceptShellEvent(session, { type: 'shell-prompt', sequence: 5 }), true);
  assert.equal(acceptShellEvent(session, { type: 'shell-ready' }), false);
  assert.equal(acceptShellEvent({}, { type: 'shell-ready', sequence: 1 }), true);
});

test('a native host takes no shell report, whatever its sequence', () => {
  const host = { nativeStructured: true };
  for (const type of ['shell-ready', 'shell-prompt', 'codex-started', 'codex-exited']) assert.equal(acceptShellEvent(host, { type, sequence: 5 }), false, type);
  assert.equal(host.lastShellEventSequence, undefined);
});

test('completion is rearmed by submitted input, not typing, empty Enter or terminal reports', () => {
  const tracker = new SubmissionTracker();
  for (const input of ['', '\r', '   \r', '\x1b[I', '\x1b[O', '\x1b[8;24;80t', '\x1b[?1;2c', '\x1b[1;1R', '\x1b]10;rgb:ffff/ffff/ffff\x07', '\x1b[<0;14;9M', '\x1b[Mabc', '\x1bOP', '\r']) assert.equal(tracker.write(input), false, JSON.stringify(input));
  assert.equal(tracker.write('继续'), false);
  assert.equal(tracker.write('\x1b[D\x1b[C'), false);
  assert.equal(tracker.write('\r'), true);
  assert.equal(tracker.write('\r'), false);
  assert.equal(tracker.write('draft\x15\r'), false, 'cleared input does not submit work');
  assert.equal(tracker.write('修改\x7f\x7f\r'), false);
  assert.equal(tracker.write('cancel\x03\r'), false);
});

test('split multiline paste and editing newlines wait for an explicit submission', () => {
  const tracker = new SubmissionTracker();
  for (const character of '\x1b[200~第一行\r\n第二行\x1b[201~') assert.equal(tracker.write(character), false);
  assert.equal(tracker.write('\n'), false, 'Ctrl+J inserts a newline');
  assert.equal(tracker.write('\x1b\r'), false, 'Alt+Enter inserts a newline');
  assert.equal(tracker.write('\x1b[13;2u'), false, 'modified Enter does not submit');
  assert.equal(tracker.write('\x1b[13;28;13;1;16;1_\x1b[13;28;13;0;16;1_'), false, 'native Windows Shift+Enter does not rearm completion');
  assert.equal(tracker.write('\x1b[13u'), true);
  assert.equal(tracker.write('\r'), false);
  assert.equal(tracker.write('\x1b['), false);
  assert.equal(tracker.write('A'), false, 'history selection alone is not a submission');
  assert.equal(tracker.write('\r'), true, 'submitting a recalled prompt is new input');
});

test('Command Prompt prompt markers report the directory, even when split across output chunks', () => {
  const { PromptMarkers, PROMPT_MARKER } = require('../electron/terminal-input.cjs');
  const markers = new PromptMarkers();
  const prompt = directory => `${PROMPT_MARKER}${directory}\x1b\\${directory}>`;
  assert.deepEqual(markers.write(`hello\r\n${prompt('C:\\项目 a')}`), ['C:\\项目 a']);
  const split = prompt('D:\\work\\(x) & y');
  assert.deepEqual(markers.write(split.slice(0, 3)), []);
  assert.deepEqual(markers.write(split.slice(3, 20)), []);
  assert.deepEqual(markers.write(split.slice(20) + 'dir\r\n' + prompt('E:\\')), ['D:\\work\\(x) & y', 'E:\\']);
  assert.deepEqual(markers.write('\x1b]0;title\x07plain output'), [], 'other OSC sequences are ignored');
});

test('input waits while PowerShell asks where the cursor is, then goes in order', () => {
  const { InputGate } = require('../electron/terminal-input.cjs');
  let now = 0; const written = [];
  const gate = new InputGate(data => written.push(data), { now: () => now, wait: 1500 });
  gate.input('a'); assert.deepEqual(written, ['a'], 'nothing asked: input goes at once');
  gate.output('PS> \x1b[6n');
  gate.input('c'); gate.input('odex\r');
  assert.deepEqual(written, ['a'], 'keys wait for the answer');
  gate.input('\x1b[4;86R');
  assert.deepEqual(written, ['a', '\x1b[4;86R', 'c', 'odex\r'], 'the answer first, then the keys in order');
  gate.output('\x1b[6n'); now = 100; gate.input('x');
  now = 1700; gate.input('y');
  assert.deepEqual(written.slice(4), [], 'still held in order behind x');
  gate.release();
  assert.deepEqual(written.slice(4), ['x', 'y']);
  gate.output('\x1b[6n'); now = 5000; gate.input('z');
  assert.deepEqual(written.slice(6), ['z'], 'an old unanswered question no longer holds input');
  gate.dispose();
});

test('three cursor answers delayed over 700 ms are dropped before restoring the whole command', t => {
  const { InputGate } = require('../electron/terminal-input.cjs');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 74; const written = [];
  const gate = new InputGate(data => written.push(data), { now: () => now });
  const advance = time => { const elapsed = time - now; now = time; t.mock.timers.tick(elapsed); };
  const command = 'claude --resume abc "继续"\r';
  gate.output('\x1b[6n');
  advance(580); gate.output('\x1b[6n');
  advance(833); gate.input('\x1b[1;1R');
  assert.equal(gate.open, 1);
  advance(1172); gate.output('\x1b[6n');
  advance(1394); gate.input('\x1b[1;1R');
  assert.equal(gate.open, 1);
  advance(1895); gate.input('\x1b[1;1R');
  assert.equal(gate.open, 0, 'the final late answer is dropped without another re-ask');
  assert.deepEqual(written, []);
  gate.afterPrompt(command);
  advance(3394); assert.deepEqual(written, []);
  advance(3395); assert.deepEqual(written, [command], 'the timeout writes the command with its first letter');
  gate.dispose();
});

test('a late first answer is dropped and a timely second answer precedes the whole restored command', t => {
  const { InputGate } = require('../electron/terminal-input.cjs');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 1000; const written = [];
  const gate = new InputGate(data => written.push(data), { now: () => now });
  const advance = time => { const elapsed = time - now; now = time; t.mock.timers.tick(elapsed); };
  const command = 'claude --resume abc "继续"\r';
  gate.output('\x1b[6n');
  advance(1509); gate.output('\x1b[6n');
  advance(1552); gate.input('\x1b[1;1R');
  assert.deepEqual(written, [], 'the answer 552 ms after its question does not reach the prompt');
  assert.equal(gate.open, 1, 'the current question still needs its own answer');
  advance(1668); gate.input('\x1b[1;1R');
  assert.deepEqual(written, ['\x1b[1;1R'], 'the answer 159 ms after its question is forwarded');
  assert.equal(gate.open, 0);
  gate.afterPrompt(command);
  advance(3167); assert.deepEqual(written, ['\x1b[1;1R']);
  advance(3168);
  assert.deepEqual(written, ['\x1b[1;1R', command], 'the command keeps its first letter');
  gate.dispose();
});

test('a cursor answer 300 ms after its question is forwarded', () => {
  const { InputGate } = require('../electron/terminal-input.cjs');
  let now = 1000; const written = [];
  const gate = new InputGate(data => written.push(data), { now: () => now });
  gate.output('\x1b[6n');
  now = 1300; gate.input('\x1b[1;1R');
  assert.deepEqual(written, ['\x1b[1;1R']);
  assert.equal(gate.open, 0);
  gate.dispose();
});

test('two open cursor questions asked 100 ms apart both receive their answers', () => {
  const { InputGate } = require('../electron/terminal-input.cjs');
  let now = 1000; const written = [];
  const gate = new InputGate(data => written.push(data), { now: () => now });
  gate.output('\x1b[6n');
  now = 1100; gate.output('\x1b[6n');
  now = 1300; gate.input('\x1b[1;1R');
  assert.equal(gate.open, 1);
  now = 1400; gate.input('\x1b[2;1R');
  assert.deepEqual(written, ['\x1b[1;1R', '\x1b[2;1R']);
  assert.equal(gate.open, 0);
  gate.dispose();
});

test('Codex receives a cursor answer even when it is 2 s late', () => {
  const { InputGate } = require('../electron/terminal-input.cjs');
  let now = 1000; const written = [];
  const gate = new InputGate(data => written.push(data), { now: () => now, shellOwnsInput: () => false });
  gate.output('\x1b[6n');
  now = 3000; gate.input('\x1b[1;1R');
  assert.deepEqual(written, ['\x1b[1;1R']);
  assert.equal(gate.open, 0);
  gate.dispose();
});

test('a chunk drops its late answer and forwards other responses and the timely answer in order', () => {
  const { InputGate } = require('../electron/terminal-input.cjs');
  let now = 1000; const written = [];
  const gate = new InputGate(data => written.push(data), { now: () => now });
  gate.output('\x1b[6n');
  now = 1509; gate.output('\x1b[6n');
  now = 1552;
  gate.input('\x1b[1;1R\x1b[?1;2c\x1b[?2;3R\x1b[O');
  assert.deepEqual(written, ['\x1b[?1;2c\x1b[?2;3R\x1b[O']);
  assert.equal(gate.open, 0);
  gate.dispose();
});

test('pushing questions prunes unanswered questions older than 30 s', () => {
  const { InputGate } = require('../electron/terminal-input.cjs');
  let now = 1000; const written = [];
  const gate = new InputGate(data => written.push(data), { now: () => now });
  gate.output('\x1b[6n');
  now = 31000; gate.output('\x1b[6n');
  assert.equal(gate.open, 2, 'a question exactly 30 s old is retained');
  now = 31001; gate.output('\x1b[6n\x1b[?6n');
  assert.equal(gate.open, 3, 'only the older question is pruned and each new question is queued');
  now = 31100; gate.input('\x1b[1;1R\x1b[2;1R\x1b[?3;1R');
  assert.deepEqual(written, ['\x1b[1;1R\x1b[2;1R\x1b[?3;1R'], 'the missing answer no longer misaligns later answers');
  assert.equal(gate.open, 0);
  gate.dispose();
});

test('a dropped final answer settles a restored command and releases held keys in order', t => {
  const { InputGate } = require('../electron/terminal-input.cjs');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 1000; const written = [];
  const gate = new InputGate(data => written.push(data), { now: () => now });
  gate.afterPrompt('claude --resume abc\r'); gate.input('x');
  gate.output('\x1b[6n');
  now = 1700; t.mock.timers.tick(700); gate.input('\x1b[1;1R');
  assert.equal(gate.open, 0);
  t.mock.timers.tick(149); assert.deepEqual(written, []);
  t.mock.timers.tick(1); assert.deepEqual(written, ['claude --resume abc\r', 'x']);
  gate.dispose();
});

test('cursor answers at the stale boundary or without a queued question are forwarded', () => {
  const { InputGate } = require('../electron/terminal-input.cjs');
  let now = 1000; const written = [];
  const gate = new InputGate(data => written.push(data), { now: () => now, stale: 600 });
  gate.output('\x1b[6n');
  now = 1600; gate.input('\x1b[1;1R');
  gate.output('\x1b[6n');
  now = 2201; gate.input('\x1b[2;1R');
  gate.input('\x1b[3;1R');
  assert.deepEqual(written, ['\x1b[1;1R', '\x1b[3;1R']);
  assert.equal(gate.open, 0);
  gate.dispose();
});

test('an answer that arrives after the gate stopped waiting for it is still dropped at the shell prompt', t => {
  const { InputGate } = require('../electron/terminal-input.cjs');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0; const written = [];
  const gate = new InputGate(data => written.push(data), { now: () => now, wait: 1500 });
  gate.output('\x1b[6n'); gate.input('x');               // held behind the open question
  now = 1500; t.mock.timers.tick(1500);                   // the gate gives up waiting and lets the key through
  assert.deepEqual(written, ['x']); assert.equal(gate.open, 0);
  now = 1700; gate.input('\x1b[3;1R');                    // the window's answer, far too late
  assert.deepEqual(written, ['x'], 'not taken for an answer to nothing and forwarded as keys');
  now = 2000; gate.output('\x1b[6n'); now = 2100; gate.input('\x1b[3;2R');
  assert.deepEqual(written, ['x', '\x1b[3;2R'], 'the next question still gets its own answer');
  gate.dispose();
});

test('a command restored at a prompt waits for that prompt\'s question and answer, not only an open one', t => {
  const { InputGate } = require('../electron/terminal-input.cjs');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const written = [];
  const gate = new InputGate(data => written.push(data), { wait: 1500, settle: 150 });
  // The prompt event comes before the prompt is drawn: nothing is asked yet, and still the command waits.
  gate.afterPrompt('claude --continue\r');
  assert.deepEqual(written, [], 'held before the question is asked');
  gate.output('PS C:\\p> \x1b[6n'); gate.input('\x1b[5;12R');
  assert.deepEqual(written, ['\x1b[5;12R'], 'after the answer, a moment more');
  // A second question in that moment holds the command until its own answer.
  t.mock.timers.tick(100); gate.output('\x1b[6n');
  t.mock.timers.tick(200); assert.deepEqual(written, ['\x1b[5;12R']);
  gate.input('\x1b[5;12R');
  assert.deepEqual(written, ['\x1b[5;12R', '\x1b[5;12R', 'claude --continue\r'], 'whole, with its first letter');
  // Keys typed while a restored command waits go after it.
  gate.afterPrompt('codex resume abc\r'); gate.input('x');
  gate.output('\x1b[6n'); gate.input('\x1b[1;1R'); t.mock.timers.tick(150);
  assert.deepEqual(written.slice(3), ['\x1b[1;1R', 'codex resume abc\r', 'x']);
  // A shell that never asks (or a window not showing the terminal) holds it no longer than wait.
  gate.afterPrompt('codex\r'); t.mock.timers.tick(1499);
  assert.equal(written.length, 6); t.mock.timers.tick(1);
  assert.deepEqual(written.slice(6), ['codex\r']);
  // A busy window (many terminals starting at once) may answer late: a restored command waits up to patience
  // for an open question, though typed keys would have gone after wait.
  gate.afterPrompt('claude --continue\r'); gate.output('\x1b[6n'); t.mock.timers.tick(5000);
  assert.equal(written.length, 7, 'still waiting for the late answer');
  gate.input('\x1b[2;1R'); t.mock.timers.tick(150);
  assert.deepEqual(written.slice(7), ['\x1b[2;1R', 'claude --continue\r']);
  gate.afterPrompt('codex\r'); gate.output('\x1b[6n'); t.mock.timers.tick(7999);
  assert.equal(written.length, 9); t.mock.timers.tick(1);
  assert.deepEqual(written.slice(9), ['codex\r'], 'an answer that never comes holds it no longer than patience');
  gate.dispose();
});

test('a lone Escape (interrupt or close) does not swallow the first key of the next command', () => {
  const tracker = new SubmissionTracker();
  tracker.write('\x1b');
  assert.equal(tracker.write('/daemon'), false);
  assert.equal(tracker.write('\r'), true);
  assert.deepEqual(tracker.sent, ['/daemon']);
});
