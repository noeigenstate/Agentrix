const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const en = require('../electron/locales/en.json');
const {
  normalizePrompt, isTypedCommand, createPendingPrompts, addPendingPrompt,
  reconcilePendingPrompts, removePendingPrompt, pendingPromptCards, PENDING_PROMPT_TIMEOUT, sameMessage,
} = require('../src/features/reading/pending-prompts.ts');

const user = (id, text) => ({ id, role: 'user', text });
const add = (state, id, text, at = 1000) => addPendingPrompt(state, id, text, at);
const sync = (state, entries, now = 1001, session = 'session') => reconcilePendingPrompts(state, session, entries, now);

// A TSX module of the reading view, compiled for the test; its own requires go through resolve first.
function compileTsx(filename, resolve) {
  const mod = new Module(filename, module);
  mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = mod.require.bind(mod);
  mod.require = name => resolve(name) ?? originalRequire(name);
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, filename);
  return mod.exports;
}
const timeline = () => compileTsx(path.join(__dirname, '../src/features/reading/Timeline.tsx'), () => null);

function pendingMarkup(prompts, props = {}) {
  const filename = path.join(__dirname, '../src/features/reading/PendingPromptEntries.tsx');
  const mod = new Module(filename, module);
  mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = mod.require.bind(mod);
  const icon = props => React.createElement('svg', { className: props.className });
  mod.require = name => name.endsWith('/UserAvatar') ? { UserAvatar: () => React.createElement('svg') } : name === './Timeline' ? timeline() : name.endsWith('/i18n') ? { t: text => en[text] ?? text } : name.endsWith('.css') ? {} : name === '@phosphor-icons/react' ? new Proxy({}, { get: () => icon }) : name === './pasted-pictures' ? require('../src/features/reading/pasted-pictures.ts') : name === '../files/file-popup' ? { showPopup() {} } : originalRequire(name);
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, filename);
  return renderToStaticMarkup(React.createElement(mod.exports.PendingPromptEntries, { prompts, ...props }));
}

