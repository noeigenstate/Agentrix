const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { findFiles, listDirectory, readProjectFile, TEXT_PAGE_BYTES } = require('../electron/project-files.cjs');

async function fixture(t) {
  const prefix = path.join(os.tmpdir(), 'agentrix-files-');
  const directory = await fs.mkdtemp(prefix);
  const projectPath = path.join(directory, "中文 [项目] & '空格'");
  await fs.mkdir(projectPath);
  t.after(async () => {
    const target = path.resolve(directory);
    assert.ok(target.startsWith(prefix));
    await fs.rm(target, { recursive: true, force: true });
  });
  return { directory, project: { path: projectPath } };
}

async function writeMentionFile(project, name) {
  await fs.mkdir(path.dirname(path.join(project.path, name)), { recursive: true });
  await fs.writeFile(path.join(project.path, name), '');
}

test('C4 project file cache entries are actually released when their timer expires', async t => {
  const { project } = await fixture(t);
  const timers = [];
  const schedule = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => {
    if (ms === 20_000) { timers.push(callback); return { unref() {} }; }
    return schedule(callback, ms, ...args);
  });
  await writeMentionFile(project, 'before.txt');
  assert.deepEqual(await findFiles(project), [{ path: 'before.txt', kind: 'file' }]);
  await writeMentionFile(project, 'later.txt');
  assert.deepEqual(await findFiles(project, 'later'), []);
  assert.equal(timers.length, 1);
  timers[0]();
  assert.deepEqual(await findFiles(project, 'later'), [{ path: 'later.txt', kind: 'file' }]);
});

test('mentions walk plain folders, derive directories, skip generated trees and limit results', async t => {
  const { project } = await fixture(t);
  await writeMentionFile(project, 'src/deep/中文 file.ts');
  await writeMentionFile(project, '.hidden');
  for (const folder of ['.git', 'node_modules', 'dist', 'build', 'out', '.next', 'target', '.venv', '__pycache__']) await writeMentionFile(project, `${folder}/excluded.txt`);
  await Promise.all(Array.from({ length: 60 }, (_, index) => writeMentionFile(project, `file-${String(index).padStart(2, '0')}.txt`)));
  const empty = await findFiles(project, '');
  assert.equal(empty.length, 50);
  assert.deepEqual(empty.map(file => file.path), [...empty.map(file => file.path)].sort((a, b) => a.localeCompare(b)));
  assert.deepEqual(await findFiles(project, 'excluded'), []);
  assert.deepEqual(await findFiles(project, 'SRC'), [{ path: 'src', kind: 'dir' }, { path: 'src/deep', kind: 'dir' }, { path: 'src/deep/中文 file.ts', kind: 'file' }]);
  assert.deepEqual(await findFiles(project, '中文 file'), [{ path: 'src/deep/中文 file.ts', kind: 'file' }]);
  assert.ok(empty.some(file => file.path === '.hidden'));
});

