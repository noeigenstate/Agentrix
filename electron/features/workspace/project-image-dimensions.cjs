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

module.exports = { projectImageDimensions };
