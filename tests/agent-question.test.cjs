const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { choiceIdentity, parseAgentScreen } = require('../src/features/agents/agent-screen.ts');
const { parseQuestion } = require('../src/features/agents/agent-question.ts');

// Screens drawn by Claude Code 2.1.294 (AskUserQuestion) and Codex 0.161 (request_user_input in Plan mode).
const read = name => fs.readFileSync(path.join(__dirname, 'fixtures/questions', name + '.txt'), 'utf8').split('\n');
const parse = name => parseAgentScreen(name.startsWith('claude') ? 'claude' : 'codex', read(name)).choice;
const option = (number, label, detail, role, selected = false, checked) =>
  ({ number, label, detail, hotkey: null, selected, role, ...(checked === undefined ? {} : { checked }) });
const claude = fields => ({ agent: 'claude', tabs: [], position: null, multi: false, submit: null, notes: null, review: null, ...fields });
const codex = fields => ({ agent: 'codex', tabs: [], position: null, multi: false, submit: null, notes: { open: false, text: '' }, review: null, ...fields });

test('every question fixture is recognised', () => {
  for (const file of fs.readdirSync(path.join(__dirname, 'fixtures/questions'))) {
    const choice = parse(file.replace(/\.txt$/, ''));
    assert.equal(choice?.kind, 'question', file);
  }
});

test('Claude single question: options with their descriptions, an own answer and Chat about this', () => {
  assert.deepEqual(parse('claude-question'), {
    kind: 'question', title: '回收站怎么处理？', context: [], hint: 'Enter to select · ↑/↓ to navigate · Esc to cancel',
    options: [
      option(1, '保留回收站（推荐）', '不动回收站里的内容。', 'answer', true),
      option(2, '清空回收站', '永久删除回收站里的全部内容，无法撤销。', 'answer'),
      option(3, 'Type something.', '', 'input'),
      option(4, 'Chat about this', '', 'chat'),
    ],
    question: claude({}),
  });
});

test('Claude question tabs, multi-select ticks, the typed own answer and the Submit row', () => {
  assert.deepEqual(parse('claude-question-tabs').question.tabs, [{ label: '回收站', answered: false }, { label: '清理目录', answered: false }]);
  const checked = parse('claude-question-multi-checked');
  assert.equal(checked.title, '要清理哪些目录？');
  assert.deepEqual(checked.question, claude({ tabs: [{ label: '回收站', answered: false }, { label: '清理目录', answered: true }], multi: true, submit: { selected: false } }));
  assert.deepEqual(checked.options.map(item => [item.label, item.checked, item.selected, item.role]), [
    ['node_modules', true, false, 'answer'], ['dist', false, true, 'answer'], ['.test-output', false, false, 'answer'],
    ['Type something', false, false, 'input'], ['Chat about this', undefined, false, 'chat'],
  ]);
  const typed = parse('claude-question-typed');
  assert.deepEqual([typed.options[3].label, typed.options[3].checked, typed.options[3].selected], ['abc', true, true]);
  assert.deepEqual(parse('claude-question-submit').question.submit, { selected: true });
});

test('Claude review page lists the answers before Submit answers / Cancel', () => {
  const review = parse('claude-question-review');
  assert.equal(review.title, 'Ready to submit your answers?');
  assert.deepEqual(review.question.review, [{ question: '回收站怎么处理？', answer: '清空回收站' }, { question: '要清理哪些目录？', answer: 'node_modules, abc' }]);
  assert.deepEqual(review.options.map(item => [item.label, item.selected]), [['Submit answers', true], ['Cancel', false]]);
});

test('Claude Review accepts the real unanswered warning with zero or some answers, and wrapped summaries', () => {
  const rows = read('claude-question-review');
  const heading = rows.findIndex(row => row.trim() === 'Review your answers');
  const ready = rows.findIndex(row => row.trim() === 'Ready to submit your answers?');
  for (const summaries of [[], [' ● First question', '   continued question', '   → First answer', '     continued answer']]) {
    const screen = parseAgentScreen('claude', [...rows.slice(0, heading + 1), '', '⚠ You have not answered all questions', '', ...summaries, '', ...rows.slice(ready)]);
    assert.equal(screen.choice?.kind, 'question');
    assert.equal(screen.waiting, undefined);
    assert.deepEqual(screen.choice.context, ['⚠ You have not answered all questions']);
    assert.deepEqual(screen.choice.question.review, summaries.length ? [{ question: 'First question continued question', answer: 'First answer continued answer' }] : []);
    assert.deepEqual(screen.choice.options.map(item => item.label), ['Submit answers', 'Cancel']);
  }
});

