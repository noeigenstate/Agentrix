const { test } = require('node:test');
const assert = require('node:assert/strict');
const { minutesPage } = require('../electron/features/team/minutes-page.cjs');

const ROW_KEYS = ['who', 'title', 'files', 'goal', 'provides', 'uses', 'doneWhen', 'questions'];
const row = (status, who = 'Sol') => ({ who, title: `${who} task`, files: 'a.cjs', goal: `${who} goal`, provides: 'p', uses: 'u', doneWhen: 'd', questions: 'q', status });
const minutes = (overrides = {}) => ({
  meeting: 'roundtable-1', round: 1, generatedAt: new Date(2026, 9, 30, 8, 5).getTime(), language: 'zh',
  rows: [row('confirmed')], issues: [{ issue: 'i', raisedBy: 'Sonnet', answer: 'a', result: 'r' }], ...overrides,
});
const cjk = /[一-鿿]/;

test('every value of every row and issue is escaped, in both languages', () => {
  const evil = `<script>alert("x")</script><img src=x onerror='y'> & "q"`;
  const filled = { ...Object.fromEntries(ROW_KEYS.map(key => [key, evil])), status: evil };
  for (const language of ['zh', 'en']) {
    const html = minutesPage(minutes({
      language, meeting: evil, round: evil, rows: [filled],
      issues: [{ issue: evil, raisedBy: evil, answer: evil, result: evil }],
    }));
    assert.doesNotMatch(html, /<script>alert|<img/);
    assert.ok(html.includes('&#60;script&#62;alert(&#34;x&#34;)&#60;/script&#62;'));
    assert.ok(html.includes('&#60;img src=x onerror=&#39;y&#39;&#62; &#38; &#34;q&#34;'));
  }
});

test('the zh page labels both tables, the title and the summary in Chinese', () => {
  const html = minutesPage(minutes({ rows: [row('confirmed'), row('open', 'Sonnet')] }));
  assert.match(html, /<html lang="zh-CN">/);
  for (const label of ['子模型', '任务', '负责的文件', '提供的接口', '用到的接口', '怎样算完成', '疑问或风险', '状态', '分歧或疑问', '谁提出', '主模型的答复', '结果']) {
    assert.ok(html.includes(`<th>${label}</th>`), label);
  }
  assert.match(html, /<h1>第 1 轮圆桌 · roundtable-1<\/h1>/);
  assert.match(html, /<title>第 1 轮圆桌 · roundtable-1<\/title>/);
  assert.match(html, /已确认 1 \/ 2/);
});

test('the en page has English labels only', () => {
  const html = minutesPage(minutes({ language: 'en', rows: [row('confirmed'), row('understood', 'Sonnet')] }));
  assert.match(html, /<html lang="en">/);
  for (const label of ['Worker', 'Task', 'Files owned', 'Provides', 'Uses', 'Done when', 'Questions or risks', 'Status', 'Disagreement or question', 'Raised by', "Lead's answer", 'Result']) {
    assert.ok(html.includes(`<th>${label}</th>`), label);
  }
  assert.match(html, /<h1>Round 1 roundtable · roundtable-1<\/h1>/);
  assert.match(html, /Confirmed 1 of 2/);
  assert.doesNotMatch(html, cjk);
});

test('each status has its mark and word, invalid reads as incomplete, and only confirmed counts', () => {
  const zh = { confirmed: '✅ 已确认', open: '⚠️ 待澄清', understood: '📝 已复述', incomplete: '✖ 不完整', invalid: '✖ 不完整' };
  const en = { confirmed: '✅ Confirmed', open: '⚠️ Open', understood: '📝 Understood', incomplete: '✖ Incomplete', invalid: '✖ Incomplete' };
  for (const [language, labels] of [['zh', zh], ['en', en]]) {
    for (const [status, label] of Object.entries(labels)) {
      const html = minutesPage(minutes({ language, rows: [row(status)] }));
      assert.ok(html.includes(`<td class="status">${label}</td>`), `${language} ${status}`);
      assert.ok(html.includes(language === 'zh' ? `已确认 ${status === 'confirmed' ? 1 : 0} / 1` : `Confirmed ${status === 'confirmed' ? 1 : 0} of 1`), `${language} ${status} count`);
    }
  }
  const all = minutesPage(minutes({ rows: Object.keys(zh).map(status => row(status, status)) }));
  assert.match(all, /已确认 1 \/ 5/);
});

