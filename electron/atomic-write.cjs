const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

// Writes a private file whole or not at all: a reader never sees half of it (startup notes, skill files, their history).
function writeFileAtomic(file, text, beforeReplace) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, text, { mode: 0o600 });
    if (beforeReplace && !beforeReplace()) return false;
    fs.renameSync(temporary, file);
    if (beforeReplace) return true;
  }
  finally { fs.rmSync(temporary, { force: true }); }
}

module.exports = { writeFileAtomic };
