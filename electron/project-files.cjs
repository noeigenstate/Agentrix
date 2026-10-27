const fs = require('node:fs/promises');
const path = require('node:path');
const { TextDecoder, promisify } = require('node:util');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { gitEnvironment } = require('./project-git.cjs');

const exec = promisify(execFile);
const fileLists = new Map();
const FILE_CACHE_MS = 20_000;
const WALK_LIMIT = 20_000;
const skippedFolders = new Set(['.git', 'node_modules', 'dist', 'build', 'out', '.next', 'target', '.venv', '__pycache__']);

async function projectFileList(root) {
  const options = { cwd: root, windowsHide: true, timeout: 5000, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env: gitEnvironment() };
  let files = [];
  try {
    if ((await exec('git', ['rev-parse', '--is-inside-work-tree'], options)).stdout.trim() === 'true') {
      files = (await exec('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], options)).stdout.split('\0').filter(Boolean);
    }
  } catch {
    // Git may be unavailable or fail for this folder; the directory walk can still find its files.
  }
  // A project inside an ignored repository subfolder also has an empty Git file list.
  if (!files.length) {
    let visited = 0;
    const walk = async relative => {
      const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (visited >= WALK_LIMIT) return;
        visited++;
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) { if (!skippedFolders.has(entry.name)) await walk(name); }
        else if (entry.isFile() || entry.isSymbolicLink()) files.push(name);
      }
    };
    await walk('');
  }
  const entries = new Map();
  for (const file of files) {
    entries.set(file, { path: file, kind: 'file' });
    for (let index = file.indexOf('/'); index >= 0; index = file.indexOf('/', index + 1)) {
      const directory = file.slice(0, index);
      entries.set(directory, { path: directory, kind: 'dir' });
    }
  }
  return [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
}

async function findFiles(project, query = '') {
  if (project.kind === 'ssh') return [];
  if (typeof query !== 'string') throw new Error('无效的文件搜索。');
  const root = path.resolve(project.path), key = project.id || root;
  let cached = fileLists.get(key);
  if (!cached || cached.root !== root || cached.expires <= Date.now()) {
    cached = { root, expires: Infinity, list: projectFileList(root) };
    fileLists.set(key, cached);
    const pending = cached;
    pending.list.then(() => { pending.expires = Date.now() + FILE_CACHE_MS; }, () => { if (fileLists.get(key) === pending) fileLists.delete(key); });
  }
  const entries = await cached.list;
  const needle = query.toLowerCase();
  if (!needle) return entries.slice(0, 50);
  const ranked = [];
  for (const entry of entries) {
    const name = entry.path.toLowerCase(), basename = name.slice(name.lastIndexOf('/') + 1);
    let at = 0;
    for (let index = 0; index < name.length && at < needle.length; index++) { if (name[index] === needle[at]) at++; }
    if (at !== needle.length) continue;
    const rank = basename.startsWith(needle) ? 0 : basename.includes(needle) ? 1 : name.includes(needle) ? 2 : 3;
    ranked.push({ entry, rank });
  }
  return ranked.sort((a, b) => a.rank - b.rank || a.entry.path.length - b.entry.path.length || a.entry.path.localeCompare(b.entry.path)).slice(0, 50).map(item => item.entry);
}

const PAGE_SIZE = 200;
const TEXT_PAGE_BYTES = 256 * 1024;
const IMAGE_TYPES = { '.png': 'image/png', '.apng': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.jpe': 'image/jpeg', '.jfif': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const VIDEO_TYPES = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.ogv': 'video/ogg', '.ogg': 'video/ogg', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo' };
const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
const fileRevision = stat => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;

function imageTypeFromBytes(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (/^GIF8[79]a/.test(bytes.toString('ascii', 0, 6))) return 'image/gif';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.toString('ascii', 0, 2) === 'BM') return 'image/bmp';
  if (bytes.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0]))) return 'image/x-icon';
  if (bytes.toString('ascii', 4, 8) === 'ftyp' && /avif|avis/.test(bytes.toString('ascii', 8))) return 'image/avif';
  return null;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function resolveProjectPath(project, relativePath = '') {
  if (typeof relativePath !== 'string' || relativePath.length > 4096 || /[\0:]/.test(relativePath) || path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes('..')) {
    throw new Error('无效的项目文件路径。');
  }
  const root = await fs.realpath(project.path);
  const candidate = await fs.realpath(path.resolve(root, relativePath));
  if (!isWithin(root, candidate)) throw new Error('该链接指向项目目录之外，无法在此打开。');
  return candidate;
}