test('pending messages use the user style and translated sending note, and escape pasted markup', () => {
  const state = add(createPendingPrompts('session'), 'p', '<script>hello</script>');
  const html = pendingMarkup(state.prompts);
  assert.match(html, /reading-user reading-pending is-sending/);
  assert.match(html, /role="status">Sending/);
  assert.match(html, /&lt;script&gt;hello&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test("a message in the agent's queue says it arrived and waits, and is never offered for sending again", () => {
  const state = add(createPendingPrompts('session'), 'p', 'queued message');
  const html = pendingMarkup(state.prompts, { queued: () => true, undelivered: () => false });
  assert.match(html, /reading-user reading-pending is-queued/);
  assert.doesNotMatch(html, /is-sending|Sending/);
  assert.match(html, /role="status">Delivered and queued/);
});

test('an expired echo still renders its text without a sending note', () => {
  const state = sync(add(createPendingPrompts('session'), 'p', 'keep me'), [], 21000);
  const html = pendingMarkup(state.prompts);
  assert.match(html, /reading-user reading-pending/);
  assert.match(html, /keep me/);
  assert.doesNotMatch(html, /Sending|is-sending|role="status"/);
});

test('a normal prompt is echoed synchronously with its original formatting', () => {
  const original = createPendingPrompts('session');
  const next = add(original, 'pending:1', 'first line\n  second line');
  assert.deepEqual(next.prompts, [{ id: 'pending:1', role: 'user', text: 'first line\n  second line', at: 1000, sending: true }]);
  assert.deepEqual(original.prompts, [], 'pure updates leave the previous state intact');
});

test('normalization trims and collapses spaces, tabs, CRLF and trailing newlines', () => {
  assert.equal(normalizePrompt(' \n hello\t world\r\n again\n\n'), 'hello world again');
});

test('typed slash and shell commands and empty prompts have no echo', () => {
  const state = createPendingPrompts('session');
  for (const text of ['/model', '/resume abc', '!echo hello', '', ' \n\t']) assert.equal(add(state, 'p', text), state);
  assert.equal(isTypedCommand('/model'), true);
  assert.equal(isTypedCommand('!echo hello'), true);
  assert.equal(isTypedCommand('/prompts:fix the bug'), true);
  assert.equal(isTypedCommand('/tmp/agentrix-images-0/20261012-210420-21a95830.png 这个是什么'), false, 'a pasted picture path is a message');
  assert.equal(isTypedCommand('/home/lisa/piv_lab/report.md 看一下'), false);
});

test('multiline pasted text beginning with slash or bang remains a normal prompt', () => {
  for (const text of ['/some text\nplease explain', '!a\r\nb']) {
    assert.equal(isTypedCommand(text), false);
    assert.equal(add(createPendingPrompts('session'), 'p', text).prompts[0].text, text);
  }
});

test('a matching real user record removes its echo despite whitespace differences', () => {
  const state = add(createPendingPrompts('session'), 'p', 'hello\n  world');
  const next = sync(state, [user('real:1', ' hello world\n\n')]);
  assert.deepEqual(next.prompts, []);
  assert.equal(state.prompts.length, 1);
});

test('assistant and tool records and different user text cannot remove an echo', () => {
  const state = add(createPendingPrompts('session'), 'p', 'hello');
  const next = sync(state, [{ id: 'a', role: 'assistant', text: 'hello' }, { id: 't', role: 'tool', text: 'hello' }, user('u', 'Hello')]);
  assert.equal(next.prompts.length, 1);
});

test('an older identical message cannot acknowledge a new send', () => {
  const previous = [user('old', 'same')];
  const state = add(createPendingPrompts('session', previous), 'p', 'same');
  assert.equal(sync(state, previous).prompts.length, 1);
  assert.equal(sync(state, [...previous, user('new', 'same')]).prompts.length, 0);
});

test('quick sends stack in order and remove only the matching entry', () => {
  let state = createPendingPrompts('session');
  for (const [id, text] of [['p1', 'first'], ['p2', 'second'], ['p3', 'third']]) state = add(state, id, text);
  assert.deepEqual(state.prompts.map(prompt => prompt.id), ['p1', 'p2', 'p3']);
  state = sync(state, [user('u2', 'second')]);
  assert.deepEqual(state.prompts.map(prompt => prompt.id), ['p1', 'p3']);
});

test('repeated identical sends consume one new user ID each, even on packet replay', () => {
  let state = add(add(createPendingPrompts('session'), 'p1', 'same'), 'p2', 'same');
  state = sync(state, [user('u1', 'same')]);
  assert.deepEqual(state.prompts.map(prompt => prompt.id), ['p2']);
  assert.equal(sync(state, [user('u1', 'same')]), state);
  state = sync(state, [user('u1', 'same'), user('u2', ' same\n')]);
  assert.deepEqual(state.prompts, []);
  state = add(state, 'p3', 'same');
  assert.equal(sync(state, [user('u1', 'same'), user('u2', 'same')]).prompts.length, 1);
});

test('the 20-second boundary drops only the sending note and retains the full text', () => {
  const state = add(createPendingPrompts('session'), 'p', 'Keep\n  everything');
  assert.equal(sync(state, [], 1000 + PENDING_PROMPT_TIMEOUT - 1), state);
  const expired = sync(state, [], 1000 + PENDING_PROMPT_TIMEOUT);
  assert.equal(expired.prompts[0].sending, false);
  assert.equal(expired.prompts[0].text, 'Keep\n  everything');
  assert.equal(sync(expired, [], 999999), expired);
  assert.deepEqual(sync(expired, [user('late', 'Keep everything')], 999999).prompts, []);
});

test('each quick send expires independently without changing order', () => {
  const state = add(add(createPendingPrompts('session'), 'p1', 'first', 1000), 'p2', 'second', 5000);
  const next = sync(state, [], 21000);
  assert.deepEqual(next.prompts.map(prompt => [prompt.id, prompt.sending]), [['p1', false], ['p2', true]]);
});

test('terminal states are independent and session changes clear all echoes', () => {
  const first = add(createPendingPrompts('session'), 'p1', 'one');
  const second = add(createPendingPrompts('other'), 'p2', 'two');
  const cleared = sync(first, [user('history', 'one')], 1001, 'new-session');
  assert.deepEqual(cleared, createPendingPrompts('new-session', [user('history', 'one')]));
  assert.equal(second.prompts[0].text, 'two');
  assert.deepEqual(sync(first, [], 1001, null).prompts, []);
});

test('a failed paste cancels only its own echo', () => {
  const state = add(add(createPendingPrompts('session'), 'p1', 'first'), 'p2', 'second');
  assert.deepEqual(removePendingPrompt(state, 'p1').prompts.map(prompt => prompt.id), ['p2']);
  assert.equal(removePendingPrompt(state, 'missing'), state);
});

test('a late replay predating the send cannot acknowledge it, and a queue record is not acceptance', () => {
  const state = add(createPendingPrompts('session'), 'p', 'same', 5000);
  assert.equal(sync(state, [{ ...user('old-replay', 'same'), at: 2000 }]).prompts.length, 1);
  assert.equal(sync(state, [{ ...user('queue', 'same'), at: 5001, queued: true }]).prompts.length, 1);
  assert.equal(sync(state, [{ ...user('accepted', 'same'), at: 5001 }]).prompts.length, 0);
});

test('queue cards survive without echoes and pair repeated identical sends one-to-one without paste-summary guesses', () => {
  const prompts = add(add(createPendingPrompts('session'), 'p1', 'same'), 'p2', 'same').prompts;
  const queue = { ...user('q1', 'same'), at: 1200, queued: true };
  let cards = pendingPromptCards(prompts, [queue]);
  assert.deepEqual(cards.prompts.map(prompt => [prompt.id, prompt.at, prompt.sending]), [['p1', 1200, false], ['p2', 1000, true]]);
  assert.deepEqual([...cards.queuedIds], ['p1']);
  cards = pendingPromptCards([], [queue]);
  assert.deepEqual(cards.prompts.map(prompt => [prompt.id, prompt.text, prompt.at]), [['q1', 'same', 1200]]);
  assert.deepEqual([...cards.queuedIds], ['q1']);
  const long = add(createPendingPrompts('session'), 'long', 'x'.repeat(300)).prompts;
  assert.equal(pendingPromptCards(long, [{ ...queue, text: '[Pasted Content 300 chars]' }]).prompts.length, 2);
});

test('producer-bounded long queued and accepted transcripts keep one echo and its full text', () => {
  const { ConversationLog, claudeConversation } = require('../electron/conversation.cjs');
  const log = new ConversationLog(), timestamp = '2026-10-17T01:00:00Z', text = 'x'.repeat(21000);
  const state = add(createPendingPrompts('session'), 'long', text, Date.parse(timestamp));
  claudeConversation(log, { type: 'queue-operation', operation: 'enqueue', timestamp, content: text });
  const cards = pendingPromptCards(state.prompts, log.list);
  assert.equal(cards.prompts.length, 1); assert.equal(cards.prompts[0].text, text);
  assert.deepEqual([...cards.queuedIds], ['long']);
  claudeConversation(log, { type: 'queue-operation', operation: 'dequeue', timestamp, content: text });
  claudeConversation(log, { type: 'attachment', uuid: 'accepted', timestamp, attachment: { type: 'queued_command', prompt: text } });
  assert.deepEqual(sync(state, log.list, Date.parse(timestamp)).prompts, []);
});

for (const accepted of [false, true]) test(`long prompts with the same displayed prefix pair the ${accepted ? 'receipt' : 'queue'} to the full original text`, () => {
  const { ConversationLog, claudeConversation } = require('../electron/conversation.cjs');
  const log = new ConversationLog(), timestamp = '2026-10-17T01:00:00Z', at = Date.parse(timestamp), prefix = 'x'.repeat(20100);
  let state = add(createPendingPrompts('session'), 'first', prefix + 'A', at - 100);
  state = add(state, 'second', prefix + 'B', at - 50);
  claudeConversation(log, { type: 'queue-operation', operation: 'enqueue', timestamp, content: prefix + 'B' });
  if (accepted) {
    claudeConversation(log, { type: 'user', uuid: 'accepted', timestamp, message: { content: prefix + 'B' } });
    state = sync(state, log.list, at);
    assert.deepEqual(state.prompts.map(prompt => prompt.id), ['first']);
  } else {
    const cards = pendingPromptCards(state.prompts, log.list);
    assert.deepEqual([...cards.queuedIds], ['second']);
  }
});

test('a prompt received after one Claude put back in its input still acknowledges the echo', () => {
  const state = add(createPendingPrompts('session'), 'p', '只回复：MARK-4');
  assert.deepEqual(sync(state, [user('u', '写一篇文章。最后写 MARK-3。只回复：MARK-4')]).prompts, []);
});

test('a message still held in the CLI input is recognised through wrapping, image marks and long-paste summaries', () => {
  const message = '合并远端的主分支的内容，然后解决冲突并提交';
  assert.equal(sameMessage(message, '合并远端的主分支的内容，然后解决\n冲突并提交'), true);
  assert.equal(sameMessage(message, '[Image #1] 合并远端的主分支的内容，然后解决冲突并提交'), true);
  assert.equal(sameMessage(message, '合并远端的主分支的内容，然后…'), true, 'a line the CLI cut short');
  assert.equal(sameMessage('first line\nsecond line', '[Pasted text #1 +2 lines]'), true);
  assert.equal(sameMessage('a'.repeat(300), '[Pasted Content 300 chars]'), true, "Codex's paste summary");
  assert.equal(sameMessage(message, ''), false);
  assert.equal(sameMessage(message, '继续'), false, 'a different prompt put back after an interrupt');
});

test('a leftover that only begins like the message is not the message', () => {
  // Enter on it would send the leftover instead of what was written.
  assert.equal(sameMessage('delete nothing', 'delete'), false);
  assert.equal(sameMessage('delete', 'delete nothing'), false);
  assert.equal(sameMessage('合并远端的主分支的内容，然后解决冲突并提交', '[Image #1] 合并远端的主分支的内容'), false);
  assert.equal(sameMessage('fix it', '[Pasted text #1 +40 lines]'), false, 'a short message is never shown as a paste');
  assert.equal(sameMessage('fix', 'f…'), false, 'too little left to tell');
});

test("an SSH project's pasted picture path is shown as the picture pasted, not as a path", () => {
  const { rememberPicture, withPictures } = require('../src/features/reading/pasted-pictures.ts');
  const path = '/tmp/agentrix-images-0/20261012-210420-21a95830.png';
  rememberPicture(path, 'data:image/png;base64,AAAA');
  assert.deepEqual(withPictures(`${path} 这个是什么`), { text: '这个是什么', images: ['data:image/png;base64,AAAA'] });
  assert.deepEqual(withPictures('/tmp/other.png 看看'), { text: '/tmp/other.png 看看', images: [] }, 'a path not pasted here stays text');
});
