const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { retryFileOperation } = require('./file-retry.cjs');

// Writes a private file whole or not at all: a reader never sees half of it (startup notes, skill files, their history).
function writeFileAtomic(file, text, beforeReplace, { flush = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  let failed = false;
  let replaced = false;
  try {
    fs.writeFileSync(temporary, text, { mode: 0o600, flag: 'wx', flush });
    if (beforeReplace && !beforeReplace()) return false;
    retryFileOperation(() => fs.renameSync(temporary, file));
    replaced = true;
    if (beforeReplace) return true;
  }
  catch (error) {
    failed = true;
    throw error;
  }
  finally {
    if (!replaced) {
      try { retryFileOperation(() => fs.rmSync(temporary, { force: true })); }
      catch (error) { if (!failed) throw error; }
    }
  }
}

module.exports = { writeFileAtomic };
