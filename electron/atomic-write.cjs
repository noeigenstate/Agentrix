const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

// Writes a private file whole or not at all: a reader never sees half of it (startup notes, skill files, their history).
function writeFileAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, text, { mode: 0o600 }); fs.renameSync(temporary, file); }
  finally { fs.rmSync(temporary, { force: true }); }
}

module.exports = { writeFileAtomic };