test('Claude bundle checkbox, tick and pointer variants keep tabs and selections', () => {
  const rows = read('claude-question-multi-checked');
  // Claude 2.1.314's symbol tables: U+2610/2612/2714 and [ ]/[×]/U+221A with pointer >.
  const fallback = rows.map(row => row.replaceAll('☐', '[ ]').replaceAll('☒', '[×]').replaceAll('✔', '√').replaceAll('❯', '>'));
  assert.deepEqual(parseAgentScreen('claude', fallback).choice, parse('claude-question-multi-checked'));
});

test('a clipped Claude tab bar retains a complete visible question, but missing option one waits', () => {
  const rows = read('claude-question');
  const heading = rows.findIndex(row => row.trim() === '回收站怎么处理？');
  assert.deepEqual(parseAgentScreen('claude', rows.slice(heading)).choice, parse('claude-question'));
  const second = rows.findIndex(row => /^\s*2\./.test(row));
  const clipped = parseAgentScreen('claude', rows.slice(second));
  assert.equal(clipped.choice, null);
  assert.deepEqual(clipped.waiting, { title: null });
});

test('a missing Claude tab bar cannot include conversation, rules or inputs in the question title', () => {
  const captured = fs.readFileSync(path.join(__dirname, 'fixtures/screens/claude-investigation-single.txt'), 'utf8')
    .split('\n').map(row => row.replaceAll('☐', '□'));
  const rows = read('claude-question');
  const heading = rows.findIndex(row => row.trim() === '回收站怎么处理？');
  for (const screenRows of [captured, ...['────────────────', '⏺ Previous answer', '● Previous answer', '⎿ Previous tool result', '❯ Previous prompt']
    .map(row => [row, '', ...rows.slice(heading)])]) {
    assert.equal(parseQuestion('claude', screenRows), null);
  }
  const screen = parseAgentScreen('claude', captured);
  assert.equal(screen.choice, null);
  assert.deepEqual(screen.waiting, { title: null });
});

test('Codex questions: position, two-column options, the last question and open notes', () => {
  assert.deepEqual(parse('codex-question'), {
    kind: 'question', title: '回收站怎么处理？', context: [], hint: 'tab to add notes | enter to submit answer | ←/→ to navigate questions | esc to interrupt',
    options: [
      option(1, '保留回收站（推荐）', '保留回收站中的内容。', 'answer', true),
      option(2, '清空回收站', '清空回收站中的内容。', 'answer'),
      option(3, 'None of the above', 'Optionally, add details in notes (tab)', 'answer'),
    ],
    question: codex({ position: { index: 1, count: 2 } }),
  });
  assert.equal(parse('codex-question-last').title, '要清理哪个目录？');
  const notes = parse('codex-question-notes');
  assert.deepEqual([notes.question.notes, notes.options[1].selected], [{ open: true, text: '' }, true]);
});

test('a question already answered or scrolled away is not a choice; padding does not change anything', () => {
  for (const name of ['claude-question', 'codex-question']) {
    assert.equal(parseAgentScreen(name.startsWith('claude') ? 'claude' : 'codex', [...read(name), '● User answered: 清空回收站', '']).choice, null, name);
    const padded = Object.freeze(read(name).map(row => row.replace(/\r$/, '') + '   \r'));
    assert.deepEqual(parseAgentScreen(name.startsWith('claude') ? 'claude' : 'codex', padded).choice, parse(name), name);
  }
});

test('numbered lines in the question text stay in the question; the options start above the live cursor', () => {
  const rows = read('claude-question');
  const at = rows.findIndex(row => row.trim() === '回收站怎么处理？');
  const withList = [...rows.slice(0, at + 1), '1. 保留：文件原样不动。', '2. 清空：无法恢复。', ...rows.slice(at + 1)];
  const choice = parseAgentScreen('claude', withList).choice;
  assert.deepEqual(choice.options.map(option => option.label), ['保留回收站（推荐）', '清空回收站', 'Type something.', 'Chat about this']);
  assert.match(choice.title, /1\. 保留：文件原样不动。/);
});

test('a question keeps its display identity while ticks, typed text and the cursor change, and not across pages', () => {
  const same = ['claude-question-multi', 'claude-question-multi-checked', 'claude-question-typed', 'claude-question-submit'].map(name => choiceIdentity(parse(name)));
  assert.equal(new Set(same).size, 1);
  assert.notEqual(choiceIdentity(parse('claude-question-tabs')), same[0]);
  assert.notEqual(choiceIdentity(parse('claude-question-review')), same[0]);
  assert.equal(choiceIdentity(parse('codex-question')), choiceIdentity(parse('codex-question-notes')));
});
