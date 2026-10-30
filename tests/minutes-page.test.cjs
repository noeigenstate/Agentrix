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

test('an unknown status is shown as written and an unknown language falls back to zh', () => {
  const html = minutesPage(minutes({ language: 'constructor', rows: [row('constructor'), row(undefined, 'Terra')] }));
  assert.match(html, /<html lang="zh-CN">/);
  assert.ok(html.includes('<td class="status">constructor</td>'));
  assert.ok(html.includes('<td class="status">—</td>'));
});

test('no issues leaves a note instead of an empty second table; no rows still gives a full page', () => {
  const noIssues = minutesPage(minutes({ issues: [] }));
  assert.equal(noIssues.match(/<table/g).length, 1);
  assert.match(noIssues, /<p class="empty">没有分歧或疑问<\/p>/);
  assert.match(minutesPage(minutes({ language: 'en', issues: [] })), /<p class="empty">No disagreements or questions<\/p>/);
  const empty = minutesPage(minutes({ rows: [], issues: [] }));
  assert.equal(empty.match(/<table/g), null);
  assert.match(empty, /还没有子模型的记录/);
  assert.match(empty, /已确认 0 \/ 0/);
  assert.match(minutesPage({ meeting: 'm', round: 1 }), /<\/html>\n$/);
});

test('lists keep their lines; empty, missing and "none" values read as a dash', () => {
  const html = minutesPage(minutes({ rows: [{ ...row('open'), files: ['a.cjs', 'b/*.cjs'], provides: 'none', uses: ' None ', doneWhen: '', questions: undefined }] }));
  assert.ok(html.includes('<td class="files">a.cjs\nb/*.cjs</td>'));
  assert.match(html, /white-space: pre-wrap/);
  assert.equal(html.match(/<td>—<\/td>/g).length, 4);
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
