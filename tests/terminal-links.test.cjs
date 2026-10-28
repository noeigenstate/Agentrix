const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { findLinkCandidates, findPathCandidates, readLogicalLine } = require('../src/features/terminal/terminal-links.ts');
const { resolveTerminalLink, resolveRevealPathText } = require('../electron/terminal-links.cjs');

test('reading paths reuse terminal links, include folders and UNC, and retain exact selectable ranges', () => {
  for (const [text, targets] of [
    ['路径：C:\\项目\\guide-whats-new.png:142:3。', ['C:\\项目\\guide-whats-new.png:142:3']],
    ['请查看src/App.tsx:142，再继续。', ['src/App.tsx:142']],
    ['目录 /tmp/results、~/docs/、src/features/ 和 .\\output\\', ['/tmp/results', '~/docs/', 'src/features/', '.\\output\\']],
    ['\\\\server\\share\\文档\\', ['\\\\server\\share\\文档\\']],
    ['//server/share/文档/', ['//server/share/文档/']],
    ['[src/App.tsx:142] 和（./src/App.tsx:142:8）', ['src/App.tsx:142', './src/App.tsx:142:8']],
    ['查看 (art/中文 报告.html) 和 `C:\\项目 空格\\art\\report.html`', ['art/中文 报告.html', 'C:\\项目 空格\\art\\report.html']],
    ['("docs/output/") 与 (art/报告_(最终).html)', ['docs/output/', 'art/报告_(最终).html']],
    ['“C:\\项目 空格\\art\\report.html” 和（./文档/中文 报告.md）', ['C:\\项目 空格\\art\\report.html', './文档/中文 报告.md']],
    ['[文件夹](src/features/) https://example.com/a.txt www.example.com', ['src/features/']],
  ]) {
    const links = findPathCandidates(text);
    assert.deepEqual(links.map(link => link.target), targets, text);
    for (const link of links) {
      // A Markdown label's hit area spans the reference; every other hit area is exactly the written path.
      if (!text.slice(link.start, link.end).startsWith('[文件夹]')) assert.equal(text.slice(link.start, link.end), link.target, text);
    }
  }
});

test('reveal path text resolves Windows, UNC, POSIX, home and relative paths without presentation or positions', () => {
  for (const [target, expected] of [
    ['"C:\\项目 空格\\guide-whats-new.png:142:8"。', 'C:\\项目 空格\\guide-whats-new.png'],
    ['[src/App.tsx:142]', 'C:\\work\\repo\\src\\App.tsx'],
    ['"C:\\项目\\report.md":142:8', 'C:\\项目\\report.md'],
    ['（.\\docs\\报告_(最终).md:12:2），', 'C:\\work\\repo\\docs\\报告_(最终).md'],
    ['\\\\server\\share\\dir\\', '\\\\server\\share\\dir'],
    ['//server/share/dir', '\\\\server\\share\\dir'],
    ['~/Desktop/result.png', 'C:\\Users\\owner\\Desktop\\result.png'],
    ['../outside.txt', 'C:\\work\\outside.txt'],
  ]) assert.equal(resolveRevealPathText('C:\\work\\repo', target, 'C:\\Users\\owner', 'win32'), expected, target);
  for (const [target, expected] of [
    ['`/tmp/报告.md:12:3`;', '/tmp/报告.md'],
    ['`src/App.tsx`:142:8', '/work/repo/src/App.tsx'],
    ['「~/Documents/result.png」', '/home/owner/Documents/result.png'],
    ['[src/App.tsx#L142C8]', '/work/repo/src/App.tsx'],
    ['.\\docs\\report.md:2', '/work/repo/docs/report.md'],
    ['../outside.txt', '/work/outside.txt'],
    ['(.)', '/work/repo'],
    ['(./folder/name_(final).md).', '/work/repo/folder/name_(final).md'],
  ]) assert.equal(resolveRevealPathText('/work/repo', target, '/home/owner', 'linux'), expected, target);
  for (const target of [null, 42, {}, '', ' ', 'x'.repeat(4097), 'bad\0path', 'a\nb', 'javascript:alert(1)', 'https://example.com/a', 'vscode://a']) {
    assert.throws(() => resolveRevealPathText('/work/repo', target), /无效/, String(target));
  }
  assert.throws(() => resolveRevealPathText('/work/repo', 'C:\\remote\\file', '/home/owner', 'linux'), /无效/);
});

test('inline-code boundaries preserve full paths containing spaces after Markdown removes its backticks', () => {
  for (const text of ['C:\\项目 空格\\guide-whats-new.png:142:3', '/tmp/中文 报告/result.png', 'reports/中文 报告.md', 'src/features/', 'docs', 'LICENSE', '.', '..', '~']) {
    assert.deepEqual(findPathCandidates(text, true), [{ start: 0, end: text.length, target: text }]);
  }
});

test('terminal links include URLs, Markdown, quoted paths and file line references', () => {
  const values = findLinkCandidates('网页 https://example.com/report_(final)?x=1。 [报告](reports/中文 报告.html) `C:\\项目 空格\\截图.png` src/App.tsx:42:3 www.example.org');
  assert.deepEqual(values.map(value => value.target), ['https://example.com/report_(final)?x=1', 'reports/中文 报告.html', 'C:\\项目 空格\\截图.png', 'src/App.tsx:42:3', 'www.example.org']);
  assert.equal(findLinkCandidates('See (http://localhost:5178/preview).')[0].target, 'http://localhost:5178/preview');
  assert.equal(findLinkCandidates('See [report](reports/report_(final).html)')[0].target, 'reports/report_(final).html');
});

