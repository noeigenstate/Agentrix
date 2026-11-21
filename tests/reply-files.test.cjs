const { test } = require('node:test');
const assert = require('node:assert/strict');
const { replyFiles } = require('../src/features/reading/reply-files.ts');

test('a reply naming a local image shows it: backticks, Markdown images and links, bare paths', () => {
  assert.deepEqual(replyFiles('我用 Codex 生成了这张照片，已经保存到 `C:\\Users\\fixture\\Desktop\\生图\\img\\dog_on_lawn.png`（1536×1024，约 2.6 MB）。'),
    ['C:\\Users\\fixture\\Desktop\\生图\\img\\dog_on_lawn.png']);
  assert.deepEqual(replyFiles('保存到C:\\Users\\fixture\\生图\\dog.png（1536×1024）。'), ['C:\\Users\\fixture\\生图\\dog.png']);
  assert.deepEqual(replyFiles('![dog](C:/out/my%20dog.png) and ![x](<C:/a b/c.jpg>)'), ['C:/out/my dog.png', 'C:/a b/c.jpg']);
  assert.deepEqual(replyFiles('relative ./img/a.png, img/b.jpeg and c.gif.'), ['./img/a.png', 'img/b.jpeg', 'c.gif']);
  assert.deepEqual(replyFiles('/home/me/pics/cat.webp'), ['/home/me/pics/cat.webp']);
  assert.deepEqual(replyFiles('file:///C:/x/y.webp'), ['C:/x/y.webp']);
  // The same file named twice, in backticks and then bare, is one picture.
  assert.deepEqual(replyFiles('`C:\\out\\a.png` — C:/out/a.png'), ['C:\\out\\a.png']);
});

test('web addresses, other files and pictures Codex generated itself are left alone', () => {
  assert.deepEqual(replyFiles('see https://example.com/a.png and ![x](https://example.com/b.jpg)'), []);
  assert.deepEqual(replyFiles('report.pngx, a.png.bak and notes.md'), []);
  // Documents and code are named all the time: no card for them.
  assert.deepEqual(replyFiles('I edited `README.md` and src/app.ts'), []);
  assert.deepEqual(replyFiles('saved C:\\Users\\u\\.codex\\generated_images\\t\\a.png'), []);
  assert.deepEqual(replyFiles('no pictures here at all'), []);
});

test('pictures come in the order the reply names them', () => {
  assert.deepEqual(replyFiles('first `C:\\out\\dog.png`, then ![cat](C:/out/cat.jpg) and C:\\out\\bird.webp'), ['C:\\out\\dog.png', 'C:/out/cat.jpg', 'C:\\out\\bird.webp']);
});

test('pages and videos a reply names are shown too', () => {
  assert.deepEqual(replyFiles('页面写好了：`site/index.html`，演示视频在 C:\\out\\demo.mp4。'), ['site/index.html', 'C:\\out\\demo.mp4']);
});
