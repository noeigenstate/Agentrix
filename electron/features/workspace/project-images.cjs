const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

const LIMITS = Object.freeze({ directories: 48, entries: 2400, depth: 4, projects: 8, readmes: 8, files: 120,
  readmeBytes: 256 * 1024, manifestBytes: 64 * 1024, imageBytes: 8 * 1024 * 1024, totalBytes: 24 * 1024 * 1024, thumbnails: 32, candidates: 6 });
const RASTER = /\.(?:png|jpe?g|webp|gif|ico)$/i;
const README = /^readme(?:[._-][\p{L}\p{M}\p{N}_.-]+)?\.md$/iu;
const ICON = /^(?:(?:app|product)[-_])?(?:icon|logo|favicon)(?:[-_.@][\w.-]+)?$/i;
const ASSETS = new Set(['assets', 'public', 'static', 'resources', 'docs', 'doc', 'images', 'img', 'screenshots', 'media', 'branding']);
const SKIP = new Set(['node_modules', 'vendor', 'dist', 'build', 'out', 'target', 'coverage', 'cache', 'tmp', 'temp', '__pycache__']);
const DATA_IMAGE = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const HTML_ENTITIES = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root, file) => { const relative = path.relative(root, file); return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`); };
const visibleDirectory = entry => entry.isDirectory() && !entry.name.startsWith('.') && !SKIP.has(entry.name.toLowerCase());

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const PIXEL_LIMIT = 40_000_000;
function pngSize(bytes) {
  return bytes.length >= 33 && bytes.subarray(0, 8).equals(PNG) && bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR'
    ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) } : null;
}

// Check compressed headers before native decoding can allocate pixels. The decoder still validates the actual
// picture; this gate only accepts known headers with bounded dimensions.
function rasterSize(bytes) {
  const png = pngSize(bytes);
  if (png) return png;
  if (bytes.length >= 13 && /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) {
    const table = bytes[10] & 128 ? 3 * (2 ** ((bytes[10] & 7) + 1)) : 0;
    return bytes.length >= 13 + table ? { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) } : null;
  }
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 0xd8) {
    const end = Math.min(bytes.length, 256 * 1024);
    for (let at = 2; at < end;) {
      if (bytes[at++] !== 255) return null;
      while (at < end && bytes[at] === 255) at++;
      const marker = bytes[at++];
      if (marker === 0xda || marker === 0xd9 || marker === 0 || at + 2 > end) return null;
      if (marker === 1 || marker >= 0xd0 && marker <= 0xd7) continue;
      const length = bytes.readUInt16BE(at);
      if (length < 2 || at + length > end) return null;
      if (JPEG_SOF.has(marker)) return length >= 11 && bytes[at + 7] >= 1 && length === 8 + 3 * bytes[at + 7]
        ? { width: bytes.readUInt16BE(at + 5), height: bytes.readUInt16BE(at + 3) } : null;
      at += length;
    }
    return null;
  }
  if (bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' && bytes.readUInt32LE(4) + 8 === bytes.length) {
    let canvas = null, frame = null, at = 12;
    for (let chunks = 0; at + 8 <= bytes.length && chunks < 256; chunks++) {
      const kind = bytes.toString('ascii', at, at + 4), length = bytes.readUInt32LE(at + 4), data = at + 8;
      if (data + length > bytes.length || kind === 'ANIM' || kind === 'ANMF') return null;
      if (kind === 'VP8X') {
        if (length !== 10 || bytes[data] & 2) return null;
        canvas = { width: 1 + bytes.readUIntLE(data + 4, 3), height: 1 + bytes.readUIntLE(data + 7, 3) };
      } else if (kind === 'VP8 ') {
        if (frame) return null;
        if (length < 10 || bytes[data] & 1 || bytes.toString('hex', data + 3, data + 6) !== '9d012a') return null;
        frame = { width: bytes.readUInt16LE(data + 6) & 0x3fff, height: bytes.readUInt16LE(data + 8) & 0x3fff };
      } else if (kind === 'VP8L') {
        if (frame) return null;
        if (length < 5 || bytes[data] !== 0x2f) return null;
        const bits = bytes.readUInt32LE(data + 1);
        if (bits >>> 29) return null;
        frame = { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
      }
      at = data + length + (length & 1);
    }
    return at === bytes.length && frame && (!canvas || canvas.width === frame.width && canvas.height === frame.height) ? frame : null;
  }
  if (bytes.length >= 22 && bytes.readUInt16LE(0) === 0 && bytes.readUInt16LE(2) === 1) {
    const count = bytes.readUInt16LE(4), size = { width: 0, height: 0 }; let pixels = 0;
    if (!count || count > 256 || bytes.length < 6 + count * 16) return null;
    for (let i = 0; i < count; i++) {
      const entry = 6 + i * 16, length = bytes.readUInt32LE(entry + 8), start = bytes.readUInt32LE(entry + 12);
      if (start < 6 + count * 16 || length < 12 || start + length > bytes.length) return null;
      const part = bytes.subarray(start, start + length); let frame = pngSize(part);
      if (!frame) {
        const header = part.readUInt32LE(0);
        if (header === 12) frame = { width: part.readUInt16LE(4), height: part.readUInt16LE(6) / 2 };
        else if (header >= 40 && header <= length) frame = { width: Math.abs(part.readInt32LE(4)), height: Math.abs(part.readInt32LE(8)) / 2 };
        else return null;
      }
      if (!Number.isSafeInteger(frame.height) || frame.width < 1 || frame.height < 1 || (pixels += frame.width * frame.height) > PIXEL_LIMIT) return null;
      size.width = Math.max(size.width, frame.width); size.height = Math.max(size.height, frame.height);
    }
    return size;
  }
  return null;
}

function projectImageDimensions(bytes, source) {
  if (!Buffer.isBuffer(bytes)) return null;
  const size = rasterSize(bytes);
  if (!size) return null;
  const side = Math.min(size.width, size.height);
  return side >= (source === 'icon' ? 16 : 48) && Math.max(size.width, size.height) <= side * 4 && size.width * size.height <= PIXEL_LIMIT ? size : null;
}

// Read destinations, not rendered Markdown: nothing is loaded from a URL or executed from a project.
function readmeImages(markdown) {
  const text = markdown.replace(/<!--[\s\S]*?-->|```[\s\S]*?```|~~~[\s\S]*?~~~/g, '');
  const references = new Map(), targets = [];
  const key = value => value.trim().replace(/\s+/g, ' ').toLowerCase();
  for (const match of text.matchAll(/^[ \t]{0,3}\[([^\]\r\n]+)\]:[ \t]*(?:<([^>\r\n]+)>|(\S+))/gm)) references.set(key(match[1]), match[2] || match[3]);
  for (const match of text.matchAll(/!\[([^\]\r\n]*)\]/g)) {
    let at = match.index + match[0].length;
    while (text[at] === ' ' || text[at] === '\t') at++;
    if (text[at] === '(') {
      at++; while (text[at] === ' ' || text[at] === '\t') at++;
      if (text[at] === '<') { const end = text.indexOf('>', at + 1); if (end >= 0) targets.push(text.slice(at + 1, end)); continue; }
      const start = at; let depth = 0;
      while (at < text.length) {
        const char = text[at];
        if (char === '\\') { at += 2; continue; }
        if (char === ')' && depth === 0 || /\s/.test(char) && depth === 0) break;
        if (char === '(') depth++; else if (char === ')') depth--;
        at++;
      }
      targets.push(text.slice(start, at));
    } else {
      const end = text[at] === '[' ? text.indexOf(']', at + 1) : -1;
      const reference = end >= 0 ? text.slice(at + 1, end) || match[1] : match[1];
      if (references.has(key(reference))) targets.push(references.get(key(reference)));
    }
  }
  for (const match of text.matchAll(/<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))[^>]*>/gi)) targets.push(match[1] ?? match[2] ?? match[3]);
  return targets;
}

function localImage(root, directory, input) {
  if (typeof input !== 'string') return null;
  let target = input.trim().replace(/&(?:#([0-9]+)|#x([0-9a-f]+)|(amp|quot|apos|lt|gt));/gi, (entity, decimal, hex, named) => {
    if (named) return HTML_ENTITIES[named.toLowerCase()];
    const code = Number.parseInt(decimal || hex, hex ? 16 : 10);
    return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : entity;
  });
  target = target.split(/[?#]/, 1)[0].replace(/\\([\\() ])/g, '$1');
  try { target = decodeURIComponent(target); } catch { return null; }
  if (!target || target.includes('\0') || /^(?:[a-z][a-z\d+.-]*:|[\\/])/i.test(target)) return null;
  const file = path.resolve(directory, target.replace(/[\\/]/g, path.sep));
  return inside(root, file) ? file : null;
}

async function listProjectImageCandidates(folder, thumbnail, limits = LIMITS) {
  let root;
  try { root = await fs.realpath(folder); if (!(await fs.stat(root)).isDirectory()) return { candidates: [] }; } catch { return { candidates: [] }; }
  const found = new Map(), visited = new Set();
  let directories = 0, entries = 0, readmes = 0, projects = 0, bytesRead = 0;

  async function list(directory) {
    if (directories >= limits.directories || entries >= limits.entries || visited.has(directory)) return [];
    visited.add(directory); directories++;
    const result = [];
    try {
      if ((await fs.lstat(directory)).isSymbolicLink() || !inside(root, await fs.realpath(directory))) return [];
      const stream = await fs.opendir(directory);
      for await (const entry of stream) { result.push(entry); if (++entries >= limits.entries) break; }
    } catch { return []; }
    return result.sort((a, b) => compare(a.name, b.name));
  }

  async function read(file, limit) {
    if (!inside(root, file) || bytesRead >= limits.totalBytes) return null;
    let handle;
    try {
      const resolved = await fs.realpath(file);
      if (!inside(root, resolved) || !(await fs.stat(resolved)).isFile()) return null;
      // Never follow a directory link, even when a README or manifest names it explicitly.
      let current = root;
      for (const part of path.relative(root, file).split(path.sep).slice(0, -1)) {
        if (part.startsWith('.') || SKIP.has(part.toLowerCase()) && part.toLowerCase() !== 'build') return null;
        current = path.join(current, part);
        if ((await fs.lstat(current)).isSymbolicLink()) return null;
      }
      handle = await fs.open(resolved, 'r');
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size === 0 || stat.size > limit || stat.size > limits.totalBytes - bytesRead) return null;
      const buffer = Buffer.alloc(stat.size + 1);
      const { bytesRead: length } = await handle.read(buffer, 0, buffer.length, 0);
      bytesRead += length;
      return length === stat.size ? buffer.subarray(0, length) : null;
    } catch { return null; } finally { await handle?.close().catch(() => {}); }
  }

  function add(file, source, rank) {
    if (!file || !RASTER.test(file) || !inside(root, file) || /(?:^|[-_.])(?:badge|coverage|shields)(?:[-_.]|$)/i.test(path.basename(file))) return;
    const previous = found.get(file);
    if (previous) { if (rank < previous.rank) found.set(file, { file, source, rank }); return; }
    if (found.size < limits.files) found.set(file, { file, source, rank });
  }

  async function manifest(file, packageFile = false) {
    const bytes = await read(file, limits.manifestBytes);
    if (!bytes) return;
    let data;
    try { data = JSON.parse(bytes.toString('utf8')); } catch { return; }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return;
    const directory = path.dirname(file);
    const icons = packageFile ? [data.icon, data.build?.icon, data.build?.win?.icon, data.build?.mac?.icon, data.build?.linux?.icon, data.config?.forge?.packagerConfig?.icon] : Array.isArray(data.icons) ? data.icons.map(icon => icon?.src) : [];
    for (const target of icons) {
      const icon = localImage(root, directory, target);
      if (!icon) continue;
      if (path.extname(icon)) add(icon, 'icon', 0);
      else for (const extension of ['.png', '.ico', '.jpg', '.webp']) add(icon + extension, 'icon', 0);
    }
    if (packageFile && typeof data.build?.directories?.buildResources === 'string') {
      const resources = localImage(root, directory, data.build.directories.buildResources);
      if (resources) for (const name of ['icon.png', 'icon.ico', 'logo.png']) add(path.join(resources, name), 'icon', 1);
    }
  }

  async function readme(file, depth) {
    if (readmes >= limits.readmes) return;
    readmes++;
    const bytes = await read(file, limits.readmeBytes);
    if (bytes) for (const target of readmeImages(bytes.toString('utf8'))) add(localImage(root, path.dirname(file), target), 'readme', 20 + depth);
  }

  async function scan(directory, depth, projectRoot = false) {
    if (depth > limits.depth) return;
    const listing = await list(directory);
    for (const entry of listing) {
      if (!entry.isFile()) continue;
      const file = path.join(directory, entry.name), name = entry.name.toLowerCase();
      if (name === 'package.json' && projectRoot) await manifest(file, true);
      else if (name === 'manifest.webmanifest' || name === 'manifest.json') await manifest(file);
      else if (README.test(entry.name)) await readme(file, depth);
      else if (RASTER.test(name)) {
        const icon = ICON.test(path.parse(name).name);
        add(file, icon ? 'icon' : 'asset', (icon ? 10 : /screenshot|preview|demo|overview|hero/.test(name) ? 30 : 40) + depth);
      }
    }
    for (const entry of listing) {
      if (!visibleDirectory(entry)) continue;
      const child = path.join(directory, entry.name), name = entry.name.toLowerCase();
      if (projectRoot && (name === 'apps' || name === 'packages')) {
        if (depth + 1 >= limits.depth) continue;
        for (const app of await list(child)) {
          if (!visibleDirectory(app) || projects >= limits.projects) continue;
          projects++; await scan(path.join(child, app.name), depth + 2, true);
        }
      } else if (projectRoot && name === 'src') {
        if (depth + 1 >= limits.depth) continue;
        for (const asset of await list(child)) if (visibleDirectory(asset) && ASSETS.has(asset.name.toLowerCase())) await scan(path.join(child, asset.name), depth + 2);
      } else if (!projectRoot || ASSETS.has(name)) await scan(child, depth + 1);
    }
  }

  await scan(root, 0, true);
  const ranked = [...found.values()].sort((a, b) => a.rank - b.rank || compare(a.file, b.file));
  const candidates = [], content = new Set(), pictures = new Set();
  let attempts = 0, icons = 0;
  for (const candidate of ranked) {
    if (candidates.length >= limits.candidates || attempts >= limits.thumbnails) break;
    if (candidate.source === 'icon' && icons >= 2) continue;
    const bytes = await read(candidate.file, limits.imageBytes);
    if (!bytes) continue;
    const digest = hash(bytes);
    if (content.has(digest)) continue;
    content.add(digest); attempts++;
    let image;
    try { image = await thumbnail(bytes, candidate.source); } catch { continue; }
    if (typeof image !== 'string' || image.length > 200_000 || !DATA_IMAGE.test(image) || pictures.has(image)) continue;
    pictures.add(image); if (candidate.source === 'icon') icons++;
    candidates.push({ path: path.relative(root, candidate.file).split(path.sep).join('/'), source: candidate.source, image });
  }
  return { candidates };
}

module.exports = { listProjectImageCandidates, projectImageDimensions, LIMITS };
