const fs = require('node:fs/promises');
const path = require('node:path');
const { VIDEO_TYPES } = require('../../project-files.cjs');
const { inside, previewLocation, localPath, projectFile, networkPath, checked, failure, OUTSIDE, SSH_OUTSIDE } = require('./preview-location.cjs');
const { cardKind, isImageFile } = require('./file-kind.cjs');
const { PictureThumbnails, dataImage, FILE_LIMIT: IMAGE_BYTES } = require('./picture-thumbnail.cjs');
const pictureValues = require('./picture-values.json');

// What the reading view shows of a document, page, video or image an agent wrote or named: the start of a Markdown
// file, a picture of an HTML page, a video to play, a small copy of the image. Cards are asked for only once they
// scroll into view.
// A remote image travels over the SSH connection in pieces the size the remote worker reads at once.
const EXCERPT = 8 * 1024, REMOTE_IMAGE_BYTES = 16 * 1024 * 1024, REMOTE_CHUNK = 256 * 1024, DOCUMENT_BYTES = 2 * 1024 * 1024;
// Text read from the start of a file, without the half of a character its last bytes may cut.
const utf8 = buffer => buffer.toString('utf8').replace(/�+$/, '');

async function readExcerpt(file, size, limit) {
  const handle = await fs.open(file, 'r');
  try {
    const length = Math.min(limit, size);
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(length), 0, length, 0);
    return utf8(buffer.subarray(0, bytesRead));
  } finally { await handle.close(); }
}

// A Markdown file outside the project: the agents keep their memory and notes elsewhere (~/.claude/projects/…/memory,
// a temporary folder). It is only shown, never served, so it is read wherever it is on the computer the project is on,
// as a picture is: only Markdown, by its absolute path, at most limit bytes of it.
async function outsideDocument(previews, project, file, limit) {
  if (cardKind(file) !== 'markdown') throw new Error('只能预览 Markdown 文件。');
  if (project.kind === 'ssh') {
    if (!path.posix.isAbsolute(file)) throw new Error('只能预览 Markdown 文件。');
    const connection = previews.remote(project); await connection.ready;
    const found = await connection.request('document', { path: file, length: limit });
    return { text: utf8(Buffer.from(found.data, 'base64')), size: found.size };
  }
  if (!path.isAbsolute(file)) throw new Error('只能预览 Markdown 文件。');
  localPath(file);
  const stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile()) throw new Error('找不到这个文件。');
  return { text: await readExcerpt(file, stat.size, limit), size: stat.size };
}

// The whole of such a document for its popup (the first 2 MB of a larger one).
async function documentText(previews, project, file) {
  const found = await outsideDocument(previews, project, checked(file), DOCUMENT_BYTES);
  return { content: found.text, truncated: found.size > DOCUMENT_BYTES };
}

