const fs = require('node:fs');

const FILE_LIMIT = 20 * 1024 * 1024, LINE_LIMIT = 16 * 1024, READ_LIMIT = 10000;

function decodeTail(buffer, start, { since = 0, timeKey = 'at', version = 1, limit = READ_LIMIT } = {}) {
  const lines = buffer.toString('utf8').split('\n');
  if (start) lines.shift();
  lines.pop(); // A torn final write is never a record.
  const records = [];
  for (const line of lines) {
    if (Buffer.byteLength(line) > LINE_LIMIT) continue;
    let record; try { record = JSON.parse(line); } catch { continue; }
    if (!record || Array.isArray(record) || typeof record !== 'object' || version !== null && record.v !== version ||
      !Number.isFinite(record[timeKey]) || record[timeKey] < since) continue;
    records.push(record);
    if (records.length > limit * 2) records.splice(0, limit);
  }
  return records.slice(-limit);
}

async function readJsonl(filename, options) {
  let file;
  try {
    file = await fs.promises.open(filename, 'r');
    const { size } = await file.stat(), start = Math.max(0, size - FILE_LIMIT);
    const buffer = Buffer.alloc(Math.min(size, FILE_LIMIT));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, start + offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return decodeTail(buffer.subarray(0, offset), start, options);
  } catch { return []; } finally { await file?.close().catch(() => {}); }
}

function readJsonlSync(filename, options) {
  let file;
  try {
    file = fs.openSync(filename, 'r');
    const { size } = fs.fstatSync(file), start = Math.max(0, size - FILE_LIMIT);
    const buffer = Buffer.alloc(Math.min(size, FILE_LIMIT));
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = fs.readSync(file, buffer, offset, buffer.length - offset, start + offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return decodeTail(buffer.subarray(0, offset), start, options);
  } catch { return []; } finally { if (file !== undefined) fs.closeSync(file); }
}

module.exports = { readJsonl, readJsonlSync, FILE_LIMIT, LINE_LIMIT, READ_LIMIT };
