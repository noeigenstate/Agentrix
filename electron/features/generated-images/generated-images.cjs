const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const path = require('node:path');
const { isGeneratedImage } = require('../../generated-image-path.cjs');
const { isImageFile, remoteImageBytes, REMOTE_IMAGE_BYTES } = require('../files/file-cards.cjs');
const { SSH_OUTSIDE, failure } = require('../files/preview-location.cjs');

const FOLDER = 'generated-images';
// A picture shown inline as its own bytes when this computer cannot shrink it (WebP), up to this size.
const RAW_PICTURE_BYTES = 2 * 1024 * 1024;
// What a file system refusal is called, never with the path it names.
const REFUSALS = { EACCES: '没有写入项目文件夹的权限。', EPERM: '没有写入项目文件夹的权限。', EROFS: '项目所在的磁盘是只读的。', ENOSPC: '磁盘空间不足。' };
const missing = error => { if (error.code === 'ENOENT') return null; throw error; };

// At most two picture jobs at a time on one SSH connection, and on this computer: a resumed conversation with many
// pictures must not fill the connection's pending requests or the remote worker's four threads, which the session's own
// input needs too. A job is a whole picture (its pages one after another) or one copy.
const lanes = new WeakMap(), LOCAL = {};
function queued(key, job) {
  if (!lanes.has(key)) lanes.set(key, { running: 0, waiting: [] });
  const lane = lanes.get(key);
  return new Promise((resolve, reject) => {
    const start = () => {
      lane.running++;
      Promise.resolve().then(job).then(resolve, reject).finally(() => { lane.running--; lane.waiting.shift()?.(); });
    };
    if (lane.running < 2) start(); else lane.waiting.push(start);
  });
}

const digest = bytes => `${bytes.length}:${createHash('sha256').update(bytes).digest('hex')}`;

// The project's copy of a picture Codex generated on this computer (at most what is read back over SSH), in its
// generated-images folder: the file of its name, or of a numbered form of it (name-2.png...), with the same size and
// SHA-256. With write, one is made under the first free name when none is there; nothing else is written, no file is
// replaced, and only a file this call created is removed when its write fails. Null when there is no copy and none was
// asked for. The SSH worker does the same on its computer (remote-worker.py generated_copy) through a descriptor of the
// folder; here the folder is checked before use (the residual race is in electron/features/generated-images/BOUNDARY.md).
async function projectCopy(root, source, write) {
  const info = isGeneratedImage(source) ? await fs.stat(source) : null;
  if (!info?.isFile()) throw new Error('只能复制 Codex 生成的图片。');
  if (info.size > REMOTE_IMAGE_BYTES) throw new Error('图片太大，不复制到项目。');
  const folder = path.join(root, FOLDER);
  if (write) await fs.mkdir(folder, { recursive: true });
  const found = await fs.lstat(folder).catch(missing);
  if (!found) return null;
  if (!found.isDirectory()) throw new Error('项目里的 generated-images 不是普通文件夹。');
  const bytes = await fs.readFile(source), wanted = digest(bytes), { name, ext } = path.parse(path.basename(source));
  for (let number = 1; number <= 1000; number++) {
    const file = number === 1 ? `${name}${ext}` : `${name}-${number}${ext}`, target = path.join(folder, file);
    const existing = await fs.lstat(target).catch(missing);
    if (existing) { if (existing.isFile() && digest(await fs.readFile(target)) === wanted) return `${FOLDER}/${file}`; continue; }
    if (!write) return null;
    const handle = await fs.open(target, 'wx').catch(error => { if (error.code === 'EEXIST') return null; throw error; });
    if (!handle) continue;
    try { await handle.writeFile(bytes); } catch (error) { await handle.close(); await fs.rm(target, { force: true }); throw error; }
    await handle.close();
    return `${FOLDER}/${file}`;
  }
  throw new Error('generated-images 里同名的文件太多。');
}