// capture(url) renders a page off screen and returns a small JPEG data URL; pages are captured one at a time and the
// pictures are kept for the latest 60 versions of files. shrink(file) and shrinkBytes(buffer) make a small data URL of
// an image (or null).
function createFileCards({ previews, capture, shrink = () => null, shrinkBytes = () => null }) {
  const pictures = new Map();
  const localPictures = new PictureThumbnails(shrink);
  let queue = Promise.resolve();
  const picture = (key, project, relative) => {
    if (pictures.has(key)) return pictures.get(key);
    // Allocate the short-lived URL only when capturing, so queued cards cannot expire it.
    const job = queue.then(async () => {
      const { url, previewId } = previews.open(project, relative, 'html');
      try { return await capture(url, previews); } finally { previews.close(previewId); }
    }).catch(() => null).then(value => { if (!value && pictures.get(key) === job) pictures.delete(key); return value; });
    queue = job;
    pictures.set(key, job);
    if (pictures.size > 60) pictures.delete(pictures.keys().next().value);
    return job;
  };
  // A small copy of an image, made once per version of the file.
  const thumbnail = async (key, make) => {
    if (!pictures.has(key)) { pictures.set(key, Promise.resolve().then(make).catch(() => null)); if (pictures.size > 60) pictures.delete(pictures.keys().next().value); }
    const value = await pictures.get(key);
    if (!value) { pictures.delete(key); throw new Error('无法读取这张图片。'); }
    return value;
  };
  // A project on another computer: the agent names files on that computer, which are read over the connection.
  async function remoteCard(project, file, kind, cwd) {
    const connection = previews.remote(project); await connection.ready;
    const root = connection.info.root, value = /^file:\/\//i.test(file) ? decodeURIComponent(new URL(file).pathname) : checked(file);
    // A relative path starts where the agent works there.
    const absolute = path.posix.resolve(typeof cwd === 'string' && cwd.startsWith('/') ? cwd : root, value.replace(/\\/g, '/'));
    const relative = path.posix.relative(root, absolute);
    if (!relative || relative === '..' || relative.startsWith('../')) {
      if (kind === 'html' || kind === 'video') throw failure('SSH_OUTSIDE', SSH_OUTSIDE);
      if (kind !== 'markdown' || !relative) throw failure('OUTSIDE', OUTSIDE);
      return { kind, path: absolute, outside: true, excerpt: (await outsideDocument(previews, project, absolute, EXCERPT)).text };
    }
    const stat = await connection.request('stat', { path: relative }).catch(error => {
      if (kind === 'html' || kind === 'video') throw error;
      return null;
    });
    if (!stat?.file) throw new Error(kind === 'image' ? '找不到这张图片。' : '这个文件没有预览卡片。');
    const read = async (length, offset = 0) => Buffer.from(await connection.request('read', { path: relative, offset, length }), 'base64');
    if (kind === 'markdown') return { kind, path: relative, excerpt: utf8(await read(Math.min(EXCERPT, stat.size))) };
    if (kind === 'video') return { kind, path: relative, url: previews.open(project, relative, 'video', VIDEO_TYPES[path.extname(relative).toLowerCase()]).url };
    const key = `${project.id}|${relative}|${stat.modifiedAt}|${stat.size}`;
    if (kind === 'html') return { kind, path: relative, picture: await picture(key, project, relative) };
    if (stat.size > REMOTE_IMAGE_BYTES) throw new Error('图片太大，无法预览。');
    return { kind, path: relative, remote: true, picture: await thumbnail(`image|${key}`, async () => {
      const parts = [];
      for (let offset = 0; offset < stat.size; offset += REMOTE_CHUNK) parts.push(await read(Math.min(REMOTE_CHUNK, stat.size - offset), offset));
      return shrinkBytes(Buffer.concat(parts));
    }) };
  }
  return async function card(project, file, cwd) {
    const kind = cardKind(file);
    if (!kind) throw new Error('这个文件没有预览卡片。');
    if (project.kind === 'ssh') return remoteCard(project, file, kind, cwd);
    // An image is only shown here, never served by the preview, so one the agent saved anywhere on this computer (its
    // own output folder, the desktop) is shown as well.
    if (kind === 'image') {
      const { base, absolute } = projectFile(project, checked(file), cwd || project.path);
      const stat = await fs.stat(absolute).catch(() => null);
      if (!stat?.isFile()) throw new Error('找不到这张图片。');
      if (stat.size > IMAGE_BYTES) throw new Error('图片太大，无法预览。');
      const picture = localPictures.file(absolute, { projectRoot: base });
      if (!dataImage(picture)) throw new Error(picture === pictureValues.omitted ? '图片太大，无法预览。' : '无法读取这张图片。');
      return { kind, path: networkPath(absolute) ? path.relative(base, absolute).split(path.sep).join('/') : absolute, picture };
    }
    const where = kind === 'markdown'
      ? await inside(project, file, cwd).catch(error => { if (['OUTSIDE', 'OUTSIDE_LINK'].includes(error.code)) return null; throw error; })
      : await previewLocation(project, file, cwd, previews.getProjects?.() || []);
    if (!where) {
      const { absolute } = projectFile(project, file, cwd || project.path);
      return { kind, path: absolute, outside: true, excerpt: (await outsideDocument(previews, project, absolute, EXCERPT)).text };
    }
    const { absolute, relative } = where;
    const previewProject = where.project || project, openingPath = where.outside ? absolute : relative;
    const stat = await fs.stat(absolute);
    if (!stat.isFile()) throw new Error('这个文件没有预览卡片。');
    if (kind === 'markdown') return { kind, path: relative, excerpt: await readExcerpt(absolute, stat.size, EXCERPT) };
    if (kind === 'video') return { kind, path: openingPath, url: previews.open(previewProject, relative, 'video', VIDEO_TYPES[path.extname(file).toLowerCase()]).url };
    return { kind, path: openingPath, picture: await picture(`${project.id}|${project.path}|${absolute}|${stat.mtimeMs}|${stat.ctimeMs}|${stat.size}`, previewProject, relative) };
  };
}

module.exports = { createFileCards, cardKind, inside, isImageFile, documentText };