test('mentions use git tracked and untracked paths, honor ignores and keep paths relative to the project', async t => {
  const { project } = await fixture(t);
  const exec = require('node:util').promisify(require('node:child_process').execFile);
  const { gitEnvironment } = require('../electron/project-git.cjs');
  const git = (...args) => exec('git', args, { cwd: project.path, windowsHide: true, timeout: 5000, env: gitEnvironment() });
  await git('init');
  await writeMentionFile(project, 'src/tracked 中文.ts');
  await writeMentionFile(project, 'dist/tracked.ts');
  await git('add', '.');
  await fs.writeFile(path.join(project.path, '.gitignore'), 'ignored/\n*.log\ndist/\n');
  await writeMentionFile(project, 'src/untracked [1].ts');
  await writeMentionFile(project, 'ignored/private.ts');
  await writeMentionFile(project, 'src/debug.log');
  const files = await findFiles(project, '');
  assert.ok(files.some(file => file.path === 'src/tracked 中文.ts'));
  assert.ok(files.some(file => file.path === 'src/untracked [1].ts'));
  assert.ok(files.some(file => file.path === 'dist/tracked.ts'), 'tracked generated files are included by git');
  assert.ok(!files.some(file => /ignored|debug|\.git\//.test(file.path)));
  assert.ok(files.every(file => !file.path.includes('\\')));
  assert.deepEqual(await findFiles({ path: path.join(project.path, 'src') }, 'tracked 中文'), [{ path: 'tracked 中文.ts', kind: 'file' }]);
  assert.deepEqual(await findFiles(project, '[1]'), [{ path: 'src/untracked [1].ts', kind: 'file' }]);
});

test('mentions walk a project subfolder ignored by its containing git repository', async t => {
  const { project: repository } = await fixture(t);
  const project = { path: path.join(repository.path, '.test-output', 'project') };
  const exec = require('node:util').promisify(require('node:child_process').execFile);
  const { gitEnvironment } = require('../electron/project-git.cjs');
  const options = { cwd: repository.path, windowsHide: true, timeout: 5000, env: gitEnvironment() };
  await exec('git', ['init'], options);
  await fs.writeFile(path.join(repository.path, '.gitignore'), '.test-output/\n');
  await writeMentionFile(project, 'src/components/Button.tsx');
  await writeMentionFile(project, 'node_modules/excluded/Button.tsx');
  const { stdout } = await exec('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { ...options, cwd: project.path });
  assert.equal(stdout, '', 'git returns no files for the ignored project');
  assert.deepEqual(await findFiles(project, 'butt'), [{ path: 'src/components/Button.tsx', kind: 'file' }]);
  assert.deepEqual(await findFiles(project, 'src/components'), [{ path: 'src/components', kind: 'dir' }, { path: 'src/components/Button.tsx', kind: 'file' }]);
});

test('mentions fall back to walking when git fails to list files', async t => {
  const { project } = await fixture(t);
  const exec = require('node:util').promisify(require('node:child_process').execFile);
  const { gitEnvironment } = require('../electron/project-git.cjs');
  const options = { cwd: project.path, windowsHide: true, timeout: 5000, env: gitEnvironment() };
  await exec('git', ['init'], options);
  await writeMentionFile(project, 'src/components/Button.tsx');
  await fs.writeFile(path.join(project.path, '.git', 'index'), 'invalid git index');
  assert.equal((await exec('git', ['rev-parse', '--is-inside-work-tree'], options)).stdout.trim(), 'true');
  await assert.rejects(exec('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], options));
  assert.deepEqual(await findFiles(project, 'butt'), [{ path: 'src/components/Button.tsx', kind: 'file' }]);
});

test('mentions rank basename prefix, basename contains, path contains and subsequences by shorter path', async t => {
  const { project } = await fixture(t);
  const names = ['deep/read-long.ts', 'bread-long.ts', 'read-context/other.ts', 'r/e/a/d.txt', 'read.ts', 'bread.ts', '🌸/notes.ts'];
  await Promise.all(names.map(name => writeMentionFile(project, name)));
  assert.deepEqual((await findFiles(project, 'ReAd')).filter(file => file.kind === 'file').map(file => file.path), ['read.ts', 'deep/read-long.ts', 'bread.ts', 'bread-long.ts', 'read-context/other.ts', 'r/e/a/d.txt']);
  assert.deepEqual(await findFiles(project, 'nomatch'), []);
  assert.deepEqual(await findFiles(project, '🌸nt'), [{ path: '🌸/notes.ts', kind: 'file' }]);
  assert.deepEqual(await findFiles(project, 'r/e/a/'), [{ path: 'r/e/a/d.txt', kind: 'file' }]);
});

test('mentions share concurrent scans, cache for 20 seconds and invalidate a changed project root', async t => {
  const { project, directory } = await fixture(t);
  project.id = 'mentions-cache-test';
  await writeMentionFile(project, 'old.ts');
  let now = Date.now(), scans = 0;
  t.mock.method(Date, 'now', () => now);
  const read = fs.readdir.bind(fs);
  t.mock.method(fs, 'readdir', async (...args) => { scans++; return read(...args); });
  await Promise.all([findFiles(project, ''), findFiles(project, 'old')]);
  assert.equal(scans, 1);
  await writeMentionFile(project, 'new.ts');
  now += 19_999;
  assert.deepEqual(await findFiles(project, 'new'), []);
  assert.equal(scans, 1);
  now++;
  assert.deepEqual(await findFiles(project, 'new'), [{ path: 'new.ts', kind: 'file' }]);
  assert.equal(scans, 2);
  const other = path.join(directory, 'other'); await fs.mkdir(other);
  await fs.writeFile(path.join(other, 'other.ts'), '');
  assert.deepEqual(await findFiles({ ...project, path: other }, ''), [{ path: 'other.ts', kind: 'file' }]);
});

test('mentions stop plain-folder enumeration at 20,000 entries', async t => {
  const { project } = await fixture(t);
  const entries = Array.from({ length: 20_010 }, (_, index) => ({ name: `file-${String(index).padStart(5, '0')}.ts`, isDirectory: () => false, isFile: () => true }));
  t.mock.method(fs, 'readdir', async () => entries);
  assert.deepEqual(await findFiles(project, 'file-19999'), [{ path: 'file-19999.ts', kind: 'file' }]);
  assert.deepEqual(await findFiles(project, 'file-20000'), []);
});

test('mentions return no SSH entries and retry failed local scans', async t => {
  assert.deepEqual(await findFiles({ kind: 'ssh', path: '/remote/unavailable' }, ''), []);
  const { project } = await fixture(t);
  const missing = { path: path.join(project.path, 'missing') };
  await assert.rejects(findFiles(missing, ''), /ENOENT/);
  await writeMentionFile(missing, 'recovered.ts');
  assert.deepEqual(await findFiles(missing, ''), [{ path: 'recovered.ts', kind: 'file' }]);
  await assert.rejects(findFiles(project, null), /无效的文件搜索/);
});

test('explorer reads real directories lazily, keeps dotfiles, and sorts folders first', async t => {
  const { project } = await fixture(t);
  await fs.mkdir(path.join(project.path, 'src'));
  await fs.writeFile(path.join(project.path, 'src', 'nested.ts'), 'export const answer = 42;');
  await fs.writeFile(path.join(project.path, 'README.md'), '# project');
  await fs.writeFile(path.join(project.path, '.gitignore'), 'node_modules');
  const root = await listDirectory(project);
  assert.equal(root.entries[0].name, 'src');
  assert.equal(root.entries[0].kind, 'directory');
  assert.ok(root.entries.some(entry => entry.name === '.gitignore'));
  assert.ok(!root.entries.some(entry => entry.name === 'nested.ts'));
  const child = await listDirectory(project, 'src');
  assert.equal(child.entries[0].path, 'src/nested.ts');
});

test('large folders can be paged without dropping or duplicating entries', async t => {
  const { project } = await fixture(t);
  await Promise.all(Array.from({ length: 215 }, (_, index) => fs.writeFile(path.join(project.path, `file-${index}.txt`), '')));
  const first = await listDirectory(project);
  assert.equal(first.entries.length, 200);
  assert.equal(first.nextOffset, 200);
  const second = await listDirectory(project, '', first.nextOffset);
  assert.equal(second.entries.length, 15);
  assert.equal(second.nextOffset, null);
  assert.equal(new Set([...first.entries, ...second.entries].map(entry => entry.path)).size, 215);
});

test('text previews preserve Unicode, source markup, empty files, and UTF-16 BOM text', async t => {
  const { project } = await fixture(t);
  const content = '<script>notExecuted()</script>\n中文源文件';
  await fs.writeFile(path.join(project.path, '中文.tsx'), content);
  const result = await readProjectFile(project, '中文.tsx');
  assert.equal(result.kind, 'text');
  assert.equal(result.content, content);
  await fs.writeFile(path.join(project.path, 'empty.txt'), '');
  assert.equal((await readProjectFile(project, 'empty.txt')).content, '');
  await fs.writeFile(path.join(project.path, 'utf16.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('中文\r\n文本', 'utf16le')]));
  assert.equal((await readProjectFile(project, 'utf16.txt')).content, '中文\r\n文本');
});

test('binary files stay distinct while large text opens with bounded pages', async t => {
  const { project } = await fixture(t);
  await fs.writeFile(path.join(project.path, 'binary.bin'), Buffer.from([0, 10, 254, 0]));
  await fs.writeFile(path.join(project.path, 'large.txt'), Buffer.alloc(1024 * 1024 + 1, 65));
  assert.equal((await readProjectFile(project, 'binary.bin')).kind, 'unsupported');
  const large = await readProjectFile(project, 'large.txt');
  assert.equal(large.kind, 'text');
  assert.equal(large.content.length, TEXT_PAGE_BYTES);
  assert.equal(large.page.count, 5);
  const last = await readProjectFile(project, 'large.txt', large.page.count - 1);
  assert.equal(last.content, 'A');
  assert.equal(last.page.byteEnd, 1024 * 1024 + 1);
});

test('project file operations reject traversal, absolute paths, alternate streams and escaping links', async t => {
  const { project, directory } = await fixture(t);
  for (const value of ['../outside', 'src/../../outside', directory, 'C:\\Windows', '/etc', '\\\\server\\share', 'README.md:stream', 'bad\0name']) {
    await assert.rejects(listDirectory(project, value));
    await assert.rejects(readProjectFile(project, value));
  }
  const outside = path.join(directory, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'private.txt'), 'outside the project');
  await fs.symlink(outside, path.join(project.path, 'external'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(listDirectory(project, 'external'), /项目目录之外/);
  await assert.rejects(readProjectFile(project, 'external/private.txt'), /项目目录之外/);
});

test('refresh observes created and removed entries and handles vanished files', async t => {
  const { project } = await fixture(t);
  const file = path.join(project.path, 'new.txt');
  assert.equal((await listDirectory(project)).entries.length, 0);
  await fs.writeFile(file, 'new');
  assert.equal((await listDirectory(project)).entries[0].name, 'new.txt');
  await fs.unlink(file);
  assert.equal((await listDirectory(project)).entries.length, 0);
  await assert.rejects(readProjectFile(project, 'new.txt'), /ENOENT/);
});

test('PNG images above the text limit still get image previews', async t => {
  const { project } = await fixture(t);
  await fs.writeFile(path.join(project.path, '图片.PNG'), Buffer.alloc(2 * 1024 * 1024));
  const result = await readProjectFile(project, '图片.PNG');
  assert.equal(result.kind, 'image');
  assert.equal(result.mimeType, 'image/png');
  assert.equal(Object.hasOwn(result, 'content'), false);
});

test('HTML defaults to a page preview and offers source pages at any size', async t => {
  const { project } = await fixture(t);
  const html = '<!doctype html><h1>预览页面</h1><script>window.ready=true</script>';
  await fs.writeFile(path.join(project.path, 'index.html'), html);
  const small = await readProjectFile(project, 'index.html');
  assert.equal(small.kind, 'html');
  assert.equal(small.content, html);
  await fs.writeFile(path.join(project.path, 'large.html'), '<!doctype html>' + ' '.repeat(2 * 1024 * 1024));
  const large = await readProjectFile(project, 'large.html');
  assert.equal(large.kind, 'html');
  assert.equal(large.content.length, TEXT_PAGE_BYTES);
  assert.equal(large.page.count, 9);
});

test('UTF-8 and UTF-16 pages reconstruct all Unicode without gaps or split characters', async t => {
  const { project } = await fixture(t);
  const content = 'A'.repeat(TEXT_PAGE_BYTES - 1) + '中🙂\uFEFF文本\r\n'.repeat(45000);
  const variants = [
    ['utf8.txt', Buffer.from(content)],
    ['utf8-bom.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(content)])],
    ['utf16-le.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, 'utf16le')])],
    ['utf16-be.txt', Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(content, 'utf16le').swap16()])],
  ];
  for (const [name, data] of variants) {
    await fs.writeFile(path.join(project.path, name), data);
    const first = await readProjectFile(project, name);
    let text = '';
    let lastEnd = first.page.byteStart;
    for (let index = 0; index < first.page.count; index++) {
      const result = await readProjectFile(project, name, index);
      assert.equal(result.kind, 'text', name);
      assert.equal(result.page.byteStart, lastEnd, name);
      assert.ok(result.page.byteEnd - result.page.byteStart <= TEXT_PAGE_BYTES + 4);
      lastEnd = result.page.byteEnd;
      text += result.content;
    }
    assert.equal(text, content, name);
    assert.equal(lastEnd, data.length);
  }
});

test('page requests stay bounded after a file shrinks and reject invalid indices', async t => {
  const { project } = await fixture(t);
  await fs.writeFile(path.join(project.path, 'live.log'), 'latest');
  const result = await readProjectFile(project, 'live.log', 50000000);
  assert.equal(result.content, 'latest');
  assert.equal(result.page.index, 0);
  for (const index of [-1, Infinity, NaN, 1.5, '2']) await assert.rejects(readProjectFile(project, 'live.log', index));
});

test('images are identified by their bytes as well as their extension', async t => {
  const { project } = await fixture(t);
  const png = await fs.readFile(path.join(__dirname, '..', 'assets', 'icon.png'));
  await fs.writeFile(path.join(project.path, 'download-without-extension'), png);
  assert.equal((await readProjectFile(project, 'download-without-extension')).mimeType, 'image/png');
  await fs.writeFile(path.join(project.path, 'photo.jfif'), Buffer.from([0xff, 0xd8, 0xff]));
  assert.equal((await readProjectFile(project, 'photo.jfif')).kind, 'image');
  await fs.writeFile(path.join(project.path, 'icon.ico'), Buffer.from([0, 0, 1, 0, 1, 0]));
  assert.equal((await readProjectFile(project, 'icon.ico')).mimeType, 'image/x-icon');
});

test('media metadata does not read the whole file or impose a 32 MiB size gate', async t => {
  const { project } = await fixture(t);
  for (const [name, kind] of [['large.png', 'image'], ['large.mp4', 'video']]) {
    const handle = await fs.open(path.join(project.path, name), 'w');
    await handle.truncate(33 * 1024 * 1024);
    await handle.close();
    const result = await readProjectFile(project, name);
    assert.equal(result.kind, kind);
    assert.equal(result.size, 33 * 1024 * 1024);
    assert.equal(Object.hasOwn(result, 'content'), false);
  }
});