// A picture on an SSH project's computer, whole: one Codex generated there (only under its generated_images, which the
// worker checks), or an image file inside the project, read as a remote image card reads one, in its connection's lane.
function remoteImage(connection, file) {
  return queued(connection, async () => {
    await connection.ready;
    if (isGeneratedImage(file)) {
      const { size } = await connection.request('generated-image', { path: file, offset: 0, length: 0 });
      return remoteImageBytes(size, async (offset, length) => (await connection.request('generated-image', { path: file, offset, length })).data);
    }
    const value = /^file:\/\//i.test(file) ? decodeURIComponent(new URL(file).pathname) : file.replace(/\\/g, '/');
    const relative = path.posix.relative(connection.info.root, path.posix.resolve(connection.info.root, value));
    if (!relative || relative === '..' || relative.startsWith('../')) throw failure('SSH_OUTSIDE', SSH_OUTSIDE);
    if (!isImageFile(relative)) throw new Error('只能显示图片文件。');
    const stat = await connection.request('stat', { path: relative });
    if (!stat.file) throw new Error('找不到这张图片。');
    return remoteImageBytes(stat.size, (offset, length) => connection.request('read', { path: relative, offset, length }));
  });
}

// A WebP picture's own bytes for the browser to show, where this computer's image decoder returns nothing.
const rawPicture = (bytes, limit = Infinity) => bytes.length <= limit && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  ? `data:image/webp;base64,${bytes.toString('base64')}` : null;

// A picture a native Codex session generated, as its conversation shows it. mode: 'live' for one generated now (copied
// into the project), 'history' for one of a resumed conversation's newest pictures (read back, its copy only looked
// for) and 'later' for an older one (its copy looked for; read back only when the reader asks, from the conversation).
// render gives at once what is known: a local picture's small copy, or that an SSH one is being read back or waits for
// a click, and that a new picture is being copied. settle gives the rest: the SSH picture (or why it cannot be shown)
// and the project's copy (its path, or why it could not be made). Copies go to the project's registered folder.
function createGeneratedImages({ findProject, remoteFor, preview, shrinkBytes, translate }) {
  const copying = mode => mode === 'live' ? { copyNote: translate('正在复制到项目…') } : {};
  const later = () => ({ note: translate('点击加载图片'), deferred: true });
  const refusal = error => REFUSALS[error.code] ? translate(REFUSALS[error.code]) : error.syscall ? translate('复制到项目失败（{code}）。', { code: error.code }) : translate(error.message);
  return {
    render(item, spec, mode) {
      if (spec.kind !== 'ssh') return { images: preview(item, spec)?.images || [], copy: copying(mode) };
      return mode === 'later' ? { ...later(), copy: {} } : { note: translate('正在取回图片…'), copy: copying(mode) };
    },
    async settle(item, spec, mode) {
      const project = findProject(spec.terminalId), write = mode === 'live';
      const copied = copy => copy ? { copied: copy } : {};
      const unmade = error => write ? { copyNote: translate('未能复制到项目：{reason}', { reason: refusal(error) }) } : {};
      if (project.kind !== 'ssh') return { copy: await queued(LOCAL, () => projectCopy(project.path, item.savedPath, write)).then(copied, unmade) };
      const unread = error => ({ note: translate('图片未能从远程读回：{reason}', { reason: translate(error.message) }) });
      let connection;
      try { connection = remoteFor(spec.terminalId); } catch (error) { return { ...unread(error), copy: unmade(error) }; }
      const [shown, copy] = await Promise.all([
        mode === 'later' ? later() : remoteImage(connection, item.savedPath).then(bytes => {
          const picture = shrinkBytes(bytes) || rawPicture(bytes, RAW_PICTURE_BYTES);
          return picture ? { images: [picture] } : { note: translate('无法读取这张图片。') };
        }, unread),
        queued(connection, () => connection.request('generated-copy', { path: item.savedPath, write })).then(found => copied(found.path), unmade),
      ]);
      return { ...shown, copy };
    },
  };
}

module.exports = { createGeneratedImages, projectCopy, remoteImage, rawPicture };