async function listDirectory(project, relativePath = '', offset = 0) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('无效的目录页码。');
  const resolved = await resolveProjectPath(project, relativePath);
  const files = await fs.readdir(resolved, { withFileTypes: true });
  files.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || collator.compare(a.name, b.name));
  const entries = files.slice(offset, offset + PAGE_SIZE).map(entry => ({
    name: entry.name,
    path: path.join(relativePath, entry.name).split(path.sep).join('/'),
    kind: entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'link' : 'file',
  }));
  return { path: relativePath, entries, total: files.length, nextOffset: offset + entries.length < files.length ? offset + entries.length : null };
}

async function readProjectFile(project, relativePath, pageIndex = 0) {
  if (!relativePath) throw new Error('请选择一个文件。');
  if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) throw new Error('无效的文件页码。');
  const resolved = await resolveProjectPath(project, relativePath);
  const handle = await fs.open(resolved, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('只能预览普通文件。');
    const base = { path: relativePath, name: path.basename(relativePath), size: stat.size, modifiedAt: stat.mtimeMs, revision: fileRevision(stat) };
    const extension = path.extname(relativePath).toLowerCase();
    const isHtml = extension === '.html' || extension === '.htm';
    const isMarkdown = ['.md', '.markdown', '.mdown', '.mkd'].includes(extension);
    const signature = Buffer.alloc(Math.min(stat.size, 64));
    await handle.read(signature, 0, signature.length, 0);
    const imageType = imageTypeFromBytes(signature) || IMAGE_TYPES[extension];
    if (imageType) return { ...base, kind: 'image', mimeType: imageType };
    if (VIDEO_TYPES[extension]) return { ...base, kind: 'video', mimeType: VIDEO_TYPES[extension] };
    const prefix = signature.subarray(0, 3);
    let encoding = 'utf-8';
    let bom = 0;
    if (prefix[0] === 0xff && prefix[1] === 0xfe) { encoding = 'utf-16le'; bom = 2; }
    else if (prefix[0] === 0xfe && prefix[1] === 0xff) { encoding = 'utf-16be'; bom = 2; }
    else if (prefix.equals(Buffer.from([0xef, 0xbb, 0xbf]))) bom = 3;
    const count = Math.max(1, Math.ceil((stat.size - bom) / TEXT_PAGE_BYTES));
    const index = Math.min(pageIndex, count - 1);
    const start = bom + index * TEXT_PAGE_BYTES;
    const end = Math.min(stat.size, start + TEXT_PAGE_BYTES);
    const readStart = Math.max(bom, start - 2);
    // Reads stay bounded even for multi-gigabyte files or files growing live.
    const buffer = Buffer.alloc(Math.max(0, Math.min(stat.size, end + 4) - readStart));
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, readStart + bytesRead);
      if (!chunk.bytesRead) break;
      bytesRead += chunk.bytesRead;
    }
    // Both adjacent pages move the same boundary forward over a character or CRLF pair.
    const boundary = position => {
      let offset = Math.max(0, Math.min(bytesRead, position - readStart));
      if (encoding === 'utf-8') {
        while (offset < bytesRead && (buffer[offset] & 0xc0) === 0x80) offset++;
        if (offset > 0 && offset < bytesRead && buffer[offset - 1] === 13 && buffer[offset] === 10) offset++;
      } else if (offset >= 2 && offset + 1 < bytesRead) {
        const unit = i => encoding === 'utf-16le' ? buffer.readUInt16LE(i) : buffer.readUInt16BE(i);
        if (unit(offset) >= 0xdc00 && unit(offset) <= 0xdfff && unit(offset - 2) >= 0xd800 && unit(offset - 2) <= 0xdbff) offset += 2;
        else if (unit(offset - 2) === 13 && unit(offset) === 10) offset += 2;
      }
      return offset;
    };
    const byteStart = boundary(start);
    const byteEnd = boundary(end);
    const data = buffer.subarray(byteStart, byteEnd);
    if (encoding === 'utf-8' && data.includes(0)) return { ...base, kind: 'unsupported', reason: '二进制文件不支持文本预览。' };
    try {
      const content = new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(data);
      return { ...base, kind: isHtml ? 'html' : isMarkdown ? 'markdown' : 'text', content, page: { index, count, byteStart: readStart + byteStart, byteEnd: readStart + byteEnd, encoding } };
    } catch {
      return { ...base, kind: 'unsupported', reason: '暂不支持此文件的文本编码。' };
    }
  } finally { await handle.close(); }
}