test('a missing or unknown status reads as incomplete, keeping an unknown value in parentheses, and an unknown language falls back to zh', () => {
  const html = minutesPage(minutes({ language: 'constructor', rows: [row('constructor'), row(undefined, 'Terra'), row('none', 'Luna'), row('<b>', 'Evil')] }));
  assert.match(html, /<html lang="zh-CN">/);
  assert.ok(html.includes('<td class="status">✖ 不完整 (constructor)</td>'));
  assert.ok(html.includes('<td class="status">✖ 不完整</td>'));
  assert.ok(html.includes('<td class="status">✖ 不完整 (&#60;b&#62;)</td>'));
  assert.equal(html.match(/<td class="status">✖ 不完整<\/td>/g).length, 2);
  const en = minutesPage(minutes({ language: 'en', rows: [row('later'), row(null)] }));
  assert.ok(en.includes('<td class="status">✖ Incomplete (later)</td>'));
  assert.ok(en.includes('<td class="status">✖ Incomplete</td>'));
  assert.match(en, /Confirmed 0 of 2/);
});

test('empty data keeps both tables and their headers, with the note in one full-width row', () => {
  const noIssues = minutesPage(minutes({ issues: [] }));
  assert.equal(noIssues.match(/<table/g).length, 2);
  assert.ok(noIssues.includes('<td class="empty" colspan="4">没有分歧或疑问</td>'));
  assert.ok(noIssues.includes('<th>主模型的答复</th>'));
  assert.ok(minutesPage(minutes({ language: 'en', issues: [] })).includes('<td class="empty" colspan="4">No disagreements or questions</td>'));
  const empty = minutesPage(minutes({ rows: [], issues: [] }));
  assert.equal(empty.match(/<table/g).length, 2);
  assert.ok(empty.includes('<td class="empty" colspan="8">还没有子模型的记录</td>'));
  assert.ok(empty.includes('<td class="empty" colspan="4">没有分歧或疑问</td>'));
  assert.ok(empty.includes('<th>状态</th>'));
  assert.ok(minutesPage(minutes({ language: 'en', rows: [] })).includes('<td class="empty" colspan="8">No worker has answered yet</td>'));
  assert.match(empty, /已确认 0 \/ 0/);
  assert.match(minutesPage({ meeting: 'm', round: 1 }), /<\/html>\n$/);
});

test('lists keep their lines; empty, missing and "none" values read as a dash', () => {
  const html = minutesPage(minutes({ rows: [{ ...row('open'), files: ['a.cjs', 'b/*.cjs'], provides: 'none', uses: ' None ', doneWhen: '', questions: undefined }] }));
  assert.match(html, /white-space: pre-wrap/);
  assert.equal(html.match(/<td>—<\/td>/g).length, 4);
  assert.ok(minutesPage(minutes({ rows: [{ ...row('open'), files: 'none' }] })).includes('<td class="files">—</td>'));
  assert.ok(minutesPage(minutes({ rows: [{ ...row('open'), questions: 'one\ntwo' }] })).includes('<td>one\ntwo</td>'));
});

test('each file is its own block, escaped first, with a break opportunity after every separator', () => {
  const html = minutesPage(minutes({ rows: [{ ...row('open'), files: ['a.cjs', 'src/<b>/x&y.cjs', 'win\\dir\\f.cjs', ' '] }] }));
  assert.ok(html.includes('<td class="files"><span class="file">a.cjs</span><span class="file">src/<wbr>&#60;b&#62;/<wbr>x&#38;y.cjs</span><span class="file">win\\<wbr>dir\\<wbr>f.cjs</span></td>'));
  assert.ok(minutesPage(minutes({ rows: [{ ...row('open'), files: 'a/b.cjs\nc/d.cjs' }] }))
    .includes('<span class="file">a/<wbr>b.cjs</span><span class="file">c/<wbr>d.cjs</span>'));
  assert.match(html, /\.files \{ overflow-wrap: break-word;/);
  assert.match(html, /\.file \{[^}]*padding-left: 16px; text-indent: -16px/);
});

test('the task cell has the title in bold and the goal below it', () => {
  assert.ok(minutesPage(minutes()).includes('<td><strong>Sol task</strong><span class="goal">Sol goal</span></td>'));
});

test('the title carries the round, the meeting id and the generated time as yyyy-mm-dd hh:mm', () => {
  const html = minutesPage(minutes({ round: 3, meeting: 'plan-9' }));
  assert.ok(html.includes('<title>第 3 轮圆桌 · plan-9</title>'));
  assert.ok(html.includes('生成于 2026-10-30 08:05'));
  for (const generatedAt of [undefined, null, 'x', NaN]) assert.ok(minutesPage(minutes({ generatedAt })).includes('生成于 —'));
});

test('the page follows the viewer\'s light or dark preference, with the app\'s palette, and tables scroll inside their panel', () => {
  const html = minutesPage(minutes());
  assert.match(html, /color-scheme: dark/);
  assert.match(html, /@media \(prefers-color-scheme: light\)/);
  for (const colour of ['#181818', '#262626', '#f8f9fb', '#ffffff', '#e4e7eb', '#24272d']) assert.ok(html.toLowerCase().includes(colour), colour);
  assert.match(html, /\.panel \{ overflow-x: auto/);
  assert.equal(html.match(/<div class="panel"[^>]*><table/g).length, 2);
});

test('in the wide table the worker column sticks left and the status column right, over opaque cells', () => {
  const html = minutesPage(minutes());
  assert.match(html, /\.wide :is\(th, td\):first-child:not\(\.empty\) \{[^}]*position: sticky; left: 0;[^}]*box-shadow: inset -1px 0 var\(--divider\)/);
  assert.match(html, /\.wide :is\(th, td\):last-child:not\(\.empty\) \{[^}]*position: sticky; right: 0;[^}]*box-shadow: inset 1px 0 var\(--divider\)/);
  assert.match(html, /\ntd \{[^}]*background: var\(--panel\)/);
  assert.match(html, /\nth \{[^}]*background: var\(--well\)/);
  assert.match(html, /border-collapse: separate/);
  assert.equal(html.match(/<table class="wide">/g).length, 1);
  assert.equal(html.match(/<table>/g).length, 1);
});