test('terminal link cells account for Chinese widths and wrapped rows', () => {
  const rows = [
    [{ chars: '图', width: 2 }, { chars: '', width: 0 }, ...[...' https:/'].map(chars => ({ chars, width: 1 }))],
    [...'/a.co/x'.split('').map(chars => ({ chars, width: 1 }))],
  ];
  const buffer = { getLine(index) { const cells = rows[index]; return cells && { isWrapped: index > 0, length: cells.length, getCell: col => cells[col] && { getChars: () => cells[col].chars, getWidth: () => cells[col].width }, translateToString: () => cells.filter(cell => cell.width > 0).map(cell => cell.chars).join('') }; } };
  const result = readLogicalLine(buffer, 10, 2);
  assert.equal(result.text, '图 https://a.co/x');
  const link = findLinkCandidates(result.text)[0];
  assert.deepEqual(result.starts[link.start], { x: 4, y: 1 });
  assert.deepEqual(result.ends[link.end - 1], { x: 7, y: 2 });
});

test('Codex relative references exclude surrounding punctuation and preserve filename parentheses', () => {
  const folder = 'art/protagonist_skill_trial_hy_raw_20260915';
  const text = `查看 HTML 报告 (${folder}/report.html) · 下载报告与模型包 (${folder}/review_bundle.zip)`;
  const links = findLinkCandidates(text);
  assert.deepEqual(links.map(link => link.target), [`${folder}/report.html`, `${folder}/review_bundle.zip`]);
  for (const link of links) assert.equal(text.slice(link.start, link.end), link.target, 'hover and click cover only the path');
  for (const [text, target] of [
    ['(./art/report.html)', './art/report.html'], ['[art/report.html]', 'art/report.html'],
    ['((art/report.html))', 'art/report.html'], ['（art/报告.html）', 'art/报告.html'],
    ['(art/中文 报告.html)', 'art/中文 报告.html'], ['(art/报告_(最终).html)', 'art/报告_(最终).html'],
    ['art/(report).html', 'art/(report).html'], ['art/[draft]/report.html', 'art/[draft]/report.html'],
    ['(art/folder(name.html)/report.html)', 'art/folder(name.html)/report.html'],
    ['(C:\\项目 空格\\art\\report.html)', 'C:\\项目 空格\\art\\report.html'],
    ['(./art/main.ts:12:4)', './art/main.ts:12:4'],
  ]) {
    const matches = findLinkCandidates(text);
    assert.deepEqual(matches.map(link => link.target), [target], text);
    assert.equal(text.slice(matches[0].start, matches[0].end), target, text);
  }
});

test('detected relative report and archive paths resolve against their own project directory', async t => {
  const prefix = path.join(os.tmpdir(), 'agentrix-relative-links-');
  const directory = await fs.mkdtemp(prefix);
  t.after(async () => { assert.ok(path.resolve(directory).startsWith(prefix)); await fs.rm(directory, { recursive: true, force: true }); });
  const project = { path: path.join(directory, '项目 空格') };
  const folder = 'art/protagonist_skill_trial_hy_raw_20260915';
  await fs.mkdir(path.join(project.path, folder), { recursive: true });
  for (const name of ['report.html', 'review_bundle.zip', '报告_(最终).html']) {
    await fs.writeFile(path.join(project.path, folder, name), 'fixture');
    for (const notation of [`(${folder}/${name})`, `(./${folder}/${name})`, `(.\\${folder.replaceAll('/', '\\')}\\${name})`]) {
      const [link] = findLinkCandidates(notation);
      assert.deepEqual(await resolveTerminalLink(project, link.target), { kind: 'file', path: `${folder}/${name}` });
    }
  }
  await assert.rejects(resolveTerminalLink(project, findLinkCandidates('(art/missing.html)')[0].target), /未找到链接文件/);
});

test('link resolution opens HTTP URLs and project files while rejecting executable protocols and escapes', async t => {
  const prefix = path.join(os.tmpdir(), 'agentrix-links-');
  const directory = await fs.mkdtemp(prefix);
  const project = { path: path.join(directory, 'project') };
  await fs.mkdir(project.path);
  t.after(async () => { const target = path.resolve(directory); assert.ok(target.startsWith(prefix)); await fs.rm(target, { recursive: true, force: true }); });
  const filename = path.join(project.path, '中文 图片.png');
  await fs.writeFile(filename, 'image');
  for (const target of ['中文 图片.png', filename, pathToFileURL(filename).href, '中文 图片.png:12:4']) {
    assert.deepEqual(await resolveTerminalLink(project, target), { kind: 'file', path: '中文 图片.png' });
  }
  assert.deepEqual(await resolveTerminalLink(project, 'http://localhost:5178/'), { kind: 'external', url: 'http://localhost:5178/' });
  assert.deepEqual(await resolveTerminalLink(project, 'www.example.org'), { kind: 'external', url: 'https://www.example.org/' });
  await fs.writeFile(path.join(directory, 'outside.txt'), 'private');
  for (const target of ['javascript:alert(1)', 'data:text/html,hi', 'vscode://test', 'powershell:command', '../outside.txt', pathToFileURL(path.join(directory, 'outside.txt')).href, 'bad\0path', '中文 图片.png:stream']) {
    await assert.rejects(resolveTerminalLink(project, target), target);
  }
});
