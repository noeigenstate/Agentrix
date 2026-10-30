const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { fileURLToPath } = require('node:url');
const path = require('node:path');
const { localPath, projectFile } = require('./preview-location.cjs');
const values = require('../../../src/shared/picture-values.json');
const { IMAGE_LIMIT: DATA_LIMIT } = require('../../oversized-record.cjs');
const FILE_LIMIT = 25 * 1024 * 1024, HEADER_LIMIT = 64 * 1024, CACHE_LIMIT = 16 * 1024 * 1024;
const JPEG_SCAN_LIMIT = 4 * 1024 * 1024;
const dataImage = value => typeof value === 'string' && /^data:image\/[\w.+-]+;base64,[A-Za-z0-9+/]/.test(value);
const jpegStart = bytes => bytes[0] === 255 && bytes[1] === 216;
const startOfFrame = new Set([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207]);

function jpegDimensions(read, length) {
  // APP/ICC segments can precede SOF by hundreds of KiB. Skip their payloads instead of loading them.
  const end = Math.min(length, JPEG_SCAN_LIMIT);
  for (let at = 2, segments = 0; at + 4 <= end && segments < 1024; segments++) {
    const header = read(at, Math.min(9, end - at));
    if (header.length < 4 || header[0] !== 255) return null;
    const marker = header[1];
    if (marker === 255) { at++; continue; }
    if ([217, 218].includes(marker)) return null;
    if (marker === 1 || marker >= 208 && marker <= 216) { at += 2; continue; }
    const size = header.readUInt16BE(2);
    if (size < 2 || at + 2 + size > length) return null;
    if (startOfFrame.has(marker)) return size >= 7 && header.length >= 9 ? [header.readUInt16BE(7), header.readUInt16BE(5)] : null;
    at += 2 + size;
  }
  return null;
}

function dimensions(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  if (bytes.length >= 10 && /^GIF8[79]a/.test(bytes.toString('ascii', 0, 6))) return [bytes.readUInt16LE(6), bytes.readUInt16LE(8)];
  if (bytes.length >= 26 && bytes.toString('ascii', 0, 2) === 'BM') {
    if (bytes.readUInt32LE(14) === 12) return [bytes.readUInt16LE(18), bytes.readUInt16LE(20)];
    return [Math.abs(bytes.readInt32LE(18)), Math.abs(bytes.readInt32LE(22))];
  }
  if (bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    const kind = bytes.toString('ascii', 12, 16);
    if (kind === 'VP8X') return [1 + bytes.readUIntLE(24, 3), 1 + bytes.readUIntLE(27, 3)];
    if (kind === 'VP8 ' && bytes.subarray(23, 26).equals(Buffer.from([157, 1, 42]))) return [bytes.readUInt16LE(26) & 16383, bytes.readUInt16LE(28) & 16383];
    if (kind === 'VP8L' && bytes[20] === 47) { const bits = bytes.readUInt32LE(21); return [1 + (bits & 16383), 1 + ((bits >>> 14) & 16383)]; }
  }
  if (jpegStart(bytes)) return jpegDimensions((at, length) => bytes.subarray(at, at + length), bytes.length);
  return null;
}
const safeDimensions = size => size && size.every(side => side > 0 && side <= 16384) && size[0] * size[1] <= 16_000_000;
// The limit applies to base64 pixels, as it does in the transcript parser; MIME prefixes do not consume it.
const payloadSize = url => url.length - url.indexOf(',') - 1;

class PictureThumbnails {
  constructor(fromFile = () => null, fromData = value => value) { this.fromFile = fromFile; this.fromData = fromData; this.cache = new Map(); this.bytes = 0; }
  remember(key, value) {
    if (!dataImage(value)) return values.unavailable;
    if (payloadSize(value) > DATA_LIMIT) return values.omitted;
    this.cache.set(key, value); this.bytes += value.length;
    while (this.cache.size > 64 || this.bytes > CACHE_LIMIT) { const oldest = this.cache.keys().next().value; this.bytes -= this.cache.get(oldest).length; this.cache.delete(oldest); }
    return value;
  }
  file(input, { projectRoot } = {}) {
    try {
      const file = input.startsWith('file:') ? fileURLToPath(input) : input;
      if (projectRoot) projectFile({ path: projectRoot }, file);
      else localPath(file);
      if (!path.isAbsolute(file)) return values.unavailable;
      const stat = fs.statSync(file, { throwIfNoEntry: false });
      if (!stat?.isFile()) return values.unavailable;
      if (stat.size > FILE_LIMIT) return values.omitted;
      const key = `file:${file}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
      if (this.cache.has(key)) return this.cache.get(key);
      const fd = fs.openSync(file, 'r');
      let size;
      try {
        const header = Buffer.alloc(Math.min(stat.size, HEADER_LIMIT)), read = fs.readSync(fd, header, 0, header.length, 0);
        size = dimensions(header.subarray(0, read));
        if (!size && jpegStart(header)) size = jpegDimensions((at, length) => {
          const bytes = Buffer.alloc(length), count = fs.readSync(fd, bytes, 0, length, at);
          return bytes.subarray(0, count);
        }, stat.size);
      }
      finally { fs.closeSync(fd); }
      if (!size) return values.unavailable;
      if (!safeDimensions(size)) return values.omitted;
      const thumbnail = this.fromFile(file);
      return thumbnail ? this.remember(key, thumbnail) : values.unavailable;
    } catch { return values.unavailable; }
  }
  data(url) {
    if (!dataImage(url)) return values.unavailable;
    if (payloadSize(url) > DATA_LIMIT) return values.omitted;
    const key = 'data:' + createHash('sha256').update(url).digest('hex');
    if (this.cache.has(key)) return this.cache.get(key);
    const size = dimensions(Buffer.from(url.slice(url.indexOf(',') + 1, url.indexOf(',') + 1 + Math.ceil(HEADER_LIMIT / 3) * 4), 'base64'));
    if (!size) return this.remember(key, url);
    if (!safeDimensions(size)) return values.omitted;
    let thumbnail = url;
    try { thumbnail = this.fromData(url) || url; } catch { }
    return this.remember(key, thumbnail);
  }
}
module.exports = { PictureThumbnails, dataImage, dimensions, safeDimensions, FILE_LIMIT };
