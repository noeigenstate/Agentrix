const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fileClipboard } = require('./file-clipboard.cjs');
const { ClipboardWrites } = require('./clipboard-writes.cjs');

function inside(root, filename) { const relative = path.relative(root, filename); return !relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); }
function cleanRelative(value, root = false) {
  if (typeof value !== 'string' || value.length > 4096 || /[\0-\x1f:]/.test(value) || path.win32.isAbsolute(value) || value.startsWith('/') || value.split(/[\\/]/).includes('..') || (!root && (!value || value === '.'))) throw new Error('无效的项目文件路径。');
  return value.replace(/\\/g, '/');
}
function cleanName(name) {
  if (typeof name !== 'string' || !name || name.length > 255 || /[\x00-\x1f<>:"/\\|?*]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw new Error('文件名不能包含路径分隔符或系统保留字符。');
  return name;
}
function selections(paths) {
  if (!Array.isArray(paths) || !paths.length || paths.length > 2000) throw new Error('请选择要操作的文件。');
  const values = [...new Set(paths.map(value => cleanRelative(value, true)))];
  return values.filter(value => !values.some(parent => parent !== value && (!parent || value.startsWith(parent.replace(/\/$/, '') + '/'))));
}
async function entryPath(project, relative, allowRoot = false) {
  const normalized = cleanRelative(relative, allowRoot);
  const root = await fs.realpath(project.path);
  if (!normalized || normalized === '.') return root;
  const candidate = path.resolve(root, normalized);
  const parent = await fs.realpath(path.dirname(candidate));
  if (!inside(root, parent)) throw new Error('该文件位于项目目录之外。');
  return path.join(parent, path.basename(candidate));
}
async function directoryPath(project, relative = '') {
  const value = await fs.realpath(await entryPath(project, relative, true));
  if (!inside(await fs.realpath(project.path), value) || !(await fs.stat(value)).isDirectory()) throw new Error('请选择项目内的文件夹。');
  return value;
}
async function unusedName(directory, name) {
  const extension = path.extname(name); const stem = name.slice(0, name.length - extension.length);
  for (let index = 0; index < 10000; index++) {
    const candidate = index ? `${stem} - 副本${index > 1 ? ` (${index})` : ''}${extension}` : name;
    try { await fs.lstat(path.join(directory, candidate)); } catch (error) { if (error.code === 'ENOENT') return candidate; throw error; }
  }
  throw new Error('同名文件过多，请先重命名。');
}

class FileOperations {
  constructor({ integrationDir, cacheRoot, remote, trash, confirmDelete, progress = () => {}, clipboard, clipboardWrites = new ClipboardWrites() }) {
    Object.assign(this, { integrationDir, cacheRoot, remote, trash, confirmDelete, progress, clipboardWrites });
    this.clipboard = clipboard || ((action, paths) => fileClipboard(integrationDir, action, paths));
    this.move = (source, target) => process.platform === 'win32' ? fileClipboard(integrationDir, 'move', [source, target]) : fs.rename(source, target);
  }
  async run(project, operation, callback) {
    if (this.busy) throw new Error('正在处理文件，请稍后再试。');
    const controller = new AbortController(); this.busy = { projectId: project.id, controller };
    const update = text => this.progress({ projectId: project.id, text });
    const check = () => { if (controller.signal.aborted) throw new Error('已取消文件操作。'); };
    update(operation);
    try { return await callback(update, check); }
    finally { this.busy = null; this.progress(null); }
  }
  cancel() { this.busy?.controller.abort(); }
  async create(project, directory, name, kind) {
    cleanRelative(directory, true); cleanName(name);
    if (!['file', 'directory'].includes(kind)) throw new Error('无效的文件类型。');
    if (project.kind === 'ssh') return this.remote(project.id).request('create', { path: directory, name, kind });
    const parent = await directoryPath(project, directory);
    const filename = path.join(parent, name);
    if (kind === 'directory') await fs.mkdir(filename);
    else await fs.writeFile(filename, '', { flag: 'wx' });
    return { path: path.posix.join(directory, name), kind };
  }
  async rename(project, relative, name) {
    cleanRelative(relative); cleanName(name);
    if (project.kind === 'ssh') return this.remote(project.id).request('rename', { path: relative, name });
    const source = await entryPath(project, relative);
    const target = path.join(path.dirname(source), name);
    if (source === target) return { path: relative };
    try { const existing = await fs.lstat(target), original = await fs.lstat(source); if (process.platform !== 'win32' || source.toLowerCase() !== target.toLowerCase() || existing.ino !== original.ino || existing.dev !== original.dev) throw new Error('已存在同名文件。'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await this.move(source, target);
    return { path: path.posix.join(path.posix.dirname(relative), name) };
  }
  async remove(project, paths) {
    const chosen = selections(paths); chosen.forEach(value => cleanRelative(value));
    if (!await this.confirmDelete(project, chosen)) return { deleted: [] };
    return this.run(project, '正在删除文件…', async (update, check) => {
      const deleted = [];
      for (const relative of chosen) {
        check(); update(`正在删除：${path.posix.basename(relative)}`);
        if (project.kind === 'ssh') await this.remote(project.id).request('remove', { path: relative });
        else await this.trash(await entryPath(project, relative));
        deleted.push(relative);
      }
      return { deleted };
    });
  }
  async copy(project, paths) {
    const chosen = selections(paths);
    return this.run(project, '正在复制文件…', async (update, check) => {
      const revision = this.clipboardWrites.reserve();
      const files = [];
      let destination;
      try {
        if (project.kind !== 'ssh') {
          for (const relative of chosen) files.push(await entryPath(project, relative, true));
        } else {
          await fs.mkdir(this.cacheRoot, { recursive: true });
          destination = await fs.mkdtemp(path.join(this.cacheRoot, 'clipboard-'));
          const connection = this.remote(project.id); await connection.ready;
          for (const relative of chosen) {
            check();
            // Each selection keeps its basename for paste, even when another selection has the same name.
            const staging = path.join(destination, String(files.length));
            await fs.mkdir(staging);
            const filename = path.join(staging, cleanName(path.posix.basename(relative || connection.info.root)));
            await this.download(connection, relative, filename, update, check);
            files.push(filename);
          }
        }
        if (!await this.clipboardWrites.commit(revision, () => { check(); return this.clipboard('copy', files); })) return { count: 0, superseded: true };
        // Committed FileDrop paths must remain available to the eventual paste.
        destination = null;
        return { count: files.length };
      } finally {
        if (destination && path.dirname(path.resolve(destination)) === path.resolve(this.cacheRoot)) await fs.rm(destination, { recursive: true, force: true });
      }
    });
  }
  async download(connection, relative, destination, update, check) {
    check();
    const meta = await connection.request('stat', { path: relative });
    if (!Number.isSafeInteger(meta.size) || meta.size < 0) throw new Error('远程文件信息无效。');
    if (meta.link) throw new Error('请复制链接指向的实际文件。');
    if (meta.directory) {
      await fs.mkdir(destination);
      let offset = 0;
      do {
        const listing = await connection.request('directory', { path: relative, offset });
        for (const entry of listing.entries) {
          cleanName(entry.name);
          if (entry.kind === 'link') throw new Error('文件夹内含有符号链接，请单独复制实际文件。');
          await this.download(connection, entry.path, path.join(destination, entry.name), update, check);
        }
        // Pages must move forward; a repeated or malformed offset would download the same files forever.
        if (listing.nextOffset !== null && !(Number.isInteger(listing.nextOffset) && listing.nextOffset > offset)) throw new Error('远程目录列表异常，已停止下载。');
        offset = listing.nextOffset;
      } while (offset !== null);
      return;
    }
    if (!meta.file) throw new Error('只能复制普通文件或文件夹。');
    update(`正在下载：${path.posix.basename(relative)}`);
    const file = await fs.open(destination, 'wx');
    try {
      for (let offset = 0; offset < meta.size;) {
        check();
        const length = Math.min(256 * 1024, meta.size - offset);
        const bytes = Buffer.from(await connection.request('read', { path: relative, offset, length }), 'base64');
        if (!bytes.length || bytes.length > length) throw new Error('远程文件已变化，请重试。');
        await file.writeFile(bytes); offset += bytes.length;
      }
    } finally { await file.close(); }
  }
  async paste(project, directory) {
    cleanRelative(directory, true);
    const sources = await this.clipboard('read');
    if (!Array.isArray(sources) || !sources.length || sources.length > 2000) throw new Error('剪贴板中没有可粘贴的文件。');
    return this.run(project, '正在粘贴文件…', async (update, check) => {
      const pasted = [];
      for (const source of sources) {
        check(); if (typeof source !== 'string' || !path.isAbsolute(source)) throw new Error('无效的剪贴板文件。');
        const name = cleanName(path.basename(source)); update(`正在粘贴：${name}`);
        if (project.kind === 'ssh') {
          pasted.push(await this.upload(this.remote(project.id), source, directory, name, update, check));
          continue;
        }
        const parent = await directoryPath(project, directory);
        const info = await fs.lstat(source);
        if (info.isDirectory() && inside(await fs.realpath(source), parent)) throw new Error('不能把文件夹复制到它自身内部。');
        const targetName = await unusedName(parent, name);
        const staging = path.join(parent, `.agentrix-copy-${randomUUID()}`);
        try {
          await fs.cp(source, staging, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true, filter: () => { check(); return true; } });
          check();
          const target = path.join(parent, targetName);
          try { await fs.lstat(target); throw new Error('目标文件已存在，请重试。'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          await this.move(staging, target);
          pasted.push(path.posix.join(directory, targetName));
        } finally { if (path.dirname(path.resolve(staging)) === parent) await fs.rm(staging, { recursive: true, force: true }); }
      }
      return { pasted };
    });
  }
  async upload(connection, source, directory, name, update, check) {
    check(); const info = await fs.lstat(source);
    if (info.isSymbolicLink()) throw new Error('远程粘贴暂不支持符号链接，请选择实际文件。');
    if (info.isDirectory()) {
      const result = await connection.request('create', { path: directory, name, kind: 'directory', unique: true });
      for (const entry of await fs.readdir(source)) await this.upload(connection, path.join(source, entry), result.path, cleanName(entry), update, check);
      return result.path;
    }
    if (!info.isFile()) throw new Error('只能粘贴普通文件或文件夹。');
    update(`正在上传：${name}`);
    const transfer = await connection.request('upload-start', { path: directory, name, size: info.size });
    const handle = await fs.open(source, 'r');
    try {
      const buffer = Buffer.alloc(256 * 1024);
      for (let offset = 0; offset < info.size;) {
        check(); const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, info.size - offset), offset);
        if (!bytesRead) throw new Error('源文件已变化，请重试。');
        await connection.request('upload-chunk', { transfer: transfer.id, offset, data: buffer.subarray(0, bytesRead).toString('base64') });
        offset += bytesRead;
      }
      check(); return (await connection.request('upload-finish', { transfer: transfer.id })).path;
    } catch (error) { await connection.request('upload-cancel', { transfer: transfer.id }).catch(() => {}); throw error; }
    finally { await handle.close(); }
  }
}
module.exports = { FileOperations, cleanName, selections, directoryPath };
