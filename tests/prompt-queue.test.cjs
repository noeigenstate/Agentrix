const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PromptQueue } = require('../electron/prompt-queue.cjs');
const { SubmissionTracker } = require('../electron/terminal-input.cjs');
const { commandPhrase, PHRASES } = require('../electron/agent-actions.cjs');
const { en } = require('../electron/i18n.cjs');

const queue = () => { let now = 1000; const q = new PromptQueue(() => {}, { now: () => now, grace: 5000 }); return { q, at: value => { now = value; } }; };
const view = q => q.list().map(item => `${item.state}:${item.text}`);

test('prompts sent while the agent works wait, are taken up in order and leave when their round ends', () => {
  const { q } = queue();
  q.submit('给登录页加验证码', false, 1000);
  q.start('给登录页加验证码', 1100, 'u1');
  q.submit('再补上测试', true, 1200);
  q.submit('然后更新文档', true, 1300);
  assert.deepEqual(view(q), ['working:给登录页加验证码', 'queued:再补上测试', 'queued:然后更新文档']);
  q.finish(2000);
  q.start('再补上测试', 2100, 'u2');
  assert.deepEqual(view(q), ['working:再补上测试', 'queued:然后更新文档']);
  q.start('再补上测试', 2100, 'u2');
  assert.equal(q.list().length, 2, 'a record read twice counts once');
  q.finish(3000); q.start('然后更新文档', 3100, 'u3'); q.finish(4000);
  assert.deepEqual(view(q), []);
});

test('the record decides the text, commands are not prompts, and a line never taken up goes away', () => {
  const { q, at } = queue();
  q.submit('', false, 1000);
  q.submit('/model', false, 1000);
  q.submit('!ls', false, 1000);
  assert.deepEqual(view(q), []);
  q.submit('', true, 1000); q.submit('typed with arrow edits', true, 1000);
  q.start('what was really sent', 1500, 'u1');
  assert.deepEqual(view(q), ['working:what was really sent']);
  q.submit('1', false, 1600);
  at(7000);
  assert.deepEqual(view(q), ['working:what was really sent'], 'an answer to a question is dropped after a while');
});

test('a message read after its round already ended does not linger as working', () => {
  const { q } = queue();
  q.submit('修复按钮', false, 1000);
  q.finish(2000);
  q.start('修复按钮', 1500, 'u1');
  assert.deepEqual(view(q), []);
  q.start('下一条', 2500, 'u2');
  assert.deepEqual(view(q), ['working:下一条']);
});

test('distinct identical user records take up distinct queued sends during the same round', () => {
  const { q } = queue();
  q.submit('same', true, 1000); q.submit('same', true, 1200);
  q.start('same', 1100, 'first'); q.start('same', 1300, 'second');
  assert.deepEqual(view(q), ['working:same', 'working:same']);
  q.start('same', 1300, 'second'); assert.equal(q.list().length, 2);
  q.finish(1500); assert.deepEqual(view(q), []);
});

test('long common prefixes cannot make the activity queue take up a different waiting send', () => {
  const { q } = queue(), prefix = 'x'.repeat(100);
  q.submit(prefix + 'A', true, 1000); q.submit(prefix + 'B', true, 1100);
  q.start(prefix + 'B', 1200, 'second');
  assert.deepEqual(view(q), [`working:${prefix}B`, `queued:${prefix}A`]);
});

test('a historical withdrawal cannot cancel a newer identical waiting send', () => {
  const { q } = queue();
  q.submit('same', true, 5000);
  q.cancel('same', 1000); assert.deepEqual(view(q), ['queued:same']);
  q.cancel('same', 5100); assert.deepEqual(view(q), []);
});

test('the terminal keeps the text of a submitted line', () => {
  const tracker = new SubmissionTracker();
  tracker.write('加个按钮x'); tracker.write('\x7f');
  assert.equal(tracker.write('\r'), true);
  assert.deepEqual(tracker.sent, ['加个按钮']);
  tracker.write('\x1b[200~第一行\r\n第二行\x1b[201~');
  tracker.write('\r');
  assert.deepEqual(tracker.sent, ['第一行\n\n第二行']);
  tracker.write('\x1b[A'); tracker.write('\r');
  assert.deepEqual(tracker.sent, [''], 'a line from history has unknown text');
  tracker.write('abc\x15'); assert.equal(tracker.write('\r'), false);
});

test('shell commands are described in a few translated words', () => {
  const cases = {
    'npm test': '运行测试', 'cd app && pnpm run build': '构建项目', 'npx tsc --noEmit': '检查类型', 'git status --short': '查看 Git 状态',
    'git diff -- src/App.tsx': '查看改动', 'git commit -m "more tests"': '提交改动', 'rg -n "useState" src': '搜索代码',
    'Get-Content README.md': '读取文件', 'Get-ChildItem -Recurse': '查看目录', 'npm ci': '安装依赖',
  };
  for (const [command, phrase] of Object.entries(cases)) assert.equal(commandPhrase(command).phrase, phrase, command);
  assert.deepEqual(commandPhrase('node scripts/smoke.mjs --fast'), { phrase: '运行脚本', object: 'smoke.mjs' });
  assert.deepEqual(commandPhrase('"C:/tools/ffmpeg.exe" -i a.mp4'), { phrase: '运行命令', object: 'ffmpeg.exe' });
  assert.deepEqual(PHRASES.filter(phrase => !Object.prototype.hasOwnProperty.call(en, phrase)), []);
});