async function saveProjectFile(project, relativePath, pageIndex, revision, content) {
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > 1024 * 1024) throw new Error('本次编辑内容超过 1 MB，请分段保存。');
  if (typeof revision !== 'string') throw new Error('请重新读取文件后编辑。');
  const preview = await readProjectFile(project, relativePath, pageIndex);
  if (!['text', 'html', 'markdown'].includes(preview.kind)) throw new Error('此文件不支持文本编辑。');
  if (preview.revision !== revision) throw new Error('文件已被其他程序修改，请刷新后重新编辑，避免覆盖新内容。');
  const resolved = await resolveProjectPath(project, relativePath);
  const temporary = path.join(path.dirname(resolved), `.agentrix-edit-${randomUUID()}.tmp`);
  let source = await fs.open(resolved, 'r+');
  let destination;
  try {
    const stat = await source.stat();
    if (fileRevision(stat) !== revision) throw new Error('文件已变化，请刷新后重新编辑。');
    // Textareas normalize line endings; retain the source file's convention.
    const normalized = preview.content.includes('\r\n') ? content.replace(/\r?\n/g, '\r\n') : content;
    const bytes = Buffer.from(normalized, preview.page.encoding === 'utf-8' ? 'utf8' : 'utf16le');
    if (preview.page.encoding === 'utf-16be') bytes.swap16();
    destination = await fs.open(temporary, 'wx', stat.mode);
    const copyRange = async (start, end) => {
      const buffer = Buffer.alloc(65536);
      for (let offset = start; offset < end;) {
        const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, end - offset), offset);
        if (!bytesRead) throw new Error('保存时文件发生变化，请刷新后重试。');
        await destination.writeFile(buffer.subarray(0, bytesRead)); offset += bytesRead;
      }
    };
    await copyRange(0, preview.page.byteStart);
    await destination.writeFile(bytes);
    await copyRange(preview.page.byteEnd, stat.size);
    await destination.chmod(stat.mode); await destination.sync(); await destination.close(); destination = null;
    await source.close(); source = null;
    // On Windows a scanner or indexer can hold the file for a moment and refuse the replacement (EPERM/EACCES/EBUSY).
    // Try again a few times within about 2.6 s, checking each time that nobody else has changed the file meanwhile.
    for (let attempt = 0; ; attempt++) {
      if (fileRevision(await fs.stat(resolved)) !== revision) throw new Error('文件已被其他程序修改，本次保存已取消。');
      try { await fs.rename(temporary, resolved); break; }
      catch (error) {
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 8) throw error;
        await new Promise(resolve => setTimeout(resolve, Math.min((attempt + 1) * 100, 400)));
      }
    }
  } finally {
    await source?.close(); await destination?.close();
    await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  return readProjectFile(project, relativePath, pageIndex);
}

module.exports = { findFiles, listDirectory, readProjectFile, saveProjectFile, resolveProjectPath, IMAGE_TYPES, VIDEO_TYPES, TEXT_PAGE_BYTES };