test('all eight columns fit at 1440 px: the wide table\'s minimum widths add up to less than the page', () => {
  const html = minutesPage(minutes());
  const rem = pattern => Number(html.match(pattern)[1]);
  const cell = rem(/\n\.wide td \{ min-width: (\d+)rem;/), files = rem(/\n\.wide \.files \{ min-width: (\d+)rem;/);
  const table = rem(/table\.wide \{ min-width: (\d+)rem;/);
  assert.equal(cell, 7);
  assert.equal(files, 14);
  // Six plain cells, the files cell and a status cell about as wide as a plain one with a count line, plus 16 px padding each side.
  const minimum = (7 * cell + files) * 16 + 8 * 32;
  assert.ok(minimum <= 1440 - 2 * 24 - 2, `${minimum} px of minimums must fit the 1440 px page`);
  assert.ok(table * 16 <= 1440 - 2 * 24 - 2);
  assert.ok(table * 16 >= minimum - 16, 'the table minimum matches the columns');
});

test('the status cell counts the row\'s open questions under the status word, in both languages', () => {
  const asked = (language, questions) => minutesPage(minutes({ language, rows: [{ ...row('open'), questions }] }));
  const zh = asked('zh', ['一般的疑问', '未解决：第一个', ' 未解决：第二个']);
  assert.ok(zh.includes('<td class="status">⚠️ 待澄清<span class="open-count">2 个未解决问题</span></td>'));
  const en = asked('en', 'Open: first\nOpen: second\nOpen: third\nplain risk');
  assert.ok(en.includes('<td class="status">⚠️ Open<span class="open-count">3 open questions</span></td>'));
  assert.ok(asked('en', 'Open: only one').includes('<span class="open-count">1 open question</span>'));
  assert.match(zh, /\.open-count \{[^}]*color: var\(--text-2\)/);
});

test('without open questions the status cell has no count, and only the page language\'s prefix counts', () => {
  const body = (language, questions) => minutesPage(minutes({ language, rows: [{ ...row('open'), questions }] })).replace(/\.open-count \{[^}]*\}/, '');
  for (const questions of ['q', 'none', '', undefined, ['a', 'b'], 'see 未解决：inside the line']) {
    for (const language of ['zh', 'en']) assert.doesNotMatch(body(language, questions), /open-count/, `${language} ${JSON.stringify(questions)}`);
  }
  assert.doesNotMatch(body('en', '未解决：zh prefix'), /open-count/);
  assert.doesNotMatch(body('zh', 'Open: en prefix'), /open-count/);
});

test('the open-question prefix is a shared label for both languages', () => {
  const { LABELS } = require('../electron/features/team/minutes-page.cjs');
  assert.equal(LABELS.zh.openPrefix, '未解决：');
  assert.equal(LABELS.en.openPrefix, 'Open: ');
});

test('spacing follows the 8 px rhythm', () => {
  const html = minutesPage(minutes());
  assert.match(html, /th, td \{ padding: 8px 16px;/);
  assert.match(html, /h2 \{ margin: 32px 0 16px;/);
  assert.match(html, /\.summary \{ margin-top: 16px;/);
  const lengths = [...html.match(/<style>[\s\S]*<\/style>/)[0].matchAll(/(?:margin|padding)[a-z-]*:[^;}]+/g)].flatMap(([declaration]) => declaration.match(/-?\d+px/g) ?? []);
  assert.ok(lengths.length >= 8);
  for (const length of lengths) assert.equal(Math.abs(parseInt(length, 10)) % 8, 0, length);
});

test('the page is one self-contained document that loads nothing external', () => {
  for (const language of ['zh', 'en']) {
    const html = minutesPage(minutes({ language }));
    assert.match(html, /^<!DOCTYPE html>\n<html /);
    assert.match(html, /<\/html>\n$/);
    assert.equal(html.match(/<html[ >]/g).length, 1);
    assert.equal(html.match(/<head>/g).length, 1);
    assert.equal(html.match(/<style>/g).length, 1);
    assert.doesNotMatch(html, /https?:|\/\/|\bsrc=|\bhref=|<link|<script|<iframe|<img|@import|url\(|@font-face/i);
  }
});
